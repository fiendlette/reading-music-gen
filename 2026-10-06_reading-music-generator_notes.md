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
- No lyrics, ever. Plain classical can be too interesting to read to, and generic lofi is "meh."

## Technical notes

- Everything is in the one HTML file: the sound engine (Web Audio), the page, and the piano recordings embedded as data.
- Piano recordings: Salamander Grand Piano by Alexander Holm, Creative Commons Attribution 3.0. Keep the credit line on the page.
- Settings are saved in the browser under the key `reading-drift-v1`.
- Claude can't hear the output, so every change needs Phi to listen and report back.
