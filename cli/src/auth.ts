import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Account } from "./types.js";

// Signing a terminal in, without a browser on the machine running it.
//
// Google hands its credential to a page, not a process, so the CLI does what a
// TV does: it prints a short code and waits while somebody approves it from a
// browser that's already signed in (server/src/clilink.ts is the other half).
// What lands here afterwards is the same signed session string the browser
// keeps in its cookie — the terminal never sees the Google account at all.

export type StoredAuth = { token: string; user: Account };

const POLL_INTERVAL_MS = 2000;

// Where a Unix machine keeps small per-user config, and where Windows does.
// Both are per-user directories; the file inside is locked down as well
// because a session token is a live credential, not a preference.
function configDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "sesh");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "sesh");
}

export function authFile(): string {
  return path.join(configDir(), "auth.json");
}

// Read once and remember: every friends refetch and DM fetch goes through
// authedFetch, and none of them should be a disk read.
let cached: StoredAuth | null | undefined;

export function loadAuth(): StoredAuth | null {
  if (cached !== undefined) return cached;
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile(), "utf8")) as StoredAuth;
    cached = parsed?.token && parsed?.user?.id ? parsed : null;
  } catch {
    // No file yet, or someone edited it into nonsense — either way, signed out.
    cached = null;
  }
  return cached;
}

export function saveAuth(auth: StoredAuth): void {
  // The modes are the point: nobody else with an account on this machine
  // should be able to read a token that acts as you. Windows ignores them,
  // where the per-user AppData directory does the same job.
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(authFile(), `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  cached = auth;
}

export function clearAuth(): boolean {
  cached = null;
  try {
    fs.unlinkSync(authFile());
    return true;
  } catch {
    return false; // Nothing stored — logging out twice isn't an error.
  }
}

// Every /api call the CLI makes goes through here. The token rides as a bearer
// header because a terminal has no cookie jar; the server reads both roads
// into the same identity.
export function authedFetch(serverUrl: string, endpoint: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const token = loadAuth()?.token;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${serverUrl}${endpoint}`, { ...init, headers });
}

// Best effort, and deliberately silent: a machine with no browser (a server
// over SSH is the obvious one) is a perfectly normal place to run this, and
// the printed URL is enough on its own.
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No such command. The user has the URL.
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(res: Response): Promise<Record<string, unknown>> {
  // An older server (or a proxy) answers these with HTML, and "unexpected
  // token <" helps nobody.
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** `sesh login` — device-code flow, start to finish. Returns an exit code. */
export async function runLogin(serverUrl: string): Promise<number> {
  let started: { code?: string; pollToken?: string; expiresAt?: number };
  try {
    const res = await fetch(`${serverUrl}/api/auth/cli/start`, { method: "POST" });
    started = await readJson(res);
    if (!res.ok || !started.code || !started.pollToken) {
      console.error(
        res.status === 503
          ? "that server doesn't have accounts turned on — you can still use sesh without signing in."
          : `couldn't start sign-in (${res.status})`,
      );
      return 1;
    }
  } catch (err) {
    console.error(`couldn't reach ${serverUrl} — ${(err as Error).message}`);
    return 1;
  }

  const linkUrl = `${serverUrl}/link`;
  console.log(`
  Sign in to sesh

    1. open   ${linkUrl}
    2. enter  ${started.code}

  (the code is good for 10 minutes)
`);
  openBrowser(linkUrl);
  process.stdout.write("waiting for you to approve it…");

  const expiresAt = typeof started.expiresAt === "number" ? started.expiresAt : Date.now() + 600_000;
  while (Date.now() < expiresAt) {
    await sleep(POLL_INTERVAL_MS);
    let result: { status?: string; token?: string; user?: Account };
    try {
      const res = await fetch(`${serverUrl}/api/auth/cli/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pollToken: started.pollToken }),
      });
      result = await readJson(res);
    } catch {
      continue; // A blip mid-wait isn't a failed sign-in; keep asking.
    }
    if (result.status === "approved" && result.token && result.user) {
      saveAuth({ token: result.token, user: result.user });
      console.log(`\n\nsigned in as ${result.user.name} (${result.user.email})`);
      console.log(`your friend code is ${result.user.friendCode} — swap it with people to add them`);
      return 0;
    }
    if (result.status === "expired") break;
    process.stdout.write(".");
  }
  console.error("\n\nthat code expired before it was approved — run `sesh login` again.");
  return 1;
}

/** `sesh logout` — the token only ever existed on this machine. */
export function runLogout(): number {
  console.log(clearAuth() ? "signed out." : "you weren't signed in.");
  return 0;
}

/** `sesh whoami` — asks the server, so an expired token shows up as one. */
export async function runWhoami(serverUrl: string): Promise<number> {
  if (!loadAuth()) {
    console.log("not signed in — run `sesh login`.");
    return 0;
  }
  try {
    const res = await authedFetch(serverUrl, "/api/auth/me");
    const data = (await readJson(res)) as { user?: Account | null };
    if (!res.ok || !data.user) {
      console.log("your saved sign-in is no longer valid — run `sesh login` again.");
      return 1;
    }
    console.log(`${data.user.name} <${data.user.email}>`);
    console.log(`friend code: ${data.user.friendCode}`);
    return 0;
  } catch (err) {
    console.error(`couldn't reach ${serverUrl} — ${(err as Error).message}`);
    return 1;
  }
}
