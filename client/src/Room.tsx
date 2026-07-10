import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { socket } from "./socket";
import { extractVideoId, loadYouTubeApi, PlayerState, type YTPlayer } from "./youtube";
import "./App.css";

type RoomState = {
  videoId: string | null;
  isPlaying: boolean;
  time: number;
};

type User = { id: string; name: string };

const NAME_STORAGE_KEY = "sesh:name";

function Room() {
  const { roomId = "" } = useParams();

  const [connected, setConnected] = useState(socket.connected);
  const [urlInput, setUrlInput] = useState("");
  const [videoId, setVideoId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [nickname, setNickname] = useState(() => sessionStorage.getItem(NAME_STORAGE_KEY) ?? "");
  const [nameInput, setNameInput] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [linkCopied, setLinkCopied] = useState(false);

  const playerRef = useRef<YTPlayer | null>(null);
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
    if (state.isPlaying && alreadyPlaying) return;
    if (!state.isPlaying && alreadyPaused) return;

    applyRemote(() => {
      playerRef.current!.seekTo(state.time, true);
      if (state.isPlaying) {
        if (!autoplayGrantedRef.current) {
          playerRef.current!.mute();
          setMuted(true);
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
    const join = () => socket.emit("room:join", { roomId, name: nickname });
    join();
    socket.on("connect", join);
    return () => {
      socket.off("connect", join);
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

  const handleLoad = () => {
    const id = extractVideoId(urlInput);
    if (!id) {
      alert("Couldn't find a YouTube video ID in that URL.");
      return;
    }
    socket.emit("video:load", { videoId: id });
    // This is a real click, so the browser allows unmuted playback here —
    // no need to defensively mute future remote syncs on this tab.
    autoplayGrantedRef.current = true;
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
          {connected ? "connected" : "disconnected"}
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

export default Room;
