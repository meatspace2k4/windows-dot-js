// Anchored moments as shared chunks (braid.js packAnchor, braid-page.js dbPut/dbGet/dbDel) and the line anchoring
// itself (braid.every): a moment stored and read back is the same moment (its checksum holds); two anchors that differ
// in one chunk store one chunk more than one; letting one go deletes only the chunks no other refers to; a missing or
// damaged chunk is refused; and every() keeps a buffer of anchors, the oldest let go only after a newer is written.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync(new URL('../braid.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../braid-page.js', import.meta.url), 'utf8'))();
const B = window.W95Braid, C = B.CHUNK;

// (bytes no two chunks of which are alike: a xorshift stream from the seed)
const bytes = (n, seed) => { const b = new Uint8Array(n); let x = seed * 2654435761 >>> 0 || 1; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff; } return b; };
const moment = (name, sys, page) => B.anchor({ name, now: 1, build: 'b', machines: { system: { meta: { n: 1 }, roots: [0], blob: sys, now: 1 } }, page: { meta: {}, roots: [], blob: page }, registry: {}, mods: [] });

{ // a round trip: the same bytes, the checksum holds
  const a = moment('a', bytes(3 * C + 100, 1), bytes(C / 2, 2)), { rec, chunks } = await B.packAnchor(a);
  assert.equal(rec.machines.system.blob.chunks.length, 4); assert.equal(rec.machines.system.blob.length, 3 * C + 100);
  const back = await B.unpackAnchor(rec, h => chunks.get(h));
  assert.deepEqual(back.machines.system.blob, a.machines.system.blob); assert.deepEqual(back.page.blob, a.page.blob);
  assert.equal(B.refuseAnchor(back, 'b'), null, 'the moment read back is the one stored');
  assert.equal(B.blobLength(rec.machines.system.blob), 3 * C + 100); assert.equal(B.blobLength(a.page.blob), C / 2);
  // a chunk missing, or one damaged: refused
  const h0 = rec.machines.system.blob.chunks[1];
  await assert.rejects(B.unpackAnchor(rec, h => (h === h0 ? undefined : chunks.get(h))), /chunk .* missing/);
  const bad = await B.unpackAnchor(rec, h => { const c = chunks.get(h); return h === h0 ? Uint8Array.from(c, (x, i) => (i === 5 ? x ^ 1 : x)) : c; });
  assert.match(B.refuseAnchor(bad, 'b'), /damaged/);
  // a record stored whole, from before chunks: read as it is
  assert.equal(await B.unpackAnchor(a, () => { throw new Error('no chunks asked'); }), a);
}

// ---- the store: braid-page.js's own dbPut/dbGet/dbDel over an IndexedDB stand-in (the calls they make, no more)
const idb = (() => {
  const stores = new Map();
  const request = f => { const r = {}; queueMicrotask(() => { try { r.result = f(); r.onsuccess && r.onsuccess(); } catch (e) { r.error = e; r.onerror && r.onerror(); } }); return r; };
  const db = {
    objectStoreNames: { contains: n => stores.has(n) }, createObjectStore: (n, o = {}) => { stores.set(n, { keyPath: o.keyPath, m: new Map() }); }, close() {},
    transaction(names) {
      const tx = { pending: 0 }; let ended = false;
      const finish = () => setTimeout(() => { if (!ended && tx.pending === 0) { ended = true; tx.oncomplete && tx.oncomplete(); } }, 0);
      const wrap = f => { tx.pending++; const r = request(f); const s = r; queueMicrotask(() => queueMicrotask(() => { tx.pending--; finish(); })); return s; };
      tx.objectStore = n => { const s = stores.get(n); return {
        get: k => wrap(() => s.m.get(k)), getKey: k => wrap(() => (s.m.has(k) ? k : undefined)), getAll: () => wrap(() => [...s.m.values()]),
        getAllKeys: () => wrap(() => [...s.m.keys()]), put: (v, k) => wrap(() => { s.m.set(s.keyPath ? v[s.keyPath] : k, v); }), delete: k => wrap(() => { s.m.delete(k); }) }; };
      finish(); return tx;
    },
  };
  return { open: () => { const r = {}; setTimeout(() => { r.result = db; if (!stores.size) r.onupgradeneeded && r.onupgradeneeded(); r.onsuccess(); }, 0); return r; }, stores };
})();
globalThis.indexedDB = idb;

const fakeUi = { W95Win32: { regDump: () => ({}) }, fs: { vols: new Map(), uncs: new Map() }, machines: () => [], sysApp: () => null, emit() {}, shared: () => null, closeMenus() {}, shell: () => ({}) };
const page = window.W95BraidPage(fakeUi), T = page.__test;
assert.ok(T, 'braid-page.js gives its store to tests (__test)');
{
  const base = bytes(8 * C, 3), changed = base.slice(); changed[5 * C + 7] ^= 0xff;
  await T.dbPut(moment('one', base, bytes(100, 9)));
  const n1 = idb.stores.get('chunks').m.size;
  await T.dbPut(moment('two', changed, bytes(100, 9)));
  const n2 = idb.stores.get('chunks').m.size;
  assert.equal(n2 - n1, 1, 'an anchor that differs in one chunk stores one chunk more');
  const two = await T.dbGet('two').catch(e => assert.fail(`the anchor read back whole: ${e.message}`)); assert.deepEqual(two.machines.system.blob, changed); assert.equal(B.refuseAnchor(two, 'b'), null);
  assert.equal(await T.dbDel('one'), true);
  assert.equal(idb.stores.get('chunks').m.size, n2 - 1, 'letting one go deletes the chunk only it had');
  assert.deepEqual((await T.dbGet('two')).machines.system.blob, changed, 'the other is whole');
  assert.equal(await T.dbDel('two'), true); assert.equal(idb.stores.get('chunks').m.size, 0, 'none left when no anchor is');
  assert.equal(await T.dbDel('two'), false);
}

{ // every(): the line anchors itself, keeping a buffer; the oldest goes only after a newer one is written
  const log = [], anchored = [];
  page.mark = async n => { log.push(['mark', n]); return { verdict: 'ok' }; };
  page.anchor = async n => { await new Promise(r => setTimeout(r, 5)); anchored.push(n); log.push(['anchor', n]); return { name: n }; };
  page.forget = async n => { log.push(['forget', n]); return true; };
  page.every(1000, 3, { anchorEvery: 20, anchorKeep: 3 });
  await new Promise(r => setTimeout(r, 300));
  page.every(0);
  const forgot = log.filter(([k]) => k === 'forget').map(([, n]) => n);
  assert.ok(anchored.length >= 5, `anchored ${anchored.length} times`);
  assert.deepEqual(page.auto.anchors, anchored.slice(-3), 'the last three kept');
  assert.deepEqual(forgot.filter(n => /^live/.test(n)), anchored.slice(0, -3), 'the older ones let go, oldest first');
  for (const n of forgot.filter(x => /^live/.test(x))) {
    const i = log.findIndex(([k, x]) => k === 'forget' && x === n), newer = anchored[anchored.indexOf(n) + 3];
    assert.ok(log.findIndex(([k, x]) => k === 'anchor' && x === newer) < i, `${n} let go only after ${newer} was written`);
  }
  assert.equal(page.every(1000).anchorEvery, 300000, 'anchoring on by default (5 min)'); page.every(0);
  assert.equal(page.every(1000, 3, { anchorEvery: 0 }).anchorEvery, 0); page.every(0);
}
console.log('braidchunks: ok');
process.exit(0);
