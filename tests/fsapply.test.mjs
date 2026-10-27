// A shared volume's changes from another person's machine (fs.js applyStore): the store operations one machine's C:
// writes through (node, remove, data, size, label) applied to another's live tree by node id give the same tree and
// bytes, write nothing back to the second one's store, and make the change events a local change makes; each machine
// creates nodes from the block of ids its store gives it
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis;
new Function(readFileSync(new URL('../fs.js', import.meta.url), 'utf8'))();
const { FileSystem } = window.W95FS;
const store = (sidBase, sent) => ({
  sidBase, load: () => null,
  node: r => sent.push({ op: 'node', ...r }), remove: sid => sent.push({ op: 'remove', sid }),
  data: (sid, offset, bytes) => sent.push({ op: 'data', sid, offset, bytes: bytes.slice() }), size: (sid, size) => sent.push({ op: 'size', sid, size }),
  label: (label, serial) => sent.push({ op: 'label', label, serial }),
});
const machine = sidBase => { const fs = new FileSystem(), sent = []; fs.mount('C', { kind: 'fixed', total: 1 << 24 }); fs.attach('C', store(sidBase, sent)); return { fs, sent }; };
const tree = fs => { const out = []; const walk = (p, d) => { for (const k of fs.readdir(p).map(e => e.name || e).sort()) { const f = p + (p.endsWith('\\') ? '' : '\\') + k, st = fs.stat(f); out.push(st.isDir ? f + '\\' : `${f}=${new TextDecoder().decode(fs.readFile(f))}`); if (st.isDir) walk(f, d + 1); } }; walk('C:\\', 0); return out; };

const A = machine(1 << 20), B = machine(2 << 20);
const sync = (from, to) => { for (const op of from.sent.splice(0)) to.fs.applyStore('C', op); };
sync(A, B); sync(B, A);   // (each one's empty root: the other's is the same)
const evs = []; B.fs.on(e => evs.push(e.op));
A.fs.mkdir('C:\\Docs'); A.fs.writeFile('C:\\Docs\\a.txt', new TextEncoder().encode('hello world'));
assert.ok(A.sent.some(o => o.op === 'node' && o.sid >= 1 << 20), 'A\'s nodes in its block');
sync(A, B);
assert.deepEqual(tree(B.fs), ['C:\\Docs\\', 'C:\\Docs\\a.txt=hello world']);
assert.deepEqual(B.sent, [], 'nothing written back by the apply');
assert.ok(evs.includes('mkdir') && evs.includes('create') && evs.includes('write'));
// B's own changes: in B's block, back to A; a rename, a truncation, a removal
B.fs.writeFile('C:\\b.txt', new TextEncoder().encode('from b'));
assert.ok(B.sent.some(o => o.op === 'node' && o.sid >= 2 << 20 && o.name === 'b.txt'));
sync(B, A); assert.deepEqual(tree(A.fs), tree(B.fs));
A.fs.rename('C:\\Docs\\a.txt', 'C:\\Docs\\renamed.txt');
const fd = A.fs.open('C:\\Docs\\renamed.txt', 'r+'); A.fs.truncate(fd, 5); A.fs.close(fd);
sync(A, B); assert.deepEqual(tree(B.fs), ['C:\\Docs\\', 'C:\\Docs\\renamed.txt=hello', 'C:\\b.txt=from b']);
A.fs.unlink('C:\\b.txt');
sync(A, B); assert.deepEqual(tree(B.fs), ['C:\\Docs\\', 'C:\\Docs\\renamed.txt=hello']);
// an op whose folder this side never saw is skipped, not thrown
assert.equal(B.fs.applyStore('C', { op: 'node', sid: 99, parent: 12345, name: 'x', dir: false }), false);
console.log('fsapply: ok');
