import React, { useEffect, useReducer, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Session } from "./session.js";
import { extractVideoId, fetchTitle, formatTime, parseTime, search } from "./youtube.js";
import type { SearchResult } from "./types.js";

const HELP = [
  ["<text>", "send a chat message"],
  ["/search <query>", "search YouTube"],
  ["/pick <n>", "play search result n for everyone"],
  ["/queue <n>", "add search result n to the queue"],
  ["/add <url>", "queue a YouTube link (plays if room is idle)"],
  ["/play  /pause", "control playback for everyone"],
  ["/seek <m:ss>", "jump everyone to a position"],
  ["/skip", "jump to the next queued track"],
  ["/remove <n>", "remove queue item n"],
  ["/vol <0-130>", "local volume (only affects you)"],
  ["/help  /quit", "toggle this help / leave"],
] as const;

function InputLine({ onSubmit }: { onSubmit: (line: string) => void }) {
  const [line, setLine] = useState("");
  useInput((input, key) => {
    if (key.return) {
      const value = line.trim();
      setLine("");
      if (value) onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      setLine((prev) => prev.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || key.escape || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
      return;
    }
    setLine((prev) => prev + input);
  });
  return (
    <Box>
      <Text color="magenta" bold>
        {"> "}
      </Text>
      <Text>{line}</Text>
      <Text color="gray">▏</Text>
    </Box>
  );
}

export function App({
  session,
  roomId,
  serverUrl,
}: {
  session: Session;
  roomId: string;
  serverUrl: string;
}) {
  const { exit } = useApp();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    session.on("update", rerender);
    return () => {
      session.off("update", rerender);
    };
  }, [session]);

  const s = session.state;

  const handle = (line: string) => {
    if (!line.startsWith("/")) {
      session.sendChat(line);
      return;
    }
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    const nth = <T,>(list: T[] | null, raw: string): T | null => {
      const i = Number(raw);
      if (!list || !Number.isInteger(i) || i < 1 || i > list.length) return null;
      return list[i - 1];
    };

    switch (cmd.toLowerCase()) {
      case "play":
      case "resume":
        void session.play();
        break;
      case "pause":
        void session.pause();
        break;
      case "seek": {
        const time = parseTime(arg);
        if (time === null) return session.setStatus("usage: /seek 1:30");
        void session.seekTo(time);
        break;
      }
      case "search":
        if (!arg) return session.setStatus("usage: /search lofi hip hop");
        session.setStatus("searching…");
        void (async () => {
          try {
            const found = await search(serverUrl, arg);
            setResults(found.length ? found : null);
            session.setStatus(found.length ? null : "no results");
          } catch (err) {
            session.setStatus((err as Error).message);
          }
        })();
        break;
      case "pick": {
        const result = nth(results, arg);
        if (!result) return session.setStatus("usage: /pick <result #>");
        setResults(null);
        void session.playNow(result.videoId, result.title);
        break;
      }
      case "queue": {
        const result = nth(results, arg);
        if (!result) return session.setStatus("usage: /queue <result #>");
        void session.addToQueue(result.videoId, result.title);
        break;
      }
      case "add": {
        const videoId = extractVideoId(arg);
        if (!videoId) return session.setStatus("that doesn't look like a YouTube link or id");
        void (async () => {
          const title = await fetchTitle(videoId);
          await session.addToQueue(videoId, title);
        })();
        break;
      }
      case "skip":
        session.skip();
        break;
      case "remove": {
        const item = nth(s.queue, arg);
        if (!item) return session.setStatus("usage: /remove <queue #>");
        session.queueRemove(item.id);
        break;
      }
      case "vol": {
        const volume = Number(arg);
        if (!Number.isFinite(volume)) return session.setStatus("usage: /vol 80");
        void session.setVolume(volume);
        break;
      }
      case "help":
        setShowHelp((v) => !v);
        break;
      case "quit":
      case "exit":
        session.destroy();
        exit();
        break;
      default:
        session.setStatus(`unknown command: /${cmd} (try /help)`);
    }
  };

  if (s.fatal) {
    return (
      <Box borderStyle="round" borderColor="red" paddingX={1}>
        <Text color="red">{s.fatal}</Text>
      </Box>
    );
  }

  const drift =
    s.driftMs === null ? "" : Math.abs(s.driftMs) < 60 ? ` · synced (${s.driftMs}ms)` : ` · syncing…`;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box justifyContent="space-between">
        <Text>
          <Text color="magenta" bold>
            ⏺ Sesh
          </Text>
          <Text color="gray"> · room </Text>
          <Text bold>{roomId}</Text>
        </Text>
        <Text color={s.connected ? "green" : "yellow"}>{s.connected ? "connected" : "reconnecting…"}</Text>
      </Box>

      {/* Now playing */}
      <Box borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column">
        {s.videoId ? (
          <>
            <Text bold>
              {s.isPlaying ? "▶ " : "⏸ "}
              {s.title ?? s.videoId}
            </Text>
            <Text color="gray">
              {formatTime(s.position ?? 0)}
              {s.duration ? ` / ${formatTime(s.duration)}` : ""}
              {drift}
            </Text>
          </>
        ) : (
          <Text color="gray">nothing playing — /search or /add something</Text>
        )}
      </Box>

      {/* Search results */}
      {results && (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
          <Text color="cyan" bold>
            results · /pick n plays · /queue n queues
          </Text>
          {results.map((r, i) => (
            <Text key={r.videoId} wrap="truncate">
              <Text color="cyan">{i + 1}.</Text> {r.title}{" "}
              <Text color="gray">
                · {r.channel}
                {r.duration ? ` · ${r.duration}` : ""}
              </Text>
            </Text>
          ))}
        </Box>
      )}

      {/* Queue + chat */}
      <Box>
        <Box borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column" width="40%">
          <Text color="blue" bold>
            up next {s.queue.length > 0 ? `(${s.queue.length})` : ""}
          </Text>
          {s.queue.length === 0 ? (
            <Text color="gray">empty — /add or /queue</Text>
          ) : (
            s.queue.slice(0, 8).map((item, i) => (
              <Text key={item.id} wrap="truncate">
                <Text color="blue">{i + 1}.</Text> {item.title ?? item.videoId}{" "}
                <Text color="gray">· {item.addedBy}</Text>
              </Text>
            ))
          )}
        </Box>
        <Box borderStyle="round" borderColor="green" paddingX={1} flexDirection="column" flexGrow={1}>
          <Text color="green" bold>
            chat
          </Text>
          {s.messages.slice(-10).map((m) => (
            <Text key={m.id} wrap="truncate">
              <Text color={m.senderId === session.clientId ? "green" : "cyan"} bold>
                {m.name}:
              </Text>{" "}
              {m.text}
            </Text>
          ))}
        </Box>
      </Box>

      {/* Presence + status */}
      <Box justifyContent="space-between">
        <Text color="gray" wrap="truncate">
          here: {s.users.map((u) => u.name).join(", ") || "…"}
        </Text>
        {s.status && <Text color="yellow">{s.status}</Text>}
      </Box>

      {showHelp && (
        <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
          {HELP.map(([cmd, desc]) => (
            <Text key={cmd}>
              <Text color="magenta">{cmd.padEnd(18)}</Text>
              <Text color="gray">{desc}</Text>
            </Text>
          ))}
        </Box>
      )}

      <InputLine onSubmit={handle} />
      <Text color="gray">type to chat · /help for commands · ctrl+c to leave</Text>
    </Box>
  );
}
