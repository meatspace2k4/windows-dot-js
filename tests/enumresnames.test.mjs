// EnumResourceNamesA calls the program back with each name of a resource type in a module (a string name as its
// text, an id as itself) until the callback returns FALSE; a type the module lacks is ERROR_RESOURCE_TYPE_NOT_FOUND.
// It answered FALSE without calling back at all, so a program listing its icons or dialogs found none.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32;

const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(1 << 20) };
const dv = new DataView(p.mem.buffer);
// a module at 10000h, its resources at +2000h: type 14 (RT_GROUP_ICON) with the names "APPICON" and 2
const BASE = 0x10000, R = BASE + 0x2000;
const dir = (at, named, ids) => { dv.setUint16(at + 12, named, true); dv.setUint16(at + 14, ids, true); };
dir(R, 0, 1); dv.setUint32(R + 16, 14, true); dv.setUint32(R + 20, 0x80000000 | 0x18, true);   // root: type 14 -> 18h
dir(R + 0x18, 1, 1);
dv.setUint32(R + 0x18 + 16, 0x80000000 | 0x100, true); dv.setUint32(R + 0x18 + 20, 0x80000000 | 0x200, true);   // "APPICON"
dv.setUint32(R + 0x18 + 24, 2, true); dv.setUint32(R + 0x18 + 28, 0x80000000 | 0x200, true);                    // 2
const nm = 'APPICON'; dv.setUint16(R + 0x100, nm.length, true); [...nm].forEach((c, i) => dv.setUint16(R + 0x102 + 2 * i, c.charCodeAt(0), true));
const mod = { name: 'EXE', base: BASE, rsrc: 0x2000 };
let heap = 0x40000;
Object.assign(p, { modules: [mod], exe: mod, alloc: n => { const a = heap; heap += n + 15 & ~15; return a; }, free() {} });
const seen = []; let stopAt = Infinity;
p.call = (fn, [m, type, name, lp]) => { seen.push([m, type, name >>> 16 ? p.readA(name) : name, lp]); return seen.length < stopAt ? 1 : 0; };
const enumNames = (...a) => API.KERNEL32.EnumResourceNamesA[1].apply(p, a);

assert.equal(enumNames(BASE, 14, 0x5000, 0x77), 1);
assert.deepEqual(seen, [[BASE, 14, 'APPICON', 0x77], [BASE, 14, 2, 0x77]], 'each name, string names as text');
seen.length = 0; stopAt = 1; enumNames(BASE, 14, 0x5000, 0); assert.equal(seen.length, 1, 'a FALSE from the callback ends it');
assert.equal(enumNames(BASE, 5, 0x5000, 0), 0, 'no dialogs'); assert.equal(p.lastError, 1813);
console.log('enumresnames: ok');
