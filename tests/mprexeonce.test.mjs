// One MPREXE: it is MPR's to start (worker.js loadMpr). Windows 95's and 98's MPR.DLL both start SYSTEM\MPREXE.EXE
// on the first call made with no server registered in MPR's shared data (MPRInitEvent, MPRMutex); the host starts none.
// Started by the host as well, a second MPREXE took MPR's shared server record, and GRPCONV's request waited for good
// at "Programs on the Start menu".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const at = w.indexOf('  loadMpr() {'), body = w.slice(at, w.indexOf('  blankPasswordList() {', at));
const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
assert.ok(!/MPREXE/i.test(code), 'loadMpr starts no MPREXE of its own');
assert.ok(!/spawnProgram/.test(code), 'nor any program');
assert.match(code, /p\.loadDll\('MPR'\)/, 'MPR is loaded, and starts MPREXE when it is first called');
console.log('mprexeonce: ok');
