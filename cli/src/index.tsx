#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import React, { useEffect, useMemo, useState } from "react";
import { Box, render, Text, useInput } from "ink";
import { loadAuth, runLogin, runLogout, runWhoami } from "./auth.js";
import { Session } from "./session.js";
import { App } from "./ui.js";
import type { Account } from "./types.js";

import { command as BIN, defaultServer, version as VERSION } from "./channel.js";

const DEFAULT_SERVER = defaultServer;
const version = () => VERSION;

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

function handOffToWindows(args: string[], reason: string): never {
  if (!windowsHas(BIN)) {
    console.error(
      `${BIN} can't play audio reliably under WSL, and no Windows-side install was found to hand off to.\n` +
        "Install it in PowerShell (see README → Terminal client → Windows), then `${BIN}` here will open it there.\n" +
        "(Developers: set SESH_ALLOW_WSL=1 to force running in WSL.)",
    );
    process.exit(1);
  }
  const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  // `|| pause` keeps the window around if sesh fails, so errors stay readable.
  const winCmd = `${BIN} ${quoted} || pause`;
  // cwd must be a Windows-visible path or every interop spawn whines about
  // UNC working directories.
  const opts = { cwd: "/mnt/c", detached: true, stdio: "ignore" as const };
  if (windowsHas("wt")) {
    spawn("wt.exe", ["new-tab", "--title", "Sesh", "cmd", "/c", winCmd], opts).unref();
    console.log(`${reason} — opened it in a new Windows Terminal tab instead.`);
  } else {
    spawn("cmd.exe", ["/c", "start", "Sesh", "cmd", "/c", winCmd], opts).unref();
    console.log(`${reason} — opened it in a Windows console instead.`);
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
  const c = BIN.padEnd(12);
  console.log(`${BIN} — watch2gether from your terminal (audio mode)

usage:
  ${c}                                    # create a room
  ${c} <ROOM-CODE> [--name <you>] [--server <url>]
  ${c} login | logout | whoami            # your sesh account
  ${c} --version

examples:
  ${BIN}
  ${BIN} F3K9QX
  ${BIN} F3K9QX --name dhairya
  ${BIN} F3K9QX --server http://localhost:3001   # local dev server
  ${BIN} login                                   # friends, invites, DMs

${BIN} ${version()} → ${DEFAULT_SERVER}`);
  process.exit(1);
}

// The account commands read as room codes otherwise. They can't collide: room
// codes are six characters from an alphabet that has no lowercase in it, and
// nothing here is six characters long anyway.
const ACCOUNT_COMMANDS = ["login", "logout", "whoami"] as const;
type AccountCommand = (typeof ACCOUNT_COMMANDS)[number];

function parseArgs(argv: string[]) {
  let roomId: string | null = null;
  let name: string | null = null;
  let server = DEFAULT_SERVER;
  let command: AccountCommand | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--name") name = argv[++i] ?? null;
    else if (arg === "--server") server = argv[++i] ?? server;
    else if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--version" || arg === "-v") {
      // Bare, so `sesh --version` can be read by a script without parsing prose.
      console.log(version());
      process.exit(0);
    }
    else if (!command && !roomId && (ACCOUNT_COMMANDS as readonly string[]).includes(arg.toLowerCase())) {
      command = arg.toLowerCase() as AccountCommand;
    } else if (!arg.startsWith("-") && !roomId && !command) roomId = arg;
    else usage();
  }
  // No room code (or the explicit "new") means "start a fresh room".
  if (!roomId || roomId.toLowerCase() === "new") roomId = generateRoomId();
  return { command, roomId: roomId.toUpperCase(), name, server: server.replace(/\/$/, "") };
}

function NamePrompt({ error, onDone }: { error: string | null; onDone: (name: string) => void }) {
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
    <Box flexDirection="column">
      {error && <Text color="red">{error}</Text>}
      <Box borderStyle="round" borderColor="magenta" paddingX={1}>
        <Text>
          <Text color="magenta" bold>
            What should we call you?{" "}
          </Text>
          {value}
          <Text color="gray">▏</Text>
        </Text>
      </Box>
    </Box>
  );
}

function Root({
  roomId: initialRoomId,
  server,
  initialName,
  token,
  account,
}: {
  roomId: string;
  server: string;
  initialName: string | null;
  token: string | null;
  account: Account | null;
}) {
  const [name, setName] = useState(initialName);
  const [nameError, setNameError] = useState<string | null>(null);
  // /join and /accept move rooms inside one session; this only changes when a
  // session has to be rebuilt (a name collision), and then it has to be the
  // room we were actually in, not the one this process started in.
  const [roomId, setRoomId] = useState(initialRoomId);
  const session = useMemo(() => {
    if (!name) return null;
    const s = new Session({ serverUrl: server, roomId, name, token, account });
    void s.start();
    return s;
  }, [name, server, roomId]);

  // However we exit (Ctrl+C, /quit), mpv and the socket must go down too.
  useEffect(() => {
    return () => session?.destroy();
  }, [session]);

  // Name already in use in this room — back to the prompt with the reason.
  // Watched via state on every update (not a one-shot event), so the reset
  // can't be missed regardless of when the denial arrives. (Names are
  // deliberately never saved: no accounts yet, so every run is a fresh
  // choice.)
  useEffect(() => {
    if (!session) return;
    const check = () => {
      if (session.state.joinDenied) {
        setNameError(session.state.joinDenied);
        setRoomId(session.state.roomId);
        setName(null);
      }
    };
    session.on("update", check);
    check(); // a denial may have landed before this effect ran
    return () => {
      session.off("update", check);
    };
  }, [session]);

  if (!name) {
    return <NamePrompt error={nameError} onDone={(picked) => setName(picked)} />;
  }
  return <App session={session!} serverUrl={server} />;
}

const { command, roomId, name, server } = parseArgs(process.argv.slice(2));
const stored = loadAuth();

if (isWsl() && !process.env.SESH_ALLOW_WSL) {
  // Reconstruct clean args (the generated room code included, so the tab
  // that opens joins the room this invocation named). The account commands
  // go over too: a token saved here would sit in a config file belonging to a
  // machine that never actually runs sesh.
  handOffToWindows(
    [
      command ?? roomId,
      ...(name && !command ? ["--name", name] : []),
      ...(server !== DEFAULT_SERVER ? ["--server", server] : []),
    ],
    command
      ? `${BIN} runs on the Windows side under WSL, so it signs in there`
      : `${BIN} doesn't play audio reliably under WSL`,
  );
}

// Account commands are plain terminal output — no TUI, and no mpv to start.
if (command) {
  // Set the code and let the loop drain instead of calling process.exit().
  // These commands finish on the tail of an HTTP request, and tearing the
  // process down while the connection is still closing trips an assertion
  // inside libuv on Windows — the command's output is already printed, so it
  // reads as a crash after a success. Node's fetch doesn't hold the loop open
  // once a response is consumed, so exiting naturally costs nothing.
  process.exitCode =
    command === "login"
      ? await runLogin(server)
      : command === "logout"
        ? runLogout()
        : await runWhoami(server);
} else {
  const instance = render(
    <Root
      roomId={roomId}
      server={server}
      // Signed in, your account's name is your name — the prompt only exists
      // because anonymous users have to be asked for one. --name still wins.
      initialName={name ?? stored?.user.name ?? null}
      token={stored?.token ?? null}
      account={stored?.user ?? null}
    />,
  );
  await instance.waitUntilExit();
  // The TUI does need a push: mpv and the socket can outlive the render. The
  // timer is unref'd so a clean drain still exits immediately, and the delay
  // keeps this out of the same teardown race as above.
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 250).unref();
}

