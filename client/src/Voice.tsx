import { useEffect, useRef, useState } from "react";
import type { useVoice } from "./voice";

type Voice = ReturnType<typeof useVoice>;
type MenuName = "input" | "output" | null;

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

const percent = (value: number) => `${Math.round(value * 100)}%`;

function DevicePanel({
  label,
  devices,
  deviceId,
  onDevice,
  volume,
  onVolume,
  maxVolume,
  children,
}: {
  label: string;
  devices: { deviceId: string; label: string }[];
  deviceId: string;
  onDevice: (id: string) => void;
  volume: number;
  onVolume: (value: number) => void;
  maxVolume: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="voice-menu">
      <label className="voice-field">
        <span>{label} device</span>
        <select value={deviceId} onChange={(e) => onDevice(e.target.value)}>
          <option value="">System default</option>
          {devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>

      <label className="voice-field">
        <span>
          {label} volume
          <em>
            {percent(volume)}
            {volume > 1 && " · boosted"}
          </em>
        </span>
        {/* The fill is drawn from the value rather than left to the browser:
            a native range leaves its thumb inset at the extremes, so a slider
            at maximum still looks a little short of it. */}
        <input
          type="range"
          className={maxVolume > 1 ? "has-unity-mark" : undefined}
          style={{ "--fill": `${(volume / maxVolume) * 100}%` } as React.CSSProperties}
          min={0}
          max={maxVolume}
          step={0.05}
          value={volume}
          onChange={(e) => onVolume(Number(e.target.value))}
        />
      </label>

      {children}
    </div>
  );
}

// A control and the menu that configures it, side by side — the way a mic
// button and its chevron work everywhere else. Clicking the button does the
// thing; clicking the chevron asks how the thing is done.
function ControlWithMenu({
  open,
  onToggle,
  onClose,
  button,
  caretLabel,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  button: React.ReactNode;
  caretLabel: string;
  children: React.ReactNode;
}) {
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
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
  }, [open, onClose]);

  return (
    <div className="voice-control-group" ref={holder}>
      {button}
      <button
        className="voice-caret"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={caretLabel}
        title={caretLabel}
      >
        ▾
      </button>
      {open && children}
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
    mutedPeers,
    error,
    inputs,
    outputs,
    settings,
    canPickOutput,
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
    dismissError,
  } = voice;
  const [menu, setMenu] = useState<MenuName>(null);

  useEffect(() => {
    if (!inVoice) setMenu(null);
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
          const silenced = mutedPeers.has(person.peerId);
          const isSpeaking = speaking.has(person.peerId) && !(isMe && muted) && !silenced;
          return (
            <div
              key={person.peerId}
              className={`voice-person${isSpeaking ? " is-speaking" : ""}${silenced ? " is-silenced" : ""}`}
              title={isMe ? `${person.name} (you)` : person.name}
            >
              <span className="voice-avatar">{initials(person.name)}</span>
              <span className="voice-person-name">
                {person.name}
                {isMe && muted && <span className="voice-muted-mark">🔇</span>}
              </span>
              {/* Silencing someone is yours alone — it changes what you hear,
                  not what anyone else does, so it lives on their chip rather
                  than in a menu that suggests it has wider reach. */}
              {!isMe && (
                <button
                  className="voice-person-mute"
                  onClick={() => togglePeerMute(person.peerId)}
                  title={silenced ? `Unmute ${person.name} for you` : `Mute ${person.name} for you`}
                  aria-label={silenced ? `Unmute ${person.name}` : `Mute ${person.name}`}
                  aria-pressed={silenced}
                >
                  {silenced ? "🔇" : "🔊"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="voice-controls">
        <ControlWithMenu
          open={menu === "input"}
          onToggle={() => setMenu((m) => (m === "input" ? null : "input"))}
          onClose={() => setMenu(null)}
          caretLabel="Input settings"
          button={
            <button
              className={`voice-control${muted ? " is-off" : ""}`}
              onClick={toggleMute}
              title={muted ? "Unmute" : "Mute"}
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            >
              {muted ? "🔇" : "🎙️"}
            </button>
          }
        >
          <DevicePanel
            label="Input"
            devices={inputs}
            deviceId={settings.inputDeviceId}
            onDevice={(id) => void setInputDevice(id)}
            volume={settings.inputVolume}
            onVolume={setInputVolume}
            // Above 100% is a boost for microphones that are simply too quiet —
            // useful, and worth labelling, because pushed far enough it will
            // clip rather than just get louder.
            maxVolume={2}
          />
        </ControlWithMenu>

        <ControlWithMenu
          open={menu === "output"}
          onToggle={() => setMenu((m) => (m === "output" ? null : "output"))}
          onClose={() => setMenu(null)}
          caretLabel="Output settings"
          button={
            <button
              className={`voice-control${deafened ? " is-off" : ""}`}
              onClick={toggleDeafen}
              title={deafened ? "Undeafen" : "Deafen"}
              aria-label={deafened ? "Turn sound back on" : "Deafen"}
            >
              {deafened ? "🔕" : "🎧"}
            </button>
          }
        >
          <DevicePanel
            label="Output"
            // Only Chromium can route an element to a chosen speaker; elsewhere
            // the browser follows the system default and a picker would lie.
            devices={canPickOutput ? outputs : []}
            deviceId={settings.outputDeviceId}
            onDevice={setOutputDevice}
            volume={settings.outputVolume}
            onVolume={setOutputVolume}
            maxVolume={1}
          >
            <label className="voice-check">
              <input
                type="checkbox"
                checked={settings.duckVideo}
                onChange={(e) => setDuckVideo(e.target.checked)}
              />
              <span className="voice-check-text">
                Lower the video while someone talks
                <em>Turns the video down so you can hear whoever's speaking.</em>
              </span>
            </label>
          </DevicePanel>
        </ControlWithMenu>

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
