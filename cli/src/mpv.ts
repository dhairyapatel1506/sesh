import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

// mpv is controlled over its JSON IPC socket: newline-delimited JSON both
// ways. Requests carry a request_id that the matching response echoes back;
// everything else that arrives is an event broadcast.
type MpvResponse = { request_id?: number; error?: string; data?: unknown; event?: string };

export class MpvError extends Error {}

export class Mpv extends EventEmitter {
  private proc: ChildProcess;
  private ipc: Socket;
  private nextRequestId = 1;
  private pending = new Map<number, { resolve: (data: unknown) => void; reject: (err: Error) => void }>();
  private buffer = "";

  private constructor(proc: ChildProcess, ipc: Socket) {
    super();
    this.proc = proc;
    this.ipc = ipc;
    ipc.on("data", (chunk) => this.onData(chunk));
    ipc.on("error", () => this.emit("gone"));
    ipc.on("close", () => this.emit("gone"));
    proc.on("exit", () => this.emit("gone"));
  }

  // Spawns an audio-only mpv and connects to its IPC socket. mpv resolves
  // YouTube URLs itself by shelling out to yt-dlp.
  private static spawnCount = 0;

  static async spawn(): Promise<Mpv> {
    // pid alone isn't unique enough — one process can host several sessions
    // (tests do), and each needs its own mpv.
    const socketPath = path.join(os.tmpdir(), `sesh-mpv-${process.pid}-${Mpv.spawnCount++}.sock`);
    const proc = spawn(
      "mpv",
      [
        "--no-video",
        "--idle=yes",
        "--no-terminal",
        "--really-quiet",
        `--input-ipc-server=${socketPath}`,
        // Audio-only stream keeps startup fast and bandwidth tiny.
        "--ytdl-format=bestaudio/best",
        "--cache=yes",
        // Escape hatch for odd audio setups (e.g. SESH_MPV_ARGS="--ao=pulse").
        ...(process.env.SESH_MPV_ARGS ? process.env.SESH_MPV_ARGS.split(/\s+/) : []),
      ],
      { stdio: "ignore" },
    );

    const spawnError = new Promise<never>((_, reject) => {
      proc.on("error", () => reject(new MpvError("mpv isn't installed (try: sudo apt install mpv yt-dlp)")));
      proc.on("exit", (code) => reject(new MpvError(`mpv exited immediately (code ${code})`)));
    });

    // The IPC socket appears shortly after launch; poll until it accepts.
    const connect = (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          const ipc = await new Promise<Socket>((resolve, reject) => {
            const sock = createConnection(socketPath);
            sock.once("connect", () => resolve(sock));
            sock.once("error", reject);
          });
          return ipc;
        } catch {
          // Not up yet — keep polling.
        }
      }
      throw new MpvError("mpv started but its IPC socket never came up");
    })();

    const ipc = await Promise.race([connect, spawnError]);
    return new Mpv(proc, ipc);
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let msg: MpvResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
        const { resolve, reject } = this.pending.get(msg.request_id)!;
        this.pending.delete(msg.request_id);
        if (msg.error && msg.error !== "success") reject(new MpvError(msg.error));
        else resolve(msg.data);
      } else if (msg.event) {
        this.emit(msg.event, msg);
      }
    }
  }

  command(...args: unknown[]): Promise<unknown> {
    const request_id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      // A wedged mpv must never freeze the client: if a reply doesn't come
      // back promptly, fail the call and let the caller's error path run.
      const timeout = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new MpvError("mpv not responding"));
      }, 5000);
      this.pending.set(request_id, {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      this.ipc.write(JSON.stringify({ command: args, request_id }) + "\n", (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pending.delete(request_id);
          reject(err);
        }
      });
    });
  }

  // Loads (replacing anything playing) and leaves the decision to play to
  // the caller — pause state is set *before* the load so not a single frame
  // of audio slips out when preparing silently.
  async load(videoId: string, opts: { paused: boolean }): Promise<void> {
    await this.setPause(opts.paused);
    await this.command("loadfile", `https://www.youtube.com/watch?v=${videoId}`, "replace");
  }

  async stop(): Promise<void> {
    await this.command("stop");
  }

  async setPause(paused: boolean): Promise<void> {
    await this.command("set_property", "pause", paused);
  }

  async seek(seconds: number): Promise<void> {
    await this.command("seek", seconds, "absolute+exact");
  }

  async setSpeed(speed: number): Promise<void> {
    await this.command("set_property", "speed", speed);
  }

  async setVolume(volume: number): Promise<void> {
    await this.command("set_property", "volume", volume);
  }

  private async getNumber(prop: string): Promise<number | null> {
    try {
      const value = await this.command("get_property", prop);
      return typeof value === "number" ? value : null;
    } catch {
      return null; // Property unavailable (e.g. nothing loaded).
    }
  }

  getTime(): Promise<number | null> {
    return this.getNumber("time-pos");
  }

  getDuration(): Promise<number | null> {
    return this.getNumber("duration");
  }

  quit(): void {
    this.pending.clear();
    try {
      this.ipc.write(JSON.stringify({ command: ["quit"] }) + "\n");
    } catch {
      // Already gone.
    }
    this.ipc.destroy();
    // Belt and braces: if the polite quit didn't land, kill the process.
    setTimeout(() => {
      if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    }, 500).unref();
  }
}
