// SUnMapLS frees the selector SMapLS made, given back in ECX as USER32's thunks give it (ne16.js): taken from EAX,
// each MapWindowPoints left its selector and the machine ran out of them
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { API } = window.W95Win32;
const regs = { eax: 0x123000, ecx: 0, edx: 0, esp: 0x8000 }, freed = [];
const p = {
  reg(r, v) { if (v === undefined) return regs[r] >>> 0; regs[r] = v >>> 0; }, r32: () => 0x1000,
  mapLSExact(a) { this.mapped16 = new Set([0x1237]); return 0x12370000; },
  unmapLSExact: API.KERNEL32.SUnMapLS && null,
};
p.unmapLSExact = function (sp) { const sel = (sp >>> 16) & 0xfff8 | 7; if (this.mapped16.has(sel) && !(sp & 0xffff)) { this.mapped16.delete(sel); freed.push(sel); } };
API.KERNEL32.SMapLS[1].call(p);
const token = regs.edx; assert.equal(token, 0x12370000);
regs.eax = 1; regs.ecx = token;   // (EAX: the thunked call's answer; ECX: what SMapLS gave)
API.KERNEL32.SUnMapLS[1].call(p);
assert.deepEqual(freed, [0x1237], 'the selector in ECX freed');
console.log('sunmaplsecx: ok');
