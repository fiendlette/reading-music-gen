// Builds aggro/dist/Aggrotech generator.html from the files in aggro/src/.
// Plain Node, no packages: `node aggro/build.mjs`.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, 'src');

// Order matters: later files use things defined in earlier ones.
const JS_FILES = ['rng.js', 'theory.js', 'track.js', 'engine.js', 'wav.js', 'ui.js'];

const page = readFileSync(join(src, 'page.html'), 'utf8');
const css = readFileSync(join(src, 'style.css'), 'utf8');
const js = JS_FILES.map((f) => `// ---- ${f} ----\n${readFileSync(join(src, 'js', f), 'utf8')}`).join('\n');
const script = `(() => {\n'use strict';\n${js}\n})();`;

if (/<\/script/i.test(script)) throw new Error('A source file contains "</script", which would break the page.');
if (!page.includes('/*__STYLE__*/') || !page.includes('/*__SCRIPT__*/')) throw new Error('page.html is missing a placeholder.');

const out = page.split('/*__STYLE__*/').join(css.trim()).split('/*__SCRIPT__*/').join(script);

mkdirSync(join(here, 'dist'), { recursive: true });
const target = join(here, 'dist', 'Aggrotech generator.html');
writeFileSync(target, out);
console.log(`Built ${target} (${(out.length / 1024).toFixed(1)} KB)`);
