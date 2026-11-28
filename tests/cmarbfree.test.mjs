// CONFIGMG's Query_Arbitrator_Free_Size and _Free_Data (12h, 13h) answer a bitmap of the resource's free values, the
// emulated cards' held (ne16.js cmFreeBits): unimplemented, RUNDLL32 stopped in SETUPX as TCP/IP was added
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype, p = Object.create(P);
p.cards = () => [{ devnode: 'ROOT\\NET\\0000', io: [[0x300, 0x20]], irq: [5], dma: [] }, { io: [[0x220, 0x10]], irq: [7], dma: [1] }];
const irq = p.cmFreeBits(4);
assert.equal(irq.length, 2);
const free = v => !!(irq[v >> 3] & (1 << (v & 7)));
assert.ok(!free(5) && !free(7) && !free(0) && free(10) && free(11), 'IRQ 5 and 7 held, 10 and 11 free');
const io = p.cmFreeBits(2); assert.equal(io.length, 8192);
assert.ok(!(io[0x300 >> 3] & 1) && (io[0x340 >> 3] & 1), 'the card\'s ports held');
assert.equal(p.cmFreeBits(1), null, 'memory: not arbitrated here');
console.log('cmarbfree: ok');
