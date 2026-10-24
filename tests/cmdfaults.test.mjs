// A command from the page (focus, close, the clipboard, a mode change, a saver) runs guest code as a step does, and
// answers to the machine the same way (caught): a processor exception is its fault, anything else its end. The
// message handler took every error as a console line and a reply, and a saver's start read any error as WinExec's 8.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const method = name => { const i = src.indexOf(`  ${name}(`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n  }\n', i) + 4); };
assert.match(src, /machine\.runCmd\(m\.name, m\.args \|\| \[\]\)/, 'the message handler runs commands through runCmd');
class FaultError extends Error { constructor(fault) { super(fault.why); this.fault = fault; } }
class HangError extends Error {}
const M = new Function('W', 'self', `return class {\n${['runCmd', 'caught', 'clipOut', 'clipIn'].map(method).join('\n')}\n}`);
const mk = proc => { const seen = []; const m = new (M({ FaultError, HangError }, { W95FS: {} }))(); Object.assign(m, { proc, exited: (c, why) => seen.push(['exited', why]) }); return [m, seen]; };
const r0 = why => { throw new FaultError({ ring: 0, why }); };

{ const p = { depth: 0, faulted(f) { this.fault = f; } }, [m, seen] = mk(p);
  m.cmd = () => r0('page fault in USER closing a window');
  assert.throws(() => m.runCmd('close', [0x40]), /closing a window/);
  assert.equal(p.fault && p.fault.why, 'page fault in USER closing a window', 'a command\'s fault is the machine\'s fault'); assert.deepEqual(seen, []); }
{ const [m, seen] = mk({ depth: 0 }); m.cmd = () => { throw new TypeError('w is undefined'); };
  assert.throws(() => m.runCmd('focus', [0x40]), /w is undefined/);
  assert.deepEqual(seen, [['exited', 'w is undefined']], 'any other error in a command ends the machine, naming it'); }
{ const [m, seen] = mk({ depth: 0 }); m.cmd = async () => { throw new TypeError('late'); };
  await assert.rejects(m.runCmd('spawn', []), /late/); assert.deepEqual(seen, [['exited', 'late']], 'and one a command\'s promise rejects with'); }
for (const name of ['clipOut', 'clipIn']) {
  const p = { depth: 0, exitCode: null, faulted(f) { this.fault = f; }, user16: () => r0(`page fault in USER (${name})`) }, [m] = mk(p);
  m.cmd = (n, a) => m[n](...a);
  assert.throws(() => m.runCmd(name, ['text']), /page fault in USER/);
  assert.equal(p.fault && p.fault.why, `page fault in USER (${name})`, `${name}'s fault reaches the machine`);
}
const saver = method('spawnSaver');
assert.doesNotMatch(saver, /catch \(e\) \{[^}]*return 8;/, 'a saver that fails to start is not WinExec\'s 8');
console.log('cmdfaults: ok');
