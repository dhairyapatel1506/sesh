#!/usr/bin/env node
import React, { useEffect, useMemo, useState } from "react";
import { Box, render, Text, useInput } from "ink";
import { Session } from "./session.js";
import { App } from "./ui.js";
import { loadConfig, saveConfig } from "./config.js";

const DEFAULT_SERVER = "https://sesh.dhairya.cloud";

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
  sesh new                                     # create a room
  sesh <ROOM-CODE> [--name <you>] [--server <url>]

examples:
  sesh new
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
  if (!roomId) usage();
  if (roomId.toLowerCase() === "new") roomId = generateRoomId();
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
const config = loadConfig();

const instance = render(<Root roomId={roomId} server={server} initialName={name ?? config.name ?? null} />);
await instance.waitUntilExit();
process.exit(0);
