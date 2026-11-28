// Braid's tray icon is Explorer's signpost drawn from its own data (session-tray.js SIGNPOST16), not EXPLORER.EXE's
// icon by index: Internet Explorer 4's EXPLORER.EXE has no icon 105, and its sixth was another
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../session-tray.js', import.meta.url), 'utf8');
assert.match(src, /st\.braid = \{[^}]*icon: icon24\(p, SIGNPOST16\)/, 'the Braid icon is SIGNPOST16');
const m = /const SIGNPOST16 = \{ rgb: '([^']+)',\s*mask: \[([^\]]+)\]/.exec(src);
assert.ok(m, 'SIGNPOST16 is there');
assert.equal(Buffer.from(m[1], 'base64').length, 16 * 16 * 3, '16 by 16, RGB');
assert.equal(m[2].split(',').length, 16, 'a mask row each');
console.log('braidsignpost: ok');
