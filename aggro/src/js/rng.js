// Seeded randomness. Everything random in a track comes from here, so the
// same seed always gives the same track.
//
// A seed looks like "H4KQ-D9TX-B2MN-L7PW": four parts, one each for
// harmony (key, scale, chords, tempo), drums, bass, and lead. Keeping the
// parts separate is what lets the lock toggles keep one part while the rest
// rerolls.

const SEED_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SEED_PARTS = ['harmony', 'drums', 'bass', 'lead'];

// FNV-1a: turns any string into a 32-bit number.
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32: small, fast, good enough for music.
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(...parts) {
  const r = mulberry32(hashString(parts.join('|')));
  return {
    next: r,
    range: (a, b) => a + (b - a) * r(),
    int: (a, b) => a + Math.floor(r() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    chance: (p) => r() < p,
    // pairs: [[value, weight], ...]
    weighted(pairs) {
      const total = pairs.reduce((s, p) => s + p[1], 0);
      let x = r() * total;
      for (const [v, w] of pairs) {
        if ((x -= w) < 0) return v;
      }
      return pairs[pairs.length - 1][0];
    },
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
}

// A fixed number in [0, 1) for a given key. Used for per-hit variation
// (velocity, noise offsets) so the WAV export is repeatable too.
function hash01(...parts) {
  return hashString(parts.join('|')) / 4294967296;
}

function randomSeedPart() {
  const bytes = new Uint8Array(4);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 4; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => SEED_ALPHABET[b % SEED_ALPHABET.length]).join('');
}

function newSeed() {
  return SEED_PARTS.map(randomSeedPart).join('-');
}

// Accepts a proper seed in any case and with any separators. Anything else
// (a word, a name) is turned into a proper seed by hashing, so any text works.
function normalizeSeed(text) {
  const clean = String(text || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!clean) return null;
  const valid = clean.length === 16 && [...clean].every((ch) => SEED_ALPHABET.includes(ch));
  if (valid) return clean.match(/.{4}/g).join('-');
  const r = makeRng('seed-from-text', clean);
  return SEED_PARTS.map(() =>
    Array.from({ length: 4 }, () => SEED_ALPHABET[Math.floor(r.next() * SEED_ALPHABET.length)]).join('')
  ).join('-');
}
