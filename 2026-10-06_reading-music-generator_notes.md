# Reading music generator: project notes

Written 2026-10-06 by C12, for moving the project into Claude Code.

## What it is

- A single web page that makes background music for reading, live in the browser. Open `reading-music-generator.html` in any browser to use it; no install needed.
- The published version lives at https://claude.ai/artifact/S5PNBKuMyQ4MRvG7DxpqDE (same page; this file is a copy of it as of 10-06).
- Three kinds of sound: Piano, Pads, and Noise. Sliders: chord changes, mood, notes, melody, beat (Pads only), tone, noise, noise kind, and volume. Each kind remembers its own settings in the browser.

## What Phi has asked for so far

- Kinds: all three, because her mood varies ("sometimes i want e music sometimes i want noise sometimes i want classical").
- Slow drifting chords, and sliders to tweak the mood live.
- A melody slider (added 10-05).
- Piano: liked, but it sounded synth-y. Fixed 10-06 by switching to real piano recordings. Not yet heard by her.
- Pads: wanted a rhythm beat, and it sounded high-pitched or staticky sometimes. Fixed 10-06 with a soft beat (kick, snare, and shaker at 72 beats per minute, with chords lined up to bars) and warmer tones. Not yet heard by her.
- Noise: brown noise made her ears feel funny, close to a misophonia reaction, so avoid it. Replaced 10-06 with soft waves. Not yet heard by her.
- 10-14 feedback and changes (not yet heard by her):
  - Pads melody was too high. Melody range is now about G3 to C5 (was E4 to D6), and the lead's octave overtone is softer.
  - Added a Tempo slider (50 to 110 bpm, default 72, shown live in the label). It sets the Pads beat speed and the melody timing in Piano and Pads. Changing it mid-play keeps the beat running and re-aligns the bars.
  - Melody rewritten as phrases instead of a random walk. A short motif (rhythm plus contour) is restated over each chord. Strong beats land on chord tones, weak beats step between them. Every 4th statement is a cadence: the 2nd ends open, the 4th ends on the chord's root. Higher Melody slider means busier rhythms and more two-note (third below) harmonizing. Piano melody range is C4 to A5.
  - Her phrase "harmonic ones esp" was read as "melodies that follow the chords". If she meant two-note or chordal harmony, that needs more work.
  - Checked by running the engine against a fake audio clock (strong beats on chord tones, root cadences, ranges respected), not by listening.
- No lyrics, ever. Plain classical can be too interesting to read to, and generic lofi is "meh."

## Technical notes

- Everything is in the one HTML file: the sound engine (Web Audio), the page, and the piano recordings embedded as data.
- Piano recordings: Salamander Grand Piano by Alexander Holm, Creative Commons Attribution 3.0. Keep the credit line on the page.
- Settings are saved in the browser under the key `reading-drift-v1`. Older saves without a tempo value pick up the default.
- Claude can't hear the output, so every change needs Phi to listen and report back.
