import type { useVoice } from "./voice";

type Voice = ReturnType<typeof useVoice>;

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

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
  const everyone = [{ peerId: "me", name: myName }, ...peers.filter((p) => p.peerId !== "me")];

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
