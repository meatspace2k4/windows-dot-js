'use strict';
// The ring-0 layer under the recompiled VxDs (tools/recomp.py --vxd): the virtual machine manager and the system
// VxDs they call, as Windows 95's VMM32 provides them. A VxD's image sits at its load base; its code is translated
// like any module's and runs flat. INT 20h with the service dword after it (VxDCall/VxDJmp) reaches the services
// below by device and service number, as the DDK's service tables number them (VMM.INC, SHELL.INC, VWIN32.INC,
// CONFIGMG.INC). Register services take and return registers; the C ones (a leading underscore) take cdecl arguments
// from the caller's stack and return EAX (and EDX). The VxD's control procedure gets the system messages, its
// protected-mode API the calls 16-bit code makes through INT 2Fh 1684h's entry point, with the caller's registers
// in a Client_Reg_Struc at EBP.
(function () {
const W = window.W95Win32, N = window.W95NE16, P = W.Process.prototype, { INTS, def16, CR, regStr } = N;
const u32 = x => x >>> 0, lo16 = (x, v) => u32((x & 0xffff0000) | (v & 0xffff));
const GPR = ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'];
const SEGS = [['cs', 'csb'], ['ds', 'dsb'], ['es', 'esb'], ['ss', 'ssb'], ['fsel', 'fs'], ['gsel', 'gsb']];

// ---------------------------------------------------------------- loading and calling
/** a VxD from the system bundle, loaded at its base: { name, id, meta, ddb, procs }; null if the bundle lacks it */
P.vxd = function (file) {
  this.vxds = this.vxds || new Map();
  const key = file.toUpperCase().replace(/^.*\\/, '');
  if (this.vxds.has(key)) return this.vxds.get(key);
  const d = window.W95SYSTEM && window.W95SYSTEM.vxds && window.W95SYSTEM.vxds[key]; if (!d) return null;
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const m = d.meta, img = d.imgBytes || (d.imgBytes = b64(d.image));
  this.u8.set(img, m.base);
  const mod = d.mod || (d.mod = new WebAssembly.Module(b64(d.wasm)));
  const run = new WebAssembly.Instance(mod, this.imports).exports.run;
  const look = new Uint32Array(this.mem.buffer, m.lookup, m.textHi - m.textLo);
  m.blocks.forEach((a, i) => { look[a - m.textLo] = i + 1; });
  const rec = { kind: 'vxd', name: m.name.trim(), file: key, id: m.id, meta: m, run, ddb: m.ddb, procs: m.procs, base: m.base };
  this.modules.push(rec); this.vxds.set(key, rec);
  return rec;
};
/** the loaded VxD with device id `id` */
P.vxdById = function (id) { for (const v of (this.vxds || new Map()).values()) if (v.id === id && v.inited) return v; return null; };

/** call flat ring-0 code at `addr` with the registers given; returns the registers and carry it left. It runs on the
 *  ring-0 stack, below whatever ring-0 frame is live */
P.vxdCall = function (addr, regs = {}) {
  const save = {}; for (const r of GPR) save[r] = this.cpu[r].value; for (const [s, b] of SEGS) { save[s] = this.cpu[s].value; save[b] = this.cpu[b].value; }
  const savedEip = this.cpu.eip.value, savedCf = this.cpu.cf.value;
  if (!this.r0Stack) { this.r0Stack = this.alloc(0x10000); this.r0Top = this.r0Stack + 0x10000 - 16; }
  const top = this.r0Depth ? (u32(this.cpu.esp.value) - 0x100) & ~3 : this.r0Top;
  for (const [s, b] of SEGS) { this.cpu[s].value = 0; if (s !== 'fsel') this.cpu[b].value = 0; }
  this.cpu.fs.value = this.tibFor ? this.tibFor() : this.cpu.fs.value;
  for (const r of GPR) if (r !== 'esp') this.cpu[r].value = u32(regs[r] || 0);
  this.cpu.esp.value = top; this.push(W.LAYOUT.SENTINEL);
  this.r0Depth = (this.r0Depth || 0) + 1; this.depth++;
  let r;
  try { r = this.runAt(addr); }
  finally { this.depth--; this.r0Depth--; }
  if (r !== 0 || this.trapped) throw new W.GuestError(this.trapped || `VxD call ${u32(addr).toString(16)} did not return (${r} at ${this.reg('eip').toString(16)})`);
  const out = { cf: this.cpu.cf.value & 1, zf: this.cpu.zf.value & 1 }; for (const k of GPR) out[k] = u32(this.cpu[k].value);
  for (const k of GPR) this.cpu[k].value = save[k]; for (const [s, b] of SEGS) { this.cpu[s].value = save[s]; this.cpu[b].value = save[b]; }
  this.cpu.eip.value = savedEip; this.cpu.cf.value = savedCf;
  return out;
};
/** a system control message to a VxD's control procedure (EAX message, EBX VM handle, the rest as given) */
P.vxdControl = function (v, msg, regs = {}) { return this.vxdCall(v.procs.control, { ebx: this.sysVM(), ...regs, eax: msg }); };
const SYS_DYNAMIC_DEVICE_INIT = 0x1b, PNP_NEW_DEVNODE = 0x22, W32_DEVICEIOCONTROL = 0x23;
const DLVXD_LOAD_DEVLOADER = 1;

/** the system VM's control block (the VM handle VxDs are given) */
P.sysVM = function () { if (!this.vmcb) this.vmcb = this.alloc(0x100); return this.vmcb; };

// ---------------------------------------------------------------- INT 20h: VxDCall / VxDJmp
const SVC = {};   // (device << 16 | service) -> fn(p): register services read and write p.cpu; C services use arg(i)
const svc = (dev, n, fn) => { SVC[dev << 16 | n] = fn; };
INTS[0x20] = function (next) {
  const d = this.r32(u32(next) - 4), dev = d >>> 16, n = d & 0x7fff, jmp = d & 0x8000, fn = SVC[dev << 16 | n];
  if (window.W95VXDTRACE) window.W95VXDTRACE(dev, n, this, u32(next) - 6);   // debugging: every VxDCall
  // a hooked service (Hook_Device_Service), or one a loaded VxD provides (its DDB's service table): entered as the
  // VMM enters it, by a call (VxDCall: the return to after the dword pushed) or a jump (VxDJmp)
  const to = (this.svcHooks && this.svcHooks.get(dev << 16 | n)) || (!fn && this.vxdService(dev, n));
  if (to) { if (!jmp) { const sp = u32(this.cpu.esp.value) - 4; this.w32(sp, u32(next)); this.cpu.esp.value = sp; } return to; }
  if (!fn) { this.trapped = `unimplemented VxD service ${dev.toString(16)}h:${n.toString(16)}h at ${u32(next - 6).toString(16)}`; return W.LAYOUT.SENTINEL; }
  // a VxDJmp comes from a stub the caller called: its return address sits above the arguments
  const sp = u32(this.cpu.esp.value) + (jmp ? 4 : 0), arg = i => this.r32(sp + 4 * i);
  const r = fn.call(this, arg);
  if (r !== undefined) this.cpu.eax.value = u32(r);
  if (jmp) { const ret = this.r32(u32(this.cpu.esp.value)); this.cpu.esp.value = u32(this.cpu.esp.value) + 4; return ret; }   // VxDJmp: back to the caller's caller
  return next;
};
const CF = (p, on) => { p.cpu.cf.value = on ? 1 : 0; };
/** a loaded VxD's service, from its DDB's service table (DDB_Service_Table_Ptr/Size) */
P.vxdService = function (dev, n) {
  const v = this.vxdById(dev); if (!v) return 0;
  const t = this.r32(v.ddb + 0x30), cnt = this.r32(v.ddb + 0x34);
  return t && n < cnt ? this.r32(t + 4 * n) : 0;
};
/** a callable address for a service the VMM implements here, for a hook to chain to: entered by a call, it runs the
 *  service with the arguments above the return address and returns there */
P.svcThunk = function (id) {
  const k = 'S' + id.toString(16);
  if (!W.API.VMMSVC) W.API.VMMSVC = {};
  if (!W.API.VMMSVC[k]) W.API.VMMSVC[k] = ['regs', function () {
    const fn = SVC[id], sp = u32(this.cpu.esp.value), ret = this.r32(sp), arg = i => this.r32(sp + 4 + 4 * i);
    if (!fn) throw new W.GuestError(`unimplemented VxD service ${(id >>> 16).toString(16)}h:${(id & 0xffff).toString(16)}h (hooked)`);
    const r = fn.call(this, arg); if (r !== undefined) this.cpu.eax.value = u32(r);
    this.cpu.esp.value = sp + 4; return ret;
  }];
  return this.thunkFor('VMMSVC', k);
};

const ZF = (p, on) => { p.cpu.zf.value = on ? 1 : 0; };
const VMM = 1, SHELL = 0x17, VWIN32 = 0x2a, CONFIGMG = 0x33;

// ---- VMM: VM and thread handles
svc(VMM, 0x01, function () { this.cpu.ebx.value = this.sysVM(); });                                   // Get_Cur_VM_Handle
svc(VMM, 0x03, function () { this.cpu.ebx.value = this.sysVM(); });                                   // Get_Sys_VM_Handle
svc(VMM, 0x04, function () { ZF(this, u32(this.cpu.ebx.value) === this.sysVM()); });                  // Test_Sys_VM_Handle
svc(VMM, 0x05, function () { CF(this, u32(this.cpu.ebx.value) !== this.sysVM()); });                  // Validate_VM_Handle
svc(VMM, 0x108, function () { this.cpu.edi.value = this.r0Thread(this.currentThreadId()); });          // Get_Cur_Thread_Handle
svc(VMM, 0xb5, function () { CF(this, true); });                                                      // Get_Environment_String: none set

// ---- VMM: memory
// _PageAllocate(nPages, pType, VM, AlignMask, minPhys, maxPhys, PhysAddrPtr, flags): EAX handle, EDX linear address.
// One address space: the handle, linear and physical addresses are the same. Memory a device must reach (PAGEUSEALIGN:
// aligned to AlignMask + 1 pages, below page maxPhys, as a DMA buffer is: the 8237 addresses 16 MB) comes from the
// low megabyte
const PAGEUSEALIGN = 2;
svc(VMM, 0x53, function (arg) {
  const n = arg(0) * 4096;
  if (arg(7) & PAGEUSEALIGN || (arg(5) && arg(5) < 0x1000)) {
    const align = (arg(7) & PAGEUSEALIGN ? arg(3) + 1 : 1) * 4096, lo = Math.ceil(this.dosTop / align) * align;
    if (lo + n > 0xa0000 || (arg(5) && (lo + n) / 4096 - 1 > arg(5))) { this.cpu.edx.value = 0; return 0; }
    this.dosTop = lo + n; this.u8.fill(0, lo, lo + n);
    if (arg(6)) this.w32(arg(6), lo);
    this.cpu.edx.value = lo; return lo;
  }
  const a = this.alloc(n + 4096); const p = (a + 4095) & ~4095; this.u8.fill(0, p, p + n);
  if (arg(6)) this.w32(arg(6), p);
  this.cpu.edx.value = p; return p;
});
svc(VMM, 0x55, function () { return 1; });                                                            // _PageFree
svc(VMM, 0x63, function (arg) { return u32(arg(0) << 12); });                                         // _LinPageLock: the region's linear address
svc(VMM, 0x64, function () { return 1; });                                                            // _LinPageUnLock
svc(VMM, 0x4f, function (arg) { const a = this.alloc(Math.max(arg(0), 1)); this.u8.fill(0, a, a + Math.max(arg(0), 1)); return a; });   // _HeapAllocate
svc(VMM, 0x51, function () { return 1; });                                                            // _HeapFree

// ---- VMM: selectors. _BuildDescriptorDWORDs(base, limit, type, size, flags) -> EAX low, EDX high dword
svc(VMM, 0x7a, function (arg) {
  const base = arg(0), limit = arg(1), type = arg(2) & 0xff, size = arg(3) & 0xff;
  this.cpu.edx.value = u32((base & 0xff000000) | ((size & 0xc0) << 16) | (limit & 0xf0000) | (type << 8) | ((base >>> 16) & 0xff));
  return u32(((base & 0xffff) << 16) | (limit & 0xffff));
});
const descBase = (lo, hi) => u32((lo >>> 16) | ((hi & 0xff) << 16) | (hi & 0xff000000));
const descLimit = (lo, hi) => { const l = (lo & 0xffff) | (hi & 0xf0000); return hi & 0x800000 ? u32(l * 4096 + 4095) : l; };
// _Allocate_LDT_Selector(VM, DescDWORD1 (high), DescDWORD2 (low), Count, flags) / _Allocate_GDT_Selector(DescDWORD1,
// DescDWORD2, flags): EAX the selector, EDX the descriptor table's selector and size
svc(VMM, 0x78, function (arg) { const s = this.allocSels(descBase(arg(2), arg(1)), descLimit(arg(2), arg(1)) + 1); this.cpu.edx.value = 0; return s; });
svc(VMM, 0x79, function (arg) { this.freeSels(arg(1) & 0xffff); return 1; });
svc(VMM, 0x76, function (arg) { const s = this.allocSels(descBase(arg(1), arg(0)), descLimit(arg(1), arg(0)) + 1); this.cpu.edx.value = 0; return s; });
svc(VMM, 0x77, function (arg) { this.freeSels(arg(0) & 0xffff); return 1; });
// Map_Flat: AH the offset of a segment register, AL of an offset register, in the client registers (EBP): EAX linear
svc(VMM, 0x1c, function () {
  const ax = this.cpu.eax.value & 0xffff, c = u32(this.cpu.ebp.value), seg = this.r16(c + (ax >> 8)), off = (ax & 0xff) === 0xff ? 0 : this.r32(c + (ax & 0xff));
  const cs = this.r16(c + 0x28), big = this.selValid(cs) && this.r32(N.L.ACC + (cs & 0xfff8)) & 0x400000;
  this.cpu.eax.value = u32(this.selBase(seg) + (big ? off : off & 0xffff));
});

// ---- VMM: lists. List_Create (EAX flags, ECX node size -> ESI list); nodes are kept in the list's own order
const lists = p => p.vxdLists || (p.vxdLists = new Map());
svc(VMM, 0x9b, function () { const h = this.alloc(16); lists(this).set(h, { size: Math.max(this.cpu.ecx.value & 0xffff, 4), nodes: [] }); this.cpu.esi.value = h; CF(this, false); });
svc(VMM, 0x9c, function () { lists(this).delete(u32(this.cpu.esi.value)); });                        // List_Destroy
svc(VMM, 0x9d, function () { const l = lists(this).get(u32(this.cpu.esi.value)); const a = this.alloc(l.size); this.u8.fill(0, a, a + l.size); this.cpu.eax.value = a; CF(this, false); });   // List_Allocate
svc(VMM, 0x9e, function () { lists(this).get(u32(this.cpu.esi.value)).nodes.unshift(u32(this.cpu.eax.value)); });   // List_Attach
svc(VMM, 0x9f, function () { lists(this).get(u32(this.cpu.esi.value)).nodes.push(u32(this.cpu.eax.value)); });      // List_Attach_Tail
svc(VMM, 0xa0, function () {                                                                          // List_Insert (EAX node after ECX)
  const l = lists(this).get(u32(this.cpu.esi.value)), at = l.nodes.indexOf(u32(this.cpu.ecx.value));
  l.nodes.splice(at < 0 ? 0 : at + 1, 0, u32(this.cpu.eax.value));
});
svc(VMM, 0xa1, function () { const l = lists(this).get(u32(this.cpu.esi.value)), i = l.nodes.indexOf(u32(this.cpu.eax.value)); if (i >= 0) l.nodes.splice(i, 1); CF(this, i < 0); });   // List_Remove
svc(VMM, 0xa2, function () { this.free && this.free(u32(this.cpu.eax.value)); });                    // List_Deallocate
svc(VMM, 0xa3, function () { const l = lists(this).get(u32(this.cpu.esi.value)); const a = l && l.nodes.length ? l.nodes[0] : 0; this.cpu.eax.value = a; ZF(this, !a); });   // List_Get_First
svc(VMM, 0xa4, function () {                                                                          // List_Get_Next
  const l = lists(this).get(u32(this.cpu.esi.value)), i = l ? l.nodes.indexOf(u32(this.cpu.eax.value)) : -1;
  const a = i >= 0 && i + 1 < l.nodes.length ? l.nodes[i + 1] : 0; this.cpu.eax.value = a; ZF(this, !a);
});
svc(VMM, 0xa5, function () { const l = lists(this).get(u32(this.cpu.esi.value)); const a = l && l.nodes.length ? l.nodes.shift() : 0; this.cpu.eax.value = a; ZF(this, !a); });   // List_Remove_First

// ---- VMM: strings
svc(VMM, 0x17b, function (arg) { const s = this.readA(arg(1)) || '', n = arg(2); this.writeA(arg(0), s.slice(0, Math.max(n - 1, 0)), n); return arg(0); });   // _lstrcpyn
svc(VMM, 0x17c, function (arg) { return (this.readA(arg(0)) || '').length; });                        // _lstrlen

// ---- VMM: the registry. Keys are handles to paths under the predefined roots; values are the registry's own
const ROOTS = { 0x80000000: 'hkcr', 0x80000001: 'hkcu', 0x80000002: 'hklm', 0x80000003: 'hku', 0x80000005: 'hkcc', 0x80000006: 'hkdd' };
const ERR = { SUCCESS: 0, FILE_NOT_FOUND: 2, INVALID_HANDLE: 6, MORE_DATA: 234, NO_MORE_ITEMS: 259, BADKEY: 1010 };
const keys = p => p.vxdKeys || (p.vxdKeys = new Map());
const keyPath = (p, h) => ROOTS[u32(h)] || keys(p).get(u32(h)) || null;
const exists = path => { const parts = path.split('\\'); let at = parts[0]; for (const k of parts.slice(1)) { const kid = W.regKids(at).find(x => x.toLowerCase() === k.toLowerCase()); if (kid === undefined) return null; at += '\\' + kid; } return at; };
const openKey = (p, h, sub, create, out) => {
  const base = keyPath(p, h); if (!base) return ERR.BADKEY;
  const s = sub ? p.readA(sub) || '' : '', want = s ? `${base}\\${s.replace(/^\\+|\\+$/g, '')}` : base;
  let path = exists(want);
  if (!path) { if (!create) return ERR.FILE_NOT_FOUND; W.regSet(want, null); path = want; }
  const k = 0x00e00000 + keys(p).size + 1 + (p.vxdKeySeq = (p.vxdKeySeq || 0) + 1); keys(p).set(k, path); p.w32(out, k);
  return ERR.SUCCESS;
};
const valBytes = v => (v === undefined ? null : typeof v === 'string' ? { type: 1, data: window.W95FS.encode(v + '\0') } : typeof v === 'number' ? { type: 4, data: new Uint8Array(new Uint32Array([v]).buffer) } : { type: v.type, data: v.data || new Uint8Array(0) });
svc(VMM, 0x148, function (arg) { return openKey(this, arg(0), arg(1), false, arg(2)); });             // _RegOpenKey
svc(VMM, 0x149, function (arg) { keys(this).delete(u32(arg(0))); return ERR.SUCCESS; });              // _RegCloseKey
svc(VMM, 0x14a, function (arg) { return openKey(this, arg(0), arg(1), true, arg(2)); });              // _RegCreateKey
svc(VMM, 0x14b, function (arg) {                                                                      // _RegDeleteKey
  const base = keyPath(this, arg(0)); if (!base) return ERR.BADKEY;
  const path = exists(`${base}\\${this.readA(arg(1)) || ''}`); if (!path) return ERR.FILE_NOT_FOUND;
  W.regDel(path); return ERR.SUCCESS;
});
svc(VMM, 0x14c, function (arg) {                                                                      // _RegEnumKey(h, index, buf, cb)
  const base = keyPath(this, arg(0)); if (!base) return ERR.BADKEY;
  const k = W.regKids(base)[arg(1)]; if (k === undefined) return ERR.NO_MORE_ITEMS;
  if (k.length >= arg(3)) return ERR.MORE_DATA;
  this.writeA(arg(2), k, arg(3)); return ERR.SUCCESS;
});
svc(VMM, 0x150, function (arg) {                                                                      // _RegEnumValue(h, i, name, *cbName, -, *type, data, *cbData)
  const base = keyPath(this, arg(0)); if (!base) return ERR.BADKEY;
  const e = W.regVals(base)[arg(1)]; if (!e) return ERR.NO_MORE_ITEMS;
  const name = (e[1] && e[1].name) || e[0], v = valBytes(e[1]);
  if (arg(3)) { const n = this.r32(arg(3)); if (name.length >= n) return ERR.MORE_DATA; this.writeA(arg(2), name, n); this.w32(arg(3), name.length); }
  if (arg(5)) this.w32(arg(5), v.type);
  if (arg(7)) { const n = this.r32(arg(7)); this.w32(arg(7), v.data.length); if (arg(6)) { if (n < v.data.length) return ERR.MORE_DATA; this.u8.set(v.data, arg(6)); } }
  return ERR.SUCCESS;
});
svc(VMM, 0x151, function (arg) {                                                                      // _RegQueryValueEx(h, name, -, *type, data, *cb)
  const base = keyPath(this, arg(0)); if (!base) return ERR.BADKEY;
  const v = valBytes(W.regGet(base, arg(1) ? this.readA(arg(1)) || '' : '')); if (!v) return ERR.FILE_NOT_FOUND;
  if (arg(3)) this.w32(arg(3), v.type);
  if (arg(5)) { const n = this.r32(arg(5)); this.w32(arg(5), v.data.length); if (arg(4)) { if (n < v.data.length) return ERR.MORE_DATA; this.u8.set(v.data, arg(4)); } }
  return ERR.SUCCESS;
});
svc(VMM, 0x152, function (arg) {                                                                      // _RegSetValueEx(h, name, -, type, data, cb)
  const base = keyPath(this, arg(0)); if (!base) return ERR.BADKEY;
  W.regSet(base, arg(1) ? this.readA(arg(1)) || '' : '', { type: arg(3), data: this.u8.slice(arg(4), arg(4) + arg(5)) });
  return ERR.SUCCESS;
});
svc(VMM, 0x155, function () { return ERR.SUCCESS; });                                                 // _RegFlushKey

// ---- SHELL: appy time, the moments the system VM's Windows can be called into (the host's slices once USER runs)
svc(SHELL, 0x0d, function () { return this.user16Ready ? 1 : 0; });                                  // _SHELL_QueryAppyTimeAvailable
// _SHELL_CallAtAppyTime(pfn, refData, flags, timeout): the callback (cdecl, refData) runs at the next appy time
svc(SHELL, 0x0e, function (arg) { (this.appyQueue = this.appyQueue || []).push({ fn: arg(0), ref: arg(1) }); return this.appyQueue.length; });
// _SHELL_CallDll(dll, proc, cbArgs, args): the 16-bit DLL's export called with the argument block as its PASCAL
// frame (the block is the stack image, last argument first); EAX its DX:AX
svc(SHELL, 0x18, function (arg) {
  const dll = this.readA(arg(0)) || '', proc = arg(1) >>> 16 ? this.readA(arg(1)) || '' : arg(1) & 0xffff, n = arg(2), blk = arg(3);
  const m = this.loadLibrary16(dll); if (!m) return 0;
  let ep;
  if (m.meta) ep = this.neExport(m, typeof proc === 'string' ? proc.toUpperCase() : proc);
  else {   // a module the personality provides (KERNEL): its export by name or ordinal, as GetProcAddress gives it
    const ord = typeof proc === 'string' ? N.names16(m.name)[proc.toUpperCase()] : proc;
    ep = ord && N.K16[`${m.name}.#${ord}`] ? this.thunk16For(`${m.name}.#${ord}`) : 0;
  }
  if (!ep) return 0;
  const words = []; for (let o = n - 2; o >= 0; o -= 2) words.push(['w', this.r16(blk + o)]);
  this.tick16(); return this.call16(ep >>> 16, ep & 0xffff, words).dxax;
});
/** run the appy-time callbacks VxDs scheduled: the host calls this between slices */
P.vxdAppy = function () {
  if (this.depth || !this.user16Ready || !this.appyQueue || !this.appyQueue.length) return;
  const q = this.appyQueue; this.appyQueue = [];
  for (const e of q) this.vxdCdecl(e.fn, [e.ref]);
};
/** call a cdecl ring-0 function with dword arguments */
P.vxdCdecl = function (fn, args) {
  if (!this.r0Stack) { this.r0Stack = this.alloc(0x10000); this.r0Top = this.r0Stack + 0x10000 - 16; }
  const top = this.r0Depth ? (u32(this.cpu.esp.value) - 0x100) & ~3 : this.r0Top, frame = top - 4 * args.length - 64;
  args.forEach((a, i) => this.w32(frame + 4 * i, u32(a)));
  // the call pushes its return on top of the arguments: enter with ESP at the arguments
  return this.vxdCallAt(fn, frame);
};
P.vxdCallAt = function (addr, sp, regs = {}) {
  const was = this.r0Depth; const save = this.r0Top;
  this.r0Depth = 0; this.r0Top = sp;   // vxdCall starts its frame here
  try { return this.vxdCall(addr, regs); } finally { this.r0Depth = was; this.r0Top = save; }
};

// ---- VWIN32: the Win32 side
svc(VWIN32, 0x02, function (arg) { this.queueApc(arg(2) & 0xffffff, arg(0), arg(1)); return 1; });   // _VWIN32_QueueUserApc(proc, data, thread)
svc(VWIN32, 0x0e, function (arg) { const e = this.r0Event(arg(0)); if (e) this.signal(e); return e ? 1 : 0; });   // _VWIN32_SetWin32Event
svc(VWIN32, 0x14, function () { return 1; });                                                         // _VWIN32_CloseVxDHandle

// ---- CONFIGMG at ring 0 (flat pointers, cdecl, EAX the CONFIGRET)
svc(CONFIGMG, 0x00, function () { return 0x400; });                                                   // Get_Version
svc(CONFIGMG, 0x02, function (arg) {                                                                  // Locate_DevNode(*dn, id, flags)
  const id = arg(1) ? (this.readA(arg(1)) || '').toUpperCase() : null, dn = id && this.devnodes().find(d => d.id === id);
  if (!dn) return CR.NO_SUCH_DEVNODE; this.w32(arg(0), dn.handle); return CR.SUCCESS;
});
// Register_Device_Driver(dn, handler, refData, flags): the handler gets the devnode's configuration events
svc(CONFIGMG, 0x0e, function (arg) { const dn = this.devnode(arg(0)); if (!dn) return CR.INVALID_DEVNODE; dn.handler = arg(1); dn.ref = arg(2); return CR.SUCCESS; });
svc(CONFIGMG, 0x36, function (arg) {                                                                  // Get_DevNode_Status(*status, *problem, dn, flags)
  const dn = this.devnode(arg(2)); if (!dn) return CR.INVALID_DEVNODE;
  this.w32(arg(0), 0x0a | (dn.started ? 8 : 0)); if (arg(1)) this.w32(arg(1), 0); return CR.SUCCESS;
});
svc(CONFIGMG, 0x3d, function (arg) {                                                                  // Get_DevNode_Key(dn, subkey, buf, len, flags)
  const dn = this.devnode(arg(0)); if (!dn) return CR.INVALID_DEVNODE;
  const k = this.cmKey(dn, arg(1) && this.readA(arg(1)), arg(4)); if (!k) return CR.REGISTRY_ERROR;
  if (arg(3) <= k.length) return CR.BUFFER_SMALL; this.writeA(arg(2), k, arg(3)); return CR.SUCCESS;
});
// Load_DLVxDs(dn, names, loadType, flags): the VxDs named (comma-separated) are loaded and told of the devnode
svc(CONFIGMG, 0x2f, function (arg) {
  const dn = this.devnode(arg(0)); if (!dn) return CR.INVALID_DEVNODE;
  for (const f of (this.readA(arg(1)) || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const v = this.vxdLoad(f); if (!v) return 0x16;   // CR_DLVXD_NOT_FOUND
    (dn.dlvxds = dn.dlvxds || []).push({ v, type: arg(2) });
    this.vxdControl(v, PNP_NEW_DEVNODE, { ebx: dn.handle, edx: arg(2) });
  }
  return CR.SUCCESS;
});
// Get_DDBs(*ppDDB, *count, loadType, dn, flags): the DDBs of the VxDs loaded for the devnode with that load type
svc(CONFIGMG, 0x30, function (arg) {
  const dn = this.devnode(arg(3)); if (!dn) return CR.INVALID_DEVNODE;
  const ddbs = (dn.dlvxds || []).filter(e => e.type === arg(2)).map(e => e.v.ddb);
  if (!ddbs.length) return 0x16;
  const a = this.alloc(4 * ddbs.length); ddbs.forEach((d, i) => this.w32(a + 4 * i, d));
  this.w32(arg(0), a); this.w32(arg(1), ddbs.length); return CR.SUCCESS;
});

// ---- VMM: Hook_Device_Service (EAX service, ESI hook): ESI the previous handler, which the hook chains to.
// Unhook_Device_Service (EAX, ESI) puts the previous one back
svc(VMM, 0x90, function () {
  const id = u32(this.cpu.eax.value), hooks = this.svcHooks || (this.svcHooks = new Map()), prevs = this.svcPrev || (this.svcPrev = new Map());
  const prev = hooks.get(id) || this.vxdService(id >>> 16, id & 0xffff) || this.svcThunk(id), hook = u32(this.cpu.esi.value);
  hooks.set(id, hook); prevs.set(hook, prev); this.cpu.esi.value = prev; CF(this, false);
});
svc(VMM, 0x11c, function () {
  const id = u32(this.cpu.eax.value), hook = u32(this.cpu.esi.value), hooks = this.svcHooks, prev = this.svcPrev && this.svcPrev.get(hook);
  if (!hooks || hooks.get(id) !== hook) { CF(this, true); return; }
  const base = this.vxdService(id >>> 16, id & 0xffff) || (W.API.VMMSVC && this.thunkByName.get('VMMSVC!S' + id.toString(16)));
  if (prev && prev !== base) hooks.set(id, prev); else hooks.delete(id);
  CF(this, false);
});

// ---- VMM: per-VM data. _Allocate_Device_CB_Area(size, flags): EAX the offset of the device's area in every VM's
// control block (one VM here: the system VM's, whose own fields come first)
svc(VMM, 0xa7, function (arg) {
  const n = (arg(0) + 3) & ~3; this.sysVM();
  const at = this.vmcbNext || 0x100; if (at + n > 0x4000) return 0;
  this.vmcbNext = at + n; this.u8.fill(0, this.vmcb + at, this.vmcb + at + n); return at;
});
svc(VMM, 0x3b, function () { this.cpu.ebx.value = this.sysVM(); });                                  // Get_Next_VM_Handle: the one VM

// ---- VMM: events. Schedule_Global_Event(ESI proc, EDX ref): EAX handle; the procedure runs between slices
svc(VMM, 0x0e, function () { const q = this.vxdEvents || (this.vxdEvents = []); q.push({ fn: u32(this.cpu.esi.value), ref: u32(this.cpu.edx.value) }); this.cpu.esi.value = q.length; });
svc(VMM, 0x0f, function () { const q = this.vxdEvents || (this.vxdEvents = []); q.push({ fn: u32(this.cpu.esi.value), ref: u32(this.cpu.edx.value) }); this.cpu.esi.value = q.length; });   // Schedule_VM_Event
/** run the events VxDs scheduled (EBX the VM, EDX the reference data, EBP the client registers) */
P.vxdRunEvents = function () {
  if (this.depth || !this.vxdEvents || !this.vxdEvents.length) return;
  const q = this.vxdEvents; this.vxdEvents = [];
  for (const e of q) this.vxdCall(e.fn, { ebx: this.sysVM(), edx: e.ref, ebp: this.crs || (this.crs = this.alloc(0x60)) });
};

// ---- VMM: I/O trapping. A VxD's handler for a port (Install_IO_Handler: ESI proc, EDX port) sees the VM's IN and OUT
// there while trapping is on for that VM (Enable/Disable_Local_Trapping, EBX VM, EDX port)
const ioh = p => p.ioHandlers || (p.ioHandlers = new Map());
svc(VMM, 0x96, function () { ioh(this).set(this.cpu.edx.value & 0xffff, { fn: u32(this.cpu.esi.value), on: true }); CF(this, false); });
svc(VMM, 0x116, function () { ioh(this).delete(this.cpu.edx.value & 0xffff); CF(this, false); });     // Remove_IO_Handler
svc(VMM, 0x98, function () { const h = ioh(this).get(this.cpu.edx.value & 0xffff); if (h) h.on = true; });    // Enable_Local_Trapping
svc(VMM, 0x9a, function () { const h = ioh(this).get(this.cpu.edx.value & 0xffff); if (h) h.on = false; });   // Disable_Local_Trapping
/** a port access by VM code (ne16 portIO): the VxD's handler takes it when trapping is on. ECX the type (0 byte in,
 *  4 byte out, 8/0Ch word, 10h/14h dword), EAX the data; true if handled */
P.vxdTrapIO = function (port, size, isIn) {
  const h = this.ioHandlers && this.ioHandlers.get(port); if (!h || !h.on || this.r0Depth) return false;
  const type = (isIn ? 0 : 4) | (size === 2 ? 8 : size === 4 ? 0x10 : 0), m = size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff;
  const r = this.vxdCall(h.fn, { eax: u32(this.cpu.eax.value) & m, ebx: this.sysVM(), ecx: type, edx: port, ebp: this.crs || (this.crs = this.alloc(0x60)) });
  if (isIn) this.cpu.eax.value = u32((this.cpu.eax.value & ~m) | (r.eax & m));
  return true;
};
// Simulate_IO (EAX data, EBX VM, ECX type, EDX port): the access as the hardware would take it
svc(VMM, 0x94, function () {
  const port = this.cpu.edx.value & 0xffff, type = this.cpu.ecx.value & 0xff, size = type & 0x10 ? 4 : type & 8 ? 2 : 1, isIn = !(type & 4);
  const was = this.r0Depth; this.r0Depth = 0;
  try { const h = this.ioHandlers && this.ioHandlers.get(port); const on = h && h.on; if (h) h.on = false; try { this.portIO(port, size, isIn); } finally { if (h) h.on = on; } }
  finally { this.r0Depth = was; }
});

// ---- VMM: boot log, formatting
svc(VMM, 0x188, function () { return 0; }); svc(VMM, 0x189, function () { return 0; }); svc(VMM, 0x18a, function () { return 0; });
// _Sprintf(buf, fmt, ...): %d %u %x %X %s %c %lx with widths and zero fill
svc(VMM, 0x174, function (arg) {
  const fmt = this.readA(arg(1)) || ''; let k = 2;
  const out = fmt.replace(/%([-0]?)(\d*)(l?)([dusxXc%])/g, (m, fl, w, l, c) => {
    if (c === '%') return '%';
    const v = arg(k++); let t = c === 's' ? this.readA(v) || '' : c === 'c' ? String.fromCharCode(v & 0xff) : c === 'd' ? String(v | 0) : c === 'u' ? String(u32(v)) : u32(v).toString(16);
    if (c === 'X') t = t.toUpperCase();
    return w ? (fl === '-' ? t.padEnd(+w) : t.padStart(+w, fl === '0' ? '0' : ' ')) : t;
  });
  this.writeA(arg(0), out, out.length + 1); return out.length;
});

// ---- SHELL_Message(EBX VM, EAX flags, ECX message, EDI caption, ESI callback, EDX ref): shown, answered OK (1)
svc(SHELL, 0x04, function () {
  const t = this.readA(u32(this.cpu.ecx.value)) || '', cap = this.readA(u32(this.cpu.edi.value)) || '';
  console.warn(`[vxd] SHELL_Message: ${cap}: ${t}`); this.cpu.eax.value = 1; CF(this, false);
});

// ---- VXDLDR: LoadDevice (EDX file name, EAX flags: 1 send it SYS_DYNAMIC_DEVICE_INIT): EAX the DDB, EDX the device
// handle; a VxD the system bundle does not carry is a file the loader cannot open (3). UnloadDevice (EBX device id or
// EDX name)
const VXDLDR = 0x27;
svc(VXDLDR, 0x01, function () {
  const name = this.readA(u32(this.cpu.edx.value)) || '', v = this.cpu.eax.value & 1 ? this.vxdLoad(name) : this.vxd(name);
  if (!v) { this.cpu.eax.value = 3; CF(this, true); return; }
  this.cpu.eax.value = v.ddb; this.cpu.edx.value = v.ddb; CF(this, false);
});
svc(VXDLDR, 0x02, function () { CF(this, false); this.cpu.eax.value = 0; });

// ---- VKD: hot keys. Define_Hot_Key (AL scan code, AH extended, EBX shift-state mask, CL flags, ESI callback, EDX ref):
// EAX the handle. The keyboard reaches Windows through its own driver, so these never fire
const VKD = 0x0d;
svc(VKD, 0x01, function () { this.cpu.eax.value = this.alloc(16); CF(this, false); });
svc(VKD, 0x02, function () { CF(this, false); });   // Remove_Hot_Key
svc(VKD, 0x03, function () { CF(this, false); });   // Local_Enable_Hot_Key
svc(VKD, 0x04, function () { CF(this, false); });   // Local_Disable_Hot_Key

// ---- VPICD: the interrupt controllers. Virtualize_IRQ (EDI VPICD_IRQ_Descriptor): EAX the IRQ handle
const vpicd = p => p.vpicd || (p.vpicd = { byIrq: new Map(), byHandle: new Map() });
const VPICD = 3;
svc(VPICD, 0x01, function () {
  const d = u32(this.cpu.edi.value), irq = this.r16(d) & 0xf, v = vpicd(this);
  if (v.byIrq.has(irq)) { CF(this, true); return; }
  const h = this.alloc(16), e = { irq, handle: h, hw: this.r32(d + 4), virt: this.r32(d + 8), eoi: this.r32(d + 0xc), iret: this.r32(d + 0x14), ref: this.r32(d + 0x1c) };
  v.byIrq.set(irq, e); v.byHandle.set(h, e); this.cpu.eax.value = h; CF(this, false);
});
const irqOf = p => vpicd(p).byHandle.get(u32(p.cpu.eax.value));
svc(VPICD, 0x02, function () { const e = irqOf(this); if (e) e.request = true; });                   // Set_Int_Request
svc(VPICD, 0x03, function () { const e = irqOf(this); if (e) e.request = false; });                  // Clear_Int_Request
svc(VPICD, 0x04, function () { const e = irqOf(this); if (e) this.picState().isr &= ~(1 << e.irq); }); // Phys_EOI
svc(VPICD, 0x11, function () { const e = irqOf(this); if (e) { vpicd(this).byIrq.delete(e.irq); vpicd(this).byHandle.delete(e.handle); } });   // Force_Default_Behavior
// Get_Complete_Status / Get_Status: ECX the VPICD_Stat bits: 04h physically masked, 08h physically in service, 20h a
// virtual request, 80h requested by a virtual device (Set_Int_Request)
const irqStatus = p => {
  const e = irqOf(p), c = p.picState(); if (!e) return 0;
  return ((c.imr[e.irq >> 3] >> (e.irq & 7) & 1) ? 4 : 0) | ((c.isr >> e.irq & 1) ? 8 : 0) | (e.request ? 0xa0 : 0);
};
svc(VPICD, 0x05, function () { this.cpu.ecx.value = irqStatus(this); });
svc(VPICD, 0x06, function () { this.cpu.ecx.value = irqStatus(this); });
svc(VPICD, 0x08, function () { const e = irqOf(this); if (e) this.picState().imr[e.irq >> 3] |= 1 << (e.irq & 7); });     // Physically_Mask
svc(VPICD, 0x09, function () { const e = irqOf(this); if (e) this.picState().imr[e.irq >> 3] &= ~(1 << (e.irq & 7)); });  // Physically_Unmask

// ---- VDMAD: the DMA controller. Virtualize_Channel (EAX channel, ESI callback): EAX the DMA handle
const VDMAD = 4, vdmad = p => p.vdmad || (p.vdmad = new Map());
const dmaOf = p => vdmad(p).get(u32(p.cpu.eax.value));
svc(VDMAD, 0x01, function () {
  const h = this.alloc(16), ch = this.cpu.eax.value & 7;
  vdmad(this).set(h, { ch, cb: u32(this.cpu.esi.value), region: { id: 0, lock: 0, lin: 0, size: 0, phys: 0 }, virt: { addr: 0, count: 0, mode: 0, ext: 0 }, masked: true });
  this.cpu.eax.value = h; CF(this, false);
});
svc(VDMAD, 0x1a, function () { vdmad(this).delete(u32(this.cpu.eax.value)); });                      // Unvirtualize_Channel
svc(VDMAD, 0x02, function () { const d = dmaOf(this), r = d.region; this.cpu.ebx.value = r.id | (r.lock << 8); this.cpu.esi.value = r.lin; this.cpu.ecx.value = r.size; this.cpu.edx.value = r.phys; });   // Get_Region_Info
svc(VDMAD, 0x03, function () { const d = dmaOf(this); d.region = { id: this.cpu.ebx.value & 0xff, lock: (this.cpu.ebx.value >> 8) & 0xff, lin: u32(this.cpu.esi.value), size: u32(this.cpu.ecx.value), phys: u32(this.cpu.edx.value) }; });   // Set_Region_Info
// Get_Virt_State / Set_Virt_State: ESI address, ECX count, DL mode, DH extended mode, as the VM programmed them
svc(VDMAD, 0x04, function () {
  const d = dmaOf(this), c = this.dmaChannel(d.ch);   // the VM programs the controller itself: its state is the virtual state
  this.cpu.esi.value = u32((c.page << 16) | c.base); this.cpu.ecx.value = c.bcount; this.cpu.edx.value = lo16(this.cpu.edx.value, c.mode & 0xfc); CF(this, false);
});
svc(VDMAD, 0x05, function () { const d = dmaOf(this); d.virt = { addr: u32(this.cpu.esi.value), count: u32(this.cpu.ecx.value), mode: this.cpu.edx.value & 0xff, ext: (this.cpu.edx.value >> 8) & 0xff }; });
// Set_Phys_State (EAX handle, EBX VM, DL mode, DH extended): the controller gets the region's physical address and
// the virtual count with the mode given
svc(VDMAD, 0x06, function () {
  const d = dmaOf(this), c = this.dmaChannel(d.ch), a = d.region.phys || d.virt.addr;
  c.base = c.cur = a & 0xffff; c.page = (a >>> 16) & 0xff; c.bcount = c.count = d.virt.count & 0xffff; c.mode = (this.cpu.edx.value & 0xfc) | (d.ch & 3);
});
svc(VDMAD, 0x07, function () { const d = dmaOf(this); d.masked = true; });                           // Mask_Channel (virtual)
svc(VDMAD, 0x08, function () { const d = dmaOf(this); d.masked = false; this.dmaChannel(d.ch).masked = false; });   // UnMask_Channel
svc(VDMAD, 0x12, function () { const d = dmaOf(this); if (d) { const c = this.dmaChannel(d.ch); d.virt = { addr: (c.page << 16) | c.base, count: c.bcount, mode: c.mode, ext: 0 }; } });   // Default_Handler
svc(VDMAD, 0x13, function () { CF(this, false); });                                                  // Disable_Translation
svc(VDMAD, 0x14, function () { CF(this, false); });                                                  // Enable_Translation
svc(VDMAD, 0x18, function () { const d = dmaOf(this); this.dmaChannel(d.ch).masked = true; });        // Phys_Mask_Channel
svc(VDMAD, 0x19, function () { const d = dmaOf(this); this.dmaChannel(d.ch).masked = false; });       // Phys_Unmask_Channel
svc(VDMAD, 0x1c, function () { const d = dmaOf(this); if (this.sound16) this.sound16(); this.cpu.ecx.value = this.dmaChannel(d.ch).count; });   // Get_Phys_Count
svc(VDMAD, 0x1e, function () { this.cpu.eax.value = 0xfff; });                                       // Get_Max_Phys_Page: 16 MB
svc(VDMAD, 0x1f, function () { CF(this, false); });                                                  // Set_Channel_Callbacks
svc(VDMAD, 0x21, function () { const d = dmaOf(this); d.virt.count = u32(this.cpu.ecx.value); });     // Set_Virt_Count

// ---- CONFIGMG: the devnode tree. ROOT-enumerated devnodes are children of the tree's root (HTREE\ROOT\0); a driver
// can create children of its own devnode (Create_DevNode) and enumerate them (Register_Enumerator)
const ROOT_DN = 0xc0ff0000;
P.cmTree = function () {
  if (this.cmRoot) return this.cmRoot;
  const root = this.cmRoot = { handle: ROOT_DN, id: 'HTREE\\ROOT\\0', children: [], parent: null };
  for (const dn of this.devnodes()) { dn.parent = dn.parent || root; dn.children = dn.children || []; if (dn.parent === root) root.children.push(dn); }
  return root;
};
P.cmNode = function (h) { this.cmTree(); return u32(h) === ROOT_DN ? this.cmRoot : this.devnode(h); };
svc(CONFIGMG, 0x03, function (arg) { const dn = this.cmNode(arg(1)); if (!dn) return CR.INVALID_DEVNODE; if (!dn.parent) return CR.NO_SUCH_DEVNODE; this.w32(arg(0), dn.parent.handle); return CR.SUCCESS; });   // Get_Parent
svc(CONFIGMG, 0x04, function (arg) { const dn = this.cmNode(arg(1)); if (!dn) return CR.INVALID_DEVNODE; const c = (dn.children || [])[0]; if (!c) return CR.NO_SUCH_DEVNODE; this.w32(arg(0), c.handle); return CR.SUCCESS; });   // Get_Child
svc(CONFIGMG, 0x05, function (arg) {                                                                  // Get_Sibling
  const dn = this.cmNode(arg(1)); if (!dn || !dn.parent) return CR.INVALID_DEVNODE;
  const sib = dn.parent.children, n = sib[sib.indexOf(dn) + 1]; if (!n) return CR.NO_SUCH_DEVNODE; this.w32(arg(0), n.handle); return CR.SUCCESS;
});
// Create_DevNode(*dn, device ID, parent, flags): a devnode under the parent, its Enum key made
svc(CONFIGMG, 0x0b, function (arg) {
  const parent = this.cmNode(arg(2)); if (!parent) return CR.INVALID_DEVNODE;
  const id = (this.readA(arg(1)) || '').toUpperCase(), have = this.devnodes().find(d => d.id === id);
  if (have) { this.w32(arg(0), have.handle); return 0x10; }   // CR_ALREADY_SUCH_DEVNODE
  const key = 'hklm\\enum\\' + id.toLowerCase(); W.regSet(key, null);
  const dn = { handle: 0xc1000000 + 0x100 * this.devnodes().length, id, key, cls: '', driver: '', parent, children: [], created: true };
  this.devnodes().push(dn); (parent.children = parent.children || []).push(dn);
  this.w32(arg(0), dn.handle); return CR.SUCCESS;
});
svc(CONFIGMG, 0x0f, function (arg) { const dn = this.cmNode(arg(0)); if (!dn) return CR.INVALID_DEVNODE; dn.enumerator = arg(1); return CR.SUCCESS; });   // Register_Enumerator
// Get_Bus_Info(dn, *busType, *size, info, flags): root-enumerated cards sit on no bus
svc(CONFIGMG, 0x44, function (arg) { const dn = this.cmNode(arg(0)); if (!dn) return CR.INVALID_DEVNODE; if (arg(1)) this.w32(arg(1), 0); if (arg(2)) this.w32(arg(2), 0); return CR.SUCCESS; });

// ---- CONFIGMG: logical configurations (BASIC 0, FILTERED 1, ALLOC 2, BOOT 3, FORCED 4) of resource descriptors.
// A card's requirements and assignment are the resources it decodes (P.cards): an IO_DES per port range, an IRQ_DES,
// a DMA_DES, the same in each list
const RES = { IO: 2, DMA: 3, IRQ: 4 };
const cmObjs = p => p.cmObjs || (p.cmObjs = new Map());
const cmObj = (p, o) => { const h = p.alloc(8); o.handle = h; cmObjs(p).set(h, o); return o; };
P.cmLogConfs = function (dn, type) {
  dn.lcs = dn.lcs || {};
  if (dn.lcs[type]) return dn.lcs[type];
  const list = dn.lcs[type] = [];
  const hw = this.cards && this.cards().find(c => c.devnode === dn.id);
  if (hw && type !== 4) {
    const lc = cmObj(this, { kind: 'lc', dn, type, res: [] }); list.push(lc);
    for (const [b, n] of hw.io) { const d = new Uint8Array(12), v = new DataView(d.buffer); v.setUint16(2, 12, true); v.setUint16(4, b, true); v.setUint16(6, b + n - 1, true); d[10] = 0xff; lc.res.push(cmObj(this, { kind: 'rd', lc, rid: RES.IO, data: d })); }
    for (const q of hw.irq) { const d = new Uint8Array(8), v = new DataView(d.buffer); v.setUint16(2, q, true); v.setUint16(4, 1 << q, true); lc.res.push(cmObj(this, { kind: 'rd', lc, rid: RES.IRQ, data: d })); }
    for (const c of hw.dma) { const d = Uint8Array.from([0, c, 1 << c, 0]); lc.res.push(cmObj(this, { kind: 'rd', lc, rid: RES.DMA, data: d })); }
  }
  return list;
};
// Add_Empty_Log_Conf(*lc, dn, priority, flags: the list in bits 0-2)
svc(CONFIGMG, 0x18, function (arg) {
  const dn = this.cmNode(arg(1)); if (!dn) return CR.INVALID_DEVNODE;
  const list = this.cmLogConfs(dn, arg(3) & 7), lc = cmObj(this, { kind: 'lc', dn, type: arg(3) & 7, res: [] });
  if (arg(2) & 8) list.unshift(lc); else list.push(lc);
  this.w32(arg(0), lc.handle); return CR.SUCCESS;
});
svc(CONFIGMG, 0x1a, function (arg) {                                                                  // Get_First_Log_Conf(*lc, dn, flags)
  const dn = this.cmNode(arg(1)); if (!dn) return CR.INVALID_DEVNODE;
  const lc = this.cmLogConfs(dn, arg(2) & 7)[0]; if (!lc) return CR.NO_MORE_LOG_CONF;
  if (arg(0)) this.w32(arg(0), lc.handle); return CR.SUCCESS;
});
svc(CONFIGMG, 0x1b, function (arg) {                                                                  // Get_Next_Log_Conf(*lc, lc, flags)
  const lc = cmObjs(this).get(u32(arg(1))); if (!lc || lc.kind !== 'lc') return 7;   // CR_INVALID_LOG_CONF
  const list = this.cmLogConfs(lc.dn, lc.type), n = list[list.indexOf(lc) + 1]; if (!n) return CR.NO_MORE_LOG_CONF;
  this.w32(arg(0), n.handle); return CR.SUCCESS;
});
svc(CONFIGMG, 0x1c, function (arg) {                                                                  // Add_Res_Des(*rd, lc, resource, data, len, flags)
  const lc = cmObjs(this).get(u32(arg(1))); if (!lc || lc.kind !== 'lc') return 7;
  const rd = cmObj(this, { kind: 'rd', lc, rid: arg(2) & 0x7fff, data: this.u8.slice(arg(3), arg(3) + arg(4)) }); lc.res.push(rd);
  if (arg(0)) this.w32(arg(0), rd.handle); return CR.SUCCESS;
});
// Get_Next_Res_Des(*rd, log conf or res des, resource type (0 all), *resource, flags)
svc(CONFIGMG, 0x1f, function (arg) {
  const cur = cmObjs(this).get(u32(arg(1))); if (!cur) return 7;
  const lc = cur.kind === 'lc' ? cur : cur.lc, from = cur.kind === 'lc' ? 0 : lc.res.indexOf(cur) + 1, want = arg(2) & 0x7fff;
  const rd = lc.res.slice(from).find(r => !want || r.rid === want); if (!rd) return CR.NO_MORE_RES_DES;
  this.w32(arg(0), rd.handle); if (arg(3)) this.w32(arg(3), rd.rid); return CR.SUCCESS;
});
svc(CONFIGMG, 0x20, function (arg) { const rd = cmObjs(this).get(u32(arg(1))); if (!rd || rd.kind !== 'rd') return 8; this.w32(arg(0), rd.data.length); return CR.SUCCESS; });   // Get_Res_Des_Data_Size
svc(CONFIGMG, 0x21, function (arg) {                                                                  // Get_Res_Des_Data(rd, buf, len, flags)
  const rd = cmObjs(this).get(u32(arg(0))); if (!rd || rd.kind !== 'rd') return 8;
  if (arg(2) < rd.data.length) return CR.BUFFER_SMALL; this.u8.set(rd.data, arg(1)); return CR.SUCCESS;
});
svc(CONFIGMG, 0x3b, function (arg) { const dn = this.cmNode(arg(1)); if (!dn) return CR.INVALID_DEVNODE; return this.cmConfig(dn, arg(0)); });   // Get_Alloc_Log_Conf(CMCONFIG, dn, flags)
// Read_Registry_Value(dn, subkey, name, type, buf, *len, flags)
svc(CONFIGMG, 0x3e, function (arg) {
  const dn = this.cmNode(arg(0)); if (!dn) return CR.INVALID_DEVNODE;
  const k = this.cmKey(dn, arg(1) && this.readA(arg(1)), arg(6)); if (!k) return CR.REGISTRY_ERROR;
  const v = valBytes(W.regGet('hklm\\' + k, (arg(2) && this.readA(arg(2))) || '')); if (!v) return CR.NO_SUCH_VALUE;
  const n = this.r32(arg(5)); this.w32(arg(5), v.data.length); if (n < v.data.length) return CR.BUFFER_SMALL;
  if (arg(4)) this.u8.set(v.data, arg(4)); return CR.SUCCESS;
});

/** a dynamically loadable VxD by file name, loaded and initialized (SYS_DYNAMIC_DEVICE_INIT) once */
P.vxdLoad = function (file) {
  const v = this.vxd(file); if (!v) return null;
  if (v.inited) return v;
  v.inited = true;
  const key = v.file, r = this.vxdControl(v, SYS_DYNAMIC_DEVICE_INIT);
  if (r.cf) { this.trapped = `${key} failed SYS_DYNAMIC_DEVICE_INIT`; return null; }
  return v;
};

// ---------------------------------------------------------------- the protected-mode API entry points
/** call a VxD's protected-mode API for the 16-bit caller: its registers in a Client_Reg_Struc, the far return
 *  already taken (CS:EIP the return address, SS:ESP above it), as the VMM's API dispatch hands them over */
P.vxdPmApi = function (v) {
  const c = this.crs || (this.crs = this.alloc(0x60)), cpu = this.cpu;
  const ss = cpu.ss.value & 0xffff, sp = cpu.esp.value & 0xffff, ssb = u32(cpu.ssb.value), ip = this.r16(ssb + sp), cs = this.r16(ssb + sp + 2);
  let fl = 0x202; for (const [r, b] of [['cf', 0], ['pf', 2], ['af', 4], ['zf', 6], ['sf', 7], ['df', 10], ['of', 11]]) if (cpu[r]) fl |= (cpu[r].value & 1) << b;
  const regs = [['edi', 0], ['esi', 4], ['ebp', 8], ['ebx', 0x10], ['edx', 0x14], ['ecx', 0x18], ['eax', 0x1c]];
  for (const [r, o] of regs) this.w32(c + o, u32(cpu[r].value));
  this.w32(c + 0x24, ip); this.w32(c + 0x28, cs); this.w32(c + 0x2c, fl); this.w32(c + 0x30, sp + 4); this.w32(c + 0x34, ss);
  this.w32(c + 0x38, cpu.es.value & 0xffff); this.w32(c + 0x3c, cpu.ds.value & 0xffff); this.w32(c + 0x40, cpu.fsel.value & 0xffff); this.w32(c + 0x44, cpu.gsel.value & 0xffff);
  this.vxdCall(v.procs.pm, { ebx: this.sysVM(), ebp: c });
  for (const [r, o] of regs) cpu[r].value = this.r32(c + o);
  const nf = this.r32(c + 0x2c); for (const [r, b] of [['cf', 0], ['pf', 2], ['af', 4], ['zf', 6], ['sf', 7], ['df', 10], ['of', 11]]) if (cpu[r]) cpu[r].value = (nf >> b) & 1;
  this.seg('es', this.r16(c + 0x38)); this.seg('ds', this.r16(c + 0x3c));
  return this.retf16(0);
};
/** route device `id`'s protected-mode API to its recompiled VxD once it is loaded; the existing entry otherwise */
P.vxdApiRoute = function (id) { const v = this.vxdById(id); return v && v.procs.pm ? v : null; };

// ---------------------------------------------------------------- Win32 DeviceIoControl into a VxD
/** W32_DEVICEIOCONTROL to a loaded VxD: ECX the control code, EBX its DDB, DIOCParams at ESI; EAX 0 or an error */
P.vxdIoctl = function (v, code, inb, nin, outb, nout, pret, h) {
  const d = this.diocp || (this.diocp = this.alloc(0x30));
  this.u8.fill(0, d, d + 0x30);
  this.w32(d + 4, this.sysVM()); this.w32(d + 8, v.ddb); this.w32(d + 0xc, code);
  this.w32(d + 0x10, inb); this.w32(d + 0x14, nin); this.w32(d + 0x18, outb); this.w32(d + 0x1c, nout); this.w32(d + 0x20, pret); this.w32(d + 0x28, h);
  return this.vxdControl(v, W32_DEVICEIOCONTROL, { ebx: v.ddb, ecx: u32(code), esi: d }).eax;
};

// ---------------------------------------------------------------- device loading
/** the MEDIA devnodes' device loader runs as Windows 95's configuration manager runs it: MMDEVLDR.VXD is loaded and
 *  sent PNP_NEW_DEVNODE (DLVXD_LOAD_DEVLOADER) for each devnode whose software key names it as DevLoader */
P.vxdDevLoaders = function () {
  if (this.devLoadersStarted) return; this.devLoadersStarted = true;
  for (const dn of this.devnodes()) {
    const sw = this.devSoftKey(dn), dl = sw && regStr(W.regGet(sw, 'DevLoader'));
    if (!dl || dl.startsWith('*')) continue;
    const v = this.vxdLoad(dl); if (!v) continue;
    const r = this.vxdControl(v, PNP_NEW_DEVNODE, { ebx: dn.handle, edx: DLVXD_LOAD_DEVLOADER });
    if (r.eax) continue;   // PNP_NEW_DEVNODE returns a CONFIGRET in EAX
    this.cmStart(dn);
  }
};
/** CONFIG_START to the devnode's registered driver (and its children's), its resources assigned */
const CONFIG_START = 1;
P.cmStart = function (dn) {
  if (dn.started) return;
  if (dn.handler) { const r = this.vxdCdecl(dn.handler, [CONFIG_START, 0, dn.handle, dn.ref || 0, 0]); dn.started = (r.eax & 0xffff) === 0; }
  else dn.started = true;
  for (const c of dn.children || []) if (c.handler) this.cmStart(c);
};
})();
