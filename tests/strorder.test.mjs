// Windows' order of strings, and a named object's life:
// - CompareStringA and lstrcmpA order by letter whatever the case, then the lower case first ("version" before
//   "Version"). By character code the capital came first: SETUPAPI's string table keeps each hash chain in this order
//   and stops at the first entry that matches without case, so it found "Version" (a value's text) where it looked
//   for "version" (the section's name), no INF section was found, and nothing installed through SETUPAPI (BROWSEUI's
//   DllInstall, the band site Explorer's taskbar creates) was registered
// - a second CreateMutex of a name gives a handle that is its process's, closed when that process ends: left open,
//   RUNONCE's Runonce_Instance_Mutex outlived every RUNONCE and each one after found a "previous instance"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32, P = Process.prototype, K = API.KERNEL32;

{ // the order
  const p = Object.create(P); p.mem = { buffer: new ArrayBuffer(0x4000) };
  const put = (at, s) => { for (let i = 0; i < s.length; i++) p.u8[at + i] = s.charCodeAt(i); p.u8[at + s.length] = 0; return at; };
  const cmp = (x, y, f = 0) => K.CompareStringA[1].call(p, 0x409, f, put(0x100, x), -1 >>> 0, put(0x800, y), -1 >>> 0);
  const l = (x, y) => K.lstrcmpA[1].call(p, put(0x100, x), put(0x800, y)) | 0;
  assert.equal(cmp('version', 'Version'), 1, 'the lower case first');
  assert.equal(cmp('Version', 'version'), 3);
  assert.equal(cmp('version', 'Version', 1), 2, 'equal without case');
  assert.equal(cmp('Version', 'Version'), 2);
  assert.equal(cmp('a', 'B'), 1, 'letters before case');
  assert.equal(cmp('B', 'a'), 3);
  assert.equal(cmp('28591', 'version'), 1);
  assert.equal(cmp('abc', 'abcd'), 1, 'the shorter first');
  assert.equal(cmp('abcd', 'ab', 0), 3);
  assert.equal(l('a', 'B'), -1); assert.equal(l('B', 'a'), 1); assert.equal(l('version', 'Version'), -1); assert.equal(l('x', 'x'), 0);
  // (counted strings: only that many characters)
  assert.equal(K.CompareStringA[1].call(p, 0x409, 0, put(0x100, 'abcX'), 3, put(0x800, 'abcY'), 3), 2);
}

{ // the name goes with the last process that has it
  const p = Object.create(P); p.mem = { buffer: new ArrayBuffer(0x1000) }; p.handles = new Map(); p.nextHandle = 0x100;
  const name = 0x200; 'Runonce_Instance_Mutex'.split('').forEach((c, i) => { p.u8[name + i] = c.charCodeAt(0); });
  const A = { pid: 1 }, B = { pid: 2 }, C = { pid: 3 };
  p.thread16 = { pc: A };
  K.CreateMutexA[1].call(p, 0, 0, name); assert.equal(p.lastError, 0, 'the first makes it');
  p.thread16 = { pc: B }; K.CreateMutexA[1].call(p, 0, 0, name); assert.equal(p.lastError, 183, 'the second finds it');
  p.namedClose(A); p.namedClose(B);
  p.thread16 = { pc: C }; K.CreateMutexA[1].call(p, 0, 0, name); assert.equal(p.lastError, 0, 'both gone: a new one');
}
console.log('strorder: ok');
