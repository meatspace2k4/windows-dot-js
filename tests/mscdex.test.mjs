// MSCDEX's device request (INT 2Fh AX=1510h), as MCICDA sends it for CD Player: the CD drive's status, the data disc
// as one data track to its lead-out (from the volume descriptor's size), its sector size; an unknown drive or command an
// error in the request header's status
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(1 << 20) };
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'es', 'ds', 'cf']) p.cpu[r] = { value: 0 };
const pvd = new Uint8Array(2048); new DataView(pvd.buffer).setUint32(80, 300000, true);
// (the volumes as the system machine has them: the page's, made afresh each time they are asked for)
const VOLS = new Map([['D', { kind: 'cdrom', letter: 'D', disc: { read: s => (s === 16 ? pvd : null) } }]]);
p.fs = { get vols() { return new Map([...VOLS].map(([k, v]) => [k, { ...v }])); } };
p.rmode = true;   // (as through DPMI's real-mode interrupt: ES:BX and the transfer address are segment:offset)
const req = (drive, cmd, block) => {
  p.u8.fill(0, 0x1000, 0x1100); p.u8[0x1002] = cmd; p.w32(0x100e, (0x110 << 16) | 0);   // header at 100:0, block at 110:0
  p.u8.fill(0, 0x1100, 0x1120); if (block) p.u8.set(block, 0x1100);
  p.cpu.eax.value = 0x1510; p.cpu.ecx.value = drive; p.cpu.es.value = 0x100; p.cpu.ebx.value = 0;
  assert.equal(p.interrupt(0x2f, 0x5000), 0x5000);
  return p.r16(0x1003);
};
assert.equal(req(3, 3, [6]), 0x0100); assert.equal(p.r32(0x1101), 0x0a14, 'device status of a data disc: no audio disc in the drive');
assert.equal(req(3, 3, [9]), 0x0100); assert.equal(p.u8[0x1101], 0xff, 'the first ask: media changed'); assert.equal(req(3, 3, [9]), 0x0100); assert.equal(p.u8[0x1101], 1, 'then not changed');
assert.equal(req(3, 3, [7]), 0x0100); assert.equal(p.r16(0x1102), 2048);
assert.equal(req(3, 3, [8]), 0x0100); assert.equal(p.r32(0x1101), 300000);
assert.equal(req(3, 3, [10]), 0x0100); assert.deepEqual([p.u8[0x1101], p.u8[0x1102]], [1, 1]);
const lead = 300000 + 150; assert.deepEqual([...p.u8.subarray(0x1103, 0x1106)], [lead % 75, Math.floor(lead / 75) % 60, Math.floor(lead / 4500)], 'the lead-out in Red Book (frame, second, minute)');
assert.equal(req(3, 3, [11, 1]), 0x0100); assert.equal(p.u8[0x1106], 0x41, 'track 1 is data'); assert.deepEqual([...p.u8.subarray(0x1102, 0x1105)], [0, 2, 0], 'at 00:02:00');
assert.equal(req(3, 3, [11, 2]), 0x8003, 'no track 2');
assert.equal(req(3, 0x84), 0x800c, 'nothing to play on a data disc'); assert.equal(req(3, 0x85), 0x0100);
assert.equal(req(3, 0x99), 0x8003); assert.equal(req(2, 3, [6]), 0x8001, 'C: is no CD drive');
// the audio disc in E: (cdaudio.js's table of contents): its tracks audio (control 01h), the lead-out; play from a track
// tells the page to play those sectors, the drive busy while it plays, the Q channel following the clock; stop pauses
// (the page told to stop), resume plays on from there, a second stop stops for good
{
  let now = 1000; const sent = []; p.cdClock = () => now; self.W95CDAUDIO = (op, from, to) => sent.push([op, from, to]);
  VOLS.set('E', { kind: 'cdrom', letter: 'E', audio: { tracks: [{ number: 1, lba: 0, sectors: 13275 }, { number: 2, lba: 13275, sectors: 13155 }], leadout: 26430 } });
  assert.equal(req(4, 3, [6]), 0x0100); assert.equal(p.r32(0x1101), 0x0214, 'device status of an audio disc: cooked/raw, audio, Red Book');
  assert.equal(req(4, 3, [10]), 0x0100); assert.deepEqual([p.u8[0x1101], p.u8[0x1102]], [1, 2]);
  assert.equal(req(4, 3, [11, 2]), 0x0100); assert.equal(p.u8[0x1106], 0x01, 'audio');
  const rb = 13275 + 150; assert.deepEqual([p.u8[0x1102], p.u8[0x1103], p.u8[0x1104]], [rb % 75, Math.floor(rb / 75) % 60, Math.floor(rb / 4500)]);
  // play track 2 to the end, by Red Book address
  p.u8.fill(0, 0x1000, 0x1100); p.u8[0x1002] = 0x84; p.u8[0x100d] = 1; p.w32(0x100e, (Math.floor(rb / 4500) << 16) | ((Math.floor(rb / 75) % 60) << 8) | (rb % 75)); p.w32(0x1012, 13155);
  p.cpu.eax.value = 0x1510; p.cpu.ecx.value = 4; p.cpu.es.value = 0x100; p.cpu.ebx.value = 0; p.interrupt(0x2f, 0);
  assert.equal(p.r16(0x1003), 0x0300, 'done, busy'); assert.deepEqual(sent, [['play', 13275, 26430]]);
  now += 2000; assert.equal(req(4, 3, [12]), 0x0300);
  assert.deepEqual([p.u8[0x1102], p.u8[0x1104], p.u8[0x1105], p.u8[0x1106]], [0x02, 0, 2, 0], 'track 02, 0:02.00 into it');
  assert.equal(req(4, 0x85), 0x0100); assert.deepEqual(sent.at(-1), ['stop', undefined, undefined]);
  assert.equal(req(4, 3, [15]), 0x0100); assert.equal(p.r16(0x1101), 1, 'paused');
  now += 5000; assert.equal(req(4, 0x88), 0x0300); assert.deepEqual(sent.at(-1), ['play', 13275 + 150, 26430], 'on from where it paused');
  assert.equal(req(4, 0x85), 0x0100); assert.equal(req(4, 0x85), 0x0100); assert.equal(req(4, 0x88), 0x800c, 'stopped: nothing to resume');
  assert.equal(req(3, 0x84), 0x800c, 'a data disc has no audio');
  // CD Player's way: play track 1 alone (its sectors); the drive is busy for the track's 177 seconds, every request
  // until then saying so, and done after; Stop then stops the page's drive even with the disc done
  const playTrack = (lba, n) => { p.u8.fill(0, 0x1000, 0x1100); p.u8[0x1002] = 0x84; p.w32(0x100e, lba); p.w32(0x1012, n); p.cpu.eax.value = 0x1510; p.cpu.ecx.value = 4; p.cpu.es.value = 0x100; p.cpu.ebx.value = 0; p.interrupt(0x2f, 0); return p.r16(0x1003); };
  sent.length = 0;
  assert.equal(playTrack(0, 13275), 0x0300); assert.deepEqual(sent, [['play', 0, 13275]]);
  for (let s = 25; s <= 175; s += 25) { now += 25000; assert.equal(req(4, 3, [15]) & 0x0200, 0x0200, `still busy ${s} s in`); }
  now += 2000; assert.equal(req(4, 3, [12]) & 0x0200, 0, 'done after the track');
  assert.equal(req(4, 0x85), 0x0100); assert.deepEqual(sent.at(-1), ['stop', undefined, undefined]);
  // seek (CD Player stops, seeks to the track, then plays): the head there, the drive idle, the Q channel at the track
  { const seek = (lba, mode) => { p.u8.fill(0, 0x1000, 0x1100); p.u8[0x1002] = 0x83; p.u8[0x100d] = mode; p.w32(0x100e, lba); p.cpu.eax.value = 0x1510; p.cpu.ecx.value = 4; p.cpu.es.value = 0x100; p.cpu.ebx.value = 0; p.interrupt(0x2f, 0); return p.r16(0x1003); };
    assert.equal(seek(13275, 0), 0x0100, 'seek to track 2'); assert.equal(req(4, 3, [12]) & 0x0200, 0, 'idle after a seek');
    assert.deepEqual([p.u8[0x1102], p.u8[0x1104], p.u8[0x1105], p.u8[0x1106]], [0x02, 0, 0, 0], 'at the start of track 02');
    assert.equal(seek(99999999, 0), 0x800c, 'past the lead-out'); }
  // stop in the middle of a play: the page told to stop
  sent.length = 0; assert.equal(playTrack(13275, 13155), 0x0300); now += 3000; assert.equal(req(4, 0x85), 0x0100); assert.deepEqual(sent, [['play', 13275, 26430], ['stop', undefined, undefined]]);
}
console.log('mscdex: ok');
