import { useEffect, useRef, useState } from "react";
import type { useVoice } from "./voice";

type Voice = ReturnType<typeof useVoice>;

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

const percent = (value: number) => `${Math.round(value * 100)}%`;

function VoiceSettings({ voice, onClose }: { voice: Voice; onClose: () => void }) {
  const {
    inputs,
    outputs,
    settings,
    canPickOutput,
    setInputDevice,
    setOutputDevice,
    setInputVolume,
    setOutputVolume,
    setDuckVideo,
  } = voice;
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!holder.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="voice-settings" ref={holder}>
      <label className="voice-field">
        <span>Microphone</span>
        <select
          value={settings.inputDeviceId}
          onChange={(e) => void setInputDevice(e.target.value)}
        >
          <option value="">System default</option>
          {inputs.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>

      <label className="voice-field">
        <span>
          Input volume <em>{percent(settings.inputVolume)}</em>
        </span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={settings.inputVolume}
          onChange={(e) => setInputVolume(Number(e.target.value))}
        />
      </label>

      {/* Only Chromium can route an element to a chosen speaker; elsewhere the
          browser follows the system default and a picker would be a lie. */}
      {canPickOutput && (
        <label className="voice-field">
          <span>Output</span>
          <select value={settings.outputDeviceId} onChange={(e) => setOutputDevice(e.target.value)}>
            <option value="">System default</option>
            {outputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="voice-field">
        <span>
          Output volume <em>{percent(settings.outputVolume)}</em>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.outputVolume}
          onChange={(e) => setOutputVolume(Number(e.target.value))}
        />
      </label>

      <label className="voice-check">
        <input
          type="checkbox"
          checked={settings.duckVideo}
          onChange={(e) => setDuckVideo(e.target.checked)}
        />
        <span>
          Lower the video while someone talks
          <em>The video doesn't stop for you — this makes room for whoever does.</em>
        </span>
      </label>
    </div>
  );
}

export function VoiceBar({ voice, myName }: { voice: Voice; myName: string }) {
  const {
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
    dismissError,
  } = voice;
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!inVoice) setSettingsOpen(false);
  }, [inVoice]);

  if (!inVoice) {
    return (
      <div className="voice voice-idle">
        <button className="voice-join" onClick={() => void join()} disabled={connecting}>
          🎙️ {connecting ? "Connecting…" : "Join voice"}
        </button>
        {/* However many are already talking — the reason to join, or not. */}
        {peers.length > 0 && (
          <span className="voice-hint">
            {peers.length === 1 ? "1 person is" : `${peers.length} people are`} in voice
          </span>
        )}
        {error && (
          <span className="voice-error" onClick={dismissError} role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }

  // "me" is the local meter's id in the hook; everyone else is keyed by the
  // socket the audio arrives on.
  const everyone = [{ peerId: "me", name: myName }, ...peers];

  return (
    <div className="voice">
      <div className="voice-people">
        {everyone.map((person) => {
          const isMe = person.peerId === "me";
          const isSpeaking = speaking.has(person.peerId) && !(isMe && muted);
          return (
            <div
              key={person.peerId}
              className={`voice-person${isSpeaking ? " is-speaking" : ""}`}
              title={isMe ? `${person.name} (you)` : person.name}
            >
              <span className="voice-avatar">{initials(person.name)}</span>
              <span className="voice-person-name">
                {person.name}
                {isMe && muted && <span className="voice-muted-mark">🔇</span>}
              </span>
            </div>
          );
        })}
      </div>

      <div className="voice-controls">
        <button
          className={`voice-control${muted ? " is-off" : ""}`}
          onClick={toggleMute}
          title={muted ? "Unmute" : "Mute"}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
        >
          {muted ? "🔇" : "🎙️"}
        </button>
        <button
          className={`voice-control${deafened ? " is-off" : ""}`}
          onClick={toggleDeafen}
          title={deafened ? "Undeafen" : "Deafen"}
          aria-label={deafened ? "Turn sound back on" : "Deafen"}
        >
          {deafened ? "🔕" : "🎧"}
        </button>
        <div className="voice-settings-menu">
          <button
            className="voice-control"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-expanded={settingsOpen}
            aria-label="Voice settings"
            title="Voice settings"
          >
            ⚙️
          </button>
          {settingsOpen && <VoiceSettings voice={voice} onClose={() => setSettingsOpen(false)} />}
        </div>
        <button className="voice-leave" onClick={leave}>
          Leave
        </button>
      </div>

      {error && (
        <p className="voice-error" onClick={dismissError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
