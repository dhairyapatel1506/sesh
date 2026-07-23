import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { io, type Socket } from "socket.io-client";
import { Mpv } from "./mpv.js";
import { fetchTitle } from "./youtube.js";
import type { ChatMessage, QueueItem, RoomState, RoomUser } from "./types.js";

// Same drift-correction tiers as the web client (client/src/Room.tsx) — the
// engine differs (mpv instead of the YouTube IFrame) but the sync math is a
// straight port. mpv reports time-pos precisely, so the CLI skips the web
// client's cached-getCurrentTime() extrapolation workaround entirely.
const DRIFT_TOLERANCE_SECONDS = 0.06;
const NUDGE_MAX_SECONDS = 1.2;
const NUDGE_RATE_DELTA = 0.25;
const RESYNC_INTERVAL_MS = 5000;
const LOCAL_DRIFT_CHECK_MS = 750;

export type UiState = {
  connected: boolean;
  users: RoomUser[];
  messages: ChatMessage[];
  queue: QueueItem[];
  videoId: string | null;
  title: string | null;
  isPlaying: boolean;
  position: number | null;
  duration: number | null;
  driftMs: number | null;
  status: string | null;
  fatal: string | null;
};

export type SessionOptions = {
  serverUrl: string;
  roomId: string;
  name: string;
};

export class Session extends EventEmitter {
  readonly state: UiState = {
    connected: false,
    users: [],
    messages: [],
    queue: [],
    videoId: null,
    title: null,
    isPlaying: false,
    position: null,
    duration: null,
    driftMs: null,
    status: null,
    fatal: null,
  };

  readonly clientId = crypto.randomUUID();
  private opts: SessionOptions;
  private socket: Socket;
  private mpv: Mpv | undefined;

  private lastState: RoomState | null = null;
  private currentVideo: string | null = null; // what mpv has loaded
  private prepare: string | null = null; // videoId pre-buffering for a barrier start
  private clockOffset = 0;
  private rateResetTimer: ReturnType<typeof setTimeout> | undefined;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private loops: ReturnType<typeof setInterval>[] = [];
  private titleCache = new Map<string, string>();
  // Playback self-healing: a dead/stalled load clears currentVideo so the
  // periodic room resync reloads it; the counters stop us retrying forever.
  private loadFailures = new Map<string, number>();
  private stallTicks = 0;

  constructor(opts: SessionOptions) {
    super();
    this.opts = opts;
    // Created (but not connected) up front so user actions can never hit an
    // undefined socket — Socket.IO buffers emits made while disconnected and
    // flushes them on connect, which is exactly right for someone typing
    // during a slow startup.
    this.socket = io(opts.serverUrl, { autoConnect: false, transports: ["websocket", "polling"] });
  }

  private update(patch: Partial<UiState>) {
    Object.assign(this.state, patch);
    this.emit("update");
  }

  setStatus(text: string | null, opts?: { sticky?: boolean }) {
    clearTimeout(this.statusTimer);
    this.update({ status: text });
    if (text && !opts?.sticky) {
      this.statusTimer = setTimeout(() => this.update({ status: null }), 4000);
    }
  }

  private serverNow() {
    return Date.now() + this.clockOffset;
  }

  // Where the audio should be *right now* according to a state snapshot.
  private targetTime(state: RoomState) {
    return state.isPlaying ? state.time + Math.max(0, this.serverNow() - state.at) / 1000 : state.time;
  }

  async start(): Promise<void> {
    let mpv: Mpv;
    try {
      mpv = await Mpv.spawn();
    } catch (err) {
      this.update({ fatal: (err as Error).message });
      return;
    }
    this.mpv = mpv;

    mpv.on("gone", () => this.update({ fatal: "mpv died — restart the client" }));

    // Reasons other than eof: "stop" fires on every replacing loadfile,
    // "error" when yt-dlp can't resolve the video.
    mpv.on("end-file", (msg: { reason?: string }) => {
      if (msg.reason === "error") {
        this.noteLoadFailure();
        return;
      }
      if (msg.reason !== "eof") return;
      this.socket.emit("video:ended", {
        time: this.state.duration ?? this.lastState?.time ?? 0,
        videoId: this.currentVideo,
      });
    });

    this.socket.on("connect", async () => {
      await this.syncClock();
      this.socket.emit("room:join", {
        roomId: this.opts.roomId,
        name: this.opts.name,
        clientId: this.clientId,
      });
      this.update({ connected: true });
    });
    this.socket.on("disconnect", () => this.update({ connected: false }));

    this.socket.on("room:users", (users: RoomUser[]) => this.update({ users }));
    this.socket.on("chat:history", (messages: ChatMessage[]) => this.update({ messages }));
    this.socket.on("chat:message", (message: ChatMessage) =>
      this.update({ messages: [...this.state.messages.slice(-99), message] }),
    );
    this.socket.on("queue:state", (queue: QueueItem[]) => this.update({ queue }));

    this.socket.on("room:state", (state: RoomState) => {
      this.lastState = state;
      // Mid-prepare, the room legitimately sits paused at 0 on the new video;
      // "correcting" to that would pause the pre-buffer and stall the barrier.
      if (this.prepare && this.prepare === state.videoId && !state.isPlaying) return;
      void this.applyState(state);
    });

    this.socket.on("video:load", ({ videoId }: { videoId: string }) => {
      this.prepare = null;
      this.lastState = { videoId, isPlaying: true, time: 0, at: this.serverNow() };
      void this.applyState(this.lastState);
    });

    this.socket.on(
      "video:play",
      ({ time, at, videoId }: { time: number; at: number; videoId?: string | null }) => {
        this.prepare = null;
        this.lastState = {
          videoId: videoId ?? this.currentVideo,
          isPlaying: true,
          time,
          at,
        };
        void this.applyState(this.lastState);
      },
    );

    this.socket.on(
      "video:pause",
      ({ time, at, videoId }: { time: number; at: number; videoId?: string | null }) => {
        this.prepare = null;
        this.lastState = {
          videoId: videoId ?? this.currentVideo,
          isPlaying: false,
          time,
          at,
        };
        void this.applyState(this.lastState);
      },
    );

    // Synchronized start: pre-buffer paused and silent, report ready, then
    // wait for the barrier's video:play.
    this.socket.on("video:prepare", ({ videoId }: { videoId: string }) => {
      this.prepare = videoId;
      this.lastState = { videoId, isPlaying: false, time: 0, at: this.serverNow() };
      void (async () => {
        try {
          this.currentVideo = videoId;
          this.update({ videoId, isPlaying: false, position: 0 });
          void this.resolveTitle(videoId);
          await mpv.load(videoId, { paused: true });
          await this.waitForLoad(videoId);
          if (this.prepare !== videoId) return; // superseded meanwhile
          this.socket.emit("video:ready", { videoId });
        } catch {
          // Load failed — the server's timeout will start the room without us.
        }
      })();
    });

    // The tight sync loop, plus UI position updates, on one cadence.
    this.loops.push(setInterval(() => void this.driftCheck(), LOCAL_DRIFT_CHECK_MS));
    this.loops.push(setInterval(() => this.socket.emit("resync:request"), RESYNC_INTERVAL_MS));

    // Only now — with mpv up and every handler wired — join the network.
    this.socket.connect();
  }

  // NTP-style: five pings, trust the lowest-RTT sample (same as the web client).
  private async syncClock() {
    let best: { rtt: number; offset: number } | null = null;
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const serverTime = await new Promise<number>((resolve) =>
        this.socket.emit("clock:ping", (time: number) => resolve(time)),
      );
      const t1 = Date.now();
      const rtt = t1 - t0;
      const offset = serverTime + rtt / 2 - t1;
      if (!best || rtt < best.rtt) best = { rtt, offset };
      await new Promise((r) => setTimeout(r, 150));
    }
    if (best) this.clockOffset = best.offset;
  }

  private async resolveTitle(videoId: string) {
    const cached = this.titleCache.get(videoId);
    if (cached) {
      if (this.state.videoId === videoId) this.update({ title: cached });
      return;
    }
    const title = await fetchTitle(videoId);
    if (title) {
      this.titleCache.set(videoId, title);
      if (this.state.videoId === videoId) this.update({ title });
    }
  }

  private waitForLoad(videoId: string): Promise<void> {
    const mpv = this.mpv;
    if (!mpv) return Promise.reject(new Error("mpv not ready"));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("load timed out"));
      }, 15000);
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onGone = () => {
        cleanup();
        reject(new Error("mpv gone"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        mpv.off("file-loaded", onLoaded);
        mpv.off("gone", onGone);
      };
      mpv.on("file-loaded", onLoaded);
      mpv.on("gone", onGone);
    });
  }

  private async resetSpeed() {
    clearTimeout(this.rateResetTimer);
    if (this.mpv) await this.mpv.setSpeed(1).catch(() => {});
  }

  // A load died (bad stream, stale yt-dlp, network). Forget what's loaded so
  // the next room:state resync reloads it — self-healing on a 5s cadence —
  // but give up per-video after 3 attempts instead of hammering forever.
  private noteLoadFailure() {
    const video = this.currentVideo;
    if (!video) return;
    const failures = (this.loadFailures.get(video) ?? 0) + 1;
    this.loadFailures.set(video, failures);
    this.currentVideo = null;
    this.update({ isPlaying: false });
    if (failures >= 3) {
      this.setStatus("this video won't play here — /skip it? (is yt-dlp up to date?)", { sticky: true });
    } else {
      this.setStatus(`playback failed — retrying (${failures}/3)`);
    }
  }

  // Bring mpv in line with an authoritative snapshot. Hard corrections only —
  // the drift loop handles fine alignment while playing.
  private async applyState(state: RoomState): Promise<void> {
    const mpv = this.mpv;
    if (!mpv) return;
    try {
      if (!state.videoId) return;

      if (state.videoId !== this.currentVideo) {
        if ((this.loadFailures.get(state.videoId) ?? 0) >= 3) return;
        // Load (or heal onto) the right video, then land on the snapshot.
        this.currentVideo = state.videoId;
        this.update({ videoId: state.videoId, title: this.titleCache.get(state.videoId) ?? null });
        void this.resolveTitle(state.videoId);
        await this.resetSpeed();
        await mpv.load(state.videoId, { paused: true });
        await this.waitForLoad(state.videoId);
        // Things may have moved on while we buffered.
        const current = this.lastState;
        if (!current || current.videoId !== state.videoId) return;
        if (this.prepare === state.videoId) return; // barrier owns the next step
        const target = this.targetTime(current);
        if (target > 0.25) await mpv.seek(target);
        await mpv.setPause(!current.isPlaying);
        this.update({ isPlaying: current.isPlaying });
        return;
      }

      if (state.isPlaying) {
        // Position while playing belongs to the drift loop; only flip pause.
        if (!this.state.isPlaying) {
          await mpv.seek(this.targetTime(state));
          await mpv.setPause(false);
          this.update({ isPlaying: true });
        }
      } else {
        await this.resetSpeed();
        await mpv.setPause(true);
        const pos = await mpv.getTime();
        if (pos === null || Math.abs(pos - state.time) > DRIFT_TOLERANCE_SECONDS) {
          await mpv.seek(state.time);
        }
        this.update({ isPlaying: false, position: state.time });
      }
    } catch {
      // mpv hiccup — the next resync will land us back on truth.
    }
  }

  private async driftCheck() {
    const mpv = this.mpv;
    if (!mpv) return;
    const state = this.lastState;
    const [position, duration] = await Promise.all([mpv.getTime(), mpv.getDuration()]);
    this.update({ position: position ?? this.state.position, duration });

    if (!state || !state.isPlaying || this.prepare || state.videoId !== this.currentVideo) {
      this.stallTicks = 0;
      return;
    }
    if (position === null) {
      // Supposed to be playing but mpv reports no position: buffering at
      // first, but after ~7.5s of it the stream is dead — reload.
      if (++this.stallTicks >= 10) {
        this.stallTicks = 0;
        this.noteLoadFailure();
      }
      return;
    }
    this.stallTicks = 0;

    const target = this.targetTime(state);
    const drift = target - position; // positive = we're behind
    const gap = Math.abs(drift);
    this.update({ driftMs: Math.round(drift * 1000) });

    // Alone in the room there's nobody to sync WITH — correcting against the
    // server's echo of our own actions just causes audible jumps (the clock
    // offset estimate is never perfect). Coast; corrections resume the
    // moment a second listener joins.
    if (this.state.users.length <= 1) {
      await this.resetSpeed().catch(() => {});
      return;
    }

    try {
      if (gap < DRIFT_TOLERANCE_SECONDS) {
        await this.resetSpeed();
      } else if (gap > NUDGE_MAX_SECONDS) {
        await this.resetSpeed();
        await mpv.seek(target);
      } else {
        await mpv.setSpeed(drift > 0 ? 1 + NUDGE_RATE_DELTA : 1 - NUDGE_RATE_DELTA);
        clearTimeout(this.rateResetTimer);
        this.rateResetTimer = setTimeout(() => void this.resetSpeed(), (gap / NUDGE_RATE_DELTA) * 1000);
      }
      this.update({ isPlaying: true });
    } catch {
      // Transient IPC failure — retry next tick.
    }
  }

  // ---- user actions ----

  sendChat(text: string) {
    this.socket.emit("chat:message", { text });
  }

  async play() {
    if (!this.mpv) return this.setStatus("player still starting\u2026");
    if (!this.currentVideo) return this.setStatus("nothing loaded — /add or /search first");
    try {
      const time = (await this.mpv.getTime()) ?? 0;
      await this.mpv.setPause(false);
      this.lastState = { videoId: this.currentVideo, isPlaying: true, time, at: this.serverNow() };
      this.update({ isPlaying: true });
      this.socket.emit("video:play", { time });
    } catch {
      this.setStatus("player not responding");
    }
  }

  async pause() {
    if (!this.mpv || !this.currentVideo) return;
    try {
      const time = (await this.mpv.getTime()) ?? 0;
      await this.resetSpeed();
      await this.mpv.setPause(true);
      this.lastState = { videoId: this.currentVideo, isPlaying: false, time, at: this.serverNow() };
      this.update({ isPlaying: false });
      this.socket.emit("video:pause", { time });
    } catch {
      this.setStatus("player not responding");
    }
  }

  async seekTo(time: number) {
    if (!this.mpv || !this.currentVideo) return;
    try {
      await this.mpv.seek(time);
      const isPlaying = this.lastState?.isPlaying ?? false;
      this.lastState = { videoId: this.currentVideo, isPlaying, time, at: this.serverNow() };
      this.socket.emit(isPlaying ? "video:play" : "video:pause", { time });
    } catch {
      this.setStatus("player not responding");
    }
  }

  // Play for everyone (the web client's "play now" path) \u2014 but buffer FIRST,
  // announce after. The web client must start on the click (autoplay
  // permission); mpv has no such constraint, so nothing is announced until
  // playback can actually begin at 0:00. Stream resolution takes seconds,
  // and announcing up front meant joining your own video 3-6s late.
  async playNow(videoId: string, title?: string | null) {
    if (!this.mpv) return this.setStatus("player still starting\u2026");
    this.prepare = null;
    this.currentVideo = videoId;
    if (title) this.titleCache.set(videoId, title);
    this.update({ videoId, title: this.titleCache.get(videoId) ?? null, isPlaying: false, position: 0 });
    void this.resolveTitle(videoId);
    this.setStatus("loading\u2026");
    try {
      await this.mpv.load(videoId, { paused: true });
      await this.waitForLoad(videoId);
    } catch {
      this.noteLoadFailure();
      return;
    }
    if (this.currentVideo !== videoId) return; // someone else took over while buffering
    this.setStatus(null);
    this.lastState = { videoId, isPlaying: true, time: 0, at: this.serverNow() };
    this.socket.emit("video:load", { videoId });
    try {
      await this.mpv.seek(0);
      await this.mpv.setPause(false);
      this.update({ isPlaying: true });
    } catch {
      this.setStatus("couldn't start playback");
    }
  }

  async addToQueue(videoId: string, title: string | null) {
    // Queueing onto an idle room means "play it now" — same as the web client.
    if (!this.lastState?.videoId) {
      await this.playNow(videoId, title);
      return;
    }
    this.socket.emit("queue:add", { videoId, title });
    this.setStatus("queued");
  }

  queuePlay(id: string) {
    this.socket.emit("queue:play", { id });
  }

  queueRemove(id: string) {
    this.socket.emit("queue:remove", { id });
  }

  skip() {
    const next = this.state.queue[0];
    if (!next) return this.setStatus("queue is empty");
    this.queuePlay(next.id);
  }

  async setVolume(volume: number) {
    if (!this.mpv) return;
    await this.mpv.setVolume(Math.max(0, Math.min(130, volume))).catch(() => {});
    this.setStatus(`volume ${volume}`);
  }

  destroy() {
    for (const loop of this.loops) clearInterval(loop);
    clearTimeout(this.rateResetTimer);
    clearTimeout(this.statusTimer);
    this.socket?.disconnect();
    this.mpv?.quit();
  }
}
