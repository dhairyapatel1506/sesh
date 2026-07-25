import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Values pasted into a dashboard arrive with invisible passengers — a trailing
// newline, a wrapping pair of quotes the shell would have eaten. Neither is
// visible in the UI that accepted it, and both fail in ways that point
// somewhere else entirely: a client id with a newline fails as an audience
// mismatch, a connection string with quotes as a DNS error.
export function env(key: string): string | undefined {
  const raw = process.env[key];
  if (raw === undefined) return undefined;
  const cleaned = raw.trim().replace(/^["']|["']$/g, "");
  return cleaned === "" ? undefined : cleaned;
}

// Everything about accounts is optional. With no DATABASE_URL the app runs
// exactly as it always has — anonymous rooms, no sign-in button — instead of
// refusing to boot. That keeps local dev and the existing deployment working
// for anyone who hasn't set a database up.
//
// Built on first use, never at import time: imports are evaluated before the
// body of the module that imports them, so reading process.env here directly
// would run before index.ts has loaded server/.env — and every local run would
// think it had no database.
let pool: pg.Pool | null = null;
let initialised = false;

function getPool(): pg.Pool | null {
  if (!initialised) {
    initialised = true;
    const connectionString = env("DATABASE_URL");
    if (connectionString) {
      pool = new pg.Pool({
        connectionString,
        // Say what we mean rather than inheriting it from the URL's sslmode.
        // A coming pg release reinterprets sslmode=require as libpq does —
        // encrypted but with the certificate unchecked — which would silently
        // downgrade this connection the day the dependency updates. Verifying
        // the certificate is the point of TLS to a database we don't host.
        ssl: { rejectUnauthorized: true },
        // Neon closes idle connections itself and its free plan counts them,
        // so a single small web service has no reason to hold many.
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      });
    }
  }
  return pool;
}

export const dbEnabled = () => getPool() !== null;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const p = getPool();
  if (!p) throw new Error("no database configured");
  const result = await p.query<T>(text, params);
  return result.rows;
}

// Applies every .sql file in migrations/ that hasn't run yet, in filename
// order, each in its own transaction. Deliberately tiny: this project has one
// server process and a handful of tables, so a migration tool would be more
// machinery than the thing it manages.
export async function migrate(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`
    create table if not exists _migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const dir = path.join(__dirname, "../migrations");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  const applied = new Set(
    (await query<{ name: string }>("select name from _migrations")).map((r) => r.name),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into _migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`migration applied: ${file}`);
    } catch (err) {
      await client.query("rollback");
      // A half-applied schema is worse than no server: stop here rather than
      // serving requests against a shape the code doesn't expect.
      throw new Error(`migration failed: ${file} — ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}
