# Aggrotech generator

A browser page that makes endless aggrotech / harsh electronic body music (EBM) live, from a seed. It's a sibling of the Reading music generator in this repository and doesn't share any code with it.

## For Phi

### Getting the page
1. On GitHub, open `aggro/dist/Aggrotech generator.html`.
2. Press the download button (the arrow pointing down, top right of the file view).
3. Double-click the downloaded file. It opens in your browser and works offline; nothing is loaded from the internet.

### Using it
- **Play / Stop**, and **Volume**, which starts at a moderate level.
- **New track** rerolls the music. It leaves your mix knobs (Aggression, Sidechain depth, Section length, Volume) alone.
- **Keep on New track: Drums / Bass / Lead** keeps that part when you reroll. Keeping Bass or Lead also keeps the key and chords, so the kept part sounds the same.
- **Seed** is the code for the current track. Type a seed (or any word) and press **Load seed** to bring a track back.
- **Favorites** saves the seed plus every slider under a name. **Recall** brings it back and keeps your current volume.
- **Save 30 seconds as WAV** downloads a sound file. When playing, it starts from the current section. When stopped, it starts from the first build, so a drop is included. Files are saved at full volume (the limiter still applies), so they can be compared with each other.
- **Your vocals** loads your own shout or vocal samples from your computer. They play in drops (every 1, 2, 4, or 8 bars, your choice) and at the start of builds, with optional distortion. Nothing is uploaded, and they're forgotten when you close the page. With none loaded, there are no vocals.

### Sending tuning notes
Claude can't hear the output, so tuning runs on your ears. Listen, jot what's wrong in plain words ("kick is mushy," "lead too thin," "bass and kick fight," "break goes on too long"), and include the seed if it's about one track. Then start a new cloud session in this repository with:

> Read aggro/README.md first. Then: <your notes>

### Honest limits
- Everything is synthesized in the browser, so it's demo-grade next to a produced track.
- The riffs are original, generated from the genre's traits; no real song's riffs, melodies, or lyrics are copied.

## For future sessions

### Rules (from the original prompt, 2026-10-13)
- Everything for this page lives in `aggro/`. **Don't touch the Reading music generator** (`reading-music-generator.html` at the top level).
- Phi doesn't code: talk in plain words and spell out abbreviations.
- One self-contained output file, `aggro/dist/Aggrotech generator.html`, built from `aggro/src/` by `aggro/build.mjs` (plain Node, no packages). Commit the built file, since Phi downloads it from GitHub.
- Plain Web Audio. If a library would genuinely help, ask Phi first; it must be inlined into the build, never loaded from the internet.
- **No network calls at all.** (A Google font was allowed but isn't used.)
- A master limiter on the output, so nothing spikes painfully at high aggression and volume.
- Dark and industrial; works in light and dark mode; usable in a narrow window.
- Settings and favorites live in `localStorage` under the key `aggro-gen-v1`. Keep that key, or migrate old data if the format changes.
- Be honest that it's demo-grade, and that you can't listen. Check what you can (below) and say what you couldn't check.

### Where things are
| Path | What it is |
| --- | --- |
| `build.mjs` | Joins the source files into the one HTML file. |
| `src/page.html` | Page layout, with placeholders for the style and script. |
| `src/style.css` | Look and feel, with light and dark colors. |
| `src/js/rng.js` | Seeded randomness and the seed format. |
| `src/js/theory.js` | Scales (the Darkness slider), chords, note-to-pitch maths. |
| `src/js/track.js` | Seed → track: key and chords, drum kit, bass line and sound, lead riffs and sounds. Also the bass pattern list. |
| `src/js/engine.js` | The sound engine: mixer and effects, the arrangement, and every instrument. |
| `src/js/wav.js` | WAV file writing and level measurement for the export. |
| `src/js/ui.js` | Controls, seed and locks, favorites, export, vocals, live display, storage. |
| `test/check.mjs` | Automated checks in headless Chromium (Playwright). |
| `test/levels.mjs` | Level meter: peak and average level per section, for the whole mix and each part on its own. |
| `dist/Aggrotech generator.html` | The built page. |

### Build and check
```
node aggro/build.mjs          # build dist/
node aggro/test/check.mjs     # 25 checks; screenshots and WAVs go to aggro/test/out/ (not committed)
node aggro/test/levels.mjs [seed] [aggression, e.g. 0,50,100]
```
Both test scripts use the Playwright that comes installed in cloud sessions (they fall back to the global install).

### How it works
- **Seed:** four parts (`HARM-DRUM-BASS-LEAD`). Each part seeds its own random stream, which is how the locks work. A part also suggests slider values: tempo and Darkness (harmony), Drum intensity (drums), Bass pattern (bass), and Lead blend (lead). Loading a seed or pressing New track applies those suggestions; recalling a favorite applies its saved sliders instead.
- **Arrangement:** intro, build, drop, break, build, drop, then back to the break, forever. A drop lasts the Section length; the other sections last half of it (at least 4 bars). Each new drop uses the next of three riff variations. A build has a noise riser, a snare roll, a rising high-pass filter on the synths, and a half-bar gap before the drop. Drops start with a low boom and crash; breaks start with a boom and a falling noise sweep.
- **Same code for playback and export:** `Engine.playStep()` schedules one 16th note. Live playback runs it from a timer about 0.18 seconds ahead; the export runs it in a loop on an `OfflineAudioContext`. Per-hit variation uses hashed values, not `Math.random`, so exports repeat exactly.
- **Signal path:** kick → its own clipper → mix. Hats, snare, and percussion → drum drive → mix. Bass, pads, and leads → build high-pass → sidechain duck → synth drive (+ parallel bitcrush) → mix. Plus reverb, lead echo, and effects returns. Mix → low cut → limiter (threshold -4 dB, its automatic make-up gain undone) → a soft ceiling at about -1 dB (no oversampling, so it can't overshoot) → volume → speakers.
- **Aggression** sets all the drive curves and the bitcrush. The make-up gain after each drive (`driveMakeup`) keeps the level roughly steady, so the knob adds grit more than volume.
- **Supersaw stabs** are drawn once per chord into a half-second buffer (band-limited saws, five per note, spread in stereo) and replayed. That's much lighter than about 20 oscillators per 16th note.
- **Mix levels** are the constants at the top of `engine.js` (`MIX_LEVEL`, `DRUM_LEVEL`, `SYNTH_LEVEL`, `PAD_LEVEL`) plus per-section levels in `playStep`. They were set with `test/levels.mjs`. At Aggression 50, the drop sits around -11 dB average with the kick and synths about equal, the build about 2 dB below, and the break about 6 dB below.

### What the checks cover (and don't)
`test/check.mjs` covers:
- no console errors and no network requests;
- every control exists and changes its setting and label;
- the audio starts on Play and the arrangement moves;
- New track and the locks;
- typed seeds;
- favorites saving, recalling, and surviving a reload;
- loading a vocal file;
- Stop;
- three WAV exports (normal, everything at maximum, everything at minimum): exactly 30 seconds, stereo at 44.1 kHz, not silent, peak below -0.5 dB, no samples at full scale;
- no sideways scrolling at 360 px wide.

It can't tell whether anything sounds good.

### History
- 2026-10-13: first version (cloud session from C13's prompt).
