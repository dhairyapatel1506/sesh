<p align="center">
  <img src="client/public/logo.png" alt="Sesh logo" width="220" />
</p>

# Sesh

**Watch YouTube with your friends, perfectly in sync.**

Create a room, share the code, and everyone's player stays locked together — play, pause, and seek are mirrored across every viewer in real time.

**Live at [sesh.dhairya.cloud](https://sesh.dhairya.cloud)** · no accounts, no setup, just a room code.

---

## Features

- 🔗 **Instant rooms** — create a room, share the link or 6-character code, done
- 🔍 **Built-in YouTube search** — search by title or just paste any YouTube link
- ⏭️ **Shared queue** — everyone sees the same "Up next" list; add videos from search (**+**) or a pasted link, auto-play when the current one ends, play-now or remove anytime
- ⚡ **Tight sync** — playback stays within tens of milliseconds across viewers
- 💬 **Room chat** — side-by-side with the video on desktop, stacked below on mobile; as ephemeral as the room itself (history lives only while someone's in the room)
  - Consecutive messages from the same person group together, like any chat app
  - Away in another tab? The tab title shows an unread count, the favicon gets a red dot, and a soft ping sounds (mutable via the 🔔 toggle)
  - Emoji picker built in — and emoji-only messages render big
- 👥 **Presence** — see who's in the room with you
- 📱 **Mobile-friendly** — responsive UI, picture-in-picture hint for listening on the go
- 🌗 **Automatic dark mode** — follows your system theme
- 💻 **Terminal client** — join the same rooms from a terminal, audio-only ([see below](#terminal-client))

## How the sync works

Keeping two YouTube players in audible sync is harder than it looks — `getCurrentTime()` lies, autoplay policies get in the way, and every device starts playback with different latency. Sesh layers several techniques to get drift down to imperceptible levels:

1. **Server-authoritative state.** The server holds each room's truth (`videoId`, playing/paused, position) and stamps every playback message with its own clock time.

2. **NTP-style clock sync.** On connect, each client pings the server five times and uses the lowest-RTT sample to estimate its offset from the server clock. That makes server timestamps directly comparable to local time, so network latency can be extrapolated out of every sync message.

3. **Honest position measurement.** The IFrame API's `getCurrentTime()` is a cached value that only refreshes a few times per second (~250 ms stale). Sesh detects the moment the cached value last changed and extrapolates forward from it, turning a jittery reading into a precise one.

4. **Three-tier drift correction**, checked every 750 ms:
   - **< 60 ms** — leave it alone
   - **60 ms – 1.2 s** — nudge playback rate ±25% (pitch-preserved) until the gap closes, so there's no audible skip
   - **> 1.2 s** — hard seek

5. **Play-start latency learning.** Each tab measures how long its player takes between "play requested" and "actually playing" and keeps an exponential moving average, then leads its seeks by that amount so playback starts already aligned.

6. **Ready-barrier starts.** When the queue auto-advances, every tab silently pre-buffers the next video (played muted until proven buffered, then parked at 0) and reports ready; only when all tabs are ready — or a short timeout passes — does the server start everyone at the same instant. Without it, fast tabs would run ahead while slow ones buffer, then jump to catch up.

Add `?debug` to any room URL to watch it all live: drift, clock offset, learned start lag, and current playback rate.

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React 18, TypeScript, Vite |
| Backend | Node.js, Express, Socket.IO |
| Video | YouTube IFrame Player API |
| Search | YouTube Data API v3 (server-side proxy with 24 h cache) |
| Hosting | Render (single service serves API + static client) |

## Running locally

Requires Node.js 20.12+.

```bash
git clone https://github.com/dhairyapatel1506/sesh.git
cd sesh
npm install
npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:3001

Open a room in two browser tabs to see the sync in action.

### YouTube search (optional)

Search needs a [YouTube Data API v3 key](https://console.cloud.google.com/apis/library/youtube.googleapis.com). Without one, everything else still works — you just paste links instead of searching.

```bash
# server/.env
YOUTUBE_API_KEY=your-key-here
```

The free quota allows ~100 searches/day; repeated queries are served from an in-memory cache.

## Terminal client

The `cli/` workspace is a full Sesh client for the terminal — same rooms, same sync, no browser. It plays the audio track through [mpv](https://mpv.io) (which resolves YouTube streams via yt-dlp) and renders a TUI with chat, the shared queue, search, and live sync stats. A terminal user and browser users can share a room; neither side can tell the difference.

> **Note:** sesh runs on Windows (natively) and Linux — but it **refuses to run under WSL**, whose audio relay is too unreliable. On a Windows machine, install and run it from PowerShell.

### Windows

mpv plays straight through WASAPI; mpv's IPC rides a named pipe instead of a unix socket, and the client handles both. Needs [Node.js](https://nodejs.org) ≥ 20.

```powershell
# Playback engine — three pieces, all required (deno solves YouTube's throttling challenges):
winget install shinchiro.mpv yt-dlp.yt-dlp.nightly DenoLand.Deno

# The client itself (from a clone of this repo, in a fresh terminal so PATH is current):
npm install; npm run build --workspace cli
npm link --workspace cli    # generates the `sesh` command shim on your PATH

sesh                        # create a room
sesh <ROOM-CODE>            # join one
```

### Linux

```bash
# Playback engine — three pieces, all required:
sudo apt install mpv
# apt's yt-dlp is perpetually stale and YouTube breaks old versions — install the latest directly:
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ~/.local/bin/yt-dlp && chmod +x ~/.local/bin/yt-dlp
# yt-dlp needs a JS runtime (deno) to solve YouTube's throttling challenges:
curl -fsSL https://deno.land/install.sh | sh

# The client itself:
npm install && npm run build --workspace cli
npm link --workspace cli    # puts `sesh` on your PATH

sesh                        # create a room
sesh <ROOM-CODE>            # join one
```

Type to chat; `/help` lists commands (`/search`, `/pick`, `/queue`, `/play`, `/pause`, `/seek`, `/skip`, `/vol`, …). The sync engine is a straight port of the web client's — server-authoritative state, NTP-style clock sync, three-tier drift correction, and ready-barrier starts — with one twist: mpv reports playback position precisely, so the CLI skips the web client's cached-`getCurrentTime()` workaround and often ends up the tightest-synced client in the room.

## Deploying

The repo includes a [`render.yaml`](render.yaml) blueprint — one web service that builds both workspaces and serves the client's static build from Express. Set `YOUTUBE_API_KEY` in the dashboard (it's marked `sync: false` so it never lives in the repo).

## Project structure

```
sesh/
├── client/          # React + Vite frontend
│   └── src/
│       ├── Room.tsx     # player, sync engine, search + queue + chat UI
│       ├── Landing.tsx  # create/join screen
│       ├── youtube.ts   # IFrame API loader + typings
│       └── socket.ts    # Socket.IO client
├── server/          # Express + Socket.IO backend
│   └── src/
│       └── index.ts     # rooms, sync relay, queue, chat, search proxy
├── cli/             # terminal client (Ink TUI + mpv audio engine)
│   └── src/
│       ├── session.ts   # socket + sync engine port
│       ├── mpv.ts       # mpv JSON IPC wrapper
│       └── ui.tsx       # panes: now playing, queue, chat, search
└── render.yaml      # Render deploy blueprint
```
