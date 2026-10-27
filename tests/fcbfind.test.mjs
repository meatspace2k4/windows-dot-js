// INT 21h's FCB searches, 11h find first and 12h find next, which File Manager uses (with an extended FCB, attribute 8,
// for a drive's volume label): unanswered, WINFILE stopped on "unhandled int 21h ax=1103" and faulted in USER after it
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process } = window.W95Win32, { FileSystem } = window.W95FS;
const p = Object.create(Process.prototype);
p.mem = { buffer: new ArrayBuffer(0x40000) };
p.cpu = {}; for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ds', 'es', 'cf']) p.cpu[r] = { value: 0 };
p.vxdFlat = true;   // (offsets are linear addresses: no segments to set up)
p.fs = new FileSystem(); p.fs.mount('C', { kind: 'fixed', total: 1 << 24, label: 'MYDISK' }); p.fs.mkdir('C:\\DOCS', { recursive: true });
p.fs.writeFile('C:\\DOCS\\README.TXT', new Uint8Array(10)); p.fs.writeFile('C:\\DOCS\\NOTES.TXT', new Uint8Array(20)); p.fs.writeFile('C:\\DOCS\\A.BAT', new Uint8Array(1));
p.fs.chdir('C:\\DOCS');
const FCB = 0x1000, DTA = 0x2000, al = () => p.cpu.eax.value & 0xff;
p.dta = DTA;
const fcb = (name, ext, attr) => {   // an extended FCB when attr is given
  p.u8.fill(0, FCB, FCB + 44); let f = FCB;
  if (attr !== undefined) { p.u8[FCB] = 0xff; p.u8[FCB + 6] = attr; f += 7; }
  p.u8[f] = 3; p.u8.fill(0x20, f + 1, f + 12); [...name].forEach((c, i) => { p.u8[f + 1 + i] = c.charCodeAt(0); }); [...ext].forEach((c, i) => { p.u8[f + 9 + i] = c.charCodeAt(0); });
  p.cpu.edx.value = FCB;
};
const found = ext => String.fromCharCode(...p.u8.subarray(DTA + (ext ? 8 : 1), DTA + (ext ? 19 : 12)));
fcb('????????', 'TXT');
p.cpu.eax.value = 0x1100; p.dosNames(0x11, false); assert.equal(al(), 0, 'found');
const names = [found(false)];
for (;;) { p.cpu.eax.value = 0x1200; p.dosNames(0x12, false); if (al()) break; names.push(found(false)); }
assert.equal(al(), 0xff, 'then none more');
assert.deepEqual(names.sort(), ['NOTES   TXT', 'README  TXT'], 'the .TXT files, as 8.3 names in the FCB');
assert.equal(p.r32(DTA + 29), names[0] === 'NOTES   TXT' ? 20 : 10, 'its size in the directory entry');
fcb('NOSUCH  ', 'XYZ'); p.cpu.eax.value = 0x1100; p.dosNames(0x11, false); assert.equal(al(), 0xff, 'none: AL FFh');
// the volume label, through an extended FCB with attribute 8
fcb('????????', '???', 8); p.cpu.eax.value = 0x1100; p.dosNames(0x11, false);
assert.equal(al(), 0); assert.equal(p.u8[DTA], 0xff, 'the extended header copied'); assert.equal(p.u8[DTA + 7 + 12], 8, 'attribute: volume label');
assert.equal(found(true).trim(), 'MYDISK');
// INT 25h, absolute disk read of C:'s boot sector (File Manager reads it): a FAT boot sector with the volume's label;
// the flags stay pushed; INT 26h, a write, is refused write-protected
{
  const { INTS } = window.W95NE16;
  for (const r of ['ss', 'ssb', 'esb', 'esp']) p.cpu[r] = { value: 0 };
  p.rmode = true; p.cpu.esp.value = 0x8000; p.cpu.ds.value = 0; p.cpu.ebx.value = 0x3000; p.cpu.ecx.value = 1; p.cpu.edx.value = 0; p.cpu.eax.value = 2;
  INTS[0x25].call(p);
  assert.equal(p.cpu.cf.value, 0, 'read');
  assert.equal(p.r16(0x3000 + 510), 0xaa55, 'a boot sector'); assert.equal(p.r16(0x3000 + 11), 512, 'its bytes a sector');
  assert.equal(String.fromCharCode(...p.u8.subarray(0x3000 + 43, 0x3000 + 54)).trim(), 'MYDISK', 'the volume\'s label');
  assert.equal(p.cpu.esp.value & 0xffff, 0x7ffe, 'the flags left pushed'); assert.equal(p.r16(0x7ffe), 0x0202);
  const before = JSON.stringify(p.fs.readdir('C:\\DOCS').map(e => [e.name, e.size]));
  p.u8.fill(0xe5, 0x3000, 0x3200); p.cpu.esp.value = 0x8000; p.cpu.eax.value = 2; INTS[0x26].call(p);
  assert.equal(p.cpu.cf.value, 0, 'a write: taken');
  assert.equal(JSON.stringify(p.fs.readdir('C:\\DOCS').map(e => [e.name, e.size])), before, 'and nothing on the drive changed');
  p.rmode = false;
}
// INT 2Fh's DriveSpace (4A11h) and SMARTDrive (4A10h) checks: neither loaded, AX back as it went (Disk Defragmenter
// asks for each drive; trapped, it stopped there)
{
  const { INTS } = window.W95NE16;
  // (5601h: INTERLNK's, a TSR's number no one here owns)
  for (const ax of [0x4a11, 0x4a10, 0x5601]) { p.cpu.eax.value = ax; p.cpu.ebx.value = 0; p.trapped = null; INTS[0x2f].call(p, 0); assert.equal(p.trapped, null); assert.equal(p.cpu.eax.value & 0xffff, ax); }
}
console.log('fcbfind: ok');
