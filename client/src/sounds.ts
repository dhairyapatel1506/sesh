// Every cue in the app, synthesized. No audio files to ship, load or cache —
// and a two-tone blip built from oscillators is a few lines, where a set of
// recorded samples is a folder of assets and a licensing question.

let context: AudioContext | null = null;

// One AudioContext for the whole app. They're a limited resource (browsers cap
// them per page) and each one costs an audio thread.
function ctx(): AudioContext | null {
  try {
    return (context ??= new AudioContext());
  } catch {
    return null; // no Web Audio — everything below becomes a no-op
  }
}

// Browsers keep an AudioContext suspended until a user gesture. Call this from
// any click so the first cue that matters isn't the one that gets swallowed.
export function warmAudio(): void {
  const audio = ctx();
  if (audio?.state === "suspended") void audio.resume();
}

type Step = {
  freq: number;
  /** seconds from the start of the cue */
  at: number;
  dur: number;
  type?: OscillatorType;
};

function play(steps: Step[], volume: number): void {
  const audio = ctx();
  if (!audio) return;
  if (audio.state === "suspended") void audio.resume();

  const now = audio.currentTime;
  for (const step of steps) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = step.type ?? "sine";
    osc.frequency.setValueAtTime(step.freq, now + step.at);

    // Ramps rather than steps at both ends: an instant start or stop on a sine
    // wave is a click, which is more noticeable than the note itself.
    const start = now + step.at;
    const end = start + step.dur;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

// Chat has to cut through whatever's playing — it competes with a music video
// on the same speakers, which is why it's the loudest thing here and why it's
// two notes rather than one. A single short beep at this level reads as part
// of the song; an interval that isn't in the music doesn't.
export const playChatPing = () =>
  play(
    [
      { freq: 880, at: 0, dur: 0.11 }, // A5
      { freq: 1318.5, at: 0.085, dur: 0.16 }, // E6
    ],
    0.32,
  );

// Rising for arrivals, falling for departures — the direction carries the
// meaning, so nobody has to learn which sound is which.
export const playVoiceJoin = () =>
  play(
    [
      { freq: 523.25, at: 0, dur: 0.09 }, // C5
      { freq: 783.99, at: 0.07, dur: 0.14 }, // G5
    ],
    0.22,
  );

export const playVoiceLeave = () =>
  play(
    [
      { freq: 783.99, at: 0, dur: 0.09 },
      { freq: 523.25, at: 0.07, dur: 0.16 },
    ],
    0.22,
  );

// Someone else coming or going is the same shape, quieter and lower: it's
// news about another person, not about you.
export const playPeerJoin = () =>
  play(
    [
      { freq: 392, at: 0, dur: 0.07 }, // G4
      { freq: 587.33, at: 0.06, dur: 0.11 }, // D5
    ],
    0.16,
  );

export const playPeerLeave = () =>
  play(
    [
      { freq: 587.33, at: 0, dur: 0.07 },
      { freq: 392, at: 0.06, dur: 0.12 },
    ],
    0.16,
  );

// Your own mic and speakers: short, dry, unmusical. These fire often, and
// anything with a tail gets irritating by the tenth time.
export const playMute = () => play([{ freq: 320, at: 0, dur: 0.07, type: "triangle" }], 0.2);
export const playUnmute = () => play([{ freq: 560, at: 0, dur: 0.07, type: "triangle" }], 0.2);

export const playDeafen = () =>
  play(
    [
      { freq: 400, at: 0, dur: 0.06, type: "triangle" },
      { freq: 260, at: 0.055, dur: 0.1, type: "triangle" },
    ],
    0.2,
  );

export const playUndeafen = () =>
  play(
    [
      { freq: 260, at: 0, dur: 0.06, type: "triangle" },
      { freq: 400, at: 0.055, dur: 0.1, type: "triangle" },
    ],
    0.2,
  );
