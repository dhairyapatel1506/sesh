#!/usr/bin/env node
// Publish the staging channel: the same build as `sesh-terminal`, under the
// package name `sesh-terminal-staging` with the command `sesh-staging`, so it
// installs beside the production client instead of replacing it. Everything
// the manifest says is derived from the production one here, at publish
// time — there is no second package.json to keep in step.
//
//   npm run publish:staging --workspace cli          (add -- --dry-run to rehearse)
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

execSync("npm run build", { cwd: cli, stdio: "inherit" });

const manifest = JSON.parse(fs.readFileSync(path.join(cli, "package.json"), "utf8"));
const staged = {
  ...manifest,
  name: "sesh-terminal-staging",
  description: `${manifest.description} (staging channel — talks to the staging server)`,
  bin: { "sesh-staging": "dist/index.js" },
  homepage: "https://sesh-staging.dhairya.cloud",
  scripts: {},
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sesh-terminal-staging-"));
fs.cpSync(path.join(cli, "dist"), path.join(dir, "dist"), { recursive: true });
fs.copyFileSync(path.join(cli, "README.md"), path.join(dir, "README.md"));
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(staged, null, 2) + "\n");

console.log(`\npublishing ${staged.name}@${staged.version} (command: sesh-staging) from ${dir}\n`);
execSync(`npm publish${dryRun ? " --dry-run" : ""}`, { cwd: dir, stdio: "inherit" });
fs.rmSync(dir, { recursive: true, force: true });
