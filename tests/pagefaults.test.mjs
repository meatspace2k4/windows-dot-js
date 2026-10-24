// A machine on the page (NativeApp) answers for what the input and its steps run as the system's machine does
// (stepfaults.test.mjs): a processor exception in USER taking a key or the mouse, or in VKD's hot keys, is the
// machine's fault; anything else its end. Each was a console line, and the machine went on.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const c0 = src.indexOf('class NativeApp {'), c1 = src.indexOf('\n}\n', c0);
const cls = src.slice(c0, c1);
const method = name => { const i = cls.indexOf(`\n  ${name}(`); assert.ok(i >= 0, name); return cls.slice(i + 1, cls.indexOf('\n  }\n', i) + 4); };
class FaultError extends Error { constructor(fault) { super(fault.why); this.fault = fault; } }
class HangError extends Error {}
const SCAN = { KeyA: 0x1e, Delete: 0x53 };
const M = new Function('W95Win32', 'SCAN', 'performance', 'setTimeout', 'clearTimeout', 'clamp', 'dirty', 'closeProgram', 'fatalException', 'faultDialog', 'emit', 'msgBox', 'basename',
  `return class {\n${['step', 'caught', 'vkd', 'key', 'feedKeys', 'pointer', 'ring0', 'progName', 'kick'].map(method).join('\n')}\n}`);
const mk = proc => {
  const seen = [];
  const m = new (M({ FaultError, HangError }, SCAN, { now: () => 0 }, () => 1, () => {}, (v, a, b) => Math.max(a, Math.min(b, v)), () => {}, () => {},
    (app, f) => seen.push(['fatal', f.why]), (n, f) => seen.push(['dialog', f.why]), () => {}, () => {}, p => p))();
  Object.assign(m, { proc, alive: true, path: 'C:\\X.EXE', sw: 640, sh: 480, timer: 1, sync() {}, clipHandoff() {}, exited: (c, why) => { seen.push(['exited', why]); m.alive = false; } });
  return [m, seen];
};
const proc = extra => Object.assign({ depth: 0, stats: { slices: 0, guestMs: 0 }, exitCode: null, trapped: null, pcFaults: [],
  faulted(f) { this.fault = f; }, hung() {}, slice: () => true, timers16() {}, threads16() {}, systemPump() {}, appy16() {}, user16: () => ({ ax: 0 }) }, extra);
const r0 = why => { throw new FaultError({ ring: 0, why }); };

{ const p = proc({ keyEvent16: () => r0('page fault in USER') }), [m, seen] = mk(p);
  m.key({ keyCode: 0x41, code: 'KeyA' }, false); m.step();
  assert.deepEqual(seen, [['fatal', 'page fault in USER']], 'a fault in USER taking a key is the machine\'s fault'); }
{ const p = proc({ mouseEvent16: () => { throw new TypeError('q is null'); } }), [m, seen] = mk(p);
  m.pointer('move', 5, 5);
  assert.deepEqual(seen, [['exited', 'q is null']], 'an error feeding the mouse ends the machine, naming it'); }
{ const p = proc({ vkdKey: () => r0('page fault in VKD') }), [m, seen] = mk(p);
  m.vkd({ code: 'Delete', ctrlKey: true, altKey: true }, false); m.step();
  assert.deepEqual(seen, [['fatal', 'page fault in VKD']], 'a fault in VKD\'s hot key is the machine\'s fault'); }
console.log('pagefaults: ok');
