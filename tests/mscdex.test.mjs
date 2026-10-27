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
p.fs = { vols: new Map([['D', { kind: 'cdrom', letter: 'D', disc: { read: s => (s === 16 ? pvd : null) } }]]) };
p.rmode = true;   // (as through DPMI's real-mode interrupt: ES:BX and the transfer address are segment:offset)
const req = (drive, cmd, block) => {
  p.u8.fill(0, 0x1000, 0x1100); p.u8[0x1002] = cmd; p.w32(0x100e, (0x110 << 16) | 0);   // header at 100:0, block at 110:0
  p.u8.fill(0, 0x1100, 0x1120); if (block) p.u8.set(block, 0x1100);
  p.cpu.eax.value = 0x1510; p.cpu.ecx.value = drive; p.cpu.es.value = 0x100; p.cpu.ebx.value = 0;
  assert.equal(p.interrupt(0x2f, 0x5000), 0x5000);
  return p.r16(0x1003);
};
assert.equal(req(3, 3, [6]), 0x0100); assert.equal(p.r32(0x1101), 0x0214, 'device status: cooked/raw, data and audio, Red Book');
assert.equal(req(3, 3, [7]), 0x0100); assert.equal(p.r16(0x1102), 2048);
assert.equal(req(3, 3, [8]), 0x0100); assert.equal(p.r32(0x1101), 300000);
assert.equal(req(3, 3, [10]), 0x0100); assert.deepEqual([p.u8[0x1101], p.u8[0x1102]], [1, 1]);
const lead = 300000 + 150; assert.deepEqual([...p.u8.subarray(0x1103, 0x1106)], [lead % 75, Math.floor(lead / 75) % 60, Math.floor(lead / 4500)], 'the lead-out in Red Book (frame, second, minute)');
assert.equal(req(3, 3, [11, 1]), 0x0100); assert.equal(p.u8[0x1106], 0x41, 'track 1 is data'); assert.deepEqual([...p.u8.subarray(0x1102, 0x1105)], [0, 2, 0], 'at 00:02:00');
assert.equal(req(3, 3, [11, 2]), 0x8003, 'no track 2');
assert.equal(req(3, 0x84), 0x0100); assert.equal(req(3, 0x85), 0x0100);
assert.equal(req(3, 0x99), 0x8003); assert.equal(req(2, 3, [6]), 0x8001, 'C: is no CD drive');
console.log('mscdex: ok');
