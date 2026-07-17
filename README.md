# Sesh 🎬

**Watch YouTube with your friends, perfectly in sync.**

Create a room, share the code, and everyone's player stays locked together — play, pause, and seek are mirrored across every viewer in real time.

**Live at [sesh.dhairya.cloud](https://sesh.dhairya.cloud)** · no accounts, no setup, just a room code.

---

## Features

- 🔗 **Instant rooms** — create a room, share the link or 6-character code, done
- 🔍 **Built-in YouTube search** — search by title or just paste any YouTube link
- ⚡ **Tight sync** — playback stays within tens of milliseconds across viewers
- 👥 **Presence** — see who's in the room with you
- 📱 **Mobile-friendly** — responsive UI, picture-in-picture hint for listening on the go
- 🌗 **Automatic dark mode** — follows your system theme

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

## Deploying

The repo includes a [`render.yaml`](render.yaml) blueprint — one web service that builds both workspaces and serves the client's static build from Express. Set `YOUTUBE_API_KEY` in the dashboard (it's marked `sync: false` so it never lives in the repo).

## Project structure

```
sesh/
├── client/          # React + Vite frontend
│   └── src/
│       ├── Room.tsx     # player, sync engine, search UI
│       ├── Landing.tsx  # create/join screen
│       ├── youtube.ts   # IFrame API loader + typings
│       └── socket.ts    # Socket.IO client
├── server/          # Express + Socket.IO backend
│   └── src/
│       └── index.ts     # rooms, sync relay, search proxy
└── render.yaml      # Render deploy blueprint
```
