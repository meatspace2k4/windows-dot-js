// A relocatable module LoadLibrary maps is put clear of 1000000h, where programs linked for Windows 95 are based
// (win32.js imageRoom), as it is put clear of 400000h. SIGRES.EXE, which RSABASE loads on Windows 95 OSR 2.5's first
// start, is linked at 1000000h, relocatable; at its base, Welcome and BonziBUDDY's MSAGENT.EXE had "no room for their
// image", "not a valid Win32 application"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const P = window.W95Win32.Process.prototype;
const spans = [];
const p = Object.assign(Object.create(P), { moduleSpans: () => spans, bundleSpans16: () => [], memoSpans: () => [] });
const dll = p.imageRoom(0x1000000, 0x6000, true);
assert.ok(dll && (dll + 0x6000 <= 0x1000000 || dll >= 0x1100000), `a relocatable module is put clear of 1000000h (at ${dll.toString(16)})`);
spans.push([dll, dll + 0x6000]);
assert.equal(p.imageRoom(0x1000000, 0x62000, false, true), 0x1000000, 'a program based there still has its base');
assert.equal(p.imageRoom(0x1000000, 0x62000, false), 0x1000000, 'a module with no relocations is put at its base');
console.log('programsbase: ok');
