// A start with its sound unheard (?debug=1, ?mute=1, a reload with Windows running: soundQuiet) stays quiet through
// MSSNDSYS's start, which enables the codec's playback and turns it down again at once, and ends with the first sound
// of some length (SystemStart), after which sounds are heard
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
window.AudioContext = class { constructor() { this.state = 'running'; } close() {} };
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js', 'sound.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const p = Object.create(P);
p.cpu = { eax: { value: 0 } }; Object.assign(p, { now: () => 0, sound16() {} });
self.W95CDGAIN = () => {};
const out = (port, v) => { p.cpu.eax.value = v; p.soundIO(port, 1, false); };
const reg = (i, v) => { out(0x534, i); out(0x535, v); };
p.soundQuiet = true;
reg(9, 0x01); reg(9, 0x00);
assert.equal(p.soundQuiet, true, 'the driver\'s start: no sound, still quiet');
reg(9, 0x01); p.quietMs = 1500; reg(9, 0x00);
assert.equal(p.soundQuiet, false, 'SystemStart played unheard: the quiet is over');
console.log('quietstart: ok');
