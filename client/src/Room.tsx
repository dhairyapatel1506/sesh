import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { API_BASE, socket } from "./socket";
import { extractVideoId, loadYouTubeApi, PlayerState, type YTPlayer } from "./youtube";
import "./App.css";

type RoomState = {
  videoId: string | null;
  isPlaying: boolean;
  time: number;
  // Server-clock ms of the moment `time` was accurate; lets us extrapolate
  // out the network latency this message spent in transit.
  at: number;
};

type User = { id: string; name: string };

type SearchResult = {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  duration: string;
};

type ChatMessage = {
  id: string;
  senderId: string;
  name: string;
  text: string;
  at: number;
};

const NAME_STORAGE_KEY = "sesh:name";
const CLIENT_ID_STORAGE_KEY = "sesh:clientId";

// Persists for this tab's lifetime so the server can recognize "the same
// person" across a reconnect (a dropped connection gets a new socket.id).
function getClientId(): string {
  let id = sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, id);
  }
  return id;
}

const CHAT_MUTE_STORAGE_KEY = "sesh:chatMuted";

// Consecutive messages from the same person within this window render as one
// group — name shown once, bubbles tucked together.
const CHAT_GROUP_WINDOW_MS = 5 * 60_000;

// A curated grid beats a full picker library: zero bundle weight, and the OS
// emoji keyboard covers everything else.
const EMOJI_CHOICES = [
  "😂", "🤣", "😊", "😍", "🥰", "😎", "🤔", "🙄",
  "😭", "😅", "🙃", "😮", "😴", "🥳", "😤", "🤯",
  "❤️", "🔥", "💀", "💯", "👍", "👎", "👏", "🙌",
  "🙏", "👀", "✨", "🎉", "🎶", "🍿", "🍕", "☕",
];

// A message that's nothing but a few emoji renders big and bubble-less.
// Emoji_Component alone (digits, skin tones, flag letters) doesn't count —
// at least one actual pictograph must be present.
function isEmojiOnly(text: string): boolean {
  const stripped = text.replace(/\s/g, "");
  // \u200d (zero-width joiner) and \ufe0f (variation selector) are the
  // invisible glue inside sequences like 👨‍👩‍👧 and ❤️.
  if (!/^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f]+$/u.test(stripped)) {
    return false;
  }
  const pictographs = [...stripped.matchAll(/\p{Extended_Pictographic}/gu)].length;
  return pictographs >= 1 && pictographs <= 4;
}

const BASE_TITLE = document.title;

// Favicon with a red dot, for unread chat while the tab's in the background.
// The badge is drawn once (favicon + overlaid dot on a canvas) and cached;
// badge-off restores the original file. The `on` flag is module state so the
// async image load can't apply a badge the UI has since turned off.
let faviconBadgeOn = false;
let faviconBadgeUrl: string | null = null;

function setFaviconBadge(on: boolean) {
  faviconBadgeOn = on;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (!on) {
    link.type = "image/svg+xml";
    link.href = "/favicon.svg";
    return;
  }
  if (faviconBadgeUrl) {
    link.type = "image/png";
    link.href = faviconBadgeUrl;
    return;
  }
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 1, 64, 61);
    ctx.beginPath();
    ctx.arc(49, 15, 14, 0, Math.PI * 2);
    ctx.fillStyle = "#ef4444";
    ctx.fill();
    faviconBadgeUrl = canvas.toDataURL("image/png");
    if (faviconBadgeOn) {
      link.type = "image/png";
      link.href = faviconBadgeUrl;
    }
  };
  img.src = "/favicon.svg";
}

// Drift correction tiers while both sides are "playing": below the
// tolerance nothing happens; up to the nudge ceiling we briefly run the
// player fast/slow (pitch-preserved, barely perceptible) to glide back into
// sync; beyond it a hard seek is less disruptive than a long nudge.
const DRIFT_TOLERANCE_SECONDS = 0.06;
const NUDGE_MAX_SECONDS = 1.2;
// A ±25% rate closes the gap at 0.25 video-seconds per real second.
const NUDGE_RATE_DELTA = 0.25;
// Authoritative pull from the server (also re-anchors after stalls)...
const RESYNC_INTERVAL_MS = 5000;
// ...but drift correction itself runs locally far more often, against the
// last known timestamped state extrapolated forward — no round trip needed.
const LOCAL_DRIFT_CHECK_MS = 750;

// YouTube IFrame API error codes: https://developers.google.com/youtube/iframe_api_reference#onError
function describeYouTubeError(code: number): string {
  switch (code) {
    case 2:
      return "That doesn't look like a valid YouTube video.";
    case 5:
      return "This video can't be played in an embedded player.";
    case 100:
      return "That video was removed or is private.";
    case 101:
    case 150:
      return "The video's owner has disabled playback on other sites.";
    default:
      return "That video can't be played.";
  }
}

function Room() {
  const { roomId = "" } = useParams();
  const clientIdRef = useRef(getClientId());

  const [connected, setConnected] = useState(socket.connected);
  const [urlInput, setUrlInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [nickname, setNickname] = useState(() => sessionStorage.getItem(NAME_STORAGE_KEY) ?? "");
  const [nameInput, setNameInput] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [linkCopied, setLinkCopied] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [unreadCount, setUnreadCount] = useState(0);
  const [chatMuted, setChatMuted] = useState(
    () => localStorage.getItem(CHAT_MUTE_STORAGE_KEY) === "1",
  );
  const [emojiOpen, setEmojiOpen] = useState(false);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  // Mirror for the socket handler, which is registered once and would
  // otherwise close over a stale value.
  const chatMutedRef = useRef(chatMuted);

  const playerRef = useRef<YTPlayer | null>(null);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingStateRef = useRef<RoomState | null>(null);

  // Latest authoritative playback state (from the server or our own emits),
  // used by the local drift-check loop between server resyncs.
  const lastStateRef = useRef<RoomState | null>(null);

  // Mirrors the videoId state for callbacks that outlive their closure
  // (the YT player's event handlers are registered once per player).
  const videoIdRef = useRef<string | null>(null);
  useEffect(() => {
    videoIdRef.current = videoId;
  }, [videoId]);

  // Set when this tab loads a video before its player exists; onReady then
  // starts playback directly instead of waiting for a server resync.
  const selfLoadRef = useRef<string | null>(null);

  // Applying a remote sync action fires a resulting onStateChange event on
  // this client's own player, which must not be re-broadcast (that would
  // create an echo). Suppress for a window rather than a single event, since
  // the resulting event can arrive as more than one state-change callback in
  // quick succession.
  const suppressUntilRef = useRef(false);
  const suppressTimerRef = useRef<number | undefined>(undefined);

  const applyRemote = (apply: () => void) => {
    suppressUntilRef.current = true;
    apply();
    window.clearTimeout(suppressTimerRef.current);
    suppressTimerRef.current = window.setTimeout(() => {
      suppressUntilRef.current = false;
    }, 1000);
  };

  // Once this tab has genuinely gotten permission to play audio, the browser
  // remembers that for the rest of the page's lifetime.
  const autoplayGrantedRef = useRef(false);

  // Estimated difference between the server's clock and ours (server - local),
  // measured NTP-style: of several ping samples, the one with the lowest
  // round-trip time carries the least asymmetry error, so it wins.
  const clockOffsetRef = useRef(0);
  const serverNow = () => Date.now() + clockOffsetRef.current;

  const syncClock = async () => {
    let best: { rtt: number; offset: number } | null = null;
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const serverTime = await new Promise<number>((resolve) =>
        socket.emit("clock:ping", (time: number) => resolve(time)),
      );
      const t1 = Date.now();
      const rtt = t1 - t0;
      const offset = serverTime + rtt / 2 - t1;
      if (!best || rtt < best.rtt) best = { rtt, offset };
      await new Promise((r) => setTimeout(r, 150));
    }
    if (best) clockOffsetRef.current = best.offset;
  };

  // Where the video should be *right now* according to a state snapshot.
  const targetTime = (state: RoomState) =>
    state.isPlaying ? state.time + Math.max(0, serverNow() - state.at) / 1000 : state.time;

  // How long this tab's player takes between playVideo() and actually
  // playing, learned from observation (exponential moving average). Seeks
  // that precede a play are led by this so playback starts on time instead
  // of that much behind.
  const playStartLagRef = useRef(0.35);
  const playRequestedAtRef = useRef<number | null>(null);

  // getCurrentTime() returns a cached value the iframe only pushes a few
  // times per second, so raw reads are up to ~250ms stale — worse than the
  // sync precision we're after. Note the instant the cached value last
  // changed and extrapolate forward from there instead.
  const positionSampleRef = useRef<{ value: number; at: number } | null>(null);
  const playbackRateRef = useRef(1);

  const estimatedPosition = () => {
    const player = playerRef.current;
    if (!player) return 0;
    const raw = player.getCurrentTime();
    const now = performance.now();
    const sample = positionSampleRef.current;
    if (!sample || raw !== sample.value) {
      positionSampleRef.current = { value: raw, at: now };
      return raw;
    }
    if (player.getPlayerState() !== PlayerState.PLAYING) return raw;
    return sample.value + ((now - sample.at) / 1000) * playbackRateRef.current;
  };

  // Gradual drift correction: run the player slightly fast or slow just long
  // enough to close the gap, instead of a visible/audible seek stutter.
  const rateNudgeTimerRef = useRef<number | undefined>(undefined);

  const setRate = (rate: number) => {
    playbackRateRef.current = rate;
    playerRef.current?.setPlaybackRate(rate);
  };

  const correctDrift = (target: number) => {
    const player = playerRef.current!;
    const drift = target - estimatedPosition(); // positive = we're behind
    const gap = Math.abs(drift);

    if (gap < DRIFT_TOLERANCE_SECONDS) {
      // In sync — make sure no stale nudge keeps running.
      window.clearTimeout(rateNudgeTimerRef.current);
      setRate(1);
      return;
    }
    if (gap > NUDGE_MAX_SECONDS) {
      window.clearTimeout(rateNudgeTimerRef.current);
      setRate(1);
      positionSampleRef.current = null;
      applyRemote(() => player.seekTo(target, true));
      return;
    }
    setRate(drift > 0 ? 1 + NUDGE_RATE_DELTA : 1 - NUDGE_RATE_DELTA);
    window.clearTimeout(rateNudgeTimerRef.current);
    rateNudgeTimerRef.current = window.setTimeout(() => setRate(1), (gap / NUDGE_RATE_DELTA) * 1000);
  };

  // Seeks/plays/pauses the player to match an authoritative state snapshot.
  // Only takes action if the player actually disagrees with that state.
  const syncPlayerToState = (state: RoomState) => {
    if (!playerRef.current) return;
    const currentState = playerRef.current.getPlayerState();
    const alreadyPlaying = currentState === PlayerState.PLAYING;
    const alreadyPaused = currentState === PlayerState.PAUSED;
    const target = targetTime(state);

    // The player is on a different video than this state describes — this
    // tab missed a video:load (e.g. a brief disconnect while someone else
    // loaded a new video). Switch to the right video at the right position
    // before any play/pause/drift logic; everything below assumes the
    // player and the state agree on which video they're talking about.
    if (state.videoId && state.videoId !== videoIdRef.current) {
      applyRemote(() => {
        positionSampleRef.current = null;
        if (state.isPlaying) {
          playerRef.current!.loadVideoById(state.videoId!, target + playStartLagRef.current);
          if (!autoplayGrantedRef.current) {
            playerRef.current!.mute();
          }
          playRequestedAtRef.current = performance.now();
        } else {
          playerRef.current!.cueVideoById(state.videoId!, target);
        }
      });
      setVideoId(state.videoId);
      return;
    }

    // A finished video is a settled position, not something to "resume":
    // if the room state points at/past the end too, leave the player alone —
    // seekTo/playVideo on an ENDED player restarts it from 0, which turns a
    // stale "still playing" room state into an endless replay loop. If the
    // server does still think it's playing (its video:ended never arrived,
    // e.g. every tab was hidden when the video finished), correct it here.
    if (currentState === PlayerState.ENDED) {
      const duration = playerRef.current.getDuration();
      if (duration > 0 && target >= duration - 1) {
        if (state.isPlaying) socket.emit("video:ended", { time: duration });
        return;
      }
    }

    if (state.isPlaying && alreadyPlaying) {
      correctDrift(target);
      return;
    }
    if (!state.isPlaying && alreadyPaused) return;

    const neverPlayed =
      currentState === PlayerState.UNSTARTED || currentState === PlayerState.CUED;

    applyRemote(() => {
      positionSampleRef.current = null; // position is about to jump
      if (!state.isPlaying && neverPlayed && state.videoId) {
        // A video that's never actually played can render as a black frame
        // if paused via a raw seek — it hasn't buffered that position and,
        // being paused, won't fetch it on its own. cueVideoById is built for
        // "show a frame at this position, don't play yet" and buffers it.
        playerRef.current!.cueVideoById(state.videoId, target);
        return;
      }

      if (state.isPlaying) {
        // Lead the seek by this tab's expected play-start delay, so playback
        // begins on time rather than that far behind everyone else.
        playerRef.current!.seekTo(target + playStartLagRef.current, true);
        if (!autoplayGrantedRef.current) {
          // Browsers block unmuted autoplay without a user gesture; start
          // muted and let the user unmute via the player's own volume control.
          playerRef.current!.mute();
        }
        playRequestedAtRef.current = performance.now();
        playerRef.current!.playVideo();
      } else {
        playerRef.current!.seekTo(target, true);
        playerRef.current!.pauseVideo();
      }
    });
  };

  // Join the room once a nickname is known, and rejoin on every (re)connect —
  // a fresh socket id after a reconnect has no room membership on the server.
  useEffect(() => {
    if (!nickname || !roomId) return;
    const join = () => {
      socket.emit("room:join", { roomId, name: nickname, clientId: clientIdRef.current });
      // Refresh the clock offset on every (re)connect — latency conditions
      // change, and a fresh socket may be on a different network path.
      void syncClock();
    };
    join();
    socket.on("connect", join);

    // Periodically pull the authoritative state so playback keeps converging
    // even while nothing new happens (no play/pause/tab-refocus to trigger
    // a one-off resync).
    const interval = window.setInterval(() => socket.emit("resync:request"), RESYNC_INTERVAL_MS);

    return () => {
      socket.off("connect", join);
      window.clearInterval(interval);
    };
  }, [nickname, roomId]);

  // Track connection status.
  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, []);

  // Create the player the first time a videoId becomes known, either from
  // this client loading a link or from the server's initial room state.
  useEffect(() => {
    if (!videoId || playerRef.current) return;
    let cancelled = false;

    loadYouTubeApi().then((YT) => {
      if (cancelled || !playerContainerRef.current) return;
      // The YouTube API replaces whatever element it's given with its own
      // <iframe>, entirely outside React's knowledge. Handing it a plain
      // child element (rather than our React-managed wrapper) keeps that
      // swap isolated in a subtree React never diffs into — otherwise, the
      // next time React needs to reposition a sibling near the wrapper, it
      // does so relative to a DOM node YouTube already ripped out, which
      // throws (and, with no error boundary, unmounts the whole app).
      const target = document.createElement("div");
      playerContainerRef.current.appendChild(target);
      playerRef.current = new YT.Player(target, {
        videoId,
        width: "640",
        height: "390",
        events: {
          onReady: () => {
            // The YouTube API sets width/height as HTML attributes, and in
            // some cascades that beats our CSS. Sizing the real iframe node
            // directly, once it exists, sidesteps any selector/specificity
            // mismatch entirely.
            const iframe = playerRef.current?.getIframe();
            if (iframe) {
              iframe.style.display = "block";
              iframe.style.width = "100%";
              iframe.style.height = "auto";
              iframe.style.aspectRatio = "16 / 9";
            }
            if (selfLoadRef.current === videoId) {
              // This tab loaded the video itself before a player existed.
              // Play straight from the top — no seek, so audio starts in
              // step with the video — and deliberately unsuppressed: the
              // resulting PLAYING event re-anchors the room clock to when
              // playback really began.
              selfLoadRef.current = null;
              playerRef.current?.playVideo();
              return;
            }
            const pending = pendingStateRef.current;
            if (!pending || pending.videoId !== videoId) return;
            syncPlayerToState(pending);
          },
          onError: (event) => {
            setPlayerError(describeYouTubeError(event.data));
          },
          onStateChange: (event) => {
            if (!playerRef.current) return;
            // A finished video must be reported, or the server keeps
            // extrapolating "playing" time past the end forever and every
            // resync tries to resume — which restarts an ended video from 0.
            // No hidden/suppress guards here: ending isn't a user action, it
            // happens on every client at once, and reporting it is idempotent.
            if (event.data === PlayerState.ENDED) {
              if ("mediaSession" in navigator) {
                navigator.mediaSession.playbackState = "paused";
              }
              socket.emit("video:ended", { time: playerRef.current.getDuration() });
              return;
            }
            if (event.data !== PlayerState.PLAYING && event.data !== PlayerState.PAUSED) {
              return;
            }
            // Learn how long a requested play actually took to start, to lead
            // the next one's seek by that much.
            if (event.data === PlayerState.PLAYING && playRequestedAtRef.current !== null) {
              const lag = (performance.now() - playRequestedAtRef.current) / 1000;
              playRequestedAtRef.current = null;
              if (lag < 3) {
                playStartLagRef.current = playStartLagRef.current * 0.6 + lag * 0.4;
              }
            }
            // Reaching PLAYING/PAUSED proves the video is actually working.
            setPlayerError(null);
            if ("mediaSession" in navigator) {
              navigator.mediaSession.playbackState =
                event.data === PlayerState.PLAYING ? "playing" : "paused";
            }
            // A hidden tab can't have received a real click.
            if (document.hidden) return;
            if (suppressUntilRef.current) return;
            const time = playerRef.current.getCurrentTime();
            socket.emit(event.data === PlayerState.PLAYING ? "video:play" : "video:pause", {
              time,
            });
            // Our own action is as authoritative as anything the server
            // sends — anchor the local drift-check to it immediately.
            lastStateRef.current = {
              videoId: videoIdRef.current,
              isPlaying: event.data === PlayerState.PLAYING,
              time,
              at: serverNow(),
            };
          },
        },
      });
    });

    return () => {
      cancelled = true;
    };
  }, [videoId]);

  // Listen for room state / remote playback / user-list events.
  useEffect(() => {
    const onRoomState = (state: RoomState) => {
      pendingStateRef.current = state;
      lastStateRef.current = state;
      if (!state.videoId) return;
      if (playerRef.current) {
        // Handles a videoId mismatch itself (switches the player over), so
        // the periodic resync self-heals a tab that diverged onto the wrong
        // video — previously only React state was updated, which an
        // already-created player never picks up.
        syncPlayerToState(state);
      } else if (state.videoId !== videoId) {
        setVideoId(state.videoId);
      }
    };

    const onVideoLoad = ({ videoId: id }: { videoId: string }) => {
      const state: RoomState = { videoId: id, isPlaying: false, time: 0, at: serverNow() };
      pendingStateRef.current = state;
      lastStateRef.current = state;
      setPlayerError(null);
      if (playerRef.current) {
        applyRemote(() => playerRef.current!.cueVideoById(id));
      }
      setVideoId(id);
    };

    // The server tells us which video the event is about; trusting it over
    // our local state means a play on a video we never received still plays
    // the right thing. (Fallback to local state tolerates an older server.)
    const onVideoPlay = ({ time, at, videoId: id }: { time: number; at: number; videoId?: string | null }) => {
      const eventVideoId = id ?? videoId;
      if (!eventVideoId) return;
      const state: RoomState = { videoId: eventVideoId, isPlaying: true, time, at };
      lastStateRef.current = state;
      syncPlayerToState(state);
    };

    const onVideoPause = ({ time, at, videoId: id }: { time: number; at: number; videoId?: string | null }) => {
      const eventVideoId = id ?? videoId;
      if (!eventVideoId) return;
      const state: RoomState = { videoId: eventVideoId, isPlaying: false, time, at };
      lastStateRef.current = state;
      syncPlayerToState(state);
    };

    const onUsers = (list: User[]) => setUsers(list);

    socket.on("room:state", onRoomState);
    socket.on("video:load", onVideoLoad);
    socket.on("video:play", onVideoPlay);
    socket.on("video:pause", onVideoPause);
    socket.on("room:users", onUsers);

    return () => {
      socket.off("room:state", onRoomState);
      socket.off("video:load", onVideoLoad);
      socket.off("video:play", onVideoPlay);
      socket.off("video:pause", onVideoPause);
      socket.off("room:users", onUsers);
    };
  }, [videoId]);

  // The tight sync loop: check drift against the extrapolated authoritative
  // state every LOCAL_DRIFT_CHECK_MS, entirely locally. The server resync
  // stays as the slower authoritative pull; this is what keeps the gap
  // inaudible in between. The faster sampler exists only to catch the
  // moments the player's cached currentTime updates, which is what makes
  // estimatedPosition() accurate.
  useEffect(() => {
    if (!videoId) return;
    const sampler = window.setInterval(() => estimatedPosition(), 100);
    const interval = window.setInterval(() => {
      const state = lastStateRef.current;
      if (!state || !state.isPlaying || state.videoId !== videoId) return;
      if (suppressUntilRef.current) return;
      if (playerRef.current?.getPlayerState() !== PlayerState.PLAYING) return;
      correctDrift(targetTime(state));
    }, LOCAL_DRIFT_CHECK_MS);
    return () => {
      window.clearInterval(sampler);
      window.clearInterval(interval);
    };
  }, [videoId]);

  // Live sync diagnostics, rendered when the URL has ?debug — compare these
  // side by side in two tabs instead of guessing by ear.
  const debugMode = useRef(new URLSearchParams(window.location.search).has("debug")).current;
  const [debugInfo, setDebugInfo] = useState("");
  useEffect(() => {
    if (!debugMode || !videoId) return;
    const interval = window.setInterval(() => {
      const state = lastStateRef.current;
      const drift =
        state?.isPlaying && playerRef.current ? targetTime(state) - estimatedPosition() : 0;
      setDebugInfo(
        [
          `drift ${(drift * 1000).toFixed(0)}ms`,
          `clock offset ${clockOffsetRef.current.toFixed(0)}ms`,
          `start lag ${(playStartLagRef.current * 1000).toFixed(0)}ms`,
          `rate ${playbackRateRef.current}`,
        ].join(" · "),
      );
    }, 250);
    return () => window.clearInterval(interval);
  }, [debugMode, videoId]);

  // A short synthesized two-tone ping — no audio file to ship, and the Web
  // Audio API is precise enough that it sounds intentional rather than harsh.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playChatPing = () => {
    try {
      const ctx = (audioCtxRef.current ??= new AudioContext());
      if (ctx.state === "suspended") void ctx.resume();
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.setValueAtTime(1174.66, t + 0.09); // A5 → D6
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    } catch {
      // No audio available (or blocked) — the tab-title badge still shows.
    }
  };

  // Browsers keep an AudioContext suspended until a user gesture, and the
  // ping fires while the tab is unfocused — so grab the first gesture to
  // unlock audio ahead of time.
  useEffect(() => {
    const warm = () => {
      try {
        const ctx = (audioCtxRef.current ??= new AudioContext());
        if (ctx.state === "suspended") void ctx.resume();
      } catch {
        // Same fallback as above.
      }
    };
    window.addEventListener("pointerdown", warm, { once: true });
    return () => window.removeEventListener("pointerdown", warm);
  }, []);

  // Chat: history replaces (it re-arrives on every rejoin, catching up on
  // anything missed while disconnected), live messages append. History is
  // silent on purpose — a reconnect replay isn't news.
  useEffect(() => {
    const onHistory = (history: ChatMessage[]) => setMessages(history);
    const onMessage = (message: ChatMessage) => {
      setMessages((prev) => [...prev.slice(-99), message]);
      // Someone else's message while this tab isn't the one being looked at
      // (other tab, other window): count it and ping.
      if (message.senderId === clientIdRef.current || document.hasFocus()) return;
      setUnreadCount((n) => n + 1);
      if (!chatMutedRef.current) playChatPing();
    };
    socket.on("chat:history", onHistory);
    socket.on("chat:message", onMessage);
    return () => {
      socket.off("chat:history", onHistory);
      socket.off("chat:message", onMessage);
    };
  }, []);

  // Coming back to the tab clears the unread state.
  useEffect(() => {
    const clear = () => setUnreadCount(0);
    window.addEventListener("focus", clear);
    return () => window.removeEventListener("focus", clear);
  }, []);

  // Surface unread messages on the tab itself: a count in the title and a
  // red dot on the favicon.
  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) ${BASE_TITLE}` : BASE_TITLE;
    setFaviconBadge(unreadCount > 0);
    return () => {
      document.title = BASE_TITLE;
      setFaviconBadge(false);
    };
  }, [unreadCount]);

  const toggleChatMuted = () => {
    setChatMuted((muted) => {
      const next = !muted;
      chatMutedRef.current = next;
      localStorage.setItem(CHAT_MUTE_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  };

  // Keep the newest message in view.
  const chatListRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = chatListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text) return;
    socket.emit("chat:message", { text });
    setChatInput("");
    setEmojiOpen(false);
  };

  // A backgrounded tab may get its video silently paused by the browser;
  // catch back up to the authoritative room state when it becomes visible.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        socket.emit("resync:request");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // Unmuting happens through the player's own volume control, which we get
  // no event for — poll so we notice it and stop defensively muting future
  // remote syncs on this tab (audible playback proves autoplay is allowed).
  useEffect(() => {
    if (!videoId) return;
    const interval = window.setInterval(() => {
      const player = playerRef.current;
      if (!player) return;
      if (!player.isMuted() && player.getPlayerState() === PlayerState.PLAYING) {
        autoplayGrantedRef.current = true;
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [videoId]);

  // Fetch the video's title (no API key needed) for lock-screen / notification
  // media controls.
  const [videoTitle, setVideoTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!videoId) return;
    setVideoTitle(null);
    let cancelled = false;
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.title) setVideoTitle(data.title);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  // Registering a Media Session (metadata + play/pause handlers) is what
  // convinces mobile Chrome to treat this tab as actively playing media and
  // keep the audio running once the app is minimized, instead of suspending
  // it like a silent background tab.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !videoId) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: videoTitle ?? "Sesh",
      artist: `Room ${roomId}`,
      artwork: [
        { src: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, sizes: "480x360", type: "image/jpeg" },
      ],
    });
    navigator.mediaSession.setActionHandler("play", () => playerRef.current?.playVideo());
    navigator.mediaSession.setActionHandler("pause", () => playerRef.current?.pauseVideo());
    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
    };
  }, [videoId, videoTitle, roomId]);

  const loadVideo = (id: string) => {
    setLoadError(null);
    setPlayerError(null);
    setSearchResults(null);
    setUrlInput("");
    socket.emit("video:load", { videoId: id });
    // This is a real click, so the browser allows unmuted playback here —
    // no need to defensively mute future remote syncs on this tab.
    autoplayGrantedRef.current = true;
    if (playerRef.current) {
      playerRef.current.loadVideoById(id);
    } else {
      // First video in this tab — the player doesn't exist yet. Have onReady
      // start it immediately rather than waiting on the next server resync
      // (which would also seek into an unbuffered spot, where YouTube shows
      // video ahead of the audio catching up).
      selfLoadRef.current = id;
    }
    setVideoId(id);
  };

  // One input serves both cases: a pasted YouTube link loads directly,
  // anything else is treated as a search query.
  const handleSubmit = async () => {
    const input = urlInput.trim();
    if (!input || searching) return;

    const id = extractVideoId(input);
    if (id) {
      loadVideo(id);
      return;
    }

    setSearching(true);
    setLoadError(null);
    try {
      const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(input)}`);
      const data: { results?: SearchResult[]; error?: string } = await res.json();
      if (!res.ok || !data.results) {
        setSearchResults(null);
        setLoadError(data.error ?? "Search failed — try again in a moment.");
        return;
      }
      if (data.results.length === 0) {
        setSearchResults(null);
        setLoadError("No videos found for that search.");
        return;
      }
      setSearchResults(data.results);
    } catch {
      setSearchResults(null);
      setLoadError("Search failed — check your connection.");
    } finally {
      setSearching(false);
    }
  };

  const submitName = () => {
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    sessionStorage.setItem(NAME_STORAGE_KEY, trimmed);
    setNickname(trimmed);
  };

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1500);
    });
  };

  if (!nickname) {
    return (
      <div className="app">
        <header>
          <h1>Sesh</h1>
        </header>
        <div className="name-gate">
          <p>Enter a name to join room {roomId}:</p>
          <div className="load-bar">
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Your name"
              onKeyDown={(e) => e.key === "Enter" && submitName()}
              autoFocus
            />
            <button onClick={submitName}>Join</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app room">
      <header>
        <h1>Sesh</h1>
        <span className="room-code">{roomId}</span>
        <span className={connected ? "ok" : "bad"}>
          {connected ? "connected" : "reconnecting…"}
        </span>
      </header>

      <div className="room-toolbar">
        <div className="user-list">
          {users.map((u) => (
            <span key={u.id} className="user-chip">
              {u.name}
            </span>
          ))}
        </div>
        <button className="copy-link" onClick={copyLink}>
          {linkCopied ? "Copied!" : "Copy invite link"}
        </button>
      </div>

      <div className="load-bar">
        <input
          value={urlInput}
          onChange={(e) => {
            setUrlInput(e.target.value);
            if (loadError) setLoadError(null);
          }}
          placeholder="Search YouTube or paste a link..."
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") setSearchResults(null);
          }}
        />
        <button onClick={handleSubmit} disabled={searching}>
          {searching ? "Searching..." : extractVideoId(urlInput) ? "Load" : "Search"}
        </button>
      </div>
      {loadError && <p className="load-error">{loadError}</p>}

      {searchResults && (
        <ul className="search-results">
          {searchResults.map((result) => (
            <li key={result.videoId}>
              <button className="search-result" onClick={() => loadVideo(result.videoId)}>
                <img src={result.thumbnail} alt="" loading="lazy" />
                <span className="search-result-info">
                  <span className="search-result-title">{result.title}</span>
                  <span className="search-result-meta">
                    {result.channel}
                    {result.duration && ` · ${result.duration}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="room-main">
        <div className="room-video">
          {videoId ? (
            <>
              <div id="yt-player" ref={playerContainerRef} />
              {playerError && (
                <p className="load-error">{playerError} Try pasting a different link.</p>
              )}
              <p className="pip-hint">
                Tip: go fullscreen, then press home — the video pops out and keeps playing while
                you use other apps.
              </p>
              {debugMode && <p className="debug-hud">{debugInfo}</p>}
            </>
          ) : (
            <p className="empty-state">Paste a YouTube link above to start a sesh.</p>
          )}
        </div>

        <div className="room-chat">
          <div className="chat">
            <div className="chat-head">
              <span>Chat</span>
              <button
                className="chat-mute"
                onClick={toggleChatMuted}
                title={chatMuted ? "Unmute message sound" : "Mute message sound"}
                aria-label={chatMuted ? "Unmute message sound" : "Mute message sound"}
              >
                {chatMuted ? "🔕" : "🔔"}
              </button>
            </div>
            <div className="chat-messages" ref={chatListRef}>
              {messages.length === 0 ? (
                <p className="chat-empty">No messages yet — say hi 👋</p>
              ) : (
                messages.map((m, i) => {
                  const own = m.senderId === clientIdRef.current;
                  // Same sender, close in time → visually one continuous
                  // group: name once, bubbles tucked together.
                  const prev = messages[i - 1];
                  const grouped =
                    prev !== undefined &&
                    prev.senderId === m.senderId &&
                    m.at - prev.at < CHAT_GROUP_WINDOW_MS;
                  const classes = ["chat-msg", own && "own", grouped && "grouped"]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <div key={m.id} className={classes}>
                      {!own && !grouped && <span className="chat-name">{m.name}</span>}
                      <span
                        className={isEmojiOnly(m.text) ? "chat-bubble emoji-only" : "chat-bubble"}
                        title={new Date(m.at).toLocaleTimeString()}
                      >
                        {m.text}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
            <div className="chat-bar-wrap">
              {emojiOpen && (
                <div className="emoji-panel">
                  {EMOJI_CHOICES.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => {
                        setChatInput((v) => v + emoji);
                        chatInputRef.current?.focus();
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
              <div className="load-bar chat-bar">
                <button
                  className="emoji-toggle"
                  onClick={() => setEmojiOpen((open) => !open)}
                  aria-label="Emoji picker"
                >
                  😊
                </button>
                <input
                  ref={chatInputRef}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Send a message..."
                  maxLength={500}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") sendChat();
                    if (e.key === "Escape") setEmojiOpen(false);
                  }}
                />
                <button onClick={sendChat}>Send</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Room;
