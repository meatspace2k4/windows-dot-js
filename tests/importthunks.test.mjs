// An import (worker.js cmd 'import': a moment anchored on this computer arrived at in a booted machine) gives every
// import thunk its definition again by its name: the 16-bit ones' (ne16.js K16, by key) and the 32-bit ones' (win32.js
// API, by DLL and name) are code the export cannot carry, and a thunk the moment had that the booted machine had not
// made came without one (SUWIN's first call through it died in api16: fn.apply of undefined). A 16-bit thunk with no
// definition in this build (KERNEL.#604, SUWIN's) is as thunk16For makes it, answered by the native module's export
// when called (api16, t.native found again): not refused.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const i = w.indexOf("case 'import': {"), body = w.slice(i, w.indexOf("case 'kick':", i));
assert.match(body, /for \(const t of p\.th16 \|\| \[\]\) if \(t && t\.key\) \{ t\.def = K16\[t\.key\]; if \(!t\.def\) delete t\.native; \}/, 'the 16-bit thunks by key, one of no definition left to the native export');
assert.ok(!/16-bit thunk without a definition/.test(body), 'not refused');
assert.match(body, /for \(const t of p\.thunks \|\| \[\]\) if \(t && t\.dll\) t\.def = \(\(W\.API \|\| \{\}\)\[t\.dll\] \|\| \{\}\)\[t\.nm\];/, 'the 32-bit thunks by DLL and name');
assert.ok(body.indexOf('p.retDone[r.kind]') < body.indexOf('p.th16'), 'after the transitions in flight, before the modules\' instances');
// (the thunk records name what they need: ne16.js thunk16Def keeps the key, win32.js thunkFor the DLL and the name)
const n = readFileSync(new URL('../ne16.js', import.meta.url), 'utf8'), x = readFileSync(new URL('../win32.js', import.meta.url), 'utf8');
assert.match(n, /P\.thunk16Def = function \(key\) \{ return \{ key, def: K16\[key\] \}; \};/);
assert.match(x, /this\.thunks\.push\(\{ dll, nm, def \}\)/);
console.log('importthunks: ok');
