// A processor exception in a ring-0 run in flight (worker.js step's r0Step: a VxD call's nested run) is answered as
// any other the machine takes: MSGSRV32's, the system's own first task, is Windows' blue screen. Its error was
// caught as any error, the machine ended, and the page drew its own "illegal operation" box over a dead system
// (MSGSRV32 at 9A11E919, Windows 98's first start). Anything else from r0Step still ends the machine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const i = src.indexOf('  answerFault() {'), j = src.indexOf('  r0Fault(e) {', i);
assert.ok(i > 0 && j > i, 'answerFault and r0StepFailed beside r0Fault');
assert.equal((src.match(/try \{ p\.r0Step\(\); \} catch \(e\) \{ this\.r0StepFailed\(e\); return; \}/g) || []).length, 2, 'both r0Step runs answer their errors so');
assert.ok(!/p\.r0Step\(\); \} catch \(e\) \{ console\.error/.test(src), 'no r0Step error ends the machine unread');
class FaultError extends Error { constructor(f) { super(f.why); this.fault = f; } }
const posted = [];
const M = new Function('W', 'post', `return {${src.slice(i, j).replace(/\n {2}\}\n(?= {2}\S)/g, '\n  },\n')}};`)({ FaultError }, m => posted.push(m));
const machine = (system = true) => {
  const m = Object.create(M); m.system = system; m.alive = true; m.fatals = []; m.ended = null;
  m.proc = { depth: 3, fault: null, faulted(f) { if (!this.fault) this.fault = f; } };
  m.fatal = f => m.fatals.push(f); m.exited = (code, why) => { m.ended = [code, why]; m.alive = false; };
  return m;
};
const msgsrv = { n: 14, ring: 3, eip: 0x9a11e919, program: 'C:\\WINDOWS\\SYSTEM\\MSGSRV32.EXE', why: 'exception eh at 9a11e919' };
{ const m = machine(); m.r0StepFailed(new FaultError(msgsrv)); clearTimeout(m.timer);
  assert.deepEqual(m.fatals, [msgsrv], 'MSGSRV32\'s fault: the blue screen');
  assert.equal(m.ended, null, 'the machine not ended (no page fault box)'); assert.equal(m.proc.depth, 0); assert.ok(m.faultTaken); }
{ const m = machine(), f = { ...msgsrv, ring: 0, program: '' }; m.r0StepFailed(new FaultError(f)); clearTimeout(m.timer);
  assert.deepEqual(m.fatals, [f], 'a ring-0 fault: the blue screen'); }
{ const m = machine(), f = { ...msgsrv, program: 'C:\\WINDOWS\\EXPLORER.EXE' }; posted.length = 0; m.r0StepFailed(new FaultError(f));
  assert.deepEqual(m.fatals, []); assert.deepEqual(posted, [{ t: 'fault', f }], 'a program\'s: its fault dialog'); assert.ok(m.stopped); }
{ const m = machine(); const was = console.error; console.error = () => {}; m.r0StepFailed(new Error('VxD call 1234 did not return')); console.error = was;
  assert.deepEqual(m.ended, [-1, 'VxD call 1234 did not return'], 'another error ends the machine'); }
console.log('r0stepfault: ok');
