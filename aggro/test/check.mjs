// Automated checks for the built page, since Claude can't listen.
// Run after building:  node aggro/build.mjs && node aggro/test/check.mjs
// Needs Playwright with Chromium (preinstalled in Claude Code cloud sessions).
// Screenshots and the exported WAVs go to aggro/test/out/ (not committed).

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });
const pageUrl = pathToFileURL(join(here, '..', 'dist', 'Aggrotech generator.html')).href;

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const root = execSync('npm root -g').toString().trim();
    return createRequire(join(root, 'noop.js'))('playwright');
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ---- WAV analysis ----
function analyseWav(buf) {
  const str = (o, n) => buf.toString('ascii', o, o + n);
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12;
  let fmt = null;
  let data = null;
  while (o < buf.length) {
    const id = str(o, 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(o + 10), rate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    if (id === 'data') data = { start: o + 8, size };
    o += 8 + size + (size % 2);
  }
  const frames = data.size / (fmt.channels * 2);
  let peak = 0;
  let sum = 0;
  let atFull = 0;
  const n = frames * fmt.channels;
  const perSecond = [];
  let secSum = 0;
  let secN = 0;
  for (let i = 0; i < n; i++) {
    const x = buf.readInt16LE(data.start + i * 2) / 32768;
    const a = Math.abs(x);
    if (a > peak) peak = a;
    if (a >= 0.999) atFull++;
    sum += x * x;
    secSum += x * x;
    secN++;
    if (secN === fmt.rate * fmt.channels) {
      perSecond.push(20 * Math.log10(Math.sqrt(secSum / secN) || 1e-9));
      secSum = 0;
      secN = 0;
    }
  }
  const db = (v) => 20 * Math.log10(v || 1e-9);
  return { ...fmt, frames, seconds: frames / fmt.rate, peakDb: db(peak), rmsDb: db(Math.sqrt(sum / n)), fullScaleShare: atFull / n, perSecond };
}

// A short synthetic "shout" (noisy, pitched burst) to test vocal loading.
function makeTestVocal(path) {
  const rate = 44100;
  const frames = Math.floor(rate * 0.5);
  const b = Buffer.alloc(44 + frames * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + frames * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(frames * 2, 40);
  let seed = 1;
  for (let i = 0; i < frames; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const env = Math.min(1, i / 500) * Math.exp(-i / (rate * 0.2));
    const x = (Math.sin((2 * Math.PI * 180 * i) / rate) * 0.6 + ((seed / 0x7fffffff) * 2 - 1) * 0.4) * env * 0.7;
    b.writeInt16LE(Math.round(x * 32767), 44 + i * 2);
  }
  writeFileSync(path, b);
}

async function exportOnce(page, label) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export')]);
  const path = join(outDir, `${label}.wav`);
  await download.saveAs(path);
  await page.waitForFunction(() => !document.getElementById('export').disabled);
  return { path, name: download.suggestedFilename(), info: analyseWav(readFileSync(path)) };
}

function describeWav(w) {
  const i = w.info;
  return `${i.seconds.toFixed(2)} s, ${i.channels} ch, ${i.rate} Hz, peak ${i.peakDb.toFixed(2)} dB, average ${i.rmsDb.toFixed(1)} dB, samples at full scale ${(i.fullScaleShare * 100).toFixed(3)}%`;
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 900 } });
const page = await context.newPage();

const errors = [];
const network = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (r) => {
  const u = r.url();
  if (!/^(file|data|blob):/.test(u)) network.push(u);
});

await page.goto(pageUrl);
await page.waitForFunction(() => window.__aggro && window.__aggro.seed);

// ---- every control exists and responds ----
const ids = ['play', 'newTrack', 'volume', 'seed', 'copySeed', 'lock-drums', 'lock-bass', 'lock-lead', 'favName', 'export', 'loadVocals', 'clearVocals', 'vocalFiles', 'vocalLevel', 'vocalEvery', 'vocalDistort'];
const sliders = ['tempo', 'aggression', 'darkness', 'leadBlend', 'bassPattern', 'drums', 'sidechain', 'sectionLen'];
const missing = [];
for (const id of [...ids, ...sliders.map((s) => 'c-' + s)]) {
  if (!(await page.$('#' + id))) missing.push(id);
}
check('All controls are on the page', missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : `${ids.length + sliders.length} found`);

async function setRange(id, value) {
  await page.$eval(
    '#' + id,
    (el, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value
  );
}

const sliderResults = [];
for (const s of sliders) {
  const el = await page.$('#c-' + s);
  const max = Number(await el.getAttribute('max'));
  const min = Number(await el.getAttribute('min'));
  const before = await page.textContent('#o-' + s);
  const target = (await page.evaluate((k) => window.__aggro.settings[k], s)) === max ? min : max;
  await setRange('c-' + s, target);
  const after = await page.textContent('#o-' + s);
  const stored = await page.evaluate((k) => window.__aggro.settings[k], s);
  sliderResults.push({ s, ok: stored === target && before !== after, label: after });
}
check('Every slider updates its setting and label', sliderResults.every((r) => r.ok), sliderResults.map((r) => `${r.s}: ${r.label}`).join('; '));

// Back to sensible values for the audio checks.
const mid = { tempo: 140, aggression: 50, darkness: 2, leadBlend: 50, bassPattern: 0, drums: 70, sidechain: 60, sectionLen: 8 };
for (const [k, v] of Object.entries(mid)) await setRange('c-' + k, v);
await setRange('volume', 40);
check('Volume slider responds', (await page.evaluate(() => window.__aggro.settings.volume)) === 40);

// ---- play ----
await page.click('#play');
await page.waitForTimeout(2500);
const audioState = await page.evaluate(() => window.__aggro.audioState);
const pos1 = await page.evaluate(() => window.__aggro.position);
check('Audio starts on Play', audioState === 'running', `audio state: ${audioState}`);
check('The arrangement moves while playing', pos1 && pos1.name === 'intro', pos1 ? `at ${pos1.name}, bar ${pos1.bar + 1} of ${pos1.bars}` : 'no position');
check('Play button turns into Stop', (await page.textContent('#play')).trim() === 'Stop');

// Live slider moves while playing should not throw.
for (const k of sliders) await setRange('c-' + k, mid[k]);
await setRange('c-aggression', 100);
await setRange('c-aggression', 50);

// ---- new track and locks ----
const seedA = await page.evaluate(() => window.__aggro.seed);
await page.click('#newTrack');
const seedB = await page.evaluate(() => window.__aggro.seed);
check('New track changes the seed', seedA !== seedB, `${seedA} → ${seedB}`);
await page.click('#lock-drums');
await page.click('#newTrack');
const seedC = await page.evaluate(() => window.__aggro.seed);
const partsB = seedB.split('-');
const partsC = seedC.split('-');
check('Locking drums keeps the drum part of the seed', partsB[1] === partsC[1] && partsB[3] !== partsC[3], `${seedB} → ${seedC}`);
await page.click('#lock-bass');
await page.click('#newTrack');
const seedD = await page.evaluate(() => window.__aggro.seed);
const partsD = seedD.split('-');
check('Locking bass keeps bass and key; lead rerolls', partsC[0] === partsD[0] && partsC[2] === partsD[2] && partsC[3] !== partsD[3], `${seedC} → ${seedD}`);
await page.click('#lock-drums');
await page.click('#lock-bass');

// ---- typed seed ----
await page.fill('#seed', 'demon core');
await page.click('#seedForm button[type=submit]');
const wordSeed = await page.evaluate(() => window.__aggro.seed);
await page.fill('#seed', wordSeed.toLowerCase());
await page.click('#seedForm button[type=submit]');
check('Typed seeds load, and any word becomes a seed', /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/.test(wordSeed) && (await page.evaluate(() => window.__aggro.seed)) === wordSeed, wordSeed);

// ---- favorites ----
for (const [k, v] of Object.entries(mid)) await setRange('c-' + k, v);
const favSeed = await page.evaluate(() => window.__aggro.seed);
await page.fill('#favName', 'Test favorite');
await page.click('#favForm button');
await page.waitForTimeout(300);
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('aggro-gen-v1')));
check('Favorites save under aggro-gen-v1', stored && stored.favorites && stored.favorites[0] && stored.favorites[0].seed === favSeed, stored ? `${stored.favorites.length} saved` : 'nothing stored');
await page.click('#newTrack');
await page.click('#favList li button');
check('Recalling a favorite brings its seed back', (await page.evaluate(() => window.__aggro.seed)) === favSeed);

// ---- vocals ----
const vocalPath = join(outDir, 'test-shout.wav');
makeTestVocal(vocalPath);
await page.setInputFiles('#vocalFiles', vocalPath);
await page.waitForFunction(() => window.__aggro.vocalCount > 0, null, { timeout: 10000 }).catch(() => {});
check('Your own vocal files load', (await page.evaluate(() => window.__aggro.vocalCount)) === 1, await page.textContent('#vocalStatus'));

await page.waitForTimeout(1500);
const pos2 = await page.evaluate(() => window.__aggro.position);
check('Still playing after all the changes', pos2 && (pos2.bar !== pos1.bar || pos2.name !== pos1.name || pos2.step !== pos1.step), pos2 ? `at ${pos2.name}, bar ${pos2.bar + 1}` : '');

// ---- stop ----
await page.click('#play');
check('Stop works', (await page.textContent('#play')).trim() === 'Play' && (await page.textContent('#section')).trim() === 'Stopped');

// ---- export at normal settings (stopped: starts at the first build) ----
await setRange('c-sectionLen', 16);
const w1 = await exportOnce(page, 'export-normal');
check('WAV export is 30 seconds, stereo, 44.1 kHz', Math.abs(w1.info.seconds - 30) < 0.01 && w1.info.channels === 2 && w1.info.rate === 44100, describeWav(w1));
check('WAV export is not silent', w1.info.rmsDb > -35, `average ${w1.info.rmsDb.toFixed(1)} dB`);
check('WAV export does not clip', w1.info.peakDb < -0.5 && w1.info.fullScaleShare === 0, `peak ${w1.info.peakDb.toFixed(2)} dB`);
check('WAV file is named after the seed', w1.name.includes(await page.evaluate(() => window.__aggro.seed)), w1.name);
console.log('      loudness per second (dB):', w1.info.perSecond.map((v) => v.toFixed(0)).join(' '));

// ---- export at the extremes ----
for (const [k, v] of Object.entries({ aggression: 100, drums: 100, sidechain: 0, leadBlend: 50 })) await setRange('c-' + k, v);
await setRange('vocalLevel', 100);
const w2 = await exportOnce(page, 'export-max');
check('At full aggression and drums the limiter still holds', w2.info.peakDb < -0.5 && w2.info.fullScaleShare === 0, describeWav(w2));
console.log('      loudness per second (dB):', w2.info.perSecond.map((v) => v.toFixed(0)).join(' '));

for (const [k, v] of Object.entries({ aggression: 0, drums: 0, sidechain: 100, leadBlend: 100, darkness: 4, bassPattern: 4 })) await setRange('c-' + k, v);
const w3 = await exportOnce(page, 'export-min');
check('At zero aggression it is still audible', w3.info.rmsDb > -40, describeWav(w3));

// ---- layout ----
await page.emulateMedia({ colorScheme: 'dark' });
await page.screenshot({ path: join(outDir, 'wide-dark.png'), fullPage: true });
await page.emulateMedia({ colorScheme: 'light' });
await page.screenshot({ path: join(outDir, 'wide-light.png'), fullPage: true });
await page.setViewportSize({ width: 360, height: 800 });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('Narrow window (360 px): no sideways scrolling', overflow <= 0, `overflow ${overflow}px`);
await page.screenshot({ path: join(outDir, 'narrow-light.png'), fullPage: true });
await page.emulateMedia({ colorScheme: 'dark' });
await page.screenshot({ path: join(outDir, 'narrow-dark.png'), fullPage: true });

// ---- persistence across reloads ----
await page.reload();
await page.waitForFunction(() => window.__aggro && window.__aggro.seed);
const afterReload = await page.evaluate(() => ({ seed: window.__aggro.seed, favs: document.querySelectorAll('#favList li:not(.empty)').length }));
check('Seed and favorites survive a reload', afterReload.favs === 1, `seed ${afterReload.seed}, ${afterReload.favs} favorite`);

check('No console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
check('No network requests', network.length === 0, network.slice(0, 5).join(', '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
