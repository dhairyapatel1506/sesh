import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { extractVideoId, loadYouTubeApi, PlayerState, type YTPlayer } from "./youtube";
import "./App.css";

const SERVER_URL = import.meta.env.DEV ? "http://localhost:3001" : "/";
const socket = io(SERVER_URL);

type RoomState = {
  videoId: string | null;
  isPlaying: boolean;
  time: number;
};

function App() {
  const [connected, setConnected] = useState(socket.connected);
  const [urlInput, setUrlInput] = useState("");
  const [videoId, setVideoId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const playerRef = useRef<YTPlayer | null>(null);
  const pendingStateRef = useRef<RoomState | null>(null);

  // Applying a remote sync action fires a resulting onStateChange event on
  // this client's own player, which must not be re-broadcast (that would
  // create an echo). A fixed timer to "wait out" that event is unreliable —
  // browsers block autoplay for tabs with no prior user gesture, so the
  // resulting event can arrive as more than one state-change callback in
  // quick succession (YouTube briefly flickers through playing/buffering
  // while it seeks) — swallowing only the first would let the second one
  // leak through as if it were a genuine local click. So we suppress for a
  // window instead of a single event, resetting (extending) that window
  // each time a new remote action comes in rather than letting an earlier
  // timer clear the flag out from under a still-settling later one.
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

  // Once this tab has genuinely gotten permission to play audio (the user
  // clicked the unmute banner), the browser remembers that for the rest of
  // the page's lifetime — further programmatic playVideo() calls in this tab
  // won't be autoplay-blocked. So we only need to defensively mute before the
  // very first auto-play attempt, not on every subsequent sync.
  const autoplayGrantedRef = useRef(false);

  // Seeks/plays/pauses the player to match an authoritative state snapshot
  // (used both the first time a player is created and to resync an existing
  // one, e.g. after a backgrounded tab regains visibility, or a remote
  // video:play/video:pause). Only takes action if the player actually
  // disagrees with that state — otherwise a resync triggered by something
  // harmless (like refocusing a tab whose video kept playing the whole time)
  // would needlessly mute and re-seek a video that was already correct.
  const syncPlayerToState = (state: RoomState) => {
    if (!playerRef.current) return;
    const currentState = playerRef.current.getPlayerState();
    const alreadyPlaying = currentState === PlayerState.PLAYING;
    const alreadyPaused = currentState === PlayerState.PAUSED;
    if (state.isPlaying && alreadyPlaying) return;
    if (!state.isPlaying && alreadyPaused) return;

    applyRemote(() => {
      playerRef.current!.seekTo(state.time, true);
      if (state.isPlaying) {
        if (!autoplayGrantedRef.current) {
          // No confirmed user gesture on this tab yet — unmuted autoplay
          // would be silently blocked by the browser. Muted autoplay is
          // always allowed.
          playerRef.current!.mute();
          setMuted(true);
        }
        playerRef.current!.playVideo();
      } else {
        playerRef.current!.pauseVideo();
      }
    });
  };

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
      if (cancelled) return;
      playerRef.current = new YT.Player("yt-player", {
        videoId,
        width: "640",
        height: "390",
        events: {
          onReady: () => {
            const pending = pendingStateRef.current;
            if (!pending || pending.videoId !== videoId) return;
            syncPlayerToState(pending);
          },
          onStateChange: (event) => {
            if (!playerRef.current) return;
            if (event.data !== PlayerState.PLAYING && event.data !== PlayerState.PAUSED) {
              return;
            }
            // A hidden tab can't have received a real click — browsers pause
            // background/muted video for power-saving reasons, and without
            // this guard that browser-induced pause gets broadcast as if the
            // user had paused it, corrupting playback for everyone else.
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

  // Listen for room state / remote playback events.
  useEffect(() => {
    const onRoomState = (state: RoomState) => {
      pendingStateRef.current = state;
      if (!state.videoId) return;
      if (state.videoId !== videoId) {
        // No player for this video yet — onReady will consume pendingStateRef
        // once it's created.
        setVideoId(state.videoId);
      } else {
        // Player already exists (this is a resync, e.g. after the tab
        // regained visibility) — apply immediately rather than waiting for
        // onReady, which only fires once at creation.
        syncPlayerToState(state);
      }
    };

    const onVideoLoad = ({ videoId: id }: { videoId: string }) => {
      pendingStateRef.current = { videoId: id, isPlaying: false, time: 0 };
      if (playerRef.current) {
        // Cue (not load) so this doesn't autoplay here — the loading client's
        // own play action will follow shortly as a normal video:play event.
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

    socket.on("room:state", onRoomState);
    socket.on("video:load", onVideoLoad);
    socket.on("video:play", onVideoPlay);
    socket.on("video:pause", onVideoPause);

    return () => {
      socket.off("room:state", onRoomState);
      socket.off("video:load", onVideoLoad);
      socket.off("video:play", onVideoPlay);
      socket.off("video:pause", onVideoPause);
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

  const handleLoad = () => {
    const id = extractVideoId(urlInput);
    if (!id) {
      alert("Couldn't find a YouTube video ID in that URL.");
      return;
    }
    socket.emit("video:load", { videoId: id });
    if (playerRef.current) {
      playerRef.current.loadVideoById(id);
    }
    setVideoId(id);
  };

  const handleUnmute = () => {
    playerRef.current?.unMute();
    autoplayGrantedRef.current = true;
    setMuted(false);
  };

  return (
    <div className="app">
      <header>
        <h1>Sesh</h1>
        <span className={connected ? "ok" : "bad"}>
          {connected ? "connected" : "disconnected"}
        </span>
      </header>

      <div className="load-bar">
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="Paste a YouTube link..."
          onKeyDown={(e) => e.key === "Enter" && handleLoad()}
        />
        <button onClick={handleLoad}>Load</button>
      </div>

      {videoId ? (
        <>
          <div id="yt-player" />
          {muted && (
            <button className="unmute-banner" onClick={handleUnmute}>
              🔇 Playing muted — click to unmute
            </button>
          )}
        </>
      ) : (
        <p className="empty-state">Paste a YouTube link above to start a sesh.</p>
      )}
    </div>
  );
}

export default App;
