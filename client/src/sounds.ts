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

// A direct message is the same news as chat — someone said something — so it
// borrows chat's shape and inverts its direction. Falling where the room ping
// rises tells the two apart without a second listen, which matters because
// they can arrive seconds apart and mean entirely different things: one is the
// room you're looking at, the other is someone who isn't in it.
export const playDmPing = () =>
  play(
    [
      { freq: 1174.66, at: 0, dur: 0.1 }, // D6
      { freq: 739.99, at: 0.085, dur: 0.17 }, // F#5
    ],
    0.28,
  );
