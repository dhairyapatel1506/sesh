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
- 🔍 **Built-in YouTube search** — search by title or just paste any YouTube link. Results are double-checked against YouTube before they're shown, so a video that can't play in an embedded player never appears as an option — including the ones YouTube itself mislabels, like age-restricted uploads and tracks locked to a handful of countries, which claim to be embeddable and then refuse on screen
- ⏭️ **Shared queue** — everyone sees the same "Up next" list; add videos from search (**+**) or a pasted link, auto-play when the current one ends, play-now or remove anytime
- ⚡ **Tight sync** — playback stays within a fraction of a second across viewers, and corrects itself without anyone hearing it happen
- 💬 **Room chat** — side-by-side with the video on desktop, stacked below on mobile; as ephemeral as the room itself (history lives only while someone's in the room)
  - Consecutive messages from the same person group together, like any chat app
  - "…is typing" indicators, live as people compose
  - Away in another tab? The tab title shows an unread count, the favicon gets a red dot, and a soft ping sounds (mutable via the 🔔 toggle)
  - Searchable emoji picker built in, plus `:shortcodes:` (`:fire:` → 🔥) — and emoji-only messages render big
- 👥 **Presence** — see who's in the room with you; names are first-come-first-served per room (no impersonating whoever's already there)
- 🔑 **Optional sign-in** — Sesh works with no account at all: open a link, type a name, you're in. Signing in with Google only adds a friends list, and carries your name into rooms so you stop typing it
- 🎙️ **Voice chat** — talk over the video, Discord-style: a row of everyone in the call, a green ring around whoever's speaking, mute and deafen (and mute any one person, just for you), and cues for joining, leaving and muting. Pick your microphone and speakers, set input and output levels, and let the video duck itself while someone's talking. Audio goes browser-to-browser and never touches the server. Best for a handful of people — every participant connects to every other, so it gets expensive past five or six. Some strict networks (symmetric NAT, corporate Wi-Fi) can't be connected without a relay server, which Sesh doesn't run; those show "couldn't reach someone" rather than failing silently
  - Tuned past WebRTC's defaults, which are built for a phone call on a bad line: 96 kbps fullband Opus with error correction on and discontinuous transmission off (it clips the starts of words), captured and encoded at 48 kHz so nothing is resampled on the way
  - If a microphone you picked earlier has since been unplugged or taken by another app, joining falls back to the system default rather than refusing. Echo cancellation, noise suppression and automatic gain are each a checkbox. All on by default, because most people are on speakers and the room is playing audio into the same microphone — but they're also why a good mic can sound like a phone, so on headphones you can switch them off
- 🫂 **Friends** — swap 6-character friend codes to connect. Your list shows who's around and who isn't — a coloured dot and a dimmed row, said once rather than spelled out beside itself — with **in a room** called out because that one's an invitation (one click joins them); from inside a sesh, one click invites anyone who's actually around. Presence is live (no polling) and only ever visible to settled friends — a pending request reveals nothing
- 💌 **Direct messages** — message a friend outside any room, from the same friends list. Unread counts, typing indicators, and a sound when something arrives while you're not looking. Conversations are kept for 30 days and then deleted — long enough to pick a thread back up, short enough that Sesh isn't an archive
- 📻 **Autoplay** — when the queue runs out, the room keeps going on its own instead of falling silent, using YouTube's own Mix radio for whatever just played. Room-wide (everyone's hearing the same thing), on by default, and it only ever engages on an empty queue after a video genuinely ends — so it never overrides anything anyone chose. Videos the room already played are skipped, so it doesn't circle
- ⏭️ **Up next, like YouTube's** — the next pick is decided while the current video is still playing and shown in the panel under it (the queue's head when there is one, the radio's pick when there isn't), clickable to skip straight to it — and because the answer is ready in advance, the handoff between videos is instant
- 🧭 **Recommendations that play in the room** — a "Recommended" list under the player, the same shape as the queue: play one now, or **+** it onto the end. Same source as YouTube's own (its mix for whatever is playing), already filtered to videos that really play embedded. It exists because the suggestions *inside* the player can't work — the embed is sandboxed, so clicking one of YouTube's does nothing, and no page can see a click inside someone else's iframe, let alone redirect it
- 🎬 **Our own end screen** — when a video ends without anything to follow it, the player shows Sesh's recommendations (YouTube's mix, pre-filtered to videos that actually play embedded) instead of YouTube's wall of tiles. One click plays it in the room, for everyone — or close it and the last frame is yours. YouTube's own recommendations still appear over the closing seconds of a video, as they do in any embed, but the sandbox means clicking one does nothing rather than taking you to youtube.com — there is no way for a page to see, let alone redirect, a click inside someone else's iframe
- 🛡️ **No accidental exits** — the embed is sandboxed, so nothing inside it can open youtube.com: not the title bar, not the channel link, not the paused "More videos" wall, not a creator's end-screen cards, not "Watch on YouTube". The browser refuses on Sesh's behalf, which means the video itself is left completely alone — click it to pause, double-click to seek, use YouTube's volume, captions, quality and settings exactly as you would anywhere else. Nothing of ours is drawn over the picture either: what's coming up lives in the panel under the player, where it doesn't compete with the film
- 🖥️ **Fullscreen with chat** — Sesh's own fullscreen button, in a row under the player where it can't clash with YouTube's own controls (and leaving fullscreen puts the page back where you were, not at the top), and a chat panel you can toggle over the video: same conversation as the room chat, plus an unread badge while it's closed. No more choosing between the video filling the screen and knowing what everyone's saying
- 🐞 **Report a bug** — from the web or the terminal, signed in or not. The web form takes a screenshot by file, paste or drag-and-drop, downscaled in the browser before it's sent. Rate-limited with a global ceiling, so an open endpoint stays an open endpoint — counted against your account where you have one, and only against your address when you don't, since one address is a household rather than a person. Reports are kept 90 days
- ⏱️ **Room uptime** — every room shows how long it's been going
- 🔇 **Tap for sound** — browsers only autoplay a muted video, so anyone who didn't press play themselves lands in the room silently. A one-tap prompt over the player turns the sound on (which also keeps the browser from suspending the tab in the background)
- 📱 **Mobile-friendly** — responsive UI, picture-in-picture hint for listening on the go
- 🌗 **Automatic dark mode** — follows your system theme
- 💻 **Terminal client** — join the same rooms from a terminal, audio-only: `npm install -g sesh-terminal` ([see below](#terminal-client))

## How the sync works

Keeping two YouTube players in audible sync is harder than it looks — `getCurrentTime()` lies, autoplay policies get in the way, and every device starts playback with different latency. Sesh layers several techniques to get drift down to imperceptible levels:

1. **Server-authoritative state.** The server holds each room's truth (`videoId`, playing/paused, position). Every playback message carries the moment it *happened* on the server's clock — sent by the client that did it, clamped by the server — rather than the moment its packet arrived, so one-way latency doesn't quietly bury itself in the room's anchor.

2. **NTP-style clock sync.** On connect, each client pings the server five times and uses the lowest-RTT sample to estimate its offset from the server clock. That makes server timestamps directly comparable to local time, so network latency can be extrapolated out of every sync message.

3. **Honest position measurement.** The IFrame API's `getCurrentTime()` is a cached value that only refreshes a few times per second (~250 ms stale). Sesh detects the moment the cached value last changed and extrapolates forward from it, turning a jittery reading into a precise one.

4. **Three-tier drift correction**, checked every 750 ms:
   - **< 300 ms** — leave it alone. The threshold sits above the noise floor of the measurement on a real connection, deliberately: correcting below it means reacting to jitter rather than to drift, which is audible as the video speeding up and slowing down for no reason
   - **300 ms – 1.2 s** — nudge playback rate ±25% (pitch-preserved) until the gap closes, so there's no audible skip. Once a nudge starts it runs until the gap is properly closed, rather than stopping the instant it re-enters tolerance and starting again a moment later
   - **> 1.2 s** — hard seek
   - **alone in the room** — no correction at all. There's nothing to be in sync with, so the only thing correction can do is fight what you just did

5. **Play-start latency learning.** Each tab measures how long its player takes between "play requested" and "actually playing" and keeps an exponential moving average, then leads its seeks by that amount so playback starts already aligned.

6. **Ready-barrier starts.** When the queue auto-advances, every tab silently pre-buffers the next video (played muted until proven buffered, then parked at 0) and reports ready; only when all tabs are ready — or a short timeout passes — does the server start everyone at the same instant. Without it, fast tabs would run ahead while slow ones buffer, then jump to catch up. A client that needs longer than the timeout (the terminal has to run yt-dlp before mpv can buffer a frame) says so while it works, and the barrier waits for it up to a ceiling.

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

The same key powers **autoplay**, which is far cheaper than search: a `search.list` call costs 100 of the 10,000 daily units, while reading a video's Mix playlist costs 1. (YouTube removed `search.list?relatedToVideoId` in 2023 — it answers 400 now — so the Mix is both the only route to real recommendations and the affordable one.) Without a key, search and autoplay are both simply absent.

### Accounts (optional)

Signing in is only needed for the friends list. Leave these unset and Sesh runs exactly as it always has — anonymous rooms, no sign-in button anywhere.

```bash
# server/.env
DATABASE_URL=postgresql://...        # any Postgres; Neon's free tier is plenty
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
SESSION_SECRET=...                   # openssl rand -hex 32
```

The Google client is an **OAuth client ID of type "Web application"** with your origins (e.g. `http://localhost:5173`) listed as authorized JavaScript origins and *no* redirect URIs — sign-in happens in the page, so nothing ever redirects. Only the default `email`/`profile`/`openid` scopes are used, which is why the consent screen needs no verification review.

The terminal signs in differently, because Google hands its credential to a *page*: `sesh login` prints a short code, you approve it at `/link` in a browser that's already signed in, and the terminal receives the same signed session the browser holds. Nothing else is needed to enable it.

Tables are created on boot: `server/migrations/*.sql` are applied in filename order, each in a transaction, tracked in a `_migrations` table. A database that's configured but unreachable stops the server rather than letting it serve a broken sign-in.

## Terminal client

The `cli/` workspace is a full Sesh client for the terminal — same rooms, same sync, no browser. It plays the audio track through [mpv](https://mpv.io) (which resolves YouTube streams via yt-dlp) and renders a TUI with chat, the shared queue, search, and live sync stats. A terminal user and browser users can share a room; neither side can tell the difference.

It's published as [`sesh-terminal`](https://www.npmjs.com/package/sesh-terminal) — no clone, no build:

```bash
npm install -g sesh-terminal

sesh                        # create a room
sesh <ROOM-CODE>            # join one
```

Needs [Node.js](https://nodejs.org) ≥ 20.12 and the playback engine below.

> **Note:** sesh runs on Windows (natively) and Linux. It won't play **under WSL** (whose audio relay is too unreliable) — running `sesh` there hands the session off to the Windows-native install, opening it in a new Windows Terminal tab. That needs the Windows install below to exist.

### Windows

mpv plays straight through WASAPI; mpv's IPC rides a named pipe instead of a unix socket, and the client handles both.

```powershell
# Playback engine — three pieces, all required (deno solves YouTube's throttling challenges):
winget install shinchiro.mpv yt-dlp.yt-dlp.nightly DenoLand.Deno

# Then, in a fresh terminal so PATH is current:
npm install -g sesh-terminal
```

### Linux

```bash
# Playback engine — three pieces, all required:
sudo apt install mpv
# apt's yt-dlp is perpetually stale and YouTube breaks old versions — install the latest directly:
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ~/.local/bin/yt-dlp && chmod +x ~/.local/bin/yt-dlp
# yt-dlp needs a JS runtime (deno) to solve YouTube's throttling challenges:
curl -fsSL https://deno.land/install.sh | sh

npm install -g sesh-terminal
```

### From source

For hacking on it — clone the repo, then:

```bash
npm install && npm run build --workspace cli
npm link --workspace cli    # puts your build's `sesh` on your PATH
```

Type to chat (`:shortcodes:` become emoji, `PgUp`/`PgDn` scrolls history, typing indicators included). **Type `/` and the commands appear as you go**, each with a one-line description, narrowing with every keystroke — `Tab` completes the best match. Arrow keys walk the whole list, not just the rows on screen — it scrolls under the selection. The same live suggestions work for emoji: type `:` and a couple of letters mid-message (`:hea`) and matching emoji appear, arrow keys to pick, `Tab`/`Enter` to insert. `/emoji` browses all 150 and `/emoji <query>` narrows them **as you type**, `Enter` drops the highlighted one onto your line, `Esc` closes. `/voice` says who's in the call and puts the room's link on your clipboard, since voice itself needs a browser. `/help` still lists everything, as a scrolling card you walk with `↑`/`↓` (or `PgUp`/`PgDn`) and close with `Esc` — as every pane's header says. `sesh --version` reports the installed version. `/copy` puts the invite link on your clipboard rather than making you select it — and it works over SSH, because the link is also sent as an OSC 52 escape sequence, which asks your terminal to do the copying instead of the machine sesh happens to be running on.

When a video won't play, the CLI now tells you *why* instead of guessing: it reads the actual error out of mpv's log (where yt-dlp's complaints end up) and says plainly whether the video is unavailable, age-restricted, blocked in your region, or just slow to arrive — retrying only the cases where retrying can help, and giving a video 30 seconds to start before calling it. "Update yt-dlp" advice appears only when the error genuinely is an extraction failure, the one case where it's true.

Sign in with `sesh login` (`sesh whoami`, `sesh logout`) and the terminal gets the account features too: `/friends` shows who's online and who's in a room, `/invite <n>` pulls one here, `/join <n>` and `/accept` move you into their room without restarting, and `/dms` / `/dm <n|name>` are direct messages, with `/room` (or Esc) going back to room chat. `/autoplay [on|off]` controls the room's radio, and `/bug <description>` files a report without leaving the terminal. Voice is read-only there — the roster shows in the presence line, but joining a call needs the browser. Without signing in the CLI behaves exactly as it always has.

The sync engine is a port of the web client's — server-authoritative state, NTP-style clock sync, three-tier drift correction, and ready-barrier starts — with one twist: mpv reports playback position precisely, so the CLI skips the web client's cached-`getCurrentTime()` workaround, holds itself to a much tighter tolerance than a browser tab can, and often ends up the tightest-synced client in the room.

## Deploying

The repo includes a [`render.yaml`](render.yaml) blueprint — one web service that builds both workspaces and serves the client's static build from Express. Set `YOUTUBE_API_KEY` in the dashboard (it's marked `sync: false` so it never lives in the repo).

Optionally set a `STATS_TOKEN` env var to enable `GET /api/stats?token=…` — live connected sockets, active rooms (users, uptime, what's playing), and page views since the last deploy. Without the env var the endpoint stays off.

The same token opens the bug-report inbox: **`/admin?token=…`** is a plain server-rendered page listing every report with its screenshot inline, and `GET /api/reports?token=…` is the same data as JSON. Gated because those screenshots are of whatever the reporter had on screen.

### Getting told about reports (optional)

Without this, reports land in the database and wait to be looked at. With it, each one is emailed as it arrives.

```bash
# server/.env (or the Render dashboard)
BREVO_API_KEY=xkeysib-...                # brevo.com — 300 emails/day free
REPORT_EMAIL_TO=you@example.com
REPORT_EMAIL_FROM=Sesh <bugs@yourdomain> # must be a sender (or on a domain) verified with Brevo
```

All three are required for mail to turn on — Brevo has no house fallback sender, so the from-address has to be one your Brevo account is allowed to send as: either an individual sender you've verified by email, or any address on a domain you've authenticated with DNS records.

Screenshots ride along as attachments, and each email links back to `/admin`. Mail is capped at five an hour: past that you get one note saying the rest are waiting rather than an inbox full of them. A failing mail provider is logged and ignored — the report is already stored, and the person who filed it has already been thanked.

### Every URL the server answers

The whole surface in one place. **Open** means anyone who can reach the site. **Signed in** means a valid session — the cookie in a browser, or the same signed token the terminal sends. **Token** means `?token=…` matching the `STATS_TOKEN` env var.

| URL | What it is | Who can use it |
|---|---|---|
| `GET /` (any page) | the web app itself — rooms, and `/link` where terminal sign-in is approved | open |
| `GET /api/health` | "is the server up" — `{ok:true}`, what uptime checks ping | open |
| `GET /api/search?q=…` | YouTube search behind the search box | open |
| `GET /api/related?videoId=…` | the end-screen recommendations — YouTube's mix for that video, filtered down to videos that actually play in an embedded player | open |
| `POST /api/report` | files a bug report (rate-limited, optional screenshot) | open |
| `GET /api/report/limits` | the report rules (min/max length, screenshot size cap) so clients can say no before the server has to | open |
| `GET /api/auth/config` | whether Google sign-in is set up, and its public client id | open |
| `POST /api/auth/google` | signs in with a Google credential, sets the session cookie | open |
| `POST /api/auth/logout` | signs out | open |
| `POST /api/auth/cli/start` → `approve` → `poll` | the terminal's sign-in dance: `start` mints the code the terminal shows, `approve` is what the `/link` page calls, `poll` hands the terminal its session | start/poll open; approve signed in |
| `GET /api/auth/me` | who the session belongs to | signed in |
| `GET /api/friends` | your friends, with online / in-a-room state | signed in |
| `POST /api/friends/request` / `accept` / `remove` | managing that list | signed in |
| `GET /api/dm/…` | your message history with one friend | signed in |
| `GET /api/stats?token=…` | live numbers — connected people, rooms, what's playing | token |
| `GET /admin?token=…` | the bug-report inbox as a readable page, screenshots inline | token |
| `GET /api/reports?token=…` | the same reports as raw JSON | token |
| `GET /api/reports/…/image?token=…` | one report's screenshot | token |

Everything else — playback sync, chat, the queue, presence, voice, autoplay — travels over the Socket.IO connection, not URLs.

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
│   └── src/         #   published to npm as `sesh-terminal`
│       ├── session.ts   # socket + sync engine port
│       ├── mpv.ts       # mpv JSON IPC wrapper
│       └── ui.tsx       # panes: now playing, queue, chat, search
└── render.yaml      # Render deploy blueprint
```

## License

[MIT](LICENSE)
