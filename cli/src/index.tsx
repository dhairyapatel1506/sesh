#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import React, { useEffect, useMemo, useState } from "react";
import { Box, render, Text, useInput } from "ink";
import { Session } from "./session.js";
import { App } from "./ui.js";
import { loadConfig, saveConfig } from "./config.js";

const DEFAULT_SERVER = "https://sesh.dhairya.cloud";

// WSL's audio relay (WSLg) wedges often enough that sesh won't play there.
// Instead of failing mysteriously, hand the session off to the Windows-native
// install (mpv → WASAPI): open a new Windows Terminal tab running the same
// command. Native Linux is unaffected; automated tests import Session
// directly and never reach this.
function isWsl(): boolean {
  return (
    process.platform === "linux" &&
    (os.release().toLowerCase().includes("microsoft") || !!process.env.WSL_DISTRO_NAME)
  );
}

function windowsHas(command: string): boolean {
  try {
    execFileSync("where.exe", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function handOffToWindows(args: string[]): never {
  if (!windowsHas("sesh")) {
    console.error(
      "sesh can't play audio reliably under WSL, and no Windows-side install was found to hand off to.\n" +
        "Install it in PowerShell (see README → Terminal client → Windows), then `sesh` here will open it there.\n" +
        "(Developers: set SESH_ALLOW_WSL=1 to force running in WSL.)",
    );
    process.exit(1);
  }
  const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  // `|| pause` keeps the window around if sesh fails, so errors stay readable.
  const winCmd = `sesh ${quoted} || pause`;
  // cwd must be a Windows-visible path or every interop spawn whines about
  // UNC working directories.
  const opts = { cwd: "/mnt/c", detached: true, stdio: "ignore" as const };
  if (windowsHas("wt")) {
    spawn("wt.exe", ["new-tab", "--title", "Sesh", "cmd", "/c", winCmd], opts).unref();
    console.log("sesh doesn't play audio reliably under WSL — opened it in a new Windows Terminal tab instead.");
  } else {
    spawn("cmd.exe", ["/c", "start", "Sesh", "cmd", "/c", winCmd], opts).unref();
    console.log("sesh doesn't play audio reliably under WSL — opened it in a Windows console instead.");
  }
  process.exit(0);
}

// Same alphabet as the web landing (client/src/roomId.ts) — rooms are created
// implicitly server-side on first join, so "creating" one is just joining a
// fresh code.
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateRoomId(length = 6): string {
  let id = "";
  for (let i = 0; i < length; i++) {
    id += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  }
  return id;
}

function usage(): never {
  console.log(`sesh — watch2gether from your terminal (audio mode)

usage:
  sesh                                         # create a room
  sesh <ROOM-CODE> [--name <you>] [--server <url>]

examples:
  sesh
  sesh F3K9QX
  sesh F3K9QX --name dhairya
  sesh F3K9QX --server http://localhost:3001   # local dev server`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let roomId: string | null = null;
  let name: string | null = null;
  let server = DEFAULT_SERVER;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--name") name = argv[++i] ?? null;
    else if (arg === "--server") server = argv[++i] ?? server;
    else if (arg === "--help" || arg === "-h") usage();
    else if (!arg.startsWith("-") && !roomId) roomId = arg;
    else usage();
  }
  // No room code (or the explicit "new") means "start a fresh room".
  if (!roomId || roomId.toLowerCase() === "new") roomId = generateRoomId();
  return { roomId: roomId.toUpperCase(), name, server: server.replace(/\/$/, "") };
}

function NamePrompt({ onDone }: { onDone: (name: string) => void }) {
  const [value, setValue] = useState("");
  useInput((input, key) => {
    if (key.return) {
      const name = value.trim().slice(0, 30);
      if (name) onDone(name);
      return;
    }
    if (key.backspace || key.delete) return setValue((v) => v.slice(0, -1));
    if (!key.ctrl && !key.meta && !key.escape && !key.tab && !key.upArrow && !key.downArrow) {
      setValue((v) => v + input);
    }
  });
  return (
    <Box borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text>
        <Text color="magenta" bold>
          What should we call you?{" "}
        </Text>
        {value}
        <Text color="gray">▏</Text>
      </Text>
    </Box>
  );
}

function Root({ roomId, server, initialName }: { roomId: string; server: string; initialName: string | null }) {
  const [name, setName] = useState(initialName);
  const session = useMemo(() => {
    if (!name) return null;
    const s = new Session({ serverUrl: server, roomId, name });
    void s.start();
    return s;
  }, [name, server, roomId]);

  // However we exit (Ctrl+C, /quit), mpv and the socket must go down too.
  useEffect(() => {
    return () => session?.destroy();
  }, [session]);

  if (!name) {
    return (
      <NamePrompt
        onDone={(picked) => {
          saveConfig({ ...loadConfig(), name: picked });
          setName(picked);
        }}
      />
    );
  }
  return <App session={session!} roomId={roomId} serverUrl={server} />;
}

const { roomId, name, server } = parseArgs(process.argv.slice(2));

if (isWsl() && !process.env.SESH_ALLOW_WSL) {
  // Reconstruct clean args (the generated room code included, so the tab
  // that opens joins the room this invocation named).
  handOffToWindows([
    roomId,
    ...(name ? ["--name", name] : []),
    ...(server !== DEFAULT_SERVER ? ["--server", server] : []),
  ]);
}

const config = loadConfig();

const instance = render(<Root roomId={roomId} server={server} initialName={name ?? config.name ?? null} />);
await instance.waitUntilExit();
process.exit(0);
