import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { API_BASE, socket } from "./socket";
import { extractVideoId, loadYouTubeApi, PlayerState, type YTPlayer } from "./youtube";
import "./App.css";

type RoomState = {
  videoId: string | null;
  isPlaying: boolean;
  time: number;
};

type User = { id: string; name: string };

type SearchResult = {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  duration: string;
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

// While two players are both "playing", the periodic resync below only
// nudges the video if it's drifted more than this — small gaps aren't
// worth interrupting playback over.
const DRIFT_THRESHOLD_SECONDS = 1.5;
const RESYNC_INTERVAL_MS = 5000;

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

  const playerRef = useRef<YTPlayer | null>(null);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingStateRef = useRef<RoomState | null>(null);

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

  // Seeks/plays/pauses the player to match an authoritative state snapshot.
  // Only takes action if the player actually disagrees with that state.
  const syncPlayerToState = (state: RoomState) => {
    if (!playerRef.current) return;
    const currentState = playerRef.current.getPlayerState();
    const alreadyPlaying = currentState === PlayerState.PLAYING;
    const alreadyPaused = currentState === PlayerState.PAUSED;

    // A finished video is a settled position, not something to "resume":
    // if the room state points at/past the end too, leave the player alone —
    // seekTo/playVideo on an ENDED player restarts it from 0, which turns a
    // stale "still playing" room state into an endless replay loop. If the
    // server does still think it's playing (its video:ended never arrived,
    // e.g. every tab was hidden when the video finished), correct it here.
    if (currentState === PlayerState.ENDED) {
      const duration = playerRef.current.getDuration();
      if (duration > 0 && state.time >= duration - 1) {
        if (state.isPlaying) socket.emit("video:ended", { time: duration });
        return;
      }
    }

    if (state.isPlaying && alreadyPlaying) {
      // Both sides agree it's playing, but positions can still drift apart
      // over time (e.g. one tab's clock running slightly fast). Correct
      // with a plain seek — no mute/pause cycle, since playback is already
      // running correctly and doesn't need to be restarted.
      const drift = Math.abs(playerRef.current.getCurrentTime() - state.time);
      if (drift > DRIFT_THRESHOLD_SECONDS) {
        applyRemote(() => playerRef.current!.seekTo(state.time, true));
      }
      return;
    }
    if (!state.isPlaying && alreadyPaused) return;

    const neverPlayed =
      currentState === PlayerState.UNSTARTED || currentState === PlayerState.CUED;

    applyRemote(() => {
      if (!state.isPlaying && neverPlayed && state.videoId) {
        // A video that's never actually played can render as a black frame
        // if paused via a raw seek — it hasn't buffered that position and,
        // being paused, won't fetch it on its own. cueVideoById is built for
        // "show a frame at this position, don't play yet" and buffers it.
        playerRef.current!.cueVideoById(state.videoId, state.time);
        return;
      }

      playerRef.current!.seekTo(state.time, true);
      if (state.isPlaying) {
        if (!autoplayGrantedRef.current) {
          // Browsers block unmuted autoplay without a user gesture; start
          // muted and let the user unmute via the player's own volume control.
          playerRef.current!.mute();
        }
        playerRef.current!.playVideo();
      } else {
        playerRef.current!.pauseVideo();
      }
    });
  };

  // Join the room once a nickname is known, and rejoin on every (re)connect —
  // a fresh socket id after a reconnect has no room membership on the server.
  useEffect(() => {
    if (!nickname || !roomId) return;
    const join = () => socket.emit("room:join", { roomId, name: nickname, clientId: clientIdRef.current });
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
      if (!state.videoId) return;
      if (state.videoId !== videoId) {
        setVideoId(state.videoId);
      } else {
        syncPlayerToState(state);
      }
    };

    const onVideoLoad = ({ videoId: id }: { videoId: string }) => {
      pendingStateRef.current = { videoId: id, isPlaying: false, time: 0 };
      setPlayerError(null);
      if (playerRef.current) {
        applyRemote(() => playerRef.current!.cueVideoById(id));
      }
      setVideoId(id);
    };

    const onVideoPlay = ({ time }: { time: number }) => {
      if (!videoId) return;
      syncPlayerToState({ videoId, isPlaying: true, time });
    };

    const onVideoPause = ({ time }: { time: number }) => {
      if (!videoId) return;
      syncPlayerToState({ videoId, isPlaying: false, time });
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
    <div className="app">
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

      {videoId ? (
        <>
          <div id="yt-player" ref={playerContainerRef} />
          {playerError && <p className="load-error">{playerError} Try pasting a different link.</p>}
          <p className="pip-hint">
            Tip: go fullscreen, then press home — the video pops out and keeps playing while you
            use other apps.
          </p>
        </>
      ) : (
        <p className="empty-state">Paste a YouTube link above to start a sesh.</p>
      )}
    </div>
  );
}

export default Room;
