import { useCallback, useEffect, useRef, useState } from "react";
import { socket } from "./socket";

export type VoicePeer = { peerId: string; name: string };

// Public STUN only. It's enough to discover your public address and punch
// through the NAT most home routers use, which covers the large majority of
// connections. It is *not* enough for symmetric NAT (some corporate and mobile
// networks), where the only fix is a TURN relay — a server that forwards the
// audio, which costs real bandwidth and is why this doesn't have one. Peers
// that can't connect surface as "couldn't connect" rather than silence.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

// Speech is bursty and the meter is jumpy at the edges; these keep the ring
// around someone's name from strobing on every syllable.
const SPEAKING_THRESHOLD = 0.015;
const SPEAKING_HANG_MS = 350;
const METER_INTERVAL_MS = 100;

type PeerState = {
  connection: RTCPeerConnection;
  audio: HTMLAudioElement;
  // Candidates that arrive before the remote description is set have nowhere
  // to go yet — WebRTC rejects them — so they wait here.
  pending: RTCIceCandidateInit[];
};

export function useVoice(roomId: string) {
  const [inVoice, setInVoice] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [peers, setPeers] = useState<VoicePeer[]>([]);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const localStream = useRef<MediaStream | null>(null);
  const connections = useRef(new Map<string, PeerState>());
  const audioContext = useRef<AudioContext | null>(null);
  const meters = useRef(new Map<string, { analyser: AnalyserNode; lastLoud: number }>());
  const inVoiceRef = useRef(false);

  // --- speaking meters ----------------------------------------------------
  const watchLevel = useCallback((id: string, stream: MediaStream) => {
    try {
      const ctx = (audioContext.current ??= new AudioContext());
      void ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      meters.current.set(id, { analyser, lastLoud: 0 });
    } catch {
      // No meter is survivable — you just don't get the speaking ring.
    }
  }, []);

  const unwatchLevel = (id: string) => meters.current.delete(id);

  useEffect(() => {
    if (!inVoice) return;
    const buffer = new Float32Array(256);
    const timer = window.setInterval(() => {
      const now = performance.now();
      const loud = new Set<string>();
      for (const [id, meter] of meters.current) {
        meter.analyser.getFloatTimeDomainData(buffer);
        // Root mean square: loudness of the window, rather than whatever the
        // waveform happened to be doing at one instant.
        let sum = 0;
        for (const sample of buffer) sum += sample * sample;
        const level = Math.sqrt(sum / buffer.length);
        if (level > SPEAKING_THRESHOLD) meter.lastLoud = now;
        if (now - meter.lastLoud < SPEAKING_HANG_MS) loud.add(id);
      }
      setSpeaking((prev) => {
        if (prev.size === loud.size && [...loud].every((id) => prev.has(id))) return prev;
        return loud;
      });
    }, METER_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [inVoice]);

  // --- peer plumbing ------------------------------------------------------
  const teardownPeer = useCallback((peerId: string) => {
    const peer = connections.current.get(peerId);
    if (!peer) return;
    peer.connection.onicecandidate = null;
    peer.connection.ontrack = null;
    peer.connection.close();
    peer.audio.srcObject = null;
    peer.audio.remove();
    connections.current.delete(peerId);
    unwatchLevel(peerId);
  }, []);

  const createPeer = useCallback(
    (peerId: string) => {
      const existing = connections.current.get(peerId);
      if (existing) return existing;

      const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const audio = document.createElement("audio");
      audio.autoplay = true;
      // Never in the page: this is an output sink, and a visible player would
      // invite someone to pause the person talking to them.
      audio.style.display = "none";
      document.body.appendChild(audio);

      for (const track of localStream.current?.getTracks() ?? []) {
        connection.addTrack(track, localStream.current!);
      }

      connection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("voice:signal", { to: peerId, data: { candidate: event.candidate } });
        }
      };
      connection.ontrack = (event) => {
        const [stream] = event.streams;
        audio.srcObject = stream;
        void audio.play().catch(() => {
          // Joining voice was a click, so autoplay is allowed — but if a
          // browser still refuses, deafened state is the honest fallback.
        });
        watchLevel(peerId, stream);
      };
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "failed") {
          setError("Couldn't reach someone in the call — their network may need a relay.");
        }
      };

      const peer: PeerState = { connection, audio, pending: [] };
      connections.current.set(peerId, peer);
      return peer;
    },
    [watchLevel],
  );

  // --- signalling ---------------------------------------------------------
  useEffect(() => {
    // The newcomer is handed everyone already in the call and offers to each.
    // One offerer per pair, decided by who arrived last, so two peers never
    // offer to each other at once.
    const onPeers = async (existing: VoicePeer[]) => {
      for (const { peerId } of existing) {
        const peer = createPeer(peerId);
        try {
          const offer = await peer.connection.createOffer();
          await peer.connection.setLocalDescription(offer);
          socket.emit("voice:signal", { to: peerId, data: { description: offer } });
        } catch {
          setError("Couldn't start the call.");
        }
      }
    };

    const onSignal = async ({
      from,
      data,
    }: {
      from: string;
      data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
    }) => {
      if (!inVoiceRef.current) return;
      const peer = createPeer(from);
      try {
        if (data.description) {
          await peer.connection.setRemoteDescription(data.description);
          // Anything that arrived early can be applied now.
          for (const candidate of peer.pending.splice(0)) {
            await peer.connection.addIceCandidate(candidate).catch(() => {});
          }
          if (data.description.type === "offer") {
            const answer = await peer.connection.createAnswer();
            await peer.connection.setLocalDescription(answer);
            socket.emit("voice:signal", { to: from, data: { description: answer } });
          }
        } else if (data.candidate) {
          if (peer.connection.remoteDescription) {
            await peer.connection.addIceCandidate(data.candidate).catch(() => {});
          } else {
            peer.pending.push(data.candidate);
          }
        }
      } catch {
        setError("Something went wrong connecting the call.");
      }
    };

    // The roster is everyone in the call including this tab. The UI renders
    // "you" separately from its own microphone meter, so leaving yourself in
    // here lists you twice — and makes the count in the idle state wrong too.
    const onRoster = (roster: VoicePeer[]) =>
      setPeers(roster.filter((peer) => peer.peerId !== socket.id));
    const onLeft = ({ peerId }: { peerId: string }) => teardownPeer(peerId);

    socket.on("voice:peers", onPeers);
    socket.on("voice:signal", onSignal);
    socket.on("voice:roster", onRoster);
    socket.on("voice:left", onLeft);
    return () => {
      socket.off("voice:peers", onPeers);
      socket.off("voice:signal", onSignal);
      socket.off("voice:roster", onRoster);
      socket.off("voice:left", onLeft);
    };
  }, [createPeer, teardownPeer]);

  // --- join / leave -------------------------------------------------------
  const leave = useCallback(() => {
    inVoiceRef.current = false;
    setInVoice(false);
    setSpeaking(new Set());
    setError(null);
    for (const peerId of [...connections.current.keys()]) teardownPeer(peerId);
    for (const track of localStream.current?.getTracks() ?? []) track.stop();
    localStream.current = null;
    unwatchLevel("me");
    socket.emit("voice:leave");
  }, [teardownPeer]);

  const join = useCallback(async () => {
    if (inVoiceRef.current || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      // The room is playing audio out of the same speakers this mic is
      // listening to, so cancellation isn't optional here the way it is in a
      // plain call app.
      localStream.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      watchLevel("me", localStream.current);
      inVoiceRef.current = true;
      setInVoice(true);
      setMuted(false);
      socket.emit("voice:join");
    } catch (err) {
      const name = (err as DOMException)?.name;
      setError(
        name === "NotAllowedError"
          ? "Microphone access was blocked — allow it in your browser's address bar."
          : name === "NotFoundError"
            ? "No microphone found."
            : "Couldn't open your microphone.",
      );
    } finally {
      setConnecting(false);
    }
  }, [connecting, watchLevel]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    for (const track of localStream.current?.getAudioTracks() ?? []) {
      // Disabling the track keeps the connection up and sends silence, which
      // is instant and reversible — stopping it would renegotiate.
      track.enabled = !next;
    }
    setMuted(next);
    if (next) {
      setSpeaking((prev) => {
        const copy = new Set(prev);
        copy.delete("me");
        return copy;
      });
    }
  }, [muted]);

  const toggleDeafen = useCallback(() => {
    const next = !deafened;
    for (const peer of connections.current.values()) peer.audio.muted = next;
    setDeafened(next);
    // Deafening while unmuted means talking to people you can't hear, which
    // nobody means to do — so it mutes too, the way Discord does.
    if (next && !muted) toggleMute();
  }, [deafened, muted, toggleMute]);

  // Changing rooms, or closing the tab, ends the call.
  useEffect(() => {
    return () => {
      if (inVoiceRef.current) leave();
    };
  }, [roomId, leave]);

  return {
    inVoice,
    connecting,
    peers,
    speaking,
    muted,
    deafened,
    error,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    dismissError: () => setError(null),
  };
}
