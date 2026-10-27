// The sound card records (Sound Recorder through MSSNDSYS): capture enable (indirect register 9 bit 1) asks the page
// for its microphone and capture disable lets it go; the codec takes frames at its rate (register 8: 8000 Hz, 8-bit
// unsigned mono here) from the microphone's samples when registers 0/1 select the microphone (bits 6-7 = 2; bits 0-3
// the gain, bit 5 +20 dB), writes them to memory through the DMA channel and interrupts when its count runs out, as
// playback does; another source records silence
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
window.AudioContext = class { constructor() { this.state = 'running'; } close() {} };
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js', 'sound.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const machine = () => {
  const p = Object.create(P), irqs = [], mic = []; let t = 0;
  p.mem = { buffer: new ArrayBuffer(1 << 20) };
  p.cpu = { eax: { value: 0 } };
  Object.assign(p, { now: () => t, raiseIRQ: irq => { irqs.push(irq); return true; }, oplRender() {}, irqPending() {} });
  self.W95MIC = on => mic.push(on);
  const reg = (i, v) => { for (const [port, x] of [[0x534, i], [0x535, v]]) { p.cpu.eax.value = x; p.soundIO(port, 1, false); } };
  const d = p.dmaChannel(1); Object.assign(d, { page: 0, base: 0x4000, cur: 0x4000, bcount: 999, count: 999, mode: 0x54, masked: false });
  return { p, irqs, mic, reg, tick: ms => { t += ms; p.sound16(); } };
};
{
  const { p, irqs, mic, reg, tick } = machine();
  reg(0, 0x80); reg(1, 0x80); reg(8, 0x00); reg(15, 99); reg(14, 0); reg(10, 2);
  reg(9, 2); assert.deepEqual(mic, [true], 'the microphone asked for');
  p.micIn(new Float32Array(8000).fill(0.5), 8000);
  tick(25);   // (200 frames due: the first 100 to the interrupt, the rest wait for its handler)
  assert.deepEqual(irqs, [7]); assert.equal(p.dmaChannel(1).cur, 0x4000 + 100);
  assert.deepEqual([...p.u8.subarray(0x4000, 0x4003)], [192, 192, 192], '0.5 at 0 dB, 8-bit unsigned');
  p.ad1848.int = false; tick(0); assert.ok(Math.abs(p.dmaChannel(1).cur - (0x4000 + 200)) <= 1, 'acknowledged: on with the frames due (to a frame of the clock\'s rounding)');
  // the microphone's +20 dB clips at full scale; another source (line) records silence
  reg(0, 0xa0); p.ad1848.int = false; tick(5); assert.equal(p.u8[p.dmaChannel(1).cur - 1], 255);
  reg(0, 0x00); p.ad1848.int = false; tick(5); assert.equal(p.u8[p.dmaChannel(1).cur - 1], 128);
  reg(9, 0); assert.deepEqual(mic, [true, false], 'let go as capture stops');
}
// 16-bit stereo: each frame four bytes, left and right; no microphone samples: silence
{
  const { p, reg, tick } = machine();
  reg(0, 0x80); reg(1, 0x80); reg(8, 0x50); reg(15, 255); reg(14, 0); reg(10, 2); reg(9, 2);
  p.micIn(new Float32Array(4000).fill(-0.25), 8000);
  tick(10);
  const dv = new DataView(p.mem.buffer); assert.equal(dv.getInt16(0x4000, true), -8192); assert.equal(dv.getInt16(0x4002, true), -8192);
  assert.ok(Math.abs(p.dmaChannel(1).cur - (0x4000 + 4 * 80)) <= 4, '80 frames of 4 bytes');
}
{
  const { p, reg, tick } = machine();
  reg(0, 0x80); reg(8, 0x00); reg(15, 255); reg(10, 2); reg(9, 2); tick(5);
  assert.deepEqual([...p.u8.subarray(0x4000, 0x4004)], [128, 128, 128, 128], 'no samples from the page: silence');
}
console.log('record: ok');
