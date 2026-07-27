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

Type to chat — `:shortcodes:` become emoji, `PgUp`/`PgDn` scrolls history, and typing indicators work across both clients.

**You don't have to learn the commands.** Type `/` and the matching ones appear above the prompt with what they do, narrowing as you keep typing; `Tab` completes the highlighted one. `/help` opens the full card as a scrolling window — `↑`/`↓` a row, `PgUp`/`PgDn` a screenful, `Esc` closes it. Every pane says `Esc closes` in its own header.

| Command | |
|---|---|
| `/search <query>` · `/pick <n>` · `/queue <n>` | find something and play or queue it |
| `/add <url>` | queue a YouTube link (plays it if the room is idle) |
| `/play` · `/pause` · `/seek <mm:ss>` · `/skip` · `/remove <n>` | control playback for everyone |
| `/autoplay [on\|off]` | the room's radio — see below |
| `/vol <0-130>` | your own volume, nobody else's |
| `/emoji [query]` | browse emoji and their `:names:` |
| `/copy [code]` | put the invite link on your clipboard (`/copy code` for just the room code) |
| `/bug <description>` | report something broken without leaving the terminal |

### Autoplay

When a video ends and the queue is empty, the room keeps going on YouTube's Mix radio for whatever just played — the same recommendations the site itself would give, minus anything the room already heard. It's **on by default** and **room-wide**: everyone hears the same thing, so it's one setting, not one per person.

`/autoplay` says which way it's set, `/autoplay on|off` changes it for the room. The state sits under the now-playing track, along with "finding something to play next…" while a pick is in flight. On a server with no YouTube API key there's nothing to toggle, and the line is hidden rather than lying.

### Bug reports

### Sharing the room

`/copy` puts the invite link straight on your clipboard — no selecting text and guessing whether this terminal wants `Ctrl+C` or `Ctrl+Shift+C`. `/copy code` copies the six-character code alone.

It works over SSH, which the obvious approach doesn't: shelling out to `pbcopy`/`clip.exe` would set the clipboard of whatever machine sesh is *running* on. So the link is also sent as an OSC 52 escape sequence, which asks your **terminal** to do the copying and therefore travels back to the computer you're sitting at (tmux and screen are wrapped for passthrough). A few terminals ignore OSC 52 and nothing acknowledges it either way, so the link is always printed alongside — and the one in the footer is an OSC 8 hyperlink, clickable to open wherever that's supported.

### Reporting a bug

`/bug the queue lost its order after a skip` files it against the room you're in. It works signed in or not, and whatever the server says back — including "you've filed three this hour" — is shown as it was written. Reports are kept 90 days.

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

These are the only commands that need an account, and the suggestion list marks them `(sign in)` while you're signed out — or `(off here)` on a server that doesn't do accounts at all — so you find out before running one rather than after.

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
