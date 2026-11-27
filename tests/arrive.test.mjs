// An arrival (braid-page.js arrive: a moment anchored on this computer, in a booted page) keeps the shell's own windows
// out of the rebind (a window of the page's is code the record cannot carry: matched by position to the booted
// shell's, the record's windows took over those objects and the rest drew nothing) and places the machines' windows
// as the record has them through the page (win95.js braidUi adoptNative, as a frame's list places one, no focus
// given to the machine): a machine that holds its Win16Lock, as a task mid-way does, sends no list until it lets go.
// The booted machines' windows the record has not are closed on the page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const bp = readFileSync(new URL('../braid-page.js', import.meta.url), 'utf8'), w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
// (arrive puts up its note and runs arrive0, whose body is the arrival itself)
const i = bp.indexOf('async function arrive0('), body = bp.slice(i, bp.indexOf('\n  }\n', i));
assert.match(body, /own = \['windows', 'tasks', 'modals', 'active', 'menus', 'menuSrc', 'cap', 'drag', 'ghost', 'msgApp'\]/, 'the shell\'s own, kept');
assert.match(body, /skip: \(o, k\) => shellSkip\(o, k\) \|\| \(o === sh && own\.includes\(k\)\)/, 'not rebound');
assert.match(body, /Object\.assign\(sh, kept\); shellBack\(sh\);/, 'put back before the shell takes them');
assert.ok(body.indexOf('const recWins = ') < body.indexOf('Object.assign(sh, kept)'), 'the record\'s windows taken first');
assert.match(body, /ui\.adoptNative\(a, n, \{ noTask: !!w\.noTask, minimizable: !w\.noTask \}\)/, 'placed through the page');
assert.match(body, /if \(w\.native && \[sys\(\), \.\.\.live\(\)\]\.includes\(w\.app\) && !placed\.has\(w\)\) ui\.closeWin\(w, true\);/, 'the booted machines\' others closed');
// the page's side: on the ui the braid page gets, placing without focus, by the frame's key
const j = w.indexOf('const braidUi = () => ({'), ui = w.slice(j, w.indexOf('\n});', j));
assert.match(ui, /adoptNative: \(app, n, o = \{\}\) => \{/);
assert.match(ui, /const key = n\.key \|\| n\.hwnd; let w = app\.wins\.get\(key\);/);
assert.match(ui, /else \{ w = new NativeWin\(app, n\); app\.wins\.set\(key, w\); windows\.push\(w\); if \(!w\.noTask\) tasks\.push\(w\); \}/);
assert.ok(!/focus\(/.test(ui.slice(ui.indexOf('adoptNative'))), 'no focus given to the machine');
assert.match(ui, /setActive: w => \{ active = w;/);
console.log('arrive: ok');
