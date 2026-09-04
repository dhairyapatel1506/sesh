import fs from "node:fs";

// Which build this is — production or staging — and everything that follows
// from it. Read from the manifest the package was published with, so the
// answer can never disagree with what npm installed. Relative to dist/, which
// is where the built files live.
//
// The two channels are two npm packages: `sesh-terminal` installs `sesh` and
// talks to production; `sesh-terminal-staging` installs `sesh-staging` and
// talks to staging. Separate packages, so both can be installed at once and
// installing one never replaces the other. The staging manifest is derived
// from the production one at publish time (scripts/publish-staging.mjs).
type Manifest = { name?: string; version?: string; bin?: Record<string, string> };

function readManifest(): Manifest {
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Manifest;
  } catch {
    return {};
  }
}

const manifest = readManifest();

export const PRODUCTION_SERVER = "https://sesh.dhairya.cloud";
export const STAGING_SERVER = "https://sesh-staging.dhairya.cloud";

export const isStaging = manifest.name === "sesh-terminal-staging";
export const version = manifest.version ?? "unknown";
// The command people type — what `bin` in the manifest says it is.
export const command = Object.keys(manifest.bin ?? {})[0] ?? (isStaging ? "sesh-staging" : "sesh");
// SESH_SERVER overrides the channel's server for anything unusual (a local
// dev server, for one).
export const defaultServer = process.env.SESH_SERVER || (isStaging ? STAGING_SERVER : PRODUCTION_SERVER);
// Config (the saved sign-in) is kept per channel: a staging sign-in is a
// staging session, signed by the staging server, and must not overwrite the
// production one — or vice versa.
export const configName = isStaging ? "sesh-staging" : "sesh";
