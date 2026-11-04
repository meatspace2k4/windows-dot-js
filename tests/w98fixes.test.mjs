// The faults Windows 98 Setup met running on Windows 95, each held here where it was fixed, so a regression fails in
// seconds instead of hours into a Setup run (bench/win98-setup.md has the run each one stopped)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32, { K16 } = window.W95NE16;
const SYS_PID = 0x40, MAIN_PID = 0x50;

// 1. ExitWindows: USER's message 3Bh ends the tasks of every process but the caller's and the desktop's. On the
// system's machine (host.system) USER's own thread is the machine's main process; answered as a separate process
// there, USER ended its own system task and ExitWindows never returned
{
  const [, , getPid] = K16['KERNEL.#471'], [, , mapHandle] = K16['KERNEL.#483'];
  const on = system => ({ host: { system }, thread16: null, inSystem: () => true, procs: new Map(), handles: new Map(), obj: () => null, lastError: 0 });
  assert.equal(getPid.call(on(true)), MAIN_PID, 'GetCurrentProcessId on the system machine\'s USER thread: the machine\'s process');
  assert.equal(mapHandle.call(on(true), 0xffffffff), MAIN_PID, 'MapProcessHandle(GetCurrentProcess()) agrees with GetCurrentProcessId');
  assert.equal(getPid.call(on(false)), SYS_PID, 'a program\'s machine: USER\'s thread is the system process');
  assert.equal(mapHandle.call(on(false), 0xffffffff), SYS_PID);
  const prog = { ...on(true), thread16: { pc: { pid: 0x6c } } };
  assert.equal(getPid.call(prog), 0x6c, 'a program\'s thread: its own process');
}

// 2. The custom display size's scan line: the BIOS mode set programs the CRTC with the line the driver's records were
// given (customEntry). Programmed as the pixels alone (1640 bytes at 818x559x16) where the driver drew 1648, the
// screen sheared 4 pixels a line
{
  const mem = new WebAssembly.Memory({ initial: 64 }), u8 = new Uint8Array(mem.buffer), dv = new DataView(mem.buffer);
  const p = Object.create(Process.prototype);
  Object.assign(p, { mem, init16() {}, w16: (a, v) => dv.setUint16(a, v, true), w32: (a, v) => dv.setUint32(a, v >>> 0, true) });
  // the display driver's records (TSENG.DRV's shapes): the mode tables, the GDIINFO of the 800x600 slot, the pitches
  const base = 0x10000, words = (at, ws) => ws.forEach((v, i) => dv.setUint16(base + at + 2 * i, v, true));
  words(0x100, [320, 200, 320, 240, 512, 384, 640, 400, 640, 480, 800, 600, 1024, 768]);
  words(0x200, [0x400, 1, 208, 156, 800, 600]);
  words(0x400, [320, 320, 512, 640, 640, 800, 1024, 1280, 640, 640, 1024, 1280, 1280, 1600, 2048].flatMap(l => [0, l]));
  p.ne = new Map([['DISPLAY', { segs: [{ num: 2, base, len: 0x1000, flags: 0 }] }]]);
  const W = 818, H = 559, slot = { i: 5, w: 800, h: 600, mode: 0x30 };
  assert.equal(p.customEntry(W, H, slot), true);
  const driverLine = dv.getUint16(base + 0x400 + 32 * 1 + 4 * slot.i + 2, true);   // (16 bits: the second depth's row)
  assert.equal(driverLine, 1648, 'the driver is given a line whose cursor image ends in its 64K bank');
  p.et = { vram: new Uint8Array(16), seq: new Uint8Array(256), gc: new Uint8Array(256), crtc: new Uint8Array(256), attr: new Uint8Array(256), dac: new Uint8Array(768) };
  p.customMode = { mode: 0x30, w: W, h: H };
  assert.equal(p.setVideoMode(0x30, false, 16), true);
  assert.equal(p.et.pitch, driverLine, 'the mode set\'s line is the driver\'s');
  assert.equal(p.et.crtc[0x13] | ((p.et.crtc[0x3f] >> 7) << 8), driverLine >> 3, 'the CRTC offset register says it, in 8 bytes');
}

// 3. RUNONCE.EXE where Setup puts it (SYSTEM): MSGSRV32 runs "runonce.exe -m" from the Windows folder first, and a
// copy of Windows 95's left there ran on Windows 98 (a "Windows 95 Setup" window over Setup's first-start items)
{
  const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
  const inSystem = src.match(/const IN_SYSTEM = new Set\(\[([^\]]*)\]\)/);
  assert.ok(inSystem && /'RUNONCE\.EXE'/.test(inSystem[1]), 'installPrograms puts RUNONCE.EXE in SYSTEM');
  const i = src.indexOf('function strayCopies('), j = src.indexOf('\n}\n', i) + 2;
  const files = new Map(), bundle = Uint8Array.of(0x4d, 0x5a, 1, 2, 3);
  const fsFake = { readFile: f => { if (!files.has(f)) throw new Error('none'); return files.get(f); }, setAttrs() {}, unlink: f => files.delete(f) };
  const strayCopies = new Function('window', 'fs', 'join', 'WINDIR', 'b64bytes', `${src.slice(i, j)}; return strayCopies;`)(
    { W95SYSTEM: { programs: { 'RUNONCE.EXE': { file: 'b' } } } }, fsFake, (...a) => a.join('\\'), 'C:\\WINDOWS', () => bundle);
  files.set('C:\\WINDOWS\\RUNONCE.EXE', bundle.slice());
  strayCopies(['RUNONCE.EXE']);
  assert.ok(!files.has('C:\\WINDOWS\\RUNONCE.EXE'), 'the page\'s own stray copy is removed');
  const setups = Uint8Array.of(0x4d, 0x5a, 9, 9, 9);
  files.set('C:\\WINDOWS\\RUNONCE.EXE', setups);
  strayCopies(['RUNONCE.EXE']);
  assert.equal(files.get('C:\\WINDOWS\\RUNONCE.EXE'), setups, 'a copy that is not the bundle\'s (Setup\'s, a person\'s) stays');
}

// 4. KERNEL32 #93 (GetpWin16Lock): no lock structure, so USER32 is given none (0). Given a block of zeros, Windows
// 95's USER32 took its lock-owner paths and returned to a 16:16 address as a linear one (BSOD 0E in Setup)
{
  const [n, fn] = API.KERNEL32['#93'];
  assert.equal(n, 1);
  const mem = new DataView(new ArrayBuffer(16)); mem.setUint32(4, 0xdeadbeef, true);
  assert.equal(fn.call({ w32: (a, v) => mem.setUint32(a, v, true) }, 4), 0);
  assert.equal(mem.getUint32(4, true), 0, 'the lock pointer written is null');
}
// 5. Run-time code is translated per stack width (and CS): a ring-3 call checks its return address against the
// protected pages only on a 32-bit stack. The same bytes run first on a 16-bit stack and then on the flat one must
// not reuse the first translation, or a flat call's push into a protected page runs on unchecked
{
  for (const f of ['dyn.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
  const { LAYOUT } = window.W95Win32;
  const mem = new WebAssembly.Memory({ initial: 2048, maximum: 2048 }), u8 = new Uint8Array(mem.buffer);
  const p = Object.create(Process.prototype), traps = [];
  Object.assign(p, { mem, r0Depth: 0, trap: (a, code) => traps.push([a >>> 0, code >>> 0]), modules: [], cpu: {} });
  for (const n of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'cf', 'pf', 'zf', 'sf', 'of', 'df', 'fs', 'ftop', 'fsw', 'fcw', 'eip',
    'cs', 'ds', 'es', 'ss', 'fsel', 'gsel', 'csb', 'dsb', 'esb', 'ssb', 'gsb', 'budget', 'if']) p.cpu[n] = new WebAssembly.Global({ value: 'i32', mutable: true }, n === 'if' ? 1 : 0);
  const at = 0x401100; u8.set([0xe8, 0, 0, 0, 0], at);   // call $+5
  const stack = 0x2000000; u8[LAYOUT.PROT + (stack >>> 12)] = 1;   // (the page below the flat stack's top: protected)
  p.cpu.ss.value = 0x17; p.cpu.esp.value = 0x8000; p.dynBlock(at).run();   // (a 16-bit stack: selector 17h, its descriptor not big)
  assert.deepEqual(traps, [], 'no check on a 16-bit stack');
  p.cpu.ss.value = 0; p.cpu.esp.value = stack + 0x1000; p.dynBlock(at).run();
  assert.deepEqual(traps, [[stack + 0x1000 - 4, 0x4000010]], 'the flat stack\'s call checks its push against the protected page (a write fault there)');
}
console.log('w98fixes: ok');
