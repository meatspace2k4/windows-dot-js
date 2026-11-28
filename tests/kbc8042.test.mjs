// The system machine's keyboard controller (ne16.js kbcIO, ports 60h and 64h): SYSDETMG's keyboard identification
// (Windows 95 OSR 2.5 Setup, its segment 1 at ring 0) sends an unknown command (05h, answered FEh), then F2h Identify,
// answered FAh ABh 83h (an MF2), each byte read at 60h when 64h's bit 0 says one is there. With no controller it read
// FFh, and Setup asked which keyboard this was
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const p = Object.create(P); p.cpu = { eax: { value: 0 } };
const out = (port, v) => { p.cpu.eax.value = v; p.portIO(port, 1, false); };
const inb = port => { p.cpu.eax.value = 0; p.portIO(port, 1, true); return p.cpu.eax.value & 0xff; };
const read = () => { assert.equal(inb(0x64) & 1, 1, 'a byte to read'); return inb(0x60); };
assert.equal(inb(0x64) & 3, 0, 'nothing to read, not busy');
out(0x60, 0x05); assert.equal(read(), 0xfe, 'an unknown command: resend');
out(0x60, 0xf2); assert.deepEqual([read(), read(), read()], [0xfa, 0xab, 0x83], 'Identify: an MF2');
assert.equal(inb(0x64) & 1, 0, 'all read');
out(0x64, 0xaa); assert.equal(read(), 0x55, 'the controller\'s self test');
out(0x60, 0xed); assert.equal(read(), 0xfa); out(0x60, 0x02); assert.equal(read(), 0xfa, 'the LEDs and their byte');
out(0x60, 0xff); assert.deepEqual([read(), read()], [0xfa, 0xaa], 'reset');
console.log('kbc8042: ok');
