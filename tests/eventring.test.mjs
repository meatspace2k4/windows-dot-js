// The page's events in a numbered ring (win95.js emit, win95.events, win95.next's `after`): read after a number by any
// number of readers, none taking another's; an event that came before a next(type, test, ms, after) is its answer at
// once, so a script that asks after the fact still sees it (shell_events, shell_next after, shell_report after)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const cut = (from, to) => { const i = src.indexOf(from); assert.ok(i >= 0, from); const j = src.indexOf(to, i); assert.ok(j > i, to); return src.slice(i, j); };
const emitSrc = cut('function emit(type, data = {}) {', '\n// The system failing');
// (emit runs from the page's first lines, before win95.js's module constants are initialized: it reads none. Its ring
// size read from a `const EVENT_RING` threw "Cannot access 'EVENT_RING' before initialization", and the page's script
// stopped at the machine's DOS boot text)
assert.ok(!/\bEVENT_RING\b/.test(emitSrc) && !/^const EVENT_RING\b/m.test(src), 'no module constant in emit');
const eventsSrc = cut('  events(after = 0, type = null) {', '\n  // resolves with the next event');
const nextSrc = cut('  next(type, test, ms = 10000, after) {', '\n};\n');
const make = new Function(`const window = {}, listeners = new Map(), DEBUG = false, failText = e => e.kind;
${emitSrc}
const script = { on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
${eventsSrc}
${nextSrc} };
return { emit, script, window };`);
const { emit, script, window } = make();
emit('window.open', { title: 'Notepad' }); emit('window.close', { title: 'Notepad' }); emit('program.exit', { path: 'X' });
const all = script.events(0);
assert.equal(all.seq, 3); assert.deepEqual(all.events.map(e => e.seq), [1, 2, 3], 'numbered in order');
assert.deepEqual(script.events(1).events.map(e => e.type), ['window.close', 'program.exit'], 'after a number');
assert.deepEqual(script.events(0, 'window').events.map(e => e.type), ['window.open', 'window.close'], 'by type or its first part');
assert.equal(script.events(0).events.length, 3, 'a read takes nothing: another reader sees them all');
// (next with `after`: the event already there is the answer at once)
const had = await script.next('window.open', e => e.title === 'Notepad', 50, 0);
assert.equal(had.seq, 1, 'one that came before the read');
// (one not there yet: waited for, as before)
const later = script.next('window.open', null, 1000, 3);
emit('window.open', { title: 'Paint' });
assert.equal((await later).title, 'Paint');
// (the ring's cap: the oldest go, and a read from before them says how many it lost)
for (let i = 0; i < 4100; i++) emit('tick');
const r = script.events(0); assert.ok(r.lost > 0 && r.events.length === 4000, 'capped, the loss said');
console.log('eventring: ok');
