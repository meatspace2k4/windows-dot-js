// a page that is not a secure context (plain http from another machine) has an AudioContext without audioWorklet:
// the sound hardware loads with no output instead of stopping the machine's start, and the context is closed
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
let closed = 0;
window.AudioContext = class { constructor() { this.state = 'running'; } close() { closed++; } };
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'sound.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
assert.equal(closed, 1, 'the context without audioWorklet is closed');
console.log('noworklet: ok');
