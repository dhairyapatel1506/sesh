import { useCallback, useEffect, useRef, useState } from "react";
import { socket } from "./socket";
import {
  playDeafen,
  playMute,
  playPeerJoin,
  playPeerLeave,
  playUndeafen,
  playUnmute,
  playVoiceJoin,
  playVoiceLeave,
} from "./sounds";

export type VoicePeer = { peerId: string; name: string };
export type AudioDevice = { deviceId: string; label: string };

// Public STUN only. It's enough to discover your public address and punch
// through the NAT most home routers use, which covers the large majority of
// connections. It is *not* enough for symmetric NAT (some corporate and mobile
// networks), where the only fix is a TURN relay — a server that forwards the
// audio, which costs real bandwidth and is why this doesn't have one. Peers
// that can't connect surface as "couldn't connect" rather than silence.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

// Opus defaults to around 32 kbps for a mono voice track, which is fine for
// speech and audibly thin next to music. Doubling it is still nothing beside a
// video stream and noticeably cleaner on consonants and laughter.
const VOICE_BITRATE = 64_000;

// Speech is bursty and the meter is jumpy at the edges; these keep the ring
// around someone's name from strobing on every syllable.
const SPEAKING_THRESHOLD = 0.015;
const SPEAKING_HANG_MS = 350;
const METER_INTERVAL_MS = 100;

const SETTINGS_KEY = "sesh:voice-settings";

type Settings = {
  inputDeviceId: string;
  outputDeviceId: string;
  inputVolume: number;
  outputVolume: number;
  duckVideo: boolean;
};

const defaultSettings: Settings = {
  inputDeviceId: "",
  outputDeviceId: "",
  inputVolume: 1,
  outputVolume: 1,
  // On by default: the whole difficulty of talking over a video is that the
  // video doesn't stop for you.
  duckVideo: true,
};

function loadSettings(): Settings {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return defaultSettings;
  }
}

// Windows lists the same microphone three times: once as itself, once as
// "Default - <name>", and once as "Communications - <name>". The last two are
// aliases pointing at whatever the OS currently prefers, not separate hardware,
// which is why a list of two devices arrives as six near-identical lines. Drop
// the aliases — "System default" is already the first option and means the same
// thing — then collapse anything left with a duplicate name.
function usableDevices(
  all: MediaDeviceInfo[],
  kind: MediaDeviceKind,
  fallback: string,
): AudioDevice[] {
  const ofKind = all.filter((device) => device.kind === kind);
  const strip = (label: string) => label.replace(/^(Default|Communications)\s+-\s+/i, "").trim();

  const collapse = (devices: MediaDeviceInfo[]) => {
    const seen = new Set<string>();
    const out: AudioDevice[] = [];
    for (const device of devices) {
      const label = strip(device.label) || `${fallback} ${out.length + 1}`;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ deviceId: device.deviceId, label });
    }
    return out;
  };

  const real = collapse(
    ofKind.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications"),
  );
  // Some platforms expose *only* the aliases. Better a deduplicated list of
  // those than an empty picker.
  return real.length > 0 ? real : collapse(ofKind);
}

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
  // People you've silenced for yourself. Local only — muting someone in your
  // own ears is a personal preference; muting them in everyone else's would be
  // a moderation power, and a room of friends doesn't need one of those.
  const [mutedPeers, setMutedPeers] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [settings, setSettings] = useState<Settings>(loadSettings);

  const micStream = useRef<MediaStream | null>(null);
  // The audio graph: mic -> gain -> destination. Peers are always sent the
  // *destination's* track, never the microphone's, so changing input device is
  // a rewire upstream rather than a track swap on every connection.
  const graph = useRef<{
    context: AudioContext;
    gain: GainNode;
    destination: MediaStreamAudioDestinationNode;
    source: MediaStreamAudioSourceNode | null;
  } | null>(null);
  const connections = useRef(new Map<string, PeerState>());
  const meters = useRef(new Map<string, { analyser: AnalyserNode; lastLoud: number }>());
  const inVoiceRef = useRef(false);
  const settingsRef = useRef(settings);
  const knownPeers = useRef<Set<string>>(new Set());
  // True from the moment we ask to join until the first roster lands, so that
  // roster can seed state without being mistaken for a burst of arrivals.
  const justJoined = useRef(false);
  // Read inside createPeer, which runs outside React's render cycle.
  const mutedPeersRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    settingsRef.current = settings;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Private mode — settings just don't persist.
    }
  }, [settings]);

  // --- devices ------------------------------------------------------------
  // Labels are hidden until microphone permission is granted, so the list is
  // worth re-reading after joining rather than only on mount.
  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setInputs(usableDevices(all, "audioinput", "Microphone"));
      setOutputs(usableDevices(all, "audiooutput", "Speaker"));
    } catch {
      // Enumeration blocked — the pickers just stay empty.
    }
  }, []);

  // Only ever asked for once voice is actually being used. Enumerating audio
  // devices makes the browser touch the audio subsystem, and on Bluetooth
  // headsets that can be enough to flip the link from A2DP (stereo, full
  // bandwidth) to the headset profile (mono, telephone bandwidth) — which
  // sounds exactly like the video going muffled for a second. Someone who
  // never opens voice now never triggers any of it.
  useEffect(() => {
    if (!inVoice) return;
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
  }, [inVoice, refreshDevices]);

  // --- speaking meters ----------------------------------------------------
  const watchLevel = useCallback((id: string, node: AudioNode | MediaStream) => {
    try {
      const audio = graph.current?.context;
      if (!audio) return;
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      const source =
        node instanceof MediaStream ? audio.createMediaStreamSource(node) : node;
      source.connect(analyser);
      meters.current.set(id, { analyser, lastLoud: 0 });
    } catch {
      // No meter is survivable — you just don't get the speaking ring.
    }
  }, []);

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

  // --- output routing -----------------------------------------------------
  const applyOutput = useCallback((audio: HTMLAudioElement) => {
    const { outputDeviceId, outputVolume } = settingsRef.current;
    audio.volume = outputVolume;
    // setSinkId is Chromium-only; elsewhere the picker is simply absent and
    // audio follows the system default.
    const withSink = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (outputDeviceId && withSink.setSinkId) {
      void withSink.setSinkId(outputDeviceId).catch(() => {});
    }
  }, []);

  useEffect(() => {
    for (const [peerId, peer] of connections.current) {
      peer.audio.volume = settings.outputVolume;
      peer.audio.muted = deafened || mutedPeers.has(peerId);
    }
  }, [settings.outputVolume, deafened, mutedPeers]);

  useEffect(() => {
    for (const peer of connections.current.values()) applyOutput(peer.audio);
  }, [settings.outputDeviceId, applyOutput]);

  useEffect(() => {
    if (graph.current) graph.current.gain.gain.value = settings.inputVolume;
  }, [settings.inputVolume]);

  // --- microphone ---------------------------------------------------------
  const openMic = useCallback(async (deviceId: string) => {
    // The room is playing audio out of the same speakers this mic is listening
    // to, so cancellation isn't optional here the way it is in a call app.
    const constraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      video: false,
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }, []);

  const wireMic = useCallback(
    (stream: MediaStream) => {
      const g = graph.current;
      if (!g) return;
      g.source?.disconnect();
      const source = g.context.createMediaStreamSource(stream);
      source.connect(g.gain);
      g.source = source;
      micStream.current = stream;
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
    },
    [muted],
  );

  const setInputDevice = useCallback(
    async (deviceId: string) => {
      setSettings((s) => ({ ...s, inputDeviceId: deviceId }));
      if (!inVoiceRef.current) return;
      try {
        const stream = await openMic(deviceId);
        for (const track of micStream.current?.getTracks() ?? []) track.stop();
        wireMic(stream);
      } catch {
        setError("Couldn't switch to that microphone.");
      }
    },
    [openMic, wireMic],
  );

  const setOutputDevice = (deviceId: string) =>
    setSettings((s) => ({ ...s, outputDeviceId: deviceId }));
  const setInputVolume = (v: number) => setSettings((s) => ({ ...s, inputVolume: v }));
  const setOutputVolume = (v: number) => setSettings((s) => ({ ...s, outputVolume: v }));
  const setDuckVideo = (on: boolean) => setSettings((s) => ({ ...s, duckVideo: on }));

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
    meters.current.delete(peerId);
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
      applyOutput(audio);
      audio.muted = deafened || mutedPeersRef.current.has(peerId);

      for (const track of graph.current?.destination.stream.getAudioTracks() ?? []) {
        const sender = connection.addTrack(track, graph.current!.destination.stream);
        // Ask for a bitrate worth listening to next to music. Best-effort: the
        // browser may clamp it, and setParameters throws on some platforms if
        // encodings haven't been created yet.
        try {
          const params = sender.getParameters();
          params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: VOICE_BITRATE }];
          void sender.setParameters(params).catch(() => {});
        } catch {
          // Keep the default bitrate.
        }
      }

      connection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("voice:signal", { to: peerId, data: { candidate: event.candidate } });
        }
      };
      connection.ontrack = (event) => {
        const [stream] = event.streams;
        audio.srcObject = stream;
        void audio.play().catch(() => {});
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
    [applyOutput, deafened, watchLevel],
  );

  // --- signalling ---------------------------------------------------------
  useEffect(() => {
    // The newcomer is handed everyone already in the call and offers to each.
    // One offerer per pair, decided by who arrived last, so two peers never
    // offer to each other at once.
    const onPeers = async (existing: VoicePeer[]) => {
      // Everyone already here is *known*, not newly arrived. Without seeding
      // this, the first roster after joining looks like everybody turning up at
      // once and plays an arrival cue for each of them — so walking into a call
      // of three sounded like four separate events.
      knownPeers.current = new Set(existing.map((peer) => peer.peerId));
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
    const onRoster = (roster: VoicePeer[]) => {
      const others = roster.filter((peer) => peer.peerId !== socket.id);
      // Arrivals and departures are announced to the people already in the
      // call — that's the cue that tells you someone can hear you now. Not on
      // the roster that arrives with your own join, though: that one is a
      // description of the room, not a list of things that just happened.
      if (inVoiceRef.current && !justJoined.current) {
        const now = new Set(others.map((p) => p.peerId));
        for (const id of now) if (!knownPeers.current.has(id)) playPeerJoin();
        for (const id of knownPeers.current) if (!now.has(id)) playPeerLeave();
        knownPeers.current = now;
      } else if (inVoiceRef.current) {
        knownPeers.current = new Set(others.map((p) => p.peerId));
      }
      justJoined.current = false;
      setPeers(others);
    };
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
    if (!inVoiceRef.current) return;
    inVoiceRef.current = false;
    setInVoice(false);
    setSpeaking(new Set());
    setError(null);
    knownPeers.current = new Set();
    justJoined.current = false;
    mutedPeersRef.current = new Set();
    setMutedPeers(new Set());
    for (const peerId of [...connections.current.keys()]) teardownPeer(peerId);
    for (const track of micStream.current?.getTracks() ?? []) track.stop();
    micStream.current = null;
    meters.current.clear();
    graph.current?.source?.disconnect();
    if (graph.current) graph.current.source = null;
    socket.emit("voice:leave");
    playVoiceLeave();
  }, [teardownPeer]);

  const join = useCallback(async () => {
    if (inVoiceRef.current || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const stream = await openMic(settingsRef.current.inputDeviceId);

      if (!graph.current) {
        const context = new AudioContext();
        const gain = context.createGain();
        const destination = context.createMediaStreamDestination();
        gain.connect(destination);
        graph.current = { context, gain, destination, source: null };
      }
      await graph.current.context.resume().catch(() => {});
      graph.current.gain.gain.value = settingsRef.current.inputVolume;
      wireMic(stream);
      // Metered on the stream the peers are actually sent — past the gain
      // stage, so the ring reflects what others hear rather than what the
      // microphone picked up.
      watchLevel("me", graph.current.destination.stream);

      inVoiceRef.current = true;
      justJoined.current = true;
      setInVoice(true);
      setMuted(false);
      socket.emit("voice:join");
      playVoiceJoin();
      // Labels only become readable once permission is granted.
      void refreshDevices();
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
  }, [connecting, openMic, refreshDevices, watchLevel, wireMic]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    for (const track of micStream.current?.getAudioTracks() ?? []) {
      // Disabling the track keeps the connection up and sends silence, which
      // is instant and reversible — stopping it would renegotiate.
      track.enabled = !next;
    }
    setMuted(next);
    (next ? playMute : playUnmute)();
    if (next) {
      setSpeaking((prev) => {
        const copy = new Set(prev);
        copy.delete("me");
        return copy;
      });
    }
  }, [muted]);

  const togglePeerMute = useCallback((peerId: string) => {
    setMutedPeers((prev) => {
      const next = new Set(prev);
      if (next.has(peerId)) next.delete(peerId);
      else next.add(peerId);
      mutedPeersRef.current = next;
      return next;
    });
  }, []);

  const toggleDeafen = useCallback(() => {
    const next = !deafened;
    for (const peer of connections.current.values()) peer.audio.muted = next;
    setDeafened(next);
    (next ? playDeafen : playUndeafen)();
    // Deafening while unmuted means talking to people you can't hear, which
    // nobody means to do — so it mutes too, the way Discord does.
    if (next && !muted) {
      for (const track of micStream.current?.getAudioTracks() ?? []) track.enabled = false;
      setMuted(true);
    }
  }, [deafened, muted]);

  // Changing rooms, or closing the tab, ends the call.
  useEffect(() => {
    return () => {
      if (inVoiceRef.current) leave();
    };
  }, [roomId, leave]);

  // Someone *else* talking — what the video should get out of the way for.
  const othersSpeaking = [...speaking].some((id) => id !== "me");

  return {
    inVoice,
    connecting,
    peers,
    speaking,
    muted,
    deafened,
    mutedPeers,
    error,
    inputs,
    outputs,
    settings,
    othersSpeaking,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    togglePeerMute,
    setInputDevice,
    setOutputDevice,
    setInputVolume,
    setOutputVolume,
    setDuckVideo,
    dismissError: () => setError(null),
    canPickOutput: typeof (HTMLAudioElement.prototype as { setSinkId?: unknown }).setSinkId === "function",
  };
}
