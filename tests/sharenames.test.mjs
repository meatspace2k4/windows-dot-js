// The host's shares as Windows sees them: a name Windows cannot spell (the home folder's "music", with its quotes) is
// listed under a legal alias, and the alias names the host's file on every operation; a clash within the folder gets
// ~2, ~3; names Windows can spell pass as they are
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const cut = (a, b) => { const i = w.indexOf(a); assert.ok(i >= 0, a); return w.slice(i, w.indexOf(b, i) + b.length); };
const legalShares = new Function(`${cut('function legalShares(H) {', '\n}\n')}\nreturn legalShares;`)();

const calls = [];
const files = { '': ['"music"', 'Music', 'plain.txt', 'a*b', 'a_b', 'what?'], '"music"': ['track "one".mp3', 'ok.mp3'] };
const H = {
  list: () => [{ name: 'HOME' }],
  op: (share, op, ...a) => {
    calls.push([share, op, ...a]);
    if (op === 'list') return { ok: (files[a[0]] || []).map(name => ({ name, dir: !name.includes('.'), size: 1 })) };
    if (op === 'stat') return { ok: { dir: false, size: 7 } };
    return { ok: null };
  },
};
const S = legalShares(H);
// the home folder: "music" is shown as _music_, a*b as a_b~2 (a_b is there already), what? as what_
const top = S.op('HOME', 'list', '').ok.map(e => e.name);
assert.deepEqual(top, ['_music_', 'Music', 'plain.txt', 'a_b~2', 'a_b', 'what_']);
// operations on the alias reach the host's name, through the folder too
S.op('HOME', 'stat', '_music_'); assert.deepEqual(calls.at(-1), ['HOME', 'stat', '"music"']);
const inner = S.op('HOME', 'list', '_music_'); assert.deepEqual(calls.at(-1), ['HOME', 'list', '"music"']);
assert.deepEqual(inner.ok.map(e => e.name), ['track _one_.mp3', 'ok.mp3']);
S.op('HOME', 'read', '_music_\\track _one_.mp3', 0, 10); assert.deepEqual(calls.at(-1), ['HOME', 'read', '"music"\\track "one".mp3', 0, 10]);
S.op('HOME', 'rename', 'a_b~2', '_music_\\moved'); assert.deepEqual(calls.at(-1), ['HOME', 'rename', 'a*b', '"music"\\moved']);
// a legal name is untouched, listed or not
S.op('HOME', 'stat', 'Music\\sub\\x.txt'); assert.deepEqual(calls.at(-1), ['HOME', 'stat', 'Music\\sub\\x.txt']);
S.op('HOME', 'space'); assert.deepEqual(calls.at(-1), ['HOME', 'space']);
console.log('sharenames: ok');
