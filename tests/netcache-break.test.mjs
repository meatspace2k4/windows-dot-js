// trying to break netCache (win95.js)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const start = src.indexOf('function netCache(app, key) {'), end = src.indexOf('\n/** a network path read', start);
const W95FS = { FSError: class extends Error { constructor(c, p) { super(p); this.code = c; } } };
let now = 0;
const netCache = new Function('fs', 'dirty', 'W95FS', 'performance', src.slice(start, end) + '\nreturn netCache;')({ version: 0 }, () => {}, W95FS, { now: () => now });
const tick = () => new Promise(r => setTimeout(r, 0));
const fails = [];
const t = async (name, fn) => { try { await fn(); } catch (e) { fails.push(name + ': ' + e.message); } };
// (a stand-in for the system's machine: nothing here reaches a real drive; writes are only recorded)
const mk = (tree, o = {}) => {
  const calls = [], writes = [], files = o.files || {};
  const app = { alive: o.alive !== false, cmd: (c, [k, op, args]) => {
    calls.push(op + ':' + (op === 'writeAll' ? args[0] : args.join(',')));
    if (o.reject) return Promise.reject(new Error('gone'));
    if (op === 'writeAll') writes.push([args[0], Array.from(args[1])]);
    return Promise.resolve(op === 'list' ? (args[0] in tree ? tree[args[0]] : null) : op === 'space' ? { total: 10, free: 5 } : op === 'readAll' ? (files[args[0]] || null) : null);
  } };
  return { c: netCache(app, 'E'), calls, app, writes };
};
const bytes = s => Uint8Array.from(s, ch => ch.charCodeAt(0)), text = b => String.fromCharCode(...b);

await t('a file named before its folder is listed is a file once listed', async () => {
  const { c } = mk({ '': [{ name: 'a.txt', dir: false, size: 4 }] });
  c.stat('a.txt'); await tick(); const s = c.stat('a.txt'); assert.equal(s.dir, false); assert.equal(s.size, 4);
});
await t('a missing name in an unlisted folder is not reported missing forever', async () => {
  const { c } = mk({ '': [] }); c.stat('nope'); await tick(); assert.equal(c.stat('nope'), null);
});
await t('a folder whose listing fails (null) does not make everything below it exist', async () => {
  const { c } = mk({}); c.stat('x\\y'); await tick(); now += 5000; const s = c.stat('x\\y'); assert.notEqual(s && s.dir, true, 'still provisional dir after failed listing');
});
await t('a rejected call does not throw out of the cache', async () => {
  const { c } = mk({}, { reject: true }); c.list(''); await tick(); await tick(); assert.deepEqual(c.list(''), []);
});
await t('a mixed-case parent listed once is not listed again within 2 s', async () => {
  const { c, calls } = mk({ 'Dir': [] }); c.list('Dir'); c.list('DIR'); c.list('dir'); assert.equal(calls.filter(x => x.startsWith('list:')).length, 1);
});
await t('a listing is refreshed after 2 s (a file added on the host shows)', async () => {
  const tree = { '': [{ name: 'a', dir: false }] }; const { c } = mk(tree);
  c.list(''); await tick(); tree[''] = [{ name: 'a', dir: false }, { name: 'b', dir: false }]; now += 2500; c.list(''); await tick();
  assert.equal(c.stat('b') && c.stat('b').dir, false);
});
await t('a file deleted on the host stops being reported after a refresh', async () => {
  const tree = { '': [{ name: 'a', dir: false }] }; const { c } = mk(tree);
  c.list(''); await tick(); tree[''] = []; now += 2500; c.list(''); await tick(); assert.equal(c.stat('a'), null);
});
await t('unlink removes the entry and relists', async () => {
  const tree = { '': [{ name: 'a', dir: false }] }; const { c, calls } = mk(tree); c.list(''); await tick();
  tree[''] = []; c.unlink('a'); await tick(); await tick(); assert.equal(c.stat('a'), null); assert.ok(calls.includes('unlink:a'));
});
await t('a dead network machine answers nothing and does not throw', async () => {
  const { c } = mk({ '': [] }, { alive: false }); assert.doesNotThrow(() => c.list('')); assert.doesNotThrow(() => c.stat('q'));
});
await t('space answers', async () => { const { c } = mk({}); c.space(); await tick(); assert.equal(c.space().total, 10); });

// the shell's own reads and writes: its copy of the file, read whole first (ready), written back on close
await t('a file not read yet is not ready, and is asked for', async () => {
  const { c, calls } = mk({ '': [{ name: 'a.txt', dir: false, size: 3 }] }, { files: { 'a.txt': bytes('abc') } });
  c.list(''); await tick();
  assert.throws(() => c.open('a.txt', { read: true }), e => e.code === 21);
  assert.ok(calls.includes('readAll:a.txt'));
  await tick(); await tick();
  const h = c.open('A.TXT', { read: true }); assert.equal(text(c.read(h, 0, 10)), 'abc'); assert.equal(c.size(h), 3); c.close(h);
});
await t('ready reads a file, and a folder with everything in it', async () => {
  const tree = { '': [{ name: 'd', dir: true }], 'd': [{ name: 'x', dir: false, size: 1 }, { name: 'e', dir: true }], 'd\\e': [{ name: 'y', dir: false, size: 2 }] };
  const { c } = mk(tree, { files: { 'd\\x': bytes('1'), 'd\\e\\y': bytes('22') } });
  await c.ready('d');
  const h = c.open('d\\e\\y', { read: true }); assert.equal(text(c.read(h, 0, 9)), '22'); c.close(h);
  const g = c.open('d\\x', { read: true }); assert.equal(text(c.read(g, 0, 9)), '1'); c.close(g);
});
await t('a shallow ready lists the folder and reads none of its files', async () => {
  const { c, calls } = mk({ '': [{ name: 'd', dir: true }], 'd': [{ name: 'x', dir: false, size: 1 }] }, { files: { 'd\\x': bytes('1') } });
  await c.ready('d', false);
  assert.equal(c.stat('d\\x').size, 1); assert.ok(!calls.some(x => x.startsWith('readAll:')));
});
await t('a new file is written to the machine as it is closed, and shows at once', async () => {
  const { c, writes } = mk({ '': [] }); c.list(''); await tick();
  const h = c.open('n.txt', { write: true, create: true, trunc: true }); c.write(h, 0, bytes('hi')); c.write(h, 2, bytes('!')); c.close(h);
  assert.deepEqual(writes, [['n.txt', [104, 105, 33]]]);
  assert.equal(c.stat('n.txt').size, 3); assert.ok(c.list('').some(e => e.name === 'n.txt'));
  const r = c.open('n.txt', { read: true }); assert.equal(text(c.read(r, 0, 9)), 'hi!'); c.close(r);
});
await t('a file only read is not written back', async () => {
  const { c, writes } = mk({ '': [{ name: 'a', dir: false, size: 1 }] }, { files: { a: bytes('z') } });
  await c.ready('a'); const h = c.open('a', { read: true, write: true }); c.read(h, 0, 1); c.close(h);
  assert.deepEqual(writes, []);
});
await t('writing into an open copy leaves the cached file as it was until close', async () => {
  const { c } = mk({ '': [{ name: 'a', dir: false, size: 3 }] }, { files: { a: bytes('abc') } });
  await c.ready('a'); const w = c.open('a', { read: true, write: true }); c.write(w, 0, bytes('X'));
  const r = c.open('a', { read: true }); assert.equal(text(c.read(r, 0, 3)), 'abc'); c.close(r);
  c.truncate(w, 1); c.close(w);
  const r2 = c.open('a', { read: true }); assert.equal(text(c.read(r2, 0, 3)), 'X'); c.close(r2);
});
await t('a folder just made holds nothing, so a file can be created in it at once', async () => {
  const { c, calls } = mk({ '': [] }); c.list(''); await tick();
  c.mkdir('new'); assert.equal(c.stat('new').dir, true); assert.equal(c.stat('new\\f'), null);
  const h = c.open('new\\f', { write: true, create: true, trunc: true }); c.close(h);
  assert.deepEqual(calls.filter(x => /^(mkdir|writeAll)/.test(x)), ['mkdir:new', 'writeAll:new\\f']);
});
await t('a rename moves the entry and the copy of its file', async () => {
  const { c } = mk({ '': [{ name: 'a', dir: false, size: 1 }] }, { files: { a: bytes('q') } });
  await c.ready('a'); c.rename('a', 'b');
  assert.equal(c.stat('a'), null); assert.equal(c.stat('b').size, 1);
  const h = c.open('b', { read: true }); assert.equal(text(c.read(h, 0, 1)), 'q'); c.close(h);
});
await t('a deleted folder takes what was under it', async () => {
  const { c } = mk({ '': [{ name: 'd', dir: true }], 'd': [{ name: 'x', dir: false, size: 1 }] });
  await c.ready('d', false); c.rmdir('d'); assert.equal(c.stat('d'), null); assert.ok(!c.list('').some(e => e.name === 'd'));
});
await t('a file changed on the server is read afresh', async () => {
  const tree = { '': [{ name: 'a', dir: false, size: 1, mtime: 1 }] }, files = { a: bytes('1') };
  const { c } = mk(tree, { files }); await c.ready('a');
  tree[''] = [{ name: 'a', dir: false, size: 2, mtime: 2 }]; files.a = bytes('22'); now += 2500; c.list(''); await tick();
  assert.throws(() => c.open('a', { read: true }), e => e.code === 21);
  await tick(); await tick();
  const h = c.open('a', { read: true }); assert.equal(text(c.read(h, 0, 9)), '22'); c.close(h);
});
await t('a file that cannot be read stays not ready', async () => {
  const { c } = mk({ '': [{ name: 'a', dir: false, size: 1 }] }); await c.ready('a');
  assert.throws(() => c.open('a', { read: true }), e => e.code === 21);
});

console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'all pass');
process.exit(fails.length ? 1 : 0);
