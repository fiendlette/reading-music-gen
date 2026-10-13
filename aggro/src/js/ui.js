// The page: controls, seed and locks, favorites, export, vocals, and the
// live display.

const STORE_KEY = 'aggro-gen-v1';

const DEFAULTS = {
  tempo: 140,
  aggression: 45,
  darkness: 0,
  leadBlend: 50,
  bassPattern: 0,
  drums: 60,
  sidechain: 60,
  sectionLen: 16,
  volume: 45,
  vocalLevel: 70,
  vocalEvery: 4,
  vocalDistort: true,
};

const CONTROLS = [
  { id: 'tempo', label: 'Tempo', hint: 'beats per minute', min: 125, max: 155, step: 1, fmt: (v) => `${v}` },
  { id: 'aggression', label: 'Aggression', hint: 'distortion and bitcrush', min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
  { id: 'darkness', label: 'Darkness', hint: 'which scale', min: 0, max: 4, step: 1, fmt: (v) => MODES[v].name },
  {
    id: 'leadBlend',
    label: 'Lead blend',
    hint: 'supersaw stabs to hoover',
    min: 0,
    max: 100,
    step: 1,
    fmt: (v) => (v <= 5 ? 'All supersaw' : v >= 95 ? 'All hoover' : `${100 - v} / ${v}`),
  },
  { id: 'bassPattern', label: 'Bass pattern', hint: '', min: 0, max: BASS_PATTERNS.length - 1, step: 1, fmt: (v) => BASS_PATTERNS[v].name },
  { id: 'drums', label: 'Drum intensity', hint: 'hats, fills, extra hits', min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
  { id: 'sidechain', label: 'Sidechain depth', hint: 'how hard bass and synths duck on each kick', min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
  { id: 'sectionLen', label: 'Section length', hint: 'bars per drop; other sections are half', min: 8, max: 32, step: 4, fmt: (v) => `${v} bars` },
];

const SECTION_WORDS = { intro: 'Intro', build: 'Build', drop: 'Drop', break: 'Break' };

const $ = (id) => document.getElementById(id);

const app = {
  settings: { ...DEFAULTS },
  seed: null,
  track: null,
  locks: { drums: false, bass: false, lead: false },
  favorites: [],
  ctx: null,
  engine: null,
  vocals: [],
  vocalNames: [],
  pos: null,
  stepQueue: [],
};

// ---- storage ----

function loadStore() {
  try {
    const j = JSON.parse(localStorage.getItem(STORE_KEY));
    if (j && j.v === 1) return j;
  } catch (e) {
    /* storage blocked or empty */
  }
  return null;
}

let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          v: 1,
          favorites: app.favorites,
          current: { seed: app.seed, settings: app.settings, locks: app.locks },
        })
      );
    } catch (e) {
      /* storage blocked; the page still works */
    }
  }, 150);
}

// ---- seed and track ----

// parts: which seed parts' suggestions to copy into the sliders.
function setSeed(seed, parts) {
  app.seed = seed;
  app.track = generateTrack(seed);
  const t = app.track;
  const s = app.settings;
  if (parts.includes('harmony')) {
    s.tempo = t.harmony.tempo;
    s.darkness = t.harmony.darkness;
  }
  if (parts.includes('drums')) s.drums = t.drums.suggestedIntensity;
  if (parts.includes('bass')) s.bassPattern = t.bass.suggestedPattern;
  if (parts.includes('lead')) s.leadBlend = t.lead.suggestedBlend;
  if (app.engine) {
    app.engine.pendingTrack = t;
    app.engine.applyLive();
  }
  $('seed').value = seed;
  refreshControls();
  saveStore();
}

function newTrack() {
  const old = app.seed.split('-');
  const fresh = newSeed().split('-');
  const L = app.locks;
  // A locked bass or lead keeps the key and chords too, so it sounds the same.
  const keepHarmony = L.bass || L.lead;
  const next = [keepHarmony ? old[0] : fresh[0], L.drums ? old[1] : fresh[1], L.bass ? old[2] : fresh[2], L.lead ? old[3] : fresh[3]];
  const parts = [];
  if (!keepHarmony) parts.push('harmony');
  if (!L.drums) parts.push('drums');
  if (!L.bass) parts.push('bass');
  if (!L.lead) parts.push('lead');
  setSeed(next.join('-'), parts);
}

function loadSeedFromInput() {
  const seed = normalizeSeed($('seed').value);
  if (!seed) {
    $('seed').value = app.seed;
    return;
  }
  setSeed(seed, SEED_PARTS);
}

// ---- controls ----

function buildControls() {
  const wrap = $('controls');
  for (const c of CONTROLS) {
    const div = document.createElement('div');
    div.className = 'ctl';
    div.innerHTML = `
      <div class="ctl-head">
        <label for="c-${c.id}">${c.label}${c.hint ? ` <span class="hint">${c.hint}</span>` : ''}</label>
        <output id="o-${c.id}" for="c-${c.id}"></output>
      </div>
      <input type="range" id="c-${c.id}" min="${c.min}" max="${c.max}" step="${c.step}">`;
    wrap.appendChild(div);
    div.querySelector('input').addEventListener('input', (e) => {
      app.settings[c.id] = Number(e.target.value);
      refreshControls();
      if (app.engine) app.engine.applyLive();
      saveStore();
    });
  }
}

function refreshControls() {
  const s = app.settings;
  for (const c of CONTROLS) {
    $('c-' + c.id).value = s[c.id];
    $('o-' + c.id).textContent = c.fmt(s[c.id]);
  }
  $('volume').value = s.volume;
  $('o-volume').textContent = `${s.volume}%`;
  $('vocalLevel').value = s.vocalLevel;
  $('o-vocalLevel').textContent = `${s.vocalLevel}%`;
  $('vocalEvery').value = String(s.vocalEvery);
  $('vocalDistort').checked = !!s.vocalDistort;
  for (const part of ['drums', 'bass', 'lead']) {
    $('lock-' + part).setAttribute('aria-pressed', String(app.locks[part]));
  }
  const h = app.track.harmony;
  $('keyinfo').textContent = `${NOTE_NAMES[h.rootPc]} ${MODES[s.darkness].name.toLowerCase()} · ${s.tempo} beats per minute`;
}

// ---- play / stop ----

async function ensureContext() {
  if (!app.ctx) app.ctx = new AudioContext({ latencyHint: 'playback' });
  if (app.ctx.state !== 'running') await app.ctx.resume();
  return app.ctx;
}

async function play() {
  const ctx = await ensureContext();
  if (app.engine) return;
  app.engine = new Engine(ctx, app.settings, app.track, app.vocals);
  app.engine.onStep = (t, info) => app.stepQueue.push({ t, info });
  app.engine.start();
  $('play').textContent = 'Stop';
  $('play').setAttribute('aria-pressed', 'true');
  document.body.classList.add('playing');
  requestAnimationFrame(draw);
}

function stop() {
  if (!app.engine) return;
  app.engine.stop();
  app.engine = null;
  app.stepQueue = [];
  app.pos = null;
  $('play').textContent = 'Play';
  $('play').setAttribute('aria-pressed', 'false');
  document.body.classList.remove('playing');
  $('section').textContent = 'Stopped';
  $('barinfo').textContent = '';
  document.querySelectorAll('#steps span').forEach((el) => el.classList.remove('on'));
}

// ---- live display ----

let scopeData = null;
function draw() {
  if (!app.engine) {
    clearScope();
    return;
  }
  const now = app.ctx.currentTime;
  let latest = null;
  while (app.stepQueue.length && app.stepQueue[0].t <= now) latest = app.stepQueue.shift().info;
  if (latest) {
    app.pos = latest;
    $('section').textContent = SECTION_WORDS[latest.name];
    $('barinfo').textContent = `bar ${latest.bar + 1} of ${latest.bars}`;
    const cells = document.querySelectorAll('#steps span');
    cells.forEach((el, i) => el.classList.toggle('on', i === latest.step));
    document.body.dataset.section = latest.name;
  }
  const canvas = $('scope');
  const an = app.engine.analyser;
  if (!scopeData || scopeData.length !== an.fftSize) scopeData = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(scopeData);
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  g.lineWidth = 1.5 * devicePixelRatio;
  g.beginPath();
  for (let i = 0; i < scopeData.length; i++) {
    const x = (i / (scopeData.length - 1)) * w;
    const y = h / 2 - scopeData[i] * (h / 2) * 1.05;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.stroke();
  requestAnimationFrame(draw);
}

function clearScope() {
  const canvas = $('scope');
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
}

// ---- favorites ----

function renderFavorites() {
  const list = $('favList');
  list.innerHTML = '';
  if (!app.favorites.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing saved yet.';
    list.appendChild(li);
    return;
  }
  app.favorites.forEach((f, i) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'fav-name';
    name.textContent = f.name;
    const seed = document.createElement('span');
    seed.className = 'fav-seed';
    seed.textContent = f.seed;
    const recall = document.createElement('button');
    recall.type = 'button';
    recall.textContent = 'Recall';
    recall.addEventListener('click', () => recallFavorite(i));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'quiet';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete ${f.name}`);
    del.addEventListener('click', () => {
      app.favorites.splice(i, 1);
      renderFavorites();
      saveStore();
    });
    li.append(name, seed, recall, del);
    list.appendChild(li);
  });
}

function saveFavorite(e) {
  e.preventDefault();
  const name = $('favName').value.trim() || `Track ${app.favorites.length + 1}`;
  app.favorites.unshift({ name, seed: app.seed, settings: { ...app.settings }, saved: new Date().toISOString().slice(0, 10) });
  $('favName').value = '';
  renderFavorites();
  saveStore();
}

function recallFavorite(i) {
  const f = app.favorites[i];
  // Keep the same settings object: the engine holds a reference to it.
  Object.assign(app.settings, DEFAULTS, f.settings, { volume: app.settings.volume });
  setSeed(f.seed, []);
}

// ---- export ----

async function exportWav() {
  const btn = $('export');
  const status = $('exportStatus');
  btn.disabled = true;
  status.textContent = 'Rendering 30 seconds…';
  try {
    const rate = 44100;
    const secs = 30;
    const off = new OfflineAudioContext(2, rate * secs, rate);
    // Exports are made at full volume (the limiter still applies), so files
    // can be compared with each other whatever the Volume slider says.
    const settings = { ...app.settings, volume: 100 };
    const eng = new Engine(off, settings, app.track, app.vocals);
    // While playing: from the start of the current section. Otherwise: from
    // the first build, so the file includes a drop.
    const from = app.pos
      ? initialState(app.pos.sec, app.pos.cycle, app.pos.dropNo - (app.pos.name === 'drop' ? 1 : 0), settings)
      : initialState(1, 0, 0, settings);
    eng.renderOffline(from, secs);
    const buf = await off.startRendering();
    const lv = measureLevels(buf);
    const name = `Aggrotech ${app.seed}.wav`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(encodeWav(buf));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    status.textContent = `Saved “${name}”. Loudest point ${lv.peakDb.toFixed(1)} dB, average ${lv.rmsDb.toFixed(1)} dB (0 is the maximum).`;
  } catch (err) {
    status.textContent = `Couldn't render: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---- vocals ----

async function loadVocals(files) {
  const status = $('vocalStatus');
  if (!files.length) return;
  status.textContent = 'Loading…';
  const ctx = app.ctx || (app.ctx = new AudioContext({ latencyHint: 'playback' }));
  let failed = 0;
  for (const file of files) {
    try {
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      app.vocals.push(buf); // same array the engine reads
      app.vocalNames.push(file.name);
    } catch (e) {
      failed++;
    }
  }
  renderVocals(failed);
}

function renderVocals(failed = 0) {
  const n = app.vocals.length;
  let msg = n
    ? `${n} sample${n === 1 ? '' : 's'} loaded: ${app.vocalNames.join(', ')}. They play in drops and at the start of builds.`
    : 'None loaded, so no vocals.';
  if (failed) msg += ` ${failed} file${failed === 1 ? '' : 's'} couldn't be read as audio.`;
  $('vocalStatus').textContent = msg;
  $('clearVocals').disabled = !n;
}

// ---- start up ----

function init() {
  buildControls();
  const stored = loadStore();
  if (stored) {
    app.favorites = Array.isArray(stored.favorites) ? stored.favorites : [];
    const cur = stored.current || {};
    Object.assign(app.settings, DEFAULTS, cur.settings || {});
    Object.assign(app.locks, cur.locks || {});
  }
  const seed = (stored && stored.current && normalizeSeed(stored.current.seed)) || null;
  if (seed) setSeed(seed, []);
  else setSeed(newSeed(), SEED_PARTS);

  const steps = $('steps');
  for (let i = 0; i < 16; i++) {
    const sp = document.createElement('span');
    if (i % 4 === 0) sp.className = 'beat';
    steps.appendChild(sp);
  }

  $('play').addEventListener('click', () => (app.engine ? stop() : play()));
  $('newTrack').addEventListener('click', newTrack);
  $('volume').addEventListener('input', (e) => {
    app.settings.volume = Number(e.target.value);
    $('o-volume').textContent = `${app.settings.volume}%`;
    if (app.engine) app.engine.applyLive();
    saveStore();
  });
  $('seedForm').addEventListener('submit', (e) => {
    e.preventDefault();
    loadSeedFromInput();
  });
  $('copySeed').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(app.seed);
      $('copySeed').textContent = 'Copied';
    } catch (e) {
      $('seed').select();
      $('copySeed').textContent = 'Press Ctrl+C';
    }
    setTimeout(() => ($('copySeed').textContent = 'Copy'), 1500);
  });
  for (const part of ['drums', 'bass', 'lead']) {
    $('lock-' + part).addEventListener('click', () => {
      app.locks[part] = !app.locks[part];
      refreshControls();
      saveStore();
    });
  }
  $('favForm').addEventListener('submit', saveFavorite);
  $('export').addEventListener('click', exportWav);
  $('loadVocals').addEventListener('click', () => $('vocalFiles').click());
  $('vocalFiles').addEventListener('change', (e) => {
    loadVocals([...e.target.files]);
    e.target.value = '';
  });
  $('clearVocals').addEventListener('click', () => {
    app.vocals.length = 0;
    app.vocalNames.length = 0;
    renderVocals();
  });
  $('vocalLevel').addEventListener('input', (e) => {
    app.settings.vocalLevel = Number(e.target.value);
    $('o-vocalLevel').textContent = `${app.settings.vocalLevel}%`;
    if (app.engine) app.engine.applyLive();
    saveStore();
  });
  $('vocalEvery').addEventListener('change', (e) => {
    app.settings.vocalEvery = Number(e.target.value);
    saveStore();
  });
  $('vocalDistort').addEventListener('change', (e) => {
    app.settings.vocalDistort = e.target.checked;
    if (app.engine) app.engine.applyLive();
    saveStore();
  });

  renderFavorites();
  renderVocals();
  refreshControls();

  // Read-only hooks for the automated checks in aggro/test/.
  window.__aggro = {
    get audioState() {
      return app.ctx ? app.ctx.state : 'none';
    },
    get settings() {
      return { ...app.settings };
    },
    get seed() {
      return app.seed;
    },
    get position() {
      return app.pos ? { ...app.pos } : null;
    },
    get vocalCount() {
      return app.vocals.length;
    },
  };
}

init();
