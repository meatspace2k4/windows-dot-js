// Windows 98's RUNONCE runs only as MSGSRV32 starts it ("runonce.exe -m"): started by anything else during a first start
// it says "InSetup, but called by someone other than msgsvr32" and ends, and its items fell to Explorer, which ran its
// own commands (FlushRegistry) as files. The system machine leaves a RUNONCE that says so to MSGSRV32; Windows 95's,
// which has no such check, it still runs itself first, under its "Windows 95 Setup" screen.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8'), i = src.indexOf('  startSystemTask() {'), j = src.indexOf('\n  /** with a network client installed', i);
assert.ok(i > 0 && j > i);
const run = runonce => {
  const files = { 'C:\\WINDOWS\\SYSTEM\\RUNONCE.EXE': new TextEncoder().encode(runonce) }, did = [];
  const fs = { exists: f => !!files[f], readFile: f => { if (!files[f]) throw new Error('no ' + f); return files[f]; } };
  const W = { regVals: () => [['programs on the start menu', 'grpconv -s']] };
  const M = new Function('W', 'fs', 'post', 'self', `return {${src.slice(i, j)}};`)(W, fs, () => {}, { W95SYSTEM: { programs: { 'RUNONCE.EXE': {} } } });
  const m = Object.assign(Object.create(M), { proc: { init16() {} }, loadMpr() {}, startMsgsrv() { did.push('msgsrv32'); return true; }, spawnProgram(f) { did.push(f); return { onExit: null }; } });
  m.startSystemTask(); return did;
};
assert.deepEqual(run('MZ... Runonce: InSetup, but called by someone other than msgsvr32!!!  Exiting...'), ['msgsrv32'], 'Windows 98\'s: MSGSRV32 starts it');
assert.deepEqual(run('MZ... Windows 95 Setup'), ['C:\\WINDOWS\\SYSTEM\\RUNONCE.EXE'], 'Windows 95\'s: run first, MSGSRV32 after');
console.log('runonce98: ok');
