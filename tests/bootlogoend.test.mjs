// The start-up logo goes once the system's machine has started (win95.js startSystem), before its first step runs
// MSGSRV32, which plays SystemStart before it starts the shell (worker.js posts 'started', then step()). Kept until the
// machine had a window, the logo was still on screen as SystemStart played
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8'), k = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const s = w.slice(w.indexOf('function startSystem()'), w.indexOf('function startSystem()') + 2000);
assert.ok(s.indexOf('sysApp = a;') < s.indexOf('bootLogoEnd();', s.indexOf('sysApp = a;')) && s.indexOf('bootLogoEnd();', s.indexOf('sysApp = a;')) < s.indexOf("emit('system.start'"), 'the logo ends as the machine has started');
assert.match(k, /post\(\{ t: 'started'[^\n]*\n\s*this\.step\(\);/, 'the machine says it started before its first step (MSGSRV32, SystemStart)');
console.log('bootlogoend: ok');
