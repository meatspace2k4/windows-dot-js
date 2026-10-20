// A registry key keeps the case it was created with across copies: a key a machine creates in its worker (SPOOLSS's
// printer driver key, "Generic / Text Only") reaches the page's copy with its name, and the page's store records the
// name, so RegEnumKey gives it back as created after the next load, not in lower case.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const W = window.W95Win32;
const ops = [];
W.regAttach({ load: () => [], op: o => ops.push(o) });
const DRV = 'hklm\\system\\currentcontrolset\\control\\print\\environments\\windows 4.0\\drivers';

// the worker's change as it sends it: the key, named as created
W.regApply({ op: 'key', path: `${DRV}\\generic / text only`, name: 'Generic / Text Only' });
assert.ok(ops.some(o => o.op === 'key' && o.path === `${DRV}\\generic / text only` && o.name === 'Generic / Text Only'), 'the store gets the name');

// a later load from what the store recorded
const held = new Map();
for (const o of ops) if (o.op === 'key') held.set(o.path, [o.path, [], o.name || null]);
W.regAttach({ load: () => [...held.values()], op() {} });
assert.deepEqual(W.regDump().filter(([p]) => p === `${DRV}\\generic / text only`).map(r => r[2]), ['Generic / Text Only'], 'the name comes back');

// a key the copy already had, named afterwards: the name is recorded too
const more = [];
W.regAttach({ load: () => [[`${DRV}\\tty`, [], null]], op: o => more.push(o) });
W.regApply({ op: 'key', path: `${DRV}\\tty`, name: 'TTY' });
assert.ok(more.some(o => o.op === 'key' && o.name === 'TTY'));
console.log('regkeycase: ok');
