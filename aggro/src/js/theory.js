// Scales and chords. The Darkness slider picks the mode; riffs are stored as
// scale steps, so they follow whatever mode is chosen.

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

// Ordered roughly from least to most dark.
const MODES = [
  { name: 'Natural minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  { name: 'Phrygian dominant', steps: [0, 1, 4, 5, 7, 8, 10] },
  { name: 'Locrian', steps: [0, 1, 3, 5, 6, 8, 10] },
];

// Chords (other than the home chord) that suit each mode, by scale step
// counted from 0.
const PROGRESSION_POOLS = [
  [5, 6, 3, 4], // natural minor: VI, VII, iv, v
  [5, 4, 3, 6], // harmonic minor: VI, V, iv, VII
  [1, 6, 3, 5], // Phrygian: II, vii, iv, VI
  [1, 6, 3, 4], // Phrygian dominant: II, vii, iv, v
  [1, 5, 6, 3], // Locrian: II, VI, vii, iv
];

// Semitones above the key's root for a scale step (any integer; wraps by octave).
function degreeSemis(mode, deg) {
  const o = Math.floor(deg / 7);
  const i = ((deg % 7) + 7) % 7;
  return mode.steps[i] + 12 * o;
}

// Three-note chord on a scale step, as semitones above the key's root.
function triad(mode, deg) {
  return [deg, deg + 2, deg + 4].map((d) => degreeSemis(mode, d));
}

function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}
