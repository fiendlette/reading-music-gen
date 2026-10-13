// The sound engine. Works on a live AudioContext (playback) and on an
// OfflineAudioContext (the WAV export) with the same code: `playStep`
// schedules everything for one 16th note, and either a timer (live) or a
// loop (export) walks through the steps.

// The arrangement cycles: intro, build, drop, break, build, drop, then back to
// the break, with new riff variations each time round.
const ARRANGEMENT = ['intro', 'build', 'drop', 'break', 'build', 'drop'];
const LOOP_FROM = 3;
const CEILING = 0.89; // about -1 dB: the loudest the output can ever get
const LIMIT_DB = -4; // where the limiter starts holding peaks down
const LIMIT_RATIO = 20;
// Mix balance, set by measuring with aggro/test/levels.mjs.
const MIX_LEVEL = 0.38;
const DRUM_LEVEL = 2;
const SYNTH_LEVEL = 1;
const PAD_LEVEL = 0.5;
// The Web Audio compressor adds its own make-up gain (part of the standard);
// this undoes it so the limiter only ever turns things down.
const LIMIT_TRIM = Math.pow(Math.pow(10, (LIMIT_DB - LIMIT_DB / LIMIT_RATIO) / 20), 0.6);

function sectionBars(name, len) {
  return name === 'drop' ? len : Math.max(4, Math.round(len / 2));
}

function initialState(sec, cycle, dropNo, settings) {
  const name = ARRANGEMENT[sec];
  return {
    sec,
    cycle,
    bar: 0,
    step: 0,
    abs: 0,
    bars: sectionBars(name, settings.sectionLen),
    dropNo: dropNo + (name === 'drop' ? 1 : 0),
  };
}

// Volume slider (0-100) to gain, curved so the middle is moderate.
function volumeGain(v) {
  return Math.pow(v / 100, 1.6);
}

function makeNoiseBuffer(ctx, seconds, key) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const r = mulberry32(hashString(key));
  for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
  return buf;
}

function makeImpulse(ctx, seconds, key) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const r = mulberry32(hashString(key + ch));
    for (let i = 0; i < len; i++) {
      const x = i / len;
      d[i] = (r() * 2 - 1) * Math.pow(1 - x, 3.2) * (i < 200 ? i / 200 : 1);
    }
  }
  return buf;
}

// Saturation curve. amount 0..1, from gentle warmth to hard clipping.
function driveK(amount) {
  return 1 + amount * 22;
}
function driveCurve(amount) {
  const n = 2048;
  const k = driveK(amount);
  const norm = Math.tanh(k);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

// Gain after a drive stage so turning up Aggression mostly adds grit rather
// than volume: undoes most of the curve's boost to quiet signals.
// strength 0..1: how much of that boost to undo.
function driveMakeup(amount, strength) {
  const k = driveK(amount);
  return Math.pow(k / Math.tanh(k), -strength);
}

// Bitcrush: rounds the wave to a few levels.
function crushCurve(bits) {
  const n = 4096;
  const half = Math.pow(2, bits) / 2;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * half) / half;
  }
  return c;
}

// Final safety: straight below the knee, then bends smoothly into CEILING.
function ceilingCurve(ceiling) {
  const n = 4096;
  const knee = ceiling * 0.75;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

class Engine {
  constructor(ctx, settings, track, vocals) {
    this.ctx = ctx;
    this.s = settings; // shared with the page, so slider moves show up here
    this.track = track;
    this.pendingTrack = null; // swapped in at the next bar line
    this.vocals = vocals || [];
    this.onStep = null;
    this.timer = null;
    this.running = false;
    this.lastHoover = null;
    this.noise = makeNoiseBuffer(ctx, 2, 'aggro-noise');
    this._cache = {};
    this._sawCache = new Map();
    this._build();
    this._trackChanged();
  }

  _gain(v = 1) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  _shaper() {
    const w = this.ctx.createWaveShaper();
    w.oversample = '2x';
    return w;
  }

  _filter(type, freq, q = 0.7) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  _build() {
    const c = this.ctx;

    // Output chain: mix → low cut → limiter → ceiling → volume → speakers.
    this.mix = this._gain(MIX_LEVEL);
    this.lowcut = this._filter('highpass', 30);
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = LIMIT_DB;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = LIMIT_RATIO;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;
    this.limitTrim = this._gain(LIMIT_TRIM);
    // No oversampling here: its smoothing filter can overshoot the curve.
    this.ceiling = this.ctx.createWaveShaper();
    this.ceiling.curve = ceilingCurve(CEILING);
    this.out = this._gain(0);
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 1024;
    this.mix.connect(this.lowcut);
    this.lowcut.connect(this.limiter);
    this.limiter.connect(this.limitTrim);
    this.limitTrim.connect(this.ceiling);
    this.ceiling.connect(this.out);
    this.out.connect(this.analyser);
    this.analyser.connect(c.destination);

    // Kick has its own clipper and skips the sidechain.
    this.kickShaper = this._shaper();
    this.kickOut = this._gain(0.95);
    this.kickShaper.connect(this.kickOut);
    this.kickOut.connect(this.mix);

    // Other drums.
    this.drumBus = this._gain(1);
    this.drumDrive = this._shaper();
    this.drumMake = this._gain(1);
    this.drumBus.connect(this.drumDrive);
    this.drumDrive.connect(this.drumMake);
    this.drumMake.connect(this.mix);

    // Bass, pads, and leads share a bus that ducks on each kick (sidechain),
    // then the aggression distortion and bitcrush.
    this.bassBus = this._gain(0.8);
    this.padBus = this._gain(PAD_LEVEL);
    this.leadBus = this._gain(0.55);
    this.synthBus = this._gain(1);
    this.duck = this._gain(1);
    this.synthDrive = this._shaper();
    this.synthMake = this._gain(1);
    this.crush = this._shaper();
    this.crush.oversample = 'none';
    this.crushAmt = this._gain(0);
    this.bassBus.connect(this.synthBus);
    this.padBus.connect(this.synthBus);
    this.leadBus.connect(this.synthBus);
    // Thins the synths out during builds, so the drop lands with full weight.
    this.buildHp = this._filter('highpass', 20);
    this.synthBus.connect(this.buildHp);
    this.buildHp.connect(this.duck);
    this.duck.connect(this.synthDrive);
    this.synthDrive.connect(this.synthMake);
    this.synthMake.connect(this.mix);
    this.synthMake.connect(this.crush);
    this.crush.connect(this.crushAmt);
    this.crushAmt.connect(this.mix);

    // Reverb.
    this.verb = c.createConvolver();
    this.verb.buffer = makeImpulse(c, 1.8, 'aggro-verb');
    this.verbSend = this._gain(1);
    this.verbOut = this._gain(0.45);
    this.verbSend.connect(this.verb);
    this.verb.connect(this.verbOut);
    this.verbOut.connect(this.mix);
    this.padSend = this._gain(0.35);
    this.padBus.connect(this.padSend);
    this.padSend.connect(this.verbSend);
    this.leadSend = this._gain(0.15);
    this.leadBus.connect(this.leadSend);
    this.leadSend.connect(this.verbSend);

    // Lead echo, dotted 8th, follows the tempo.
    this.delay = c.createDelay(2);
    this.delaySend = this._gain(0.15);
    this.delayTone = this._filter('lowpass', 2800);
    this.delayFb = this._gain(0.35);
    this.leadBus.connect(this.delaySend);
    this.delaySend.connect(this.delay);
    this.delay.connect(this.delayTone);
    this.delayTone.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    this.delayTone.connect(this.duck);

    // Risers, downlifters, impacts.
    this.fxBus = this._gain(0.6);
    this.fxBus.connect(this.mix);
    this.fxSend = this._gain(0.3);
    this.fxBus.connect(this.fxSend);
    this.fxSend.connect(this.verbSend);

    // Your vocal samples.
    this.vocalBus = this._gain(1);
    this.vocalShaper = this._shaper();
    this.vocalOut = this._gain(0.8);
    this.vocalSend = this._gain(0.25);
    this.vocalBus.connect(this.vocalShaper);
    this.vocalShaper.connect(this.vocalOut);
    this.vocalOut.connect(this.mix);
    this.vocalOut.connect(this.vocalSend);
    this.vocalSend.connect(this.verbSend);
  }

  // Things that depend on the track: kick tuning, bass and lead registers.
  _trackChanged() {
    const tr = this.track;
    this.bassRoot = 28 + ((tr.harmony.rootPc - 4 + 12) % 12); // E1 up to D♯2
    this.leadRoot = this.bassRoot + 24;
    let f = midiToHz(this.bassRoot);
    while (f > 62) f /= 2;
    while (f < 40) f *= 2;
    this.kickEndHz = f;
    this.delaySend.gain.value = tr.lead.delayMix;
    this._cache.kick = null;
    this.applyLive();
  }

  // Apply slider values that act on the sound right away.
  applyLive() {
    const s = this.s;
    const now = this.ctx.currentTime;
    const a = s.aggression / 100;
    const grit = this.track.drums.kick.grit;
    const kickKey = a + ':' + grit;
    if (this._cache.kick !== kickKey) {
      this._cache.kick = kickKey;
      this.kickShaper.curve = driveCurve(0.2 + a * 0.5 + grit * 0.15);
    }
    if (this._cache.agg !== a) {
      this._cache.agg = a;
      this.drumDrive.curve = driveCurve(a * 0.55);
      this.synthDrive.curve = driveCurve(0.08 + a * 0.75);
      this.crush.curve = crushCurve(Math.round(7 - a * 4));
      this.drumMake.gain.setTargetAtTime(DRUM_LEVEL * driveMakeup(a * 0.55, 0.6), now, 0.02);
      this.synthMake.gain.setTargetAtTime(SYNTH_LEVEL * driveMakeup(0.08 + a * 0.75, 0.25), now, 0.02);
      this.crushAmt.gain.setTargetAtTime(Math.max(0, (a - 0.25) / 0.75) * 0.3, now, 0.02);
    }
    const vocalKey = s.vocalDistort ? 'on' + a : 'off';
    if (this._cache.vocal !== vocalKey) {
      this._cache.vocal = vocalKey;
      this.vocalShaper.curve = s.vocalDistort ? driveCurve(0.45 + a * 0.4) : null;
    }
    this.vocalOut.gain.setTargetAtTime((s.vocalLevel / 100) * 0.9, now, 0.02);
    this.delay.delayTime.setTargetAtTime((60 / s.tempo) * 0.75, now, 0.05);
    if (this.running && this.ctx instanceof AudioContext) {
      this.out.gain.setTargetAtTime(volumeGain(s.volume), now, 0.03);
    }
  }

  // ---- playback ----

  start(fromState) {
    const c = this.ctx;
    const now = c.currentTime;
    this.state = fromState || initialState(0, 0, 0, this.s);
    this.running = true;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(0, now);
    this.out.gain.linearRampToValueAtTime(volumeGain(this.s.volume), now + 0.08);
    this.nextTime = now + 0.08;
    this._pump();
    this.timer = setInterval(() => this._pump(), 25);
  }

  _pump() {
    const now = this.ctx.currentTime;
    if (this.nextTime < now - 0.1) this.nextTime = now + 0.05; // fell behind; skip ahead
    while (this.nextTime < now + 0.18) {
      this.playStep(this.nextTime, this.state);
      this._advance(this.state);
      this.nextTime += 15 / this.s.tempo;
    }
  }

  stop() {
    const c = this.ctx;
    const now = c.currentTime;
    clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0, now + 0.08);
    setTimeout(() => this.analyser.disconnect(), 250);
  }

  // Schedule `seconds` of music on an OfflineAudioContext.
  renderOffline(fromState, seconds) {
    this.running = true;
    this.out.gain.value = volumeGain(this.s.volume);
    this.state = fromState;
    let t = 0.01;
    while (t < seconds) {
      this.playStep(t, this.state);
      this._advance(this.state);
      t += 15 / this.s.tempo;
    }
  }

  _advance(st) {
    st.step++;
    st.abs++;
    if (st.step < 16) return;
    st.step = 0;
    st.bar++;
    if (st.bar < st.bars) return;
    st.bar = 0;
    st.sec++;
    if (st.sec >= ARRANGEMENT.length) {
      st.sec = LOOP_FROM;
      st.cycle++;
    }
    const name = ARRANGEMENT[st.sec];
    st.bars = sectionBars(name, this.s.sectionLen);
    if (name === 'drop') st.dropNo++;
  }

  // ---- the arrangement: what plays on each 16th ----

  playStep(t, st) {
    if (st.step === 0 && this.pendingTrack) {
      this.track = this.pendingTrack;
      this.pendingTrack = null;
      this._trackChanged();
    }
    const tr = this.track;
    const s = this.s;
    const name = ARRANGEMENT[st.sec];
    const beat = 60 / s.tempo;
    const six = beat / 4;
    const { step, bar, bars } = st;
    const mode = MODES[s.darkness];
    const chordDeg = tr.harmony.prog[bar % 4];
    const intensity = s.drums / 100;
    const lastBar = bar === bars - 1;
    const p = (bar * 16 + step) / (bars * 16); // progress through the section
    const jit = (salt) => hash01(tr.seed, st.cycle, st.sec, st.abs, salt);

    const isIntro = name === 'intro';
    const isBuild = name === 'build';
    const isDrop = name === 'drop';
    const isBreak = name === 'break';
    const dropout = isBuild && lastBar && step >= 8; // the gap before the drop
    const variant = isDrop ? (st.dropNo - 1) % 3 : 0;

    if (this.onStep) this.onStep(t, { name, bar, bars, step, sec: st.sec, cycle: st.cycle, dropNo: st.dropNo });

    // Section-change effects.
    if (step === 0) {
      const hpTarget = isBuild ? 30 + 650 * p * p : 20;
      if (isDrop && bar === 0) this.buildHp.frequency.setValueAtTime(20, t);
      else this.buildHp.frequency.setTargetAtTime(hpTarget, t, 0.4);
      const riserBars = Math.min(4, bars);
      if (isBuild && bar === bars - riserBars) this.riser(t, riserBars * 16 * six);
      if (isDrop && bar === 0) this.impact(t, 1);
      if (isBreak && bar === 0) {
        this.impact(t, 0.5);
        this.downlifter(t, 2 * 16 * six);
      }
    }

    // Kick: four on the floor.
    const kickOn = isDrop || (isBuild && !dropout) || (isIntro && bar >= bars / 2);
    if (kickOn && step % 4 === 0) {
      this.kick(t, isDrop ? 1 : 0.85);
      this.duckAt(t, beat);
    }
    if (isDrop && intensity > 0.7 && bar % 2 === 1 && tr.drums.ghostKicks.includes(step)) {
      this.kick(t, 0.55);
      this.duckAt(t, beat * 0.5);
    }

    // Snare/clap on 2 and 4; a roll at the end of each build; fills in drops.
    const rollBars = bars >= 8 ? 2 : 1;
    const inRoll = isBuild && bar >= bars - rollBars;
    if (inRoll) {
      const rollP = (bar - (bars - rollBars) + step / 16) / rollBars;
      const sixteenths = rollBars === 1 || bar === bars - 1;
      if (sixteenths || step % 2 === 0) this.snare(t, 0.3 + 0.7 * rollP, false);
    } else if ((isDrop || isBuild) && step % 8 === 4) {
      this.snare(t, 0.95, true);
    } else if (isDrop && intensity > 0.35 && bar % 8 === 7 && step >= 12) {
      const fill16 = tr.drums.fill === '16ths' || step >= 14;
      if (fill16 || step % 2 === 0) this.snare(t, 0.45 + 0.12 * (step - 12), false);
    } else if (isDrop && intensity > 0.8 && step % 16 === 14 && jit('ghost') < 0.5) {
      this.snare(t, 0.3, false);
    }

    // Hats.
    const hatOn = !dropout && (isDrop || isBuild || isIntro || (isBreak && bar >= bars / 2));
    if (hatOn) {
      const busy = intensity > 0.3 && (isDrop || (isBuild && p > 0.5));
      const offbeatsOnly = isIntro || isBreak;
      const play = offbeatsOnly ? step % 4 === 2 : busy || step % 2 === 0;
      if (play) {
        const open = isDrop && intensity > 0.45 && tr.drums.openHats.includes(step);
        const quiet = offbeatsOnly ? 0.55 : 1;
        const vel = tr.drums.hat.accents[step] * (0.35 + 0.65 * intensity) * quiet * (0.9 + 0.2 * jit('h'));
        this.hat(t, vel, open, (jit('hp') - 0.5) * 0.3);
      }
    }
    if (isDrop && intensity > 0.6 && tr.drums.perc.steps[step]) this.perc(t, 0.5 + 0.4 * intensity);

    // Bass.
    const bassOn = isDrop || (isBuild && !dropout) || (isIntro && bar >= bars / 2);
    if (bassOn) {
      let n = BASS_PATTERNS[s.bassPattern].note(step, bar, tr);
      if (tr.bass.turnaround && s.bassPattern !== 4 && bar % 4 === 3 && step >= 12) {
        n = step % 4 === 0 ? null : { deg: 0, oct: step % 2 ? 12 : 0, len: 1 };
      }
      if (n) {
        let root = this.bassRoot + degreeSemis(mode, chordDeg + n.deg);
        while (root - this.bassRoot > 9) root -= 12;
        const cutScale = isIntro ? 0.4 : isBuild ? 0.6 + 0.4 * p : 1;
        this.bassNote(t, root + n.oct, n.len * six * 0.9, 0.85, cutScale);
      }
    }

    // Pads: one chord per bar.
    if (step === 0 && !(isBuild && lastBar)) {
      const lvl = isIntro ? 0.6 : isBreak ? 1.5 : isBuild ? 0.5 : 0.3;
      const notes = triad(mode, chordDeg).map((x) => this.leadRoot + x);
      this.pad(t, notes, 16 * six, lvl);
    }

    // Leads: supersaw stabs and hoover, mixed by Lead blend.
    if ((isDrop || isBuild || isBreak) && !dropout) {
      const blend = s.leadBlend / 100;
      const stabAmt = Math.cos((blend * Math.PI) / 2);
      const hoovAmt = Math.sin((blend * Math.PI) / 2);
      const lvl = isDrop ? 1 : isBuild ? 0.35 + 0.35 * p : 0.75;
      const i32 = (bar % 2) * 16 + step;

      const sv = tr.lead.stabVariants[variant][i32];
      if (stabAmt > 0.05 && sv) {
        const cut = isDrop ? tr.lead.stab.cutoff : isBuild ? 450 + p * (tr.lead.stab.cutoff - 450) : 1500;
        const tri = triad(mode, chordDeg + sv.inv).map((x) => this.leadRoot + 12 + x);
        tri.push(this.leadRoot + degreeSemis(mode, chordDeg)); // root an octave down for weight
        this.stab(t, tri, sv.len * six * 0.8, lvl * stabAmt * (sv.accent ? 1 : 0.7), cut);
      }

      const hv = tr.lead.hooverVariants[variant][i32];
      if (hoovAmt > 0.05 && hv && (isDrop || p >= 0.5)) {
        const midi = this.leadRoot + degreeSemis(mode, chordDeg + hv.deg);
        const cut = isDrop ? 3400 : isBuild ? 1000 + p * 1800 : 1200;
        this.hoover(t, midi, hv.len * six * 0.95, lvl * hoovAmt, this.lastHoover, cut);
        this.lastHoover = midi;
      }
    }

    // Your vocal samples, dropped in on the downbeat.
    if (this.vocals.length && s.vocalLevel > 0 && step === 0) {
      const every = Number(s.vocalEvery) || 4;
      if ((isDrop && bar % every === 0) || (isBuild && bar === 0)) {
        const buf = this.vocals[Math.floor(jit('v') * this.vocals.length)];
        this.vocal(t, buf);
      }
    }
  }

  // ---- voices ----

  // Sidechain: dip the bass/pad/lead bus on each kick, then let it recover.
  duckAt(t, beat) {
    const depth = (this.s.sidechain / 100) * 0.85;
    if (depth <= 0.001) return;
    const g = this.duck.gain;
    const t0 = Math.max(0, t - 0.004); // fully down by the time the kick lands
    g.setValueAtTime(1, t0);
    g.linearRampToValueAtTime(1 - depth, t);
    g.setTargetAtTime(1, t + 0.02, beat * 0.13);
  }

  _noiseSource(t, salt) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    return { node: n, offset: hash01(t.toFixed(4), salt) * 1.5 };
  }

  kick(t, vel) {
    const c = this.ctx;
    const k = this.track.drums.kick;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(k.pStart, t);
    o.frequency.exponentialRampToValueAtTime(this.kickEndHz, t + k.pTime);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.0015);
    g.gain.setValueAtTime(vel, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + k.decay);
    o.connect(g);
    g.connect(this.kickShaper);
    o.start(t);
    o.stop(t + k.decay + 0.05);

    const { node, offset } = this._noiseSource(t, 'kick');
    const hp = this._filter('highpass', 1800);
    const ng = c.createGain();
    ng.gain.setValueAtTime(k.click * vel, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
    node.connect(hp);
    hp.connect(ng);
    ng.connect(this.kickShaper);
    node.start(t, offset);
    node.stop(t + 0.02);
  }

  snare(t, vel, withBody) {
    const c = this.ctx;
    const cl = this.track.drums.clap;
    const { node, offset } = this._noiseSource(t, 'snare');
    const bp = this._filter('bandpass', cl.tone, 0.9);
    const g = c.createGain();
    // Clap: three quick bursts, then the tail.
    g.gain.setValueAtTime(0, t);
    for (const d of [0, 0.011, 0.022]) {
      g.gain.setValueAtTime(vel, t + d);
      g.gain.linearRampToValueAtTime(vel * 0.25, t + d + 0.009);
    }
    g.gain.setValueAtTime(vel, t + 0.031);
    g.gain.setTargetAtTime(0, t + 0.033, cl.decay / 3);
    node.connect(bp);
    bp.connect(g);
    g.connect(this.drumBus);
    const send = this._gain(cl.verb);
    g.connect(send);
    send.connect(this.verbSend);
    node.start(t, offset);
    node.stop(t + cl.decay * 2 + 0.06);

    if (withBody && cl.body > 0.05) {
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(200, t);
      o.frequency.exponentialRampToValueAtTime(150, t + 0.05);
      const bg = c.createGain();
      bg.gain.setValueAtTime(cl.body * vel, t);
      bg.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      o.connect(bg);
      bg.connect(this.drumBus);
      o.start(t);
      o.stop(t + 0.1);
    }
  }

  hat(t, vel, open, pan) {
    const c = this.ctx;
    const h = this.track.drums.hat;
    const { node, offset } = this._noiseSource(t, 'hat');
    const hp = this._filter('highpass', h.tone);
    const g = c.createGain();
    const decay = open ? 0.2 : h.decay;
    g.gain.setValueAtTime(vel * 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    const pn = c.createStereoPanner();
    pn.pan.value = pan;
    node.connect(hp);
    hp.connect(g);
    g.connect(pn);
    pn.connect(this.drumBus);
    node.start(t, offset);
    node.stop(t + decay + 0.02);
  }

  perc(t, vel) {
    const c = this.ctx;
    const pc = this.track.drums.perc;
    const g = c.createGain();
    const pn = c.createStereoPanner();
    pn.pan.value = 0.35;
    g.connect(pn);
    pn.connect(this.drumBus);
    if (pc.type === 'zap') {
      const o = c.createOscillator();
      o.frequency.setValueAtTime(1400 * pc.pitch, t);
      o.frequency.exponentialRampToValueAtTime(90, t + 0.05);
      g.gain.setValueAtTime(vel * 0.3, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.09);
    } else {
      const bp = this._filter('bandpass', 2400 * pc.pitch, 3);
      bp.connect(g);
      g.gain.setValueAtTime(vel * 0.4, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      for (const f of [587, 845]) {
        const o = c.createOscillator();
        o.type = 'square';
        o.frequency.value = f * pc.pitch;
        o.connect(bp);
        o.start(t);
        o.stop(t + 0.07);
      }
    }
  }

  bassNote(t, midi, dur, vel, cutScale) {
    const c = this.ctx;
    const b = this.track.bass.sound;
    const f = midiToHz(midi);
    const lp = this._filter('lowpass', 100, b.q);
    const rest = Math.min(18000, b.cutoff * cutScale);
    lp.frequency.setValueAtTime(Math.min(18000, rest + b.env * cutScale), t);
    lp.frequency.setTargetAtTime(rest, t, b.decay / 2.5);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 0.5, t + 0.002);
    g.gain.setValueAtTime(vel * 0.5, t + Math.max(0.003, dur - 0.01));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.025);
    const end = t + dur + 0.05;
    for (const d of [-b.detune, b.detune]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = d;
      o.connect(lp);
      o.start(t);
      o.stop(end);
    }
    if (b.sub) {
      const o = c.createOscillator();
      o.type = 'square';
      o.frequency.value = f / 2;
      const sg = this._gain(0.35);
      o.connect(sg);
      sg.connect(lp);
      o.start(t);
      o.stop(end);
    }
    lp.connect(g);
    g.connect(this.bassBus);
  }

  pad(t, notes, dur, level) {
    const c = this.ctx;
    const lp = this._filter('lowpass', 900, 0.5);
    const g = c.createGain();
    const attack = Math.min(0.4, dur * 0.3);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level * 0.12, t + attack);
    g.gain.setValueAtTime(level * 0.12, t + dur - 0.05);
    g.gain.setTargetAtTime(0, t + dur - 0.05, 0.15);
    const end = t + dur + 0.7;
    notes.forEach((m, i) => {
      for (const d of [-10, 10]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiToHz(m);
        o.detune.value = d;
        const pn = c.createStereoPanner();
        pn.pan.value = (d < 0 ? -0.4 : 0.4) * (i % 2 ? -1 : 1);
        o.connect(pn);
        pn.connect(lp);
        o.start(t);
        o.stop(end);
      }
    });
    lp.connect(g);
    g.connect(this.padBus);
  }

  // Supersaw stab: five detuned saws per note, chopped short. The saws are
  // drawn once per chord into a buffer (see _supersaw), which is far lighter
  // than running twenty oscillators for every 16th note.
  stab(t, notes, dur, vel, cutoff) {
    const c = this.ctx;
    const st = this.track.lead.stab;
    const src = c.createBufferSource();
    src.buffer = this._supersaw(notes);
    const lp = this._filter('lowpass', cutoff, 0.8);
    lp.frequency.setValueAtTime(Math.min(18000, cutoff * 1.6), t);
    lp.frequency.setTargetAtTime(cutoff, t, 0.04);
    const g = c.createGain();
    const peak = vel * 0.22;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.003);
    g.gain.setTargetAtTime(peak * 0.6, t + 0.003, st.decay / 3);
    g.gain.setValueAtTime(peak * 0.6, t + Math.max(0.01, dur));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.04);
    src.connect(lp);
    lp.connect(g);
    g.connect(this.leadBus);
    src.start(t);
    src.stop(t + dur + 0.08);
  }

  // Half a second of a held supersaw chord, cached per chord.
  _supersaw(notes) {
    const st = this.track.lead.stab;
    const key = notes.join(',') + '|' + st.detune.toFixed(3);
    let buf = this._sawCache.get(key);
    if (buf) return buf;
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * 0.5);
    buf = this.ctx.createBuffer(2, len, sr);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    const spread = [-1, 1, 0, -0.5, 0.5];
    const pans = [-0.6, 0.6, 0, -0.3, 0.3];
    const norm = 1 / Math.sqrt(notes.length * spread.length);
    const r = mulberry32(hashString(key));
    // Band-limited saw (polyBLEP), so high notes don't fold back into hiss.
    const blep = (ph, dt) => {
      if (ph < dt) {
        const x = ph / dt;
        return x + x - x * x - 1;
      }
      if (ph > 1 - dt) {
        const x = (ph - 1) / dt;
        return x * x + x + x + 1;
      }
      return 0;
    };
    for (const m of notes) {
      spread.forEach((sp, i) => {
        const dt = (midiToHz(m) * Math.pow(2, (sp * st.detune) / 1200)) / sr;
        const a = ((pans[i] + 1) * Math.PI) / 4;
        const gl = Math.cos(a) * norm;
        const gr = Math.sin(a) * norm;
        let ph = r();
        for (let n = 0; n < len; n++) {
          const y = 2 * ph - 1 - blep(ph, dt);
          L[n] += y * gl;
          R[n] += y * gr;
          ph += dt;
          if (ph >= 1) ph -= 1;
        }
      });
    }
    if (this._sawCache.size > 48) this._sawCache.clear();
    this._sawCache.set(key, buf);
    return buf;
  }

  // Hoover: detuned saws plus one an octave down, swooping up into each note
  // and (optionally) diving down on release.
  hoover(t, midi, dur, vel, prevMidi, cutoff) {
    const c = this.ctx;
    const h = this.track.lead.hoover;
    const f = midiToHz(midi);
    const fPrev = prevMidi != null ? midiToHz(prevMidi) : f;
    const lp = this._filter('lowpass', cutoff, 2);
    const g = c.createGain();
    const peak = vel * 0.11;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.01);
    g.gain.setValueAtTime(peak, t + dur);
    g.gain.setTargetAtTime(0, t + dur, 0.05);
    const end = t + dur + 0.3;
    const voices = [
      { d: -h.detune, pan: -0.5, lvl: 1 },
      { d: 0, pan: 0, lvl: 1 },
      { d: h.detune, pan: 0.5, lvl: 1 },
      { d: -1200, pan: 0, lvl: 0.7 },
    ];
    for (const v of voices) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(fPrev, t);
      o.frequency.exponentialRampToValueAtTime(f, t + h.glide);
      o.detune.setValueAtTime(v.d - h.bend * 100, t);
      o.detune.linearRampToValueAtTime(v.d, t + 0.09);
      if (h.dive) {
        o.detune.setValueAtTime(v.d, t + dur);
        o.detune.linearRampToValueAtTime(v.d - 700, t + dur + 0.2);
      }
      const vg = this._gain(v.lvl);
      const pn = c.createStereoPanner();
      pn.pan.value = v.pan;
      o.connect(vg);
      vg.connect(pn);
      pn.connect(lp);
      o.start(t);
      o.stop(end);
    }
    lp.connect(g);
    g.connect(this.leadBus);
  }

  riser(t, dur) {
    const c = this.ctx;
    const n = c.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const bp = this._filter('bandpass', 250, 1.5);
    bp.frequency.setValueAtTime(250, t);
    bp.frequency.exponentialRampToValueAtTime(7000, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.03);
    n.connect(bp);
    bp.connect(g);
    g.connect(this.fxBus);
    n.start(t);
    n.stop(t + dur + 0.05);
  }

  downlifter(t, dur) {
    const c = this.ctx;
    const n = c.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const hp = this._filter('highpass', 5000);
    hp.frequency.setValueAtTime(5000, t);
    hp.frequency.exponentialRampToValueAtTime(150, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.28, t);
    g.gain.linearRampToValueAtTime(0, t + dur);
    n.connect(hp);
    hp.connect(g);
    g.connect(this.fxBus);
    n.start(t);
    n.stop(t + dur + 0.05);
  }

  // Low boom plus a noise crash at the start of drops and breaks.
  impact(t, amount) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.6);
    const g = c.createGain();
    g.gain.setValueAtTime(0.7 * amount, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    o.connect(g);
    g.connect(this.fxBus);
    o.start(t);
    o.stop(t + 1.5);

    const n = c.createBufferSource();
    n.buffer = this.noise;
    const hp = this._filter('highpass', 4000);
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.22 * amount, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    n.connect(hp);
    hp.connect(ng);
    ng.connect(this.fxBus);
    n.start(t);
    n.stop(t + 1.85);
  }

  vocal(t, buf) {
    const n = this.ctx.createBufferSource();
    n.buffer = buf;
    n.connect(this.vocalBus);
    n.start(t);
  }
}
