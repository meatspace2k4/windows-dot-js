// The page's buffers for a machine's screen follow the screen the machine scans out, by their own size (win95.js
// followMode). A travel puts the machine's sw and sh back from the moment and leaves the canvases, the page's live
// things, as they were: a moment taken at 706x859 arrived at from 640x480 had sw at 706 and a 640-wide image, and the
// machine's 1416-byte lines were drawn 640 pixels to a row, the screen sheared
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const line = src.split('\n').find(l => /^  followMode\(m\) \{/.test(l)); assert.ok(line, 'followMode found');
const followMode = new Function(`return function ${line.trim()}`)();
const app = (sw, sh, iw, ih) => { const a = { sw, sh, img: { width: iw, height: ih }, sized: [] }; a.screenSized = (w, h) => { a.sized.push([w, h]); a.sw = w; a.sh = h; a.img = { width: w, height: h }; }; a.followMode = followMode; return a; };
const scan = (w, h, bpp = 16) => ({ scan: { w, h, bpp } });

// after a travel: sw as the moment had it, the image as the page had it
let a = app(706, 859, 640, 480); a.followMode(scan(706, 859));
assert.deepEqual(a.sized, [[706, 859]], 'the image made the screen\'s size, sw already being it');
// a mode change, as before
a = app(640, 480, 640, 480); a.followMode(scan(706, 859)); assert.deepEqual(a.sized, [[706, 859]]);
// nothing changed: nothing made
a = app(706, 859, 706, 859); a.followMode(scan(706, 859)); assert.deepEqual(a.sized, []);
// no scan or text mode: nothing
a = app(706, 859, 640, 480); a.followMode({}); a.followMode(scan(720, 400, 0)); assert.deepEqual(a.sized, []);
console.log('followmode: ok');
