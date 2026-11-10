// Moments of a machine share the memory that did not change between them (braid.js takeMemory): a chunk whose bytes
// are the last moment's at that place is that moment's chunk itself. Copied whole, each moment held all of the
// machine's memory, and the line marking itself through Windows 98 Setup ran the page out of memory. A travel puts the
// moment's bytes back and the next moment shares them; the export carries the bytes in their places.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync(new URL('../braid.js', import.meta.url), 'utf8'))();
const B = self.W95Braid;
const mem = new WebAssembly.Memory({ initial: 20 }), u = new Uint8Array(mem.buffer), root = { mem };
u[5] = 7; u[0x50000] = 9;
const g1 = B.takeGraph([root]); u[0x50000] = 10;
const g2 = B.takeGraph([root]);
const c1 = g1.entries[1].bytes.chunks, c2 = g2.entries[1].bytes.chunks;
assert.equal(g1.entries[1].bytes.length, u.length);
assert.ok(c1[0] === c2[0], 'an unchanged chunk is shared, not copied');
assert.ok(c1[1] !== c2[1], 'a changed chunk is the new moment\'s own');
assert.equal(c1[1][0x10000], 9, 'the earlier moment keeps its bytes');
B.restoreGraph(g1); assert.equal(u[0x50000], 9, 'travel puts the moment\'s bytes back');
const g3 = B.takeGraph([root]); assert.ok(g3.entries[1].bytes.chunks[1] === c1[1], 'after a travel the next moment shares the moment travelled to');
const s = B.serialize(g2); assert.equal(s.blob[0x50000], 10); assert.equal(s.blob[5], 7);
assert.notEqual(B.hashGraph ? B.hashGraph(0x811c9dc5, g1) : 0, B.hashGraph ? B.hashGraph(0x811c9dc5, g2) : 1, 'the checksum reads the chunks');
console.log('braidshare: ok');
