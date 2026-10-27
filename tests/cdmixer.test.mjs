// The audio CD drive's output goes through the sound card's AUX1 (with the FM synthesizer's), so the mixer's MIDI
// line and master Volume set its level: a driver write to the codec's indirect registers 2 and 3 (bits 0-4 in 1.5 dB
// steps, +12 dB at 0, 0 dB at 8; bit 7 mute) sends the page that gain; a play sends the gain AUX1 has then; a codec not
// yet set up passes it at 0 dB
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
window.AudioContext = class { constructor() { this.state = 'running'; } close() {} };
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js', 'sound.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const p = Object.create(P), gains = [];
p.cpu = { eax: { value: 0 } }; Object.assign(p, { now: () => 0, sound16() {} });
self.W95CDGAIN = (l, r) => gains.push([+l.toFixed(3), +r.toFixed(3)]);
const out = (port, v) => { p.cpu.eax.value = v; p.soundIO(port, 1, false); };
const reg = (i, v) => { out(0x534, i); out(0x535, v); };
assert.deepEqual(p.cdAuxGain(), [1, 1], 'no codec set up yet: 0 dB');
reg(2, 0x08); reg(3, 0x08);
assert.deepEqual(gains, [[1, 0], [1, 1]], 'each write sends both channels (right still muted at its reset value, then 0 dB)');
reg(2, 0x14); assert.deepEqual(gains.at(-1), [+Math.pow(10, -18 / 20).toFixed(3), 1], '20 steps: -18 dB');
reg(3, 0x88); assert.deepEqual(gains.at(-1), [+Math.pow(10, -18 / 20).toFixed(3), 0], 'mute');
reg(3, 0x00); assert.deepEqual(gains.at(-1), [+Math.pow(10, -18 / 20).toFixed(3), +Math.pow(10, 12 / 20).toFixed(3)], '+12 dB at 0');
const n = gains.length; reg(3, 0x00); assert.equal(gains.length, n, 'the same value again: nothing sent');
reg(6, 0x10); assert.equal(gains.length, n, 'the DAC (Wave) is not the CD\'s');
// a play from the drive sends AUX1's gain first
{
  const sent = []; self.W95CDAUDIO = (op, from, to) => sent.push(op); gains.length = 0;
  p.mem = { buffer: new ArrayBuffer(1 << 20) }; Object.assign(p.cpu, { ebx: { value: 0 }, ecx: { value: 4 }, edx: { value: 0 }, es: { value: 0x100 }, cf: { value: 0 } }); p.rmode = true; p.cdClock = () => 0;
  p.fs = { vols: new Map([['E', { kind: 'cdrom', letter: 'E', audio: { tracks: [{ number: 1, lba: 0, sectors: 7500 }], leadout: 7500 } }]]) };
  p.u8[0x1002] = 0x84; p.w32(0x100e, 0); p.w32(0x1012, 7500); p.cpu.eax.value = 0x1510;
  p.interrupt(0x2f, 0);
  assert.deepEqual(sent, ['play']); assert.equal(gains.length, 1); assert.equal(gains[0][1], +Math.pow(10, 12 / 20).toFixed(3));
}
console.log('cdmixer: ok');
