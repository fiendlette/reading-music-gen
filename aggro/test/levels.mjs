// Level meter for tuning the mix without ears. Renders a track offline and
// reports peak and average level per section, for the whole mix before the
// limiter, after it, and for each part on its own.
//
//   node aggro/test/levels.mjs [seed] [aggression, e.g. 50 or 0,50,100]
//
// Levels are in dB below full scale (0 is the maximum). The limiter starts
// working at -4 dB, so a pre-limiter peak far above that means it is
// squashing hard.

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const seed = process.argv[2] || 'K7Q2-M9XA-3PLD-T4VW';
const aggressions = (process.argv[3] || '50').split(',').map(Number);

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const root = execSync('npm root -g').toString().trim();
    return createRequire(join(root, 'noop.js'))('playwright');
  }
}

const files = ['rng.js', 'theory.js', 'track.js', 'engine.js', 'wav.js'];
const source = files.map((f) => readFileSync(join(here, '..', 'src', 'js', f), 'utf8')).join('\n');

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<!doctype html><title>levels</title>');
await page.addScriptTag({ content: source + '\nwindow.__lib = { Engine, generateTrack, initialState, sectionBars, ARRANGEMENT };' });

const report = await page.evaluate(
  async ({ seed, aggressions }) => {
    const { Engine, generateTrack, initialState, sectionBars, ARRANGEMENT } = window.__lib;
    const SECONDS = 30;
    const RATE = 44100;
    const outs = ['kickOut', 'drumMake', 'synthMake', 'crushAmt', 'verbOut', 'fxBus'];
    const parts = {
      kick: ['kickOut'],
      drums: ['drumMake'],
      synths: ['synthMake', 'crushAmt'],
    };
    const track = generateTrack(seed);
    const db = (x) => (x > 0 ? 20 * Math.log10(x) : -120);

    async function render(settings, tap) {
      const off = new OfflineAudioContext(2, RATE * SECONDS, RATE);
      const eng = new Engine(off, settings, track, []);
      if (tap !== 'master') {
        eng.mix.disconnect();
        eng.mix.connect(off.destination);
        if (tap !== 'mix') {
          for (const o of outs) eng[o].disconnect(eng.mix);
          for (const o of parts[tap]) eng[o].connect(eng.mix);
        }
      }
      eng.renderOffline(initialState(0, 0, 0, settings), SECONDS);
      return off.startRendering();
    }

    function sections(settings) {
      const bar = (60 / settings.tempo) * 4;
      let t = 0;
      const list = [];
      for (let i = 0; i < ARRANGEMENT.length && t < SECONDS; i++) {
        const len = sectionBars(ARRANGEMENT[i], settings.sectionLen) * bar;
        list.push({ name: ARRANGEMENT[i], from: t, to: Math.min(SECONDS, t + len) });
        t += len;
      }
      return list;
    }

    function measure(buf, secs) {
      return secs.map((s) => {
        let peak = 0;
        let sum = 0;
        let n = 0;
        for (let ch = 0; ch < 2; ch++) {
          const d = buf.getChannelData(ch);
          for (let i = Math.floor(s.from * RATE); i < Math.floor(s.to * RATE); i++) {
            const a = Math.abs(d[i]);
            if (a > peak) peak = a;
            sum += d[i] * d[i];
            n++;
          }
        }
        return { name: s.name, peak: db(peak), rms: db(Math.sqrt(sum / Math.max(1, n))) };
      });
    }

    const out = [];
    for (const aggression of aggressions) {
      const settings = {
        tempo: 140, aggression, darkness: track.harmony.darkness, leadBlend: 50, bassPattern: 0,
        drums: 70, sidechain: 60, sectionLen: 8, volume: 100, vocalLevel: 0, vocalEvery: 4, vocalDistort: false,
      };
      const secs = sections(settings);
      const rows = {};
      for (const tap of ['master', 'mix', ...Object.keys(parts)]) rows[tap] = measure(await render(settings, tap), secs);
      out.push({ aggression, sections: secs.map((s) => s.name), rows });
    }
    return out;
  },
  { seed, aggressions }
);

await browser.close();

console.log(`Seed ${seed}. Each cell: peak / average (dB). Section length 8 bars.\n`);
for (const r of report) {
  console.log(`Aggression ${r.aggression}%`);
  console.log('  ' + 'part'.padEnd(10) + r.sections.map((s) => s.padStart(14)).join(''));
  for (const [tap, cells] of Object.entries(r.rows)) {
    const label = tap === 'master' ? 'output' : tap === 'mix' ? 'pre-limit' : tap;
    console.log('  ' + label.padEnd(10) + cells.map((c) => `${c.peak.toFixed(1)} / ${c.rms.toFixed(1)}`.padStart(14)).join(''));
  }
  console.log('');
}
