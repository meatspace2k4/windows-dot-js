import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js', 'ne16.js']) {
  new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
}

const W = window.W95Win32;
const P = W.Process.prototype;
const saver = { pid: 0x120, saverMode: 'p', exitCode: null };
const thread = { id: 8, pc: saver, state: 'waiting', wait: null, ctx: {} };
const p = Object.create(P);
let ended = null;
Object.assign(p, {
  threadsById: new Map([[thread.id, thread]]),
  threadsNest: 0,
  thread16: null,
  win16Held: null,
  cpu: { eip: { value: 0x401000 } },
  saveCtx16: () => ({}),
  loadCtx16() {},
  now: () => 0,
  imgUse() {},
  runTop() { throw new W.HangError('saver blocked inside a nested guest call'); },
  endProcess(pc, code) { ended = [pc, code]; pc.exitCode = code; },
});

P.threads16.call(p);
assert.deepEqual(ended, [saver, 0xffffffff], 'a hung saver is ended as an isolated child process');
assert.equal(thread.state, 'done', 'the hung saver thread is retired');
assert.equal(p.win16Held, null, 'the saver does not leave the shell holding the global Win16 lock');
console.log('saverhang: ok');
