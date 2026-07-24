# sesh-cli

**Watch YouTube with your friends, perfectly in sync — from your terminal.**

The terminal client for [Sesh](https://sesh.dhairya.cloud). Same rooms as the web app, audio only: a browser user and a terminal user can share a room and neither side can tell the difference.

```bash
npm install -g sesh-cli

sesh                 # create a room
sesh F3K9QX          # join one
```

## What you get

A TUI with the now-playing track, the shared queue, room chat, YouTube search, and live sync stats. Audio plays through [mpv](https://mpv.io), which resolves streams via yt-dlp.

Type to chat — `:shortcodes:` become emoji, `PgUp`/`PgDn` scrolls history, and typing indicators work across both clients. `/help` lists the rest: `/search`, `/pick`, `/queue`, `/play`, `/pause`, `/seek`, `/skip`, `/vol`, `/emoji`.

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
```

Names are picked fresh each run and are first-come-first-served within a room — nothing is stored anywhere.

## How the sync works

The sync engine is a port of the web client's: server-authoritative state, NTP-style clock sync, three-tier drift correction, and ready-barrier starts for queue advances. One twist — mpv reports playback position precisely, where a browser's `getCurrentTime()` is a stale cached value, so the terminal client is often the tightest-synced client in the room.

Full write-up and source: [github.com/dhairyapatel1506/sesh](https://github.com/dhairyapatel1506/sesh)

## License

MIT
