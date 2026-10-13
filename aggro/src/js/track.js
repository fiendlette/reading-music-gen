// Turns a seed into a track: the key and chords, the drum kit and patterns,
// the bass line and sound, and the lead riffs and sounds. Original material
// built from the genre's traits; nothing here copies a real song.

// Bass patterns, one per position of the Bass pattern slider. `note(step,
// bar, track)` returns {deg, oct, len} or null for a rest. Steps are 16th
// notes, 0-15 in a bar; most patterns rest on the kick so the bass sits
// under it rather than on top of it.
const BASS_PATTERNS = [
  { name: 'Rolling 16ths', note: (s) => (s % 4 === 0 ? null : { deg: 0, oct: 0, len: 1 }) },
  { name: 'Offbeat 8ths', note: (s) => (s % 4 === 2 ? { deg: 0, oct: 0, len: 2 } : null) },
  { name: 'Octave bounce', note: (s) => (s % 4 === 0 ? null : { deg: 0, oct: s % 4 === 2 ? 12 : 0, len: 1 }) },
  { name: 'Gallop', note: (s) => (s % 4 >= 2 ? { deg: 0, oct: s % 4 === 3 ? 12 : 0, len: 1 } : null) },
  { name: 'Riff', note: (s, bar, tr) => tr.bass.riff[(bar % 2) * 16 + s] },
];

function generateTrack(seed) {
  const [hs, ds, bs, ls] = seed.split('-');
  return {
    seed,
    harmony: genHarmony(hs),
    drums: genDrums(ds),
    bass: genBass(bs),
    lead: genLead(ls),
  };
}

function genHarmony(key) {
  const r = makeRng('harmony', key);
  const rootPc = r.int(0, 11);
  const darkness = r.weighted([[0, 3], [1, 3], [2, 3], [3, 1.5], [4, 0.6]]);
  const tempo = r.int(134, 148);
  const chosen = r.shuffle(PROGRESSION_POOLS[darkness]);
  // Shapes favour staying on the home chord: short repeating riffs, not
  // wandering harmony.
  const shape = r.pick([
    [0, 0, 1, 2],
    [0, 1, 0, 2],
    [0, 1, 2, 3],
    [0, 0, 0, 1],
    [0, 1, 0, 1],
    [0, 0, 1, 1],
  ]);
  const prog = shape.map((k) => (k === 0 ? 0 : chosen[k - 1]));
  return { rootPc, darkness, tempo, prog };
}

function genDrums(key) {
  const r = makeRng('drums', key);
  const perc = [];
  const percDensity = r.range(0.12, 0.3);
  for (let s = 0; s < 16; s++) perc.push(s % 4 !== 0 && r.chance(percDensity));
  return {
    kick: {
      pStart: r.range(150, 230), // pitch at the hit, in hertz
      pTime: r.range(0.03, 0.065), // how fast it drops
      decay: r.range(0.17, 0.3),
      click: r.range(0.25, 0.7),
      grit: r.range(0, 1),
    },
    clap: {
      tone: r.range(1100, 2200),
      decay: r.range(0.12, 0.24),
      body: r.range(0.1, 0.6),
      verb: r.range(0.25, 0.5),
    },
    hat: {
      tone: r.range(6500, 9500),
      decay: r.range(0.022, 0.05),
      accents: Array.from({ length: 16 }, (_, i) => (i % 4 === 2 ? 1 : r.range(0.35, 0.8))),
    },
    openHats: r.pick([[2, 6, 10, 14], [6, 14], [2, 10], [2, 6, 10, 14, 15]]),
    ghostKicks: r.pick([[14], [15], [10], [7, 15], [13]]),
    perc: { type: r.pick(['zap', 'metal']), steps: perc, pitch: r.range(0.8, 1.3) },
    fill: r.pick(['16ths', '8ths-then-16ths']),
    suggestedIntensity: r.int(45, 80),
  };
}

function genBass(key) {
  const r = makeRng('bass', key);
  const density = r.range(0.55, 0.85);
  const riff = [];
  for (let i = 0; i < 32; i++) {
    const s = i % 16;
    if (s % 4 === 0 && r.chance(0.85)) riff.push(null);
    else if (r.chance(density)) {
      riff.push({
        deg: r.weighted([[0, 7], [4, 1.2], [2, 0.6], [-1, 0.4]]),
        oct: r.chance(0.25) ? 12 : 0,
        len: r.chance(0.2) ? 2 : 1,
      });
    } else riff.push(null);
  }
  if (!riff.some(Boolean)) riff[2] = { deg: 0, oct: 0, len: 1 };
  return {
    riff,
    sound: {
      detune: r.range(4, 14), // cents between the two saws
      cutoff: r.range(260, 600), // filter resting point, hertz
      env: r.range(900, 2400), // how far the filter opens on each note
      q: r.range(3, 8), // filter resonance
      decay: r.range(0.07, 0.17),
      sub: r.chance(0.5),
    },
    turnaround: r.chance(0.6),
    suggestedPattern: r.weighted([[0, 3], [1, 1.5], [2, 2.5], [3, 1.5], [4, 2.5]]),
  };
}

// Stab gate: which 16ths the supersaw chord plays on (trance-style chop).
function makeGate(r) {
  const dens = r.range(0.45, 0.7);
  const g = [];
  for (let s = 0; s < 16; s++) {
    const on = s === 0 || (s % 4 === 0 ? r.chance(0.7) : r.chance(dens * (s % 2 ? 0.8 : 1)));
    g.push(on ? { len: 1, accent: s % 4 === 0 || r.chance(0.3), inv: r.chance(0.15) ? 1 : 0 } : null);
  }
  // Merge some neighbours into longer stabs.
  for (let s = 0; s < 15; s++) {
    if (g[s] && !g[s + 1] && r.chance(0.35)) g[s].len = 2;
  }
  return g;
}

function mutateGate(gate, r, amount) {
  return gate.map((cell, s) => {
    if (s === 0 || !r.chance(amount)) return cell ? { ...cell } : null;
    return cell ? null : { len: 1, accent: r.chance(0.4), inv: 0 };
  });
}

// Hoover riff: a one-bar motif, repeated with a changed ending.
function makeHooverBar(r) {
  const notes = [];
  let t = 0;
  while (t < 16) {
    const len = r.pick([2, 2, 3, 4, 6]);
    if (t === 0 || r.chance(0.7)) {
      notes.push({ step: t, len: Math.min(len, 16 - t), deg: r.weighted([[0, 4], [2, 2], [4, 2], [7, 1.2], [-2, 0.8], [1, 0.6]]) });
    }
    t += len;
  }
  return notes;
}

function hooverVariant(bar, r, amount) {
  const second = bar.map((n) => ({ ...n }));
  const last = second[second.length - 1];
  last.deg = r.pick([4, 7, -2, 2, 1]);
  const first = bar.map((n) => ({ ...n, deg: r.chance(amount) ? n.deg + r.pick([-1, 1, 2]) : n.deg }));
  return [...first, ...second.map((n) => ({ ...n, step: n.step + 16 }))];
}

// Index notes by step so the scheduler can look them up quickly.
function indexByStep(notes) {
  const map = new Array(32).fill(null);
  for (const n of notes) map[n.step] = n;
  return map;
}

function genLead(key) {
  const r = makeRng('lead', key);
  const gate = makeGate(r);
  const stabVariants = [0, 0.12, 0.25].map((amt) => [...mutateGate(gate, r, amt), ...mutateGate(gate, r, amt + 0.1)]);
  const motif = makeHooverBar(r);
  const hooverVariants = [0, 0.2, 0.4].map((amt) => indexByStep(hooverVariant(motif, r, amt)));
  return {
    stabVariants,
    hooverVariants,
    stab: {
      detune: r.range(12, 28), // cents of spread across the five saws
      decay: r.range(0.08, 0.2),
      cutoff: r.range(2600, 5500),
    },
    hoover: {
      detune: r.range(14, 30),
      bend: r.range(2, 5), // semitones it swoops up from
      glide: r.range(0.03, 0.09),
      dive: r.chance(0.6), // pitch drop on release
    },
    delayMix: r.range(0.08, 0.22),
    suggestedBlend: r.int(20, 80),
  };
}
