# sesh-terminal

**Watch YouTube with your friends, perfectly in sync — from your terminal.**

The terminal client for [Sesh](https://sesh.dhairya.cloud). Same rooms as the web app, audio only: a browser user and a terminal user can share a room and neither side can tell the difference.

```bash
npm install -g sesh-terminal

sesh                 # create a room
sesh F3K9QX          # join one
```

## What you get

A TUI with the now-playing track, the shared queue, room chat, YouTube search, and live sync stats. Audio plays through [mpv](https://mpv.io), which resolves streams via yt-dlp.

Type to chat — `:shortcodes:` become emoji, `PgUp`/`PgDn` scrolls history, and typing indicators work across both clients. `/help` lists the rest: `/search`, `/pick`, `/queue`, `/play`, `/pause`, `/seek`, `/skip`, `/vol`, `/emoji`.

## Signing in

Google hands its credential to a *page*, so the terminal borrows a browser for one step:

```bash
sesh login     # prints a code — approve it at /link in a signed-in browser
sesh whoami
sesh logout
```

The session is stored in `~/.config/sesh/auth.json` (`%APPDATA%\sesh\auth.json` on Windows), owner-readable only. Signed in, your account name is your name in every room, and these work:

| Command | |
|---|---|
| `/friends` | who's in a room, who's online, who's offline · your friend code |
| `/friends add <CODE>` · `accept <n>` · `remove <n>` | manage the list |
| `/invite <n>` | ask a friend to come to this room (only if they're online and not already here) |
| `/join <n>` · `/accept` | go to a friend's room, or take an invite — no restart |
| `/dms` · `/dm <n\|name>` | conversations and direct messages · `/room` (or Esc) goes back |

Direct messages are friends-only and deleted after 30 days. Voice chat is read-only here: the presence line shows who's in the call, but joining one needs the web client. None of this is required — without an account the CLI works exactly as before.

## Requirements

Node.js ≥ 20.12, plus the playback engine — **all three pieces are required** (deno is what solves YouTube's throttling challenges):

**Windows**

```powershell
winget install shinchiro.mpv yt-dlp.yt-dlp.nightly DenoLand.Deno
```

**Linux**

```bash
sudo apt install mpv
# apt's yt-dlp is perpetually stale and YouTube breaks old versions — install the latest directly:
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ~/.local/bin/yt-dlp && chmod +x ~/.local/bin/yt-dlp
curl -fsSL https://deno.land/install.sh | sh
```

> **WSL:** playback doesn't work there — WSL's audio relay is too unreliable to sync against. Running `sesh` inside WSL hands the session off to a Windows-native install and opens it in a new Windows Terminal tab, so install the Windows requirements above.

## Options

```
sesh <ROOM-CODE> [--name <you>] [--server <url>]
sesh login | logout | whoami
```

Names are first-come-first-served within a room. Signed in, your account name is used unless `--name` says otherwise; signed out, you're asked each run and nothing is stored anywhere.

## How the sync works

The sync engine is a port of the web client's: server-authoritative state, NTP-style clock sync, three-tier drift correction, and ready-barrier starts for queue advances. One twist — mpv reports playback position precisely, where a browser's `getCurrentTime()` is a stale cached value, so the terminal client is often the tightest-synced client in the room.

Full write-up and source: [github.com/dhairyapatel1506/sesh](https://github.com/dhairyapatel1506/sesh)

## License

MIT
