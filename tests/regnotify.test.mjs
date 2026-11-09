// RegNotifyChangeKeyValue: the event is set once, at the key's next change of the kinds asked for (values: LAST_SET 4;
// keys made or deleted: NAME 1), under it too when the subtree is watched, whoever made the change (a quiet one told
// from the page or another machine as well). Windows 98's ADVAPI32 has the call; missing here, its import was a dead
// thunk on Windows 98's first start and the shell's start stalled behind the logo.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, [n, fn] = W.API.ADVAPI32.RegNotifyChangeKeyValue;
assert.equal(n, 5);
W.regLoad([]); W.regSet('hklm\\software\\test', 'v', 1); W.regSet('hklm\\software\\test\\sub', 'w', 1);
const HKLM = 0x80000002, signalled = [];
const objs = new Map();
// (the process's handles and memory stood in: a string argument is its own address, readA)
const p = Object.create(W.Process.prototype), out = 0x20; let opened = 0;
const newHandle = o => { const h = 0x100 + objs.size; objs.set(h, o); return h; };
Object.assign(p, { obj: h => objs.get(h), newHandle, signal: o => signalled.push(o.name), readA: a => (typeof a === 'string' ? a : ''), w32: (a, v) => { if (a === out) opened = v; } });
const ev = name => newHandle({ kind: 'event', name });
// the key's handle, as RegOpenKeyExA gives it
assert.equal(W.API.ADVAPI32.RegOpenKeyExA[1].call(p, HKLM, 'software\\test', 0, 0, out), 0);
const hk = opened;
assert.equal(fn.call(p, hk, 0, 4, ev('values'), 1), 0);
assert.equal(fn.call(p, hk, 1, 4, ev('subtree'), 1), 0);
assert.equal(fn.call(p, hk, 0, 1, ev('names'), 1), 0);
W.regSet('hklm\\software\\test\\sub', 'w', 2);
assert.deepEqual(signalled, ['subtree'], 'a value under it: only the subtree watch');
W.regSet('hklm\\software\\test', 'v', 2);
assert.deepEqual(signalled, ['subtree', 'values'], 'a value of the key');
W.regSet('hklm\\software\\test', 'v', 3);
assert.deepEqual(signalled, ['subtree', 'values'], 'once each');
W.regApply({ op: 'key', path: 'hklm\\software\\test\\new', name: 'New' }, true);
assert.deepEqual(signalled, ['subtree', 'values', 'names'], 'a key made under it, told quietly: its names changed');
assert.equal(fn.call(p, hk, 0, 1, ev('names2'), 1), 0);
W.regApply({ op: 'delkey', path: 'hklm\\software\\test\\sub' }, true);
assert.deepEqual(signalled, ['subtree', 'values', 'names', 'names2'], 'a key deleted under it, told quietly');
assert.equal(fn.call(p, hk, 0, 4, 0, 0), 0, 'a synchronous ask answered');
assert.equal(fn.call(p, 0x1234, 0, 4, ev('x'), 1), 6, 'no such key');
console.log('regnotify: ok');
