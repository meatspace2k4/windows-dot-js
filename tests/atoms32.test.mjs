// KERNEL32's local atoms (AddAtomA, FindAtomA, DeleteAtom, GetAtomNameA, InitAtomTable): each process's own table.
// They were dead imports: HyperTerminal's AddAtomA faulted and its fault handling stopped the system's machine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32;
const p = Object.create(Process.prototype); p.mem = { buffer: new ArrayBuffer(0x20000) };
const K = n => (...a) => API.KERNEL32[n][1].call(p, ...a);
const NAME = 0x11000, BUF = 0x12000;   // (a string's address is 10000h or more: one under it is MAKEINTATOM's integer)
const str = s => { p.writeA(NAME, s); return NAME; };
const A = { pid: 1 }, B = { pid: 2 };
p.thread16 = { pc: A };
const a1 = K('AddAtomA')(str('HyperTerminal'));
assert.ok(a1 >= 0xc000, 'a string atom');
assert.equal(K('AddAtomA')(str('hyperterminal')), a1, 'the same name, any case: the same atom');
assert.equal(K('FindAtomA')(str('HYPERTERMINAL')), a1);
assert.equal(K('GetAtomNameA')(a1, BUF, 64), 13); assert.equal(p.readA(BUF), 'HyperTerminal');
assert.equal(K('AddAtomA')(str('#42')), 42, 'an integer atom is itself'); assert.equal(K('AddAtomA')(42), 42);
assert.equal(K('GetAtomNameA')(42, BUF, 64), 3); assert.equal(p.readA(BUF), '#42');
p.thread16 = { pc: B };
assert.equal(K('FindAtomA')(str('HyperTerminal')), 0, 'another process\'s table is its own');
p.thread16 = { pc: A };
K('DeleteAtom')(a1); assert.equal(K('FindAtomA')(str('HyperTerminal')), a1, 'added twice: still there after one delete');
K('DeleteAtom')(a1); assert.equal(K('FindAtomA')(str('HyperTerminal')), 0, 'gone with its last reference');
console.log('atoms32: ok');
