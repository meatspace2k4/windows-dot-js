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
  this.protect(m.base, m.base + (m.size || img.length));   // (ring 0's pages: a program's stray pointer into them faults, win32.js PROT)
  const mod = d.mod || (d.mod = new WebAssembly.Module(b64(d.wasm)));
  const run = new WebAssembly.Instance(mod, this.imports).exports.run;
  const look = new Uint32Array(this.mem.buffer, m.lookup, m.textHi - m.textLo);
  m.blocks.forEach((a, i) => { look[a - m.textLo] = i + 1; });
  const rec = { kind: 'vxd', name: m.name.trim(), file: key, id: m.id, meta: m, run, ddb: m.ddb, procs: m.procs, base: m.base, clock: true };
  this.modules.push(rec); this.vxds.set(key, rec);
  // (debugging, ?dynat=addr,...: those blocks run as run-time code, block by block, so a write watch names the block
  // that wrote and the stack it ran on; a VxD's name: all of its blocks)
  for (const a of (this.host && this.host.dynAt) || []) {
    if (typeof a === 'string') { if (a.toUpperCase() === rec.name.toUpperCase()) look.fill(0); }
    else if (a >= m.textLo && a < m.textHi) this.smc(a);
  }
  return rec;
};
/** the loaded VxD with device id `id` */
P.vxdById = function (id) { for (const v of (this.vxds || new Map()).values()) if (v.id === id && v.inited) return v; return null; };

/** call flat ring-0 code at `addr` with the registers given; returns the registers and carry it left. It runs on the
 *  ring-0 stack, below whatever ring-0 frame is live */
P.vxdCall = function (addr, regs = {}, at) {
  const save = {}; for (const r of GPR) save[r] = this.cpu[r].value; for (const [s, b] of SEGS) { save[s] = this.cpu[s].value; save[b] = this.cpu[b].value; }
  // (and the interrupt flag: ring-0 code runs with interrupts as it sets them, and the return to the caller takes the
  // caller's back, as the VMM's return to a VM restores its flags; a VxD that left them disabled held the sound card's
  // interrupt for good, and a wait on a wave's end never ended)
  const savedEip = this.cpu.eip.value, savedCf = this.cpu.cf.value, savedIf = this.cpu.if ? this.cpu.if.value : 1;
  const top = at !== undefined ? at : this.r0Free();
  for (const [s, b] of SEGS) { this.cpu[s].value = 0; if (s !== 'fsel') this.cpu[b].value = 0; }
  this.cpu.fs.value = this.tibFor ? this.tibFor() : this.cpu.fs.value;
  for (const r of GPR) if (r !== 'esp') this.cpu[r].value = u32(regs[r] || 0);
  this.cpu.esp.value = top; this.push(W.LAYOUT.SENTINEL);
  this.r0Depth = (this.r0Depth || 0) + 1; this.depth++;
  let r;
  try { r = this.runAt(addr); }
  finally { this.depth--; this.r0Depth--; if (this.cpu.if) this.cpu.if.value = savedIf; }
  if (r !== 0 || this.trapped) throw new W.GuestError(this.trapped || `VxD call ${u32(addr).toString(16)} did not return (${r} at ${this.reg('eip').toString(16)})`);
  const out = { cf: this.cpu.cf.value & 1, zf: this.cpu.zf.value & 1 }; for (const k of GPR) out[k] = u32(this.cpu[k].value);
  for (const k of GPR) this.cpu[k].value = save[k]; for (const [s, b] of SEGS) { this.cpu[s].value = save[s]; this.cpu[b].value = save[b]; }
  this.cpu.eip.value = savedEip; this.cpu.cf.value = savedCf;
  if (!this.r0Depth) this.vmIrqDeliver();
  return out;
};
/** ring-0 work the host starts (a time-out, a hot key, an event) as a run that can stop and go on later, as a ring-0
 *  thread would: a VxD that blocks (_BlockOnID) until another's work signals it, a blue screen (message mode) waiting
 *  for a key with nothing else running. The page keeps drawing and taking keys meanwhile. It returns the registers it
 *  left, or null when it stopped: r0Runs holds the stopped ones, which the host resumes (r0Step) as they can go on */
// Each run has a ring-0 stack of its own, as a ring-0 thread has: a run that stops keeps its frames where they are,
// and no other ring-0 frame is placed by where a stopped run's SS:ESP points. Placed below the lowest stopped run's
// SS:ESP (stackLinOf of its saved registers, which for a run stopped in VM code it called is the VM's segment and
// SP), a time-out's frames landed in VxD images: VTDAPI's event saved the client registers over its own
// VxDCall Begin_Nest_Exec (f0f1h:f8h at VTDAPI+186h), NDIS's Get_System_Time read device FFh
P.r0Start = function (addr, regs = {}, vm = null) {
  const outer = this.saveFull(), stack = (this.r0Stacks || (this.r0Stacks = [])).pop() || this.alloc(0x10000);
  for (const [s, b] of SEGS) { this.cpu[s].value = 0; if (s !== 'fsel') this.cpu[b].value = 0; }
  this.cpu.fs.value = this.tibFor ? this.tibFor() : this.cpu.fs.value;
  for (const r of GPR) if (r !== 'esp') this.cpu[r].value = u32(regs[r] || 0);
  this.cpu.esp.value = stack + 0x10000 - 16; this.push(W.LAYOUT.SENTINEL);
  this.depth++;
  return this.r0Run({ outer, eip: addr, stack, vm });
};
P.r0Run = function (s) {
  this.r0Depth = (this.r0Depth || 0) + 1; this.preempted = 0; this.r0StopReady = null;
  const curVM = this.curVM; if (s.vm) this.curVM = s.vm;   // (an MS-DOS VM's event runs as that VM, each time it goes on)
  let r;
  try { r = this.runTop(s.eip); }
  catch (e) { this.r0Depth--; this.curVM = curVM; this.loadFull(s.outer); this.r0Stacks.push(s.stack); throw e; }
  this.r0Depth--; this.curVM = curVM;
  if (s.vm && r !== 1 && s.vm.m && s.vm.started && !s.vm.gone) this.vmFromClient(s.vm);   // (its client registers back to its machine, done)
  if (r === 1 && !this.trapped) {   // it waits (R0WAIT, until `ready`), or its time ran out: kept as it is, the host's state put back
    s.ctx = this.saveFull(); s.eip = u32(this.cpu.eip.value);
    s.wait = !this.preempted; s.cont = this.r0Cont; s.ready = s.wait ? this.r0StopReady || (() => true) : () => true;
    (this.r0Runs || (this.r0Runs = [])).push(s);
    this.loadFull(s.outer); return null;
  }
  this.r0Stacks.push(s.stack);   // (its stack free for the next run)
  const out = { cf: this.cpu.cf.value & 1, zf: this.cpu.zf.value & 1 }; for (const k of GPR) out[k] = u32(this.cpu[k].value);
  this.loadFull(s.outer);
  if (r !== 0 || this.trapped) throw new W.GuestError(this.trapped || `VxD call did not return (${r})`);
  if (!this.r0Depth) this.vmIrqDeliver();
  return out;
};
/** the host's turn while ring-0 runs are stopped: events scheduled meanwhile start (as runs of their own), else the
 *  newest run that can go on goes on until it ends or stops again. True while any is still stopped */
P.r0Step = function () { return this.asInterrupt(() => this.r0StepIn()); };
P.r0StepIn = function () {
  const runs = this.r0Runs || [];
  if (!runs.length) return false;
  // (a run whose time ran out is ring-0 code in progress: it goes on first, as nothing interrupts ring 0 with more of
  // it; events start once every stopped run is one that waits)
  if (this.vxdEvents && this.vxdEvents.length && runs.every(s => s.wait)) {
    const e = this.vxdEvents.shift(), v = this.vmEventVM(e);
    if (v) { this.vmEventRun(v, e); return true; }
    if (this.vmEventGone(e)) return true;
    this.r0Start(e.fn, { ebx: this.sysVM(), edx: e.ref, ebp: this.vmClientIdle(), esi: e.handle || 0 });
    return !!(this.r0Runs && this.r0Runs.length);
  }
  for (let i = runs.length - 1; i >= 0; i--) {
    const s = runs[i]; if (!s.ready()) continue;
    runs.splice(i, 1);
    s.outer = this.saveFull(); this.loadFull(s.ctx);
    this.r0Go = s.wait; this.r0Cont = s.cont;
    this.r0Run(s); break;
  }
  return !!(this.r0Runs && this.r0Runs.length);
};
/** a callback VKD makes at interrupt time (a hot key): as ring-0 work the host starts */
P.r0Callback = function (fn, regs) {
  return this.asInterrupt(() => (this.depth ? this.vxdCall(fn, { ...regs, ebp: this.vmClientIdle() }) : this.r0Start(fn, { ...regs, ebp: this.vmClientIdle() })));
};
// R0WAIT: where a ring-0 run that waits stops (run returns 1 there) and goes on when resumed, at r0Cont
W.API.VMMSVC = W.API.VMMSVC || {};
W.API.VMMSVC.R0WAIT = ['regs', function () { if (this.r0Go) { this.r0Go = false; return this.r0Cont; } return -1; }];
/** stop the ring-0 run here (a service that waits, until `ready()`): it goes on after the service when the host
 *  resumes it. Only a run the host started that can stop (r0Start) stops; false otherwise */
P.r0Stop = function (ready) {
  if (this.runLevel !== this.yieldLevel || !this.r0Depth) return false;
  this.r0StopAt = this.thunkFor('VMMSVC', 'R0WAIT'); this.r0StopReady = ready || null;
  return true;
};
/** the interrupts VxDs requested for the VM (VPICD_Set_Int_Request), taken as ring 0 returns to VM code */
P.vmIrqDeliver = function () {
  const by = this.vpicd && this.vpicd.byIrq; if (!by || this.inIRQ) return;
  if (this.cpu.if && !(this.cpu.if.value & 1)) return;   // the VM has interrupts disabled: taken as it enables them (sound16's pass)
  for (const [irq, e] of by) if (e.request) { e.request = false; this.vmIRQ(irq); }
};
/** where the next ring-0 frame starts: below the stack in use when ring-0 frames are live (ring-0 code's own, or
 *  16-bit code it called on an alias of it), below the lowest live frame when VM code runs on its own stack in
 *  between (nested execution), else at the top */
P.r0Free = function () {
  if (!this.r0Stack) { this.r0Stack = this.alloc(0x10000); this.r0Top = this.r0Stack + 0x10000 - 16; }
  if (this.r0Depth) return (this.stackLin() - 0x100) & ~3;
  return this.r0Low !== undefined ? this.r0Low : this.r0Top;
};
/** the linear address SS:ESP points at */
P.stackLin = function () { return this.stackLinOf(this.cpu.ss.value, this.cpu.ssb.value, this.cpu.esp.value); };
/** the linear address of a stack by its SS, SS's base and ESP: ESP itself for a flat stack (SS null, the flat selector
 *  as 16-bit code that jumped into a 32-bit module has it, or a 32-bit stack segment), the base and SP for a 16-bit one */
P.stackLinOf = function (ss, ssb, esp) {
  ss &= 0xffff;
  if (!ss || ss === N.L.FLATDS || this.r32(N.L.ACC + (ss & 0xfff8)) & 0x400000) return u32(esp);
  return u32(ssb + (esp & 0xffff));
};
/** run `fn` (VM code) from ring 0: the ring-0 frames down to the current ESP stay live while it runs */
P.r0Out = function (fn) {
  const low = this.r0Low, was = this.r0Depth;
  if (this.r0Depth) this.r0Low = (this.stackLin() - 0x100) & ~3;
  this.r0Depth = 0;
  try { return fn(); } finally { this.r0Low = low; this.r0Depth = was; }
};
/** a system control message to a VxD's control procedure (EAX message, EBX VM handle, the rest as given) */
P.vxdControl = function (v, msg, regs = {}) { return this.vxdCall(v.procs.control, { ebx: this.sysVM(), ebp: this.r32(this.sysVM() + 8), ...regs, eax: msg }); };   // EBP the VM's client registers
const SYS_DYNAMIC_DEVICE_INIT = 0x1b, SYS_DYNAMIC_DEVICE_EXIT = 0x1c, PNP_NEW_DEVNODE = 0x22, W32_DEVICEIOCONTROL = 0x23;
const DLVXD_LOAD_DEVLOADER = 1;

/** the system VM's control block (the VM handle VxDs are given) */
P.sysVM = function () {
  if (!this.vmcb) {   // CB_VM_Status, CB_High_Linear, CB_Client_Pointer (the client registers), CB_VMID, CB_Signature
    this.vmcb = this.alloc(0x4000);
    // the system VM runs Windows, a protected-mode application: VMStat_PM_Exec | VMStat_PM_App (SHELL takes MSGSRV32's
    // API calls only from it)
    this.w32(this.vmcb, 0x60); this.w32(this.vmcb + 8, this.vmClient()); this.w32(this.vmcb + 0xc, 1); this.w32(this.vmcb + 0x10, 0x62634d56);
  }
  return this.vmcb;
};

// ---------------------------------------------------------------- INT 20h: VxDCall / VxDJmp
const SVC = {};   // (device << 16 | service) -> fn(p): register services read and write p.cpu; C services use arg(i)
const svc = (dev, n, fn) => { SVC[dev << 16 | n] = fn; };
N.VXD_SVC = SVC;   // (the stand-ins by device << 16 | service, for the static checks: tools/gapmap.mjs)
INTS[0x20] = function (next) {
  const d = this.r32(u32(next) - 4), dev = d >>> 16, n = d & 0x7fff, jmp = d & 0x8000, fn = SVC[dev << 16 | n];
  if (window.W95VXDTRACE) window.W95VXDTRACE(dev, n, this, u32(next) - 6);   // debugging: every VxDCall
  // a hooked service (Hook_Device_Service), or one a loaded VxD provides (its DDB's service table): entered as the
  // VMM enters it, by a call (VxDCall: the return to after the dword pushed) or a jump (VxDJmp)
  const to = (this.svcHooks && this.svcHooks.get(dev << 16 | n)) || (!fn && this.vxdService(dev, n));
  if (to) { if (!jmp) { const sp = u32(this.cpu.esp.value) - 4; this.w32(sp, u32(next)); this.cpu.esp.value = sp; } return to; }
  if (!fn && !this.vxdById(dev) && this.absentService(dev, n)) { if (jmp) { const ret = this.r32(u32(this.cpu.esp.value)); this.cpu.esp.value = u32(this.cpu.esp.value) + 4; return ret; } return next; }
  if (!fn) { this.trapped = `unimplemented VxD service ${dev.toString(16)}h:${n.toString(16)}h at ${u32(next - 6).toString(16)}`; return W.LAYOUT.SENTINEL; }
  // a VxDJmp comes from a stub the caller called: its return address sits above the arguments
  const sp = u32(this.cpu.esp.value) + (jmp ? 4 : 0), arg = i => this.r32(sp + 4 * i);
  this.svcSite = jmp ? this.r32(sp - 4) : u32(next) - 6;   // where it was called from, for a deadlock's report
  this.r0StopAt = 0;
  const r = fn.call(this, arg);
  if (r !== undefined) this.cpu.eax.value = u32(r);
  if (window.W95VXDRET) window.W95VXDRET(dev, n, this, arg, u32(this.cpu.eax.value));   // debugging: each service's result
  let back = next;
  if (jmp) { back = this.r32(u32(this.cpu.esp.value)); this.cpu.esp.value = u32(this.cpu.esp.value) + 4; }   // VxDJmp: back to the caller's caller
  if (this.r0StopAt) { const at = this.r0StopAt; this.r0StopAt = 0; this.r0Cont = back; return at; }   // the service waits there (r0Stop)
  return back;
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

// ---- VMM: the VMs. The system VM, and one more for each MS-DOS program SHELL starts (System_Control Create_VM, as
// WinOldAp asks SHELL's API function 3): its control block as the system VM's (CB_VM_Status, CB_High_Linear the
// linear address of its first megabyte, CB_Client_Pointer, CB_VMID, CB_Signature; the devices' areas at the offsets
// _Allocate_Device_CB_Area gave), its client registers, its V86 memory
const CB = { STATUS: 0, HIGH: 4, CLIENT: 8, ID: 0xc, SIG: 0x10 };
/** the VM whose handle (control block) is h, the system VM's record for it, or null */
P.vmOf = function (h) { h = u32(h); return h === this.sysVM() ? { cb: h, sys: true } : (this.vms || []).find(v => v.cb === h) || null; };
P.vmHandles = function () { return [this.sysVM(), ...(this.vms || []).filter(v => !v.gone).map(v => v.cb)]; };
const VM_XMS_KB = 1024;   // (a VM's extended memory, XMS's, past 120000h of its memory)
P.createVM = function () {
  // (its memory: an ended VM's block when one is parked (vmEnd), else new from the heap)
  const size = 0x120000 + VM_XMS_KB * 1024, cb = this.alloc(0x4000), client = this.alloc(0x60), mem = (this.vmMemSpare && this.vmMemSpare.pop()) || this.alloc(size + 0x1000);
  this.u8.fill(0, cb, cb + 0x4000); this.u8.fill(0, client, client + 0x60);
  const high = (mem + 0xfff) & ~0xfff; this.u8.fill(0, high, high + size);
  const vm = { cb, client, high, mem, id: (this.vmNextId = (this.vmNextId || 1) + 1), status: 0 };
  // its memory: the DOS that booted (the page's PC, as the VMM's loader left it), as V86MMGR makes a VM's from the system
  // VM's; a machine of v86.js's runs it there, in Windows' memory
  // (Windows' fixed drives its local disks, as IFSMgr gives them to a VM: each a FAT view of fs.js's drive, one per
  // drive for every VM)
  this.fixedDisk('C');
  if (this.pcDos && window.W95V86) vm.m = window.W95V86.vmMachine({ mem: this.mem, base: high, xmsKB: VM_XMS_KB, fs: this.fs, disks: this.vmDisks, clip: m => this.vmClipboard(m), vmId: vm.id, vgaPort: (port, size, isIn, eax) => this.vmVgaIO(vm, port, size, isIn, eax) }, this.pcDos);
  // a V86 VM being made: CB_VM_Status VMStat_Creating until VM_Init has been sent
  this.w32(cb + CB.STATUS, 4); this.w32(cb + CB.HIGH, high); this.w32(cb + CB.CLIENT, client); this.w32(cb + CB.ID, vm.id); this.w32(cb + CB.SIG, 0x62634d56);
  this.w32(client + 0x2c, 0x20202);   // (the client's flags: V86, IF)
  (this.vms || (this.vms = [])).push(vm);
  return vm;
};
/** a control message sent to the devices for VM `vm` (EBX its handle, EBP its client registers): false when one
 *  fails it (CF). The file system's devices are left out: a VM's files are its own MS-DOS's, whose drives are Windows'
 *  through the redirector (v86.js), where IFSMgr would take that DOS's file tables over (it walks the VM's system
 *  file tables from the List of Lists it found in the system VM's DOS, which is not the one the VM booted) */
const VM_FS_DEVICES = new Set(['IFSMGR', 'VREDIR']);
P.vmBroadcast = function (vm, msg, regs = {}) {
  for (const v of [...(this.vxds || new Map()).values()].filter(x => x.inited && !VM_FS_DEVICES.has(String(x.name).trim().toUpperCase()))) {
    const r = this.vxdCall(v.procs.control, { ...regs, eax: msg, ebx: vm.cb, ebp: vm.client });
    if (r.cf) { W.log('warn', 'vxd', `${v.file} failed system control ${msg} for VM ${vm.id}`); return false; }
  }
  return true;
};
const CREATE_VM = 7, VM_CRITICAL_INIT = 8, VM_INIT = 9, VM_TERMINATE = 0xa, VM_NOT_EXECUTEABLE = 0xb, DESTROY_VM = 0xc;
/** System_Control Create_VM, which the VMM carries out: a VM made, Create_VM and VM_Critical_Init sent for it, then
 *  VM_Init in its own context (the current VM while the devices take it); EBX the new VM, or CF when a device refused
 *  it (VM_Not_Executeable and Destroy_VM sent then, the VM gone) */
P.vmCreate = function (regs) {
  const vm = this.createVM();
  const ok = this.vmBroadcast(vm, CREATE_VM, regs) && this.vmBroadcast(vm, VM_CRITICAL_INIT, regs) && (() => {
    const cur = this.curVM; this.curVM = vm;
    try { return this.vmBroadcast(vm, VM_INIT, regs); } finally { this.curVM = cur; }
  })();
  if (!ok) { this.vmBroadcast(vm, VM_NOT_EXECUTEABLE, { edx: 0 }); this.vmBroadcast(vm, DESTROY_VM); vm.gone = true; vm.m = null; if (vm.mem) { (this.vmMemSpare || (this.vmMemSpare = [])).push(vm.mem); vm.mem = 0; } return 0; }   // (parked, as vmEnd parks it)
  this.w32(vm.cb + CB.STATUS, this.r32(vm.cb + CB.STATUS) & ~4);
  return vm.cb;
};
// the client registers (Client_Reg_Struc) of a VM whose machine is stopped, from its processor and back
const CRS_V86 = [['edi', 0], ['esi', 4], ['ebp', 8], ['ebx', 0x10], ['edx', 0x14], ['ecx', 0x18], ['eax', 0x1c]];
const FLAG_BITS = [['cf', 0], ['pf', 2], ['zf', 6], ['sf', 7], ['if', 9], ['df', 10], ['of', 11]];
P.vmToClient = function (vm) {
  const m = vm.m, c = vm.client; if (!m) return;
  for (const [r, o] of CRS_V86) this.w32(c + o, u32(m.cpu[r].value));
  let fl = 0x20002; for (const [f, b] of FLAG_BITS) fl |= (m.cpu[f].value & 1) << b;
  this.w32(c + 0x24, u32(m.cpu.eip.value) - u32(m.cpu.csb.value)); this.w32(c + 0x28, m.cpu.cs.value & 0xffff); this.w32(c + 0x2c, fl);
  this.w32(c + 0x30, m.cpu.esp.value & 0xffff); this.w32(c + 0x34, m.cpu.ss.value & 0xffff);
  this.w32(c + 0x38, m.cpu.es.value & 0xffff); this.w32(c + 0x3c, m.cpu.ds.value & 0xffff); this.w32(c + 0x40, m.cpu.fsel.value & 0xffff); this.w32(c + 0x44, m.cpu.gsel.value & 0xffff);
};
P.vmFromClient = function (vm) {
  const m = vm.m, c = vm.client; if (!m) return;
  for (const [r, o] of CRS_V86) m.cpu[r].value = this.r32(c + o);
  const fl = this.r32(c + 0x2c); for (const [f, b] of FLAG_BITS) m.cpu[f].value = (fl >> b) & 1;
  m.sreg('ss', this.r16(c + 0x34)); m.cpu.esp.value = this.r32(c + 0x30) & 0xffff;
  m.sreg('es', this.r16(c + 0x38)); m.sreg('ds', this.r16(c + 0x3c)); m.sreg('fsel', this.r16(c + 0x40)); m.sreg('gsel', this.r16(c + 0x44));
  m.sreg('cs', this.r16(c + 0x28)); m.cpu.eip.value = u32(m.cpu.csb.value) + (this.r32(c + 0x24) & 0xffff);
};
/** an interrupt run in a VM's own machine on its client registers (Exec_Int in its context): its DOS's or BIOS's
 *  handler, through its vectors, to the IRET back to a stub in its ROM's segment; its machine as it was afterwards */
P.vmIntV86 = function (vm, n) {
  const m = vm.m, keep = {}; for (const r of m.CPU_NAMES || Object.keys(m.cpu)) keep[r] = m.cpu[r].value;
  const halted = m.halted, ret = m.boxReturn, STUB = 0xf3a00;
  m.s8(STUB, 0xcd); m.s8(STUB + 1, n);
  this.vmFromClient(vm); m.sreg('cs', 0xf000); m.cpu.eip.value = m.v86 + STUB; m.halted = false; m.nestReturn = m.v86 + STUB + 2;
  try {
    for (let k = 0; k < 2000; k++) { const st = m.v86Run(4000); if (st === 'nest') break; if (st === 'trap') throw new W.GuestError(`VM ${vm.id}: ${m.trapped}`); if (st === 'idle') m.halted = false; }
    const c = vm.client, cs = this.r32(c + 0x28), ip = this.r32(c + 0x24);
    this.vmToClient(vm); this.w32(c + 0x28, cs); this.w32(c + 0x24, ip);
  } finally {
    m.nestReturn = 0; for (const r of Object.keys(keep)) m.cpu[r].value = keep[r]; m.halted = halted; m.boxReturn = ret;
  }
};
/** an MS-DOS program's clipboard calls (INT 2Fh AH=17h, the interface WinOldAp's SHELL gives a VM), done on the system
 *  VM's clipboard with USER's own functions: 1700h the version (not 1700h: there is one), 1701h OpenClipboard,
 *  1702h EmptyClipboard, 1703h SetClipboardData (DX the format, ES:BX the data, SI:CX its size), 1704h the size of
 *  the format DX's data (DX:AX), 1705h that data to ES:BX, 1708h CloseClipboard, 1709h the room for SI:CX bytes;
 *  AX 0 when a call fails. While USER is busy in a thread's call (or a thread holds the Win16Lock) the VM waits for it,
 *  as SHELL has the call made in the system VM when it can: answered 0 then, ScanDisk run by Windows 98 Setup quit
 *  without its report (Setup's thread holds the lock as it waits for it), and Setup said there was not enough
 *  conventional memory to check the disks */
P.vmClipboard = function (m) {
  const ax = m.r('ax'), dx = m.r('dx'), es = m.cpu.es.value & 0xffff, bx = m.r('bx'), big = ((m.r('si') << 16) | m.r('cx')) >>> 0;
  const ret = v => { m.w('ax', v); return true; };
  if (ax === 0x1700) return ret(0x0a01);
  if (this.depth || this.thread16 || this.win16Held) return 'wait';
  const u = (ord, a = []) => this.user16(ord, a).ax;
  try {
    switch (ax) {
      case 0x1701: return ret(u(137, [['w', 0]]) ? 1 : 0);
      case 0x1702: return ret(u(139) ? 1 : 0);
      case 0x1703: {
        const n = Math.min(big, 0x100000), h = this.globalAlloc16(0x2002, n); if (!h) return ret(0);
        const b = this.gblock(h); this.u8.set(m.u8.subarray(m.v86 + es * 16 + bx, m.v86 + es * 16 + bx + n), b.lin);
        return ret(u(141, [['w', dx], ['w', h]]) ? 1 : 0);
      }
      case 0x1704: case 0x1705: {
        const h = u(142, [['w', dx]]), b = h && this.gblock(h); if (!b) { m.w('dx', 0); return ret(0); }
        if (ax === 0x1704) { m.w('dx', b.size >>> 16); return ret(b.size & 0xffff); }
        m.u8.set(this.u8.subarray(b.lin, b.lin + b.size), m.v86 + es * 16 + bx); return ret(1);
      }
      case 0x1708: return ret(u(138) ? 1 : 0);
      case 0x1709: m.w('dx', big >>> 16); return ret(big & 0xffff);
    }
  } catch (e) { if (!(e instanceof W.GuestError)) throw e; W.log('warn', 'vmm', `VM clipboard ${ax.toString(16)}h: ${e.message}`); }
  return ret(0);
};
/** the MS-DOS VMs' time: each started one runs for its share of `ms`; its program's end ends it */
P.vmsRun = function (ms) {
  const held = new Set((this.r0Runs || []).map(s => s.vm).filter(Boolean));   // (a VM in an event that is stopped: held there)
  const live = (this.vms || []).filter(v => v.m && v.started && !v.gone && !v.suspended && !held.has(v)); if (!live.length) return;
  for (const v of live) {
    const t0 = performance.now();
    this.vmPageFaults(v); this.vmMapSync(v, true);
    while (performance.now() - t0 < ms / live.length) {
      const st = v.m.v86Run(4000);
      if (st === 'idle') { v.m.halted = false; break; }
      if (st === 'exit') { this.vmEnd(v); break; }
      if (st === 'trap') { W.log('warn', 'vmm', `VM ${v.id} stopped: ${v.m.trapped}`); this.vmEnd(v, true); break; }
    }
    if (!v.gone) { this.vmMapSync(v, false); this.vmDisplayEvent(v); }
  }
};
/** VDD's part when a windowed VM's screen has changed since the grabber last cleared its changes (vddGrab 4): message
 *  41Ah to its WinOldAp window through SHELL_Event (EBX the VM, ECX the message, EAX 0), as VDD posts it (VDD 2:57A4);
 *  again each quarter second while the grabber has not taken them (WinOldAp drops it until its window is up: 2:1D1) */
P.vmDisplayEvent = function (vm) {
  const m = vm.m; if (!m || (vm.dispPosted && performance.now() - vm.dispPosted < 250)) return;
  const at = m.v86 + 0xb8000 + m.m16(0x44e), cur = m.m16(0x450 + 2 * m.m8(0x462)), was = vm.grabShot;
  let changed = !was || cur !== vm.grabCur; for (let i = 0; !changed && i < 4000; i++) if (m.u8[at + i] !== was[i]) changed = true;
  if (!changed) return;
  const fn = this.vxdService(SHELL, 2); if (!fn) return;
  vm.dispPosted = performance.now();
  const r = this.vxdCall(fn, { ebx: vm.cb, ecx: 0x41a, eax: 0, esi: 0, edx: 0, ebp: this.vmClientIdle() });
  vm.dispEvents = (vm.dispEvents || 0) + 1; vm.dispLast = r && r.eax;
};
/** a VM's program has ended (its EXEC returned, CF its failure): DOSMGR's callback told in the VM's context (SHELL takes
 *  the exit code from the VM's DOS), then the VM closed, as Windows closes one: VM_Terminate in its context,
 *  VM_Not_Executeable (EDX VNE_Crashed when it stopped), Destroy_VM */
P.vmEnd = function (vm, crashed = false) {
  vm.started = false;
  // (what its screen last showed, kept for the diagnostics: worker.js probe)
  if (vm.m) { const m = vm.m; vm.lastInts = m.ilog; vm.lastScreen = [...Array(25)].map((_, r) => [...Array(80)].map((_, c) => String.fromCharCode(m.m8(0xb8000 + (r * 80 + c) * 2) || 32)).join('').trimEnd()).filter(Boolean); }
  const cur = this.curVM; this.curVM = vm;
  try {
    this.vmToClient(vm);
    if (vm.execEnd && !crashed) this.vxdCall(vm.execEnd.fn, { ebx: vm.cb, ebp: vm.client, edx: vm.execEnd.ref });
    this.vmBroadcast(vm, VM_TERMINATE);
  } finally { this.curVM = cur; }
  this.vmBroadcast(vm, VM_NOT_EXECUTEABLE, { edx: crashed ? 1 : 0 });
  this.vmBroadcast(vm, DESTROY_VM);
  this.vmMapSync(vm, false);   // (its last screen to the VxD's pages)
  vm.gone = true; vm.m = null;
  // (its events go with it, queued or stopped in a wait, as the VMM cancels a destroyed VM's events)
  if (this.vxdEvents) this.vxdEvents = this.vxdEvents.filter(e => e.vm !== vm.cb);
  if (this.r0Runs) this.r0Runs = this.r0Runs.filter(s => { if (s.vm !== vm) return true; if (s.stack) (this.r0Stacks || (this.r0Stacks = [])).push(s.stack); return false; });
  // (its 2 MB of memory parked for the next VM made (createVM), not given back to the heap: the devices keep the
  // VM's handle after Destroy_VM (WinOldAp's window repaints its last screen through VDD, which reads and writes
  // the VM's video pages at CB_High_Linear; SHELL's release comes after), and freed, the block was USER's and
  // Explorer's next memory, written over under them (Explorer's jump to 0:0 as Windows 98 Setup's ScanDisk ended).
  // Kept for good, each MS-DOS program Windows 98 Setup ran held one, and MSGSRV32 ran out of memory after Setup;
  // parked, as many blocks as VMs ran at once. Its control block stays: the handle is not given to another VM)
  if (vm.mem) { (this.vmMemSpare || (this.vmMemSpare = [])).push(vm.mem); vm.mem = 0; }
  // (the grabber's copy of its screen and its colors stay: WinOldAp's window shows the last screen once the program
  // has ended, and repaints from them, ne16.js vddGrab)   // (the grabber's copy of its screen and its shadow, ne16.js vddGrab)
};
// ---- VMM: VM and thread handles
svc(VMM, 0x01, function () { this.cpu.ebx.value = this.curVM ? this.curVM.cb : this.sysVM(); });   // Get_Cur_VM_Handle
svc(VMM, 0x03, function () { this.cpu.ebx.value = this.sysVM(); });                                   // Get_Sys_VM_Handle
svc(VMM, 0x04, function () { ZF(this, u32(this.cpu.ebx.value) === this.sysVM()); });                  // Test_Sys_VM_Handle
svc(VMM, 0x05, function () { const v = this.vmOf(this.cpu.ebx.value); CF(this, !v || !!v.gone); });  // Validate_VM_Handle
svc(VMM, 0x108, function () { this.cpu.edi.value = this.r0Thread(this.currentThreadId()); });          // Get_Cur_Thread_Handle
svc(VMM, 0x02, function () { ZF(this, u32(this.cpu.ebx.value) === (this.curVM ? this.curVM.cb : this.sysVM())); });   // Test_Cur_VM_Handle
svc(VMM, 0x109, function () { ZF(this, u32(this.cpu.edi.value) === this.r0Thread(this.currentThreadId())); });   // Test_Cur_Thread_Handle
// the system VM always runs, has the focus and its usual priorities; another VM is suspended and resumed as asked
svc(VMM, 0x2b, function () { const v = this.vmOf(this.cpu.ebx.value); if (!v || v.sys) { CF(this, true); return; } v.suspended = (v.suspended || 0) + 1; CF(this, false); });   // Suspend_VM
svc(VMM, 0x2c, function () { const v = this.vmOf(this.cpu.ebx.value); if (v && !v.sys && v.suspended) v.suspended--; CF(this, false); });                                // Resume_VM
svc(VMM, 0x30, function () { this.cpu.ebx.value = this.sysVM(); });                                   // Get_Execution_Focus
svc(VMM, 0x31, function () { CF(this, false); });                                                     // Set_Execution_Focus
svc(VMM, 0x32, function () { this.cpu.eax.value = 0; this.cpu.ecx.value = 100; this.cpu.edx.value = 50; this.cpu.esi.value = 100; });   // Get_Time_Slice_Priority
svc(VMM, 0x33, function () { CF(this, false); });                                                     // Set_Time_Slice_Priority
svc(VMM, 0x37, function () {});                                                                       // Adjust_Execution_Time
svc(VMM, 0x40, function () { this.cpu.eax.value = this.sysTime(); });                                   // Get_VM_Exec_Time: EAX, the rest kept (SHELL's EDX, a time it subtracts)
svc(VMM, 0xd0, function () { this.cpu.eax.value = this.sysTime(); });                                  // Get_Last_Updated_VM_Exec_Time
svc(VMM, 0x114, function () {});                                                                      // Adjust_Thread_Exec_Priority
svc(VMM, 0x163, function () {});                                                                      // Set_Inversion_Pri
svc(VMM, 0x166, function () { this.cpu.ecx.value = 8; return 8; });                                     // Get_Thread_Win32_Pri: normal, EAX and ECX
// End_Crit_And_Suspend: CF set, the system VM not suspended (as Suspend_VM answers), which SHELL tests for
svc(VMM, 0x21, function () { if (this.vxdCrit) this.vxdCrit--; CF(this, true); });
// Get_Crit_Section_Status: EBX the owner, ECX its claims (none but the VxDs' own here)
svc(VMM, 0x29, function () { const n = this.vxdCrit || 0; this.cpu.ecx.value = n; this.cpu.ebx.value = n ? this.sysVM() : 0; CF(this, false); });
svc(VMM, 0x09, function () { CF(this, false); });                                                     // Install_V86_Break_Point: no V86 code reaches it
svc(VMM, 0xbd, function () {});                                                                       // Set_System_Exit_Code
svc(VMM, 0xdb, function () { this.cpu.eax.value = 0; this.cpu.ebx.value = 0; ZF(this, true); CF(this, false); });   // Get_Name_Of_Ugly_TSR: EAX:EBX the name, none loaded (ZF)
svc(VMM, 0xe0, function () { this.cpu.eax.value = 0; this.cpu.edx.value = 0; CF(this, false); });     // GetSetDetailedVMError: none
svc(VMM, 0x142, function () { this.cpu.eax.value = 0; });                                              // Get_Set_Real_DOS_PSP
svc(VMM, 0x18, function () { CF(this, false); });                                                     // Hook_NMI_Event: no NMI comes
svc(VMM, 0xe9, function () { CF(this, false); });                                                     // Hook_Invalid_Page_Fault: every page is present
// Close_VM (EBX VM, EAX flags): the system VM's is the machine's end; an MS-DOS VM's ends that VM, as its program's
// end does (vmsRun), its memory given back (it reset the machine whatever VM it was asked for)
svc(VMM, 0xec, function () {
  const v = this.vmOf(this.cpu.ebx.value);
  if (v && !v.sys) { if (!v.gone) this.vmEnd(v); CF(this, false); return; }
  if (this.host && this.host.reset) this.host.reset(); throw new W.GuestError('the system VM was closed');
});
svc(VMM, 0x2f, function () { throw new W.GuestError('Crash_Cur_VM'); });
// the page tables: one address space, every page mapped to itself. _CopyPageTable(page, n, buf, flags): the entries
// (present, writable, user); _ModifyPageBits, _MapIntoV86, _PhysIntoV86: the mapping stays as it is
// A page an MS-DOS VM has written since its dirty bit was last cleared: dirty (P_DIRTY 40h), as the processor sets it,
// which VDD reads to find what changed on a VM's screen (VDD 1:24F63). Never dirty, VDD saw no change and the grabber
// drew nothing. Kept by linear page (dirtyLin): the VM's own (CB_High_Linear on) and the VxD's page mapped there, both
// one physical page on Windows 95, which VDD reads it through (its video memory's own linear pages)
svc(VMM, 0x61, function (arg) {
  for (let i = 0; i < arg(1); i++) {
    const pg = arg(0) + i, dirty = this.dirtyLin && this.dirtyLin.has(pg);
    this.w32(arg(2) + 4 * i, u32(pg * 0x1000 | 7 | 0x20 | (dirty ? 0x40 : 0)));
  }
  return 1;
});
// _ModifyPageBits(VM, VMLinPgNum, nPages, bitAND, bitOR, pType, flags): of the bits kept here, the dirty bit, cleared
// where bitAND clears it (VDD, once it has taken a page's changes): the VM's page and the page mapped there
svc(VMM, 0x60, function (arg) {
  const v = this.vmOf(arg(0));
  if (v && !v.sys && this.dirtyLin && !(arg(3) & 0x40)) for (let i = 0; i < arg(2); i++) {
    const pg = arg(1) + i, to = v.vmaps && v.vmaps.get(pg);
    this.dirtyLin.delete((v.high >>> 12) + pg); if (to) this.dirtyLin.delete(to >>> 12);
  }
  return 1;
});
// a VxD's memory mapped into an MS-DOS VM's first megabyte (VDD's video memory for the VM at A0000h-BFFFFh): a VM's
// memory is a block of its own here, not page tables, so a mapped page is kept as its own copy in the VM's memory, the
// VxD's page and the VM's in step at each turn of the VM's (vmMapSync) and as the mapping changes. The system VM's
// pages stay as they are (one address space). _MapIntoV86(hMem, VM, VMLinPgNum, nPages, PageOff, flags): the pages
// of a block; the null page's handle unmaps them. _PhysIntoV86(PhysPage, VM, VMLinPgNum, nPages, flags): the
// hardware's (a VM in a window does not have them): unmapped. _LinMapIntoV86(HLinPgNum, VM, VMLinPgNum, nPages, flags)
P.vmMapPages = function (vmh, page, n, lin) {
  const v = this.vmOf(vmh); if (!v || v.sys || !v.m) return 1;
  const maps = v.vmaps || (v.vmaps = new Map()), vmLin = pg => v.m.v86 + pg * 0x1000;
  for (let i = 0; i < n; i++) {
    const pg = page + i, old = maps.get(pg);
    if (old) this.u8.copyWithin(old, vmLin(pg), vmLin(pg) + 0x1000);   // (what the VM wrote, to the page it had)
    const to = lin ? lin(i) : 0;
    if (to) { maps.set(pg, to); this.u8.copyWithin(vmLin(pg), to, to + 0x1000); } else maps.delete(pg);
  }
  return 1;
};
/** a VM's first touch of a page a VxD hooked (Hook_V86_Page: VDD's video memory, A0h-BFh) and has not mapped: the
 *  hook called as the page fault calls it (EAX the page, EBX the VM), once a page for each VM (a page the hook leaves
 *  unmapped, the VGA's graphics pages in text mode, is not asked again each turn). Its pages always present, the VM
 *  never faulted, VDD never mapped its screen, and the window was blank */
P.vmPageFaults = function (v) {
  if (!this.v86PageHooks || !this.v86PageHooks.size) return;
  const tried = v.pageTried || (v.pageTried = new Set());
  for (const [pg, fn] of this.v86PageHooks) {
    if ((v.vmaps && v.vmaps.has(pg)) || tried.has(pg)) continue;
    tried.add(pg);
    const cur = this.curVM; this.curVM = v;
    try { this.vxdCall(fn, { eax: pg, ebx: v.cb, ebp: v.client }); } finally { this.curVM = cur; }
  }
};
/** the pages VxDs mapped into a VM, in step: `toVM` before the VM runs (what the VxD wrote), else after (what the VM wrote) */
P.vmMapSync = function (v, toVM) {
  if (!v.vmaps || !v.m) return;
  for (const [pg, lin] of v.vmaps) {
    const a = v.m.v86 + pg * 0x1000;
    if (toVM) { this.u8.copyWithin(a, lin, lin + 0x1000); continue; }
    // (what the VM wrote: the page dirty, as the processor marks it, then the VxD's copy brought up to date)
    let i = 0; const u = this.u8; while (i < 0x1000 && u[a + i] === u[lin + i]) i++;
    if (i < 0x1000) { const d = this.dirtyLin || (this.dirtyLin = new Set()); d.add(a >>> 12); d.add(lin >>> 12); u.copyWithin(lin, a, a + 0x1000); }
  }
};
svc(VMM, 0x5d, function (arg) { const h = u32(arg(0)), off = arg(4); return this.vmMapPages(arg(1), arg(2), arg(3), h && h !== this.nulPage ? i => h + (off + i) * 0x1000 : null); });
svc(VMM, 0x5e, function (arg) { return this.vmMapPages(arg(1), arg(2), arg(3), null); });
// VMM_GetDDBList: the first DDB, each one's DDB_Next the one loaded after it
svc(VMM, 0x13f, function () {
  const vs = [...(this.vxds || new Map()).values()].filter(v => v.inited);
  vs.forEach((v, i) => this.w32(v.ddb, vs[i + 1] ? vs[i + 1].ddb : 0));
  this.cpu.eax.value = vs.length ? vs[0].ddb : 0;
});
// _GetVxDName(addr, buf): the name of the VxD whose image holds the address ("VMM" for the VMM's own)
svc(VMM, 0x17e, function (arg) {
  const a = u32(arg(0)), v = [...(this.vxds || new Map()).values()].find(x => a >= x.meta.base && a < x.meta.base + x.meta.size);
  this.writeA(arg(1), v ? v.name : 'VMM'); return arg(1);
});
svc(VMM, 0x18e, function (arg) { const a = (this.readA(arg(0)) || '').toLowerCase(), b = (this.readA(arg(1)) || '').toLowerCase(); return a < b ? -1 : a > b ? 1 : 0; });   // _lstrcmpi
// _GetDescriptor(selector, VM, flags): EAX the low dword, EDX the high
svc(VMM, 0x7b, function (arg) {
  const sel = arg(0) & 0xfff8, base = this.r32(N.L.LDT + sel); let lim = this.r32(N.L.LDT + sel + 4), g = 0;
  if (lim > 0xfffff) { lim >>>= 12; g = 0x800000; }
  this.cpu.edx.value = u32((base & 0xff000000) | ((base >>> 16) & 0xff) | (this.r32(N.L.ACC + sel) & 0x40ff00) | g | (lim & 0xf0000));
  return u32((base & 0xffff) << 16 | (lim & 0xffff));
});
// Get_Environment_String (ESI a name, or 0): EDX its value in the environment Windows started with, or with ESI 0 the
// environment itself (in DOS's memory after its arena header, whose size MMDEVLDR reads); CF none of that name
svc(VMM, 0xb5, function () {
  if (!this.vmmEnv) {
    const s = N.DOS_ENV, paras = (s.length + 15) >> 4, a = (this.dosTop + 15) & ~15; this.dosTop = a + 16 + paras * 16;
    this.u8.fill(0, a, a + 16 + paras * 16); this.u8[a] = 0x4d; this.w16(a + 1, 8); this.w16(a + 3, paras);
    for (let i = 0; i < s.length; i++) this.u8[a + 16 + i] = s.charCodeAt(i);
    this.vmmEnv = a + 16;
  }
  this.cpu.edx.value = this.vmmEnv;
  const name = u32(this.cpu.esi.value) && (this.readA(u32(this.cpu.esi.value)) || '').toUpperCase(); if (!name) { CF(this, false); return; }
  for (let p = this.vmmEnv, e; (e = this.readA(p)); p += e.length + 1) if (e.slice(0, e.indexOf('=')).toUpperCase() === name) { this.cpu.edx.value = p + e.indexOf('=') + 1; CF(this, false); return; }
  CF(this, true);
});

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
  (this.pageAllocs || (this.pageAllocs = new Map())).set(p, a);   // (the block it is in, for _PageFree)
  if (arg(6)) this.w32(arg(6), p);
  this.cpu.edx.value = p; return p;
});
svc(VMM, 0x55, function (arg) { const a = this.pageAllocs && this.pageAllocs.get(u32(arg(0))); if (a) { this.pageAllocs.delete(u32(arg(0))); this.free(a); } return 1; });   // _PageFree(hMem, flags)
svc(VMM, 0x63, function (arg) { return u32(arg(0) << 12); });                                         // _LinPageLock: the region's linear address
svc(VMM, 0x64, function () { return 1; });                                                            // _LinPageUnLock
// _HeapAllocate, _HeapFree: the VxDs' heap on ring 0's pages (win32.js PROT), as the VMM's heap is in the system arena,
// which ring 3 cannot reach: a program's stray pointer into a VxD's data faults rather than writing over it (Paint's
// C++ unwind, on a pointer it read from address 0, wrote a stack address into NETBEUI's list, and NETBEUI's next
// time-out followed it). Pools of 256 KB, page-aligned and protected whole, blocks of 16 bytes and up from them
P.r0Alloc = function (n) {
  n = (Math.max(n, 1) + 15) & ~15;
  const h = this.r0Heap || (this.r0Heap = { pool: 0, top: 0, end: 0, sizes: new Map(), free: new Map() });
  const l = h.free.get(n); let a = l && l.length ? l.pop() : 0;
  if (!a) {
    if (h.top + n > h.end) {
      const size = Math.max(0x40000, (n + 0xfff) & ~0xfff), raw = this.alloc(size + 0x1000, false), p = (raw + 0xfff) & ~0xfff;
      this.protect(p, p + size); h.top = p; h.end = p + size;
    }
    a = h.top; h.top += n;
  }
  h.sizes.set(a, n); this.u8.fill(0, a, a + n); return a;
};
P.r0HeapFree = function (a) {
  const h = this.r0Heap, n = h && h.sizes.get(a); if (!n) return false;
  h.sizes.delete(a); if (!h.free.has(n)) h.free.set(n, []); h.free.get(n).push(a); return true;
};
svc(VMM, 0x4f, function (arg) { return this.r0Alloc(arg(0)); });                                      // _HeapAllocate
svc(VMM, 0x51, function (arg) { if (!this.r0HeapFree(u32(arg(0)))) this.free(u32(arg(0))); return 1; });   // _HeapFree(hAddress, flags)

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
// (each selector the descriptor given, its access byte and size bits: one descriptor, a 4 GB flat one among them,
// not 64K tiles over its limit)
const descSels = (p, lo, hi, count = 1) => {
  const n = Math.max(1, count), s = p.allocSels(0, n * 0x10000);
  for (let k = 0; k < n; k++) p.setDesc(s + 8 * k, descBase(lo, hi), descLimit(lo, hi), u32(hi & 0x00c0ff00));
  return s;
};
svc(VMM, 0x78, function (arg) { const s = descSels(this, arg(2), arg(1), arg(3)); this.cpu.edx.value = 0; return s; });
svc(VMM, 0x79, function (arg) { this.freeSels(arg(1) & 0xffff); return 1; });
svc(VMM, 0x76, function (arg) { const s = descSels(this, arg(1), arg(0)); this.cpu.edx.value = 0; return s; });
svc(VMM, 0x77, function (arg) { this.freeSels(arg(0) & 0xffff); return 1; });
// _SetDescriptor(selector, VM, DescDWORD1 (high), DescDWORD2 (low), flags): the descriptor given; nonzero
svc(VMM, 0x7c, function (arg) { this.setDesc(arg(0) & 0xffff, descBase(arg(3), arg(2)), descLimit(arg(3), arg(2)), u32(arg(2) & 0x00c0ff00)); if (this.refreshSegs) this.refreshSegs(); return 1; });

// ---- VMM: the V86 address space's device pages and hooks, as VDD claims the video memory's (VDD.VXD's Sys_Critical_Init).
// _Assign_Device_V86_Pages(VMLinrPage, nPages, VM (0: every VM), flags): the pages a device's own in the VMs, nonzero
// unless one is a device's already; _DeAssign_Device_V86_Pages gives them back; _Get_Device_V86_Pages_Array(VM,
// ArrayBuf, flags) the bitmap of the first 110h pages assigned (global and the VM's), nonzero. One address space here:
// the claim is a record, the pages stay where they are
const devPages = (p, vm) => { const m = p.devV86 || (p.devV86 = new Map()); if (!m.has(vm)) m.set(vm, new Set()); return m.get(vm); };
svc(VMM, 0x72, function (arg) {
  const lo = arg(0), n = arg(1), mine = devPages(this, u32(arg(2))), all = devPages(this, 0);
  for (let i = lo; i < lo + n; i++) if (mine.has(i) || all.has(i)) return 0;
  for (let i = lo; i < lo + n; i++) mine.add(i);
  return 1;
});
svc(VMM, 0x73, function (arg) { const s = devPages(this, u32(arg(2))); for (let i = arg(0); i < arg(0) + arg(1); i++) s.delete(i); return 1; });
svc(VMM, 0x74, function (arg) {
  const buf = u32(arg(1)), on = new Set([...devPages(this, 0), ...(arg(0) ? devPages(this, u32(arg(0))) : [])]);
  for (let w = 0; w < 0x110 / 32; w++) { let d = 0; for (let b = 0; b < 32; b++) if (on.has(w * 32 + b)) d |= 1 << b; this.w32(buf + 4 * w, u32(d)); }
  return 1;
});
// Hook_V86_Page(EAX page, ESI callback): the page's faults the callback's; every page is present here, so none comes. CF clear
svc(VMM, 0x71, function () { (this.v86PageHooks || (this.v86PageHooks = new Map())).set(this.cpu.eax.value >>> 0, u32(this.cpu.esi.value)); CF(this, false); });
// Hook_PM_Fault(EAX the fault, ESI the handler): ESI the one before (none), CF clear
svc(VMM, 0x80, function () { (this.pmFaultHooks || (this.pmFaultHooks = new Map())).set(this.cpu.eax.value & 0xff, u32(this.cpu.esi.value)); this.cpu.esi.value = 0; CF(this, false); });
// _LinMapIntoV86(HLinPgNum, VM, VMLinPgNum, nPages, flags) and _PageLock/_PageUnLock(hMem, nPages, PageOff, flags):
// one address space, every page present and locked: nonzero (the mapping as it is, as _MapIntoV86 answers)
svc(VMM, 0x62, function (arg) { const pg = arg(0); return this.vmMapPages(arg(1), arg(2), arg(3), i => (pg + i) * 0x1000); });
svc(VMM, 0x56, function () { return 1; }); svc(VMM, 0x57, function () { return 1; });
// _GetNulPageHandle: the handle of the page the VMM maps where nothing is (a page of zeros)
svc(VMM, 0x6a, function () {
  if (!this.nulPage) { const a = this.alloc(0x2000), pg = (a + 0xfff) & ~0xfff; this.u8.fill(0, pg, pg + 0x1000); (this.pageAllocs || (this.pageAllocs = new Map())).set(pg, a); this.nulPage = pg; }
  return this.nulPage;
});
// No_Fail_Resume_VM (EBX): as Resume_VM, never failing
svc(VMM, 0x2d, function () { const v = this.vmOf(this.cpu.ebx.value); if (v && !v.sys && v.suspended) v.suspended--; });
// Map_Flat: AH the offset of a segment register, AL of an offset register, in the client registers (EBP): EAX linear
// Map_Flat (AH, AL: the offsets of a segment and an offset register in the client registers): the current VM's client
// registers, through its control block (CB_Client_Pointer), whatever EBP holds
svc(VMM, 0x1c, function () {
  const ax = this.cpu.eax.value & 0xffff, c = this.r32(this.sysVM() + 8), seg = this.r16(c + (ax >> 8)), off = (ax & 0xff) === 0xff ? 0 : this.r32(c + (ax & 0xff));
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
// _lstrcpyn(dest, src, n): EAX dest, EDX its terminating null, ECX the room left there, as its callers append: SHELL
// copies the Windows folder, then a file name at EDX in ECX characters (tools/staticmap.py found the reads)
svc(VMM, 0x17b, function (arg) {
  const s = this.readA(arg(1)) || '', n = u32(arg(2)), k = this.writeA(arg(0), s.slice(0, Math.max(Math.min(n, 0x7fffffff) - 1, 0)), n > 0x7fffffff ? undefined : n);
  this.cpu.edx.value = u32(arg(0) + k) | 0; this.cpu.ecx.value = u32(n - k) | 0; return arg(0);
});
// _lstrlen: EAX the length, EDX the terminating null, as callers take it: MMDEVLDR appends "\Drivers" at EDX after it
// (left as it was, EDX 0, the strings went to address 0, the null page)
svc(VMM, 0x17c, function (arg) { const n = (this.readA(arg(0)) || '').length; this.cpu.edx.value = u32(arg(0) + n) | 0; return n; });

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
svc(SHELL, 0x0e, function (arg) { return this.appyCall(arg(0), arg(1)) ? 1 : this.appyQueue.length; });
/** an appy-time call: queued for the host's next appy time, unless the appy-time thread itself (MSGSRV32's: SHELL's
 *  appy-time server) makes it with Windows up, when it runs at once on that thread, as SHELL runs it (MSGSRV32's
 *  start-up has MMDEVLDR queue the devices' start inside DriverProc 800h, and finds the card's drivers loaded when it
 *  plays SystemStart after it). True when it ran */
P.appyCall = function (fn, ref) {
  if (this.user16Ready && this.thread16 && this.thread16 === this.appyThread) { this.vxdCdecl(fn, [ref]); return true; }
  (this.appyQueue = this.appyQueue || []).push({ fn, ref }); return false;
};
// _SHELL_CallDll(dll, proc, cbArgs, args): the 16-bit DLL's export called with the argument block as its PASCAL
// frame (the block is the stack image, last argument first); EAX its DX:AX, ECX 0 once it was called (SHELL's callers
// take ECX nonzero, jecxz, as the call not made: tools/staticmap.py)
svc(SHELL, 0x18, function (arg) {
  const dll = this.readA(arg(0)) || '', proc = arg(1) >>> 16 ? this.readA(arg(1)) || '' : arg(1) & 0xffff, n = arg(2), blk = arg(3);
  this.cpu.ecx.value = 1;
  const m = this.loadLibrary16(dll); if (!m) return 0;
  let ep;
  if (m.meta) ep = this.neExport(m, typeof proc === 'string' ? proc.toUpperCase() : proc);
  else {   // a module the personality provides (KERNEL): its export by name or ordinal, as GetProcAddress gives it
    const ord = typeof proc === 'string' ? N.names16(m.name)[proc.toUpperCase()] : proc;
    ep = ord && N.K16[`${m.name}.#${ord}`] ? this.thunk16For(`${m.name}.#${ord}`) : 0;
  }
  if (!ep) return 0;
  const words = []; for (let o = n - 2; o >= 0; o -= 2) words.push(['w', this.r16(blk + o)]);
  this.tick16(); const r = this.call16(ep >>> 16, ep & 0xffff, words).dxax; this.cpu.ecx.value = 0; return r;
});
/** run the appy-time callbacks VxDs scheduled: the host calls this between slices */
P.vxdAppy = function () {
  if (this.depth || !this.user16Ready || !this.appyQueue || !this.appyQueue.length) return;
  const q = this.appyQueue; this.appyQueue = [];
  for (const e of q) { if (window.W95APPYTRACE) window.W95APPYTRACE(e); this.vxdCdecl(e.fn, [e.ref]); }
};
/** _SHELL_PostMessage(hwnd, message, wParam, lParam, callback, reference): a message posted through SHELL.VXD (service
 *  17h:6), as KERNEL32 tells MSGSRV32's window its start is done (501h); false with no SHELL loaded */
P.shellPostMessage = function (hwnd, msg, wParam, lParam) {
  const fn = this.vxdService(SHELL, 6); if (!fn) return false;
  return !!(this.vxdCdecl(fn, [hwnd, msg, wParam, lParam, 0, 0]).eax);
};
/** call a cdecl ring-0 function with dword arguments */
P.vxdCdecl = function (fn, args) {
  const frame = this.r0Free() - 4 * args.length - 64;
  args.forEach((a, i) => this.w32(frame + 4 * i, u32(a)));
  // the call pushes its return on top of the arguments: enter with ESP at the arguments
  return this.vxdCallAt(fn, frame);
};
P.vxdCallAt = function (addr, sp, regs = {}) { return this.vxdCall(addr, regs, sp); };

// ---- VWIN32: the Win32 side
svc(VWIN32, 0x02, function (arg) { this.queueApc(this.r0Tid(arg(2)), arg(0), arg(1)); return 1; });   // _VWIN32_QueueUserApc(proc, data, thread)
svc(VWIN32, 0x0e, function (arg) { const e = this.r0Event(arg(0)); if (e) this.signal(e); return e ? 1 : 0; });   // _VWIN32_SetWin32Event
svc(VWIN32, 0x14, function () { return 1; });                                                         // _VWIN32_CloseVxDHandle
// VWIN32_EnterCrstR0 / VWIN32_LeaveCrstR0 (EDX the critical section): SPOOLER's, around its queue's work. One
// processor, and ring 0 is not preempted here: nothing else can be in it meanwhile (tools/staticmap.py found them called)
svc(VWIN32, 0x09, function () { CF(this, false); });
svc(VWIN32, 0x0a, function () { CF(this, false); });

// ---- CONFIGMG at ring 0 (flat pointers, cdecl, EAX the CONFIGRET)
svc(CONFIGMG, 0x00, function () { return 0x400; });                                                   // Get_Version
svc(CONFIGMG, 0x02, function (arg) {                                                                  // Locate_DevNode(*dn, id, flags)
  const id = arg(1) ? (this.readA(arg(1)) || '').toUpperCase() : null, dn = id && this.devnodes().find(d => d.id === id);
  if (!dn) return CR.NO_SUCH_DEVNODE; this.w32(arg(0), dn.handle); return CR.SUCCESS;
});
// Register_Device_Driver(dn, handler, refData, flags): the handler gets the devnode's configuration events
// (a devnode whose resources are assigned is started as its driver registers: the handler gets CONFIG_START before the
// call returns, as CONFIGMG starts it)
svc(CONFIGMG, 0x0e, function (arg) { const dn = this.devnode(arg(0)); if (!dn) return CR.INVALID_DEVNODE; dn.handler = arg(1); dn.ref = arg(2); this.cmStart(dn); return CR.SUCCESS; });
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
    // (*NAME: a static VxD already loaded, by its DDB's name)
    const v = f.startsWith('*') ? [...(this.vxds || new Map()).values()].find(x => x.inited && x.name.toUpperCase() === f.slice(1).toUpperCase()) : this.vxdLoad(f);
    if (!v) return CR.DLVXD_NOT_FOUND;
    (dn.dlvxds = dn.dlvxds || []).push({ v, type: arg(2) });
    this.vxdControl(v, PNP_NEW_DEVNODE, { ebx: dn.handle, edx: arg(2) });
  }
  return CR.SUCCESS;
});
// Get_DDBs(*ppDDB, *count, loadType, dn, flags): the DDBs of the VxDs loaded for the devnode with that load type
svc(CONFIGMG, 0x30, function (arg) {
  const dn = this.devnode(arg(3)); if (!dn) return CR.INVALID_DEVNODE;
  const ddbs = (dn.dlvxds || []).filter(e => e.type === arg(2)).map(e => e.v.ddb);
  if (!ddbs.length) return CR.DLVXD_NOT_FOUND;
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
svc(VMM, 0x3b, function () { const l = this.vmHandles(), i = l.indexOf(u32(this.cpu.ebx.value)); this.cpu.ebx.value = l[(i + 1) % l.length]; });   // Get_Next_VM_Handle: round the list, the system VM first

// ---- VMM: events. Schedule_Global_Event(ESI proc, EDX ref): EAX handle; the procedure runs between slices
svc(VMM, 0x0e, function () { const q = this.vxdEvents || (this.vxdEvents = []); q.push({ fn: u32(this.cpu.esi.value), ref: u32(this.cpu.edx.value) }); this.cpu.esi.value = q.length; });
svc(VMM, 0x0f, function () { const q = this.vxdEvents || (this.vxdEvents = []); q.push({ fn: u32(this.cpu.esi.value), ref: u32(this.cpu.edx.value), vm: u32(this.cpu.ebx.value) }); this.cpu.esi.value = q.length; });   // Schedule_VM_Event (EBX the VM)
/** run the events VxDs scheduled (EBX the VM, EDX the reference data, EBP the client registers) */
P.vxdRunEvents = function () { return this.asInterrupt(() => this.vxdRunEventsIn()); };
P.vxdRunEventsIn = function () {
  if (this.vxdRunTimeOuts) this.vxdRunTimeOuts();
  if (this.depth) return;
  if (this.kernelApcs && this.kernelApcs.length) { const k = this.kernelApcs; this.kernelApcs = []; for (const a of k) this.vxdCdecl(a.fn, [a.data]); }
  if (!this.vxdEvents || !this.vxdEvents.length) return;
  if ((this.r0Runs || []).some(s => !s.wait)) return;   // (ring-0 code in progress, its time out: it goes on first, r0Step)
  const q = this.vxdEvents; this.vxdEvents = [];
  for (const e of q) { const v = this.vmEventVM(e); if (v) this.vmEventRun(v, e); else if (!this.vmEventGone(e)) this.vxdCall(e.fn, { ebx: this.sysVM(), edx: e.ref, ebp: this.vmClientIdle() }); }
};
/** an event for an MS-DOS VM that has ended: the VMM drops a VM's events when it destroys it. Run as the system VM's,
 *  SHELL's hold of a VM whose program had ended waited for a release that never came (SHELL 1:1158C), a deadlock */
P.vmEventGone = function (e) { if (!e.vm || e.vm === this.sysVM()) return false; const v = this.vmOf(e.vm); return !v || !!v.gone; };
/** the MS-DOS VM a VM event was scheduled for (Schedule_VM_Event, Call_Priority_VM_Event: EBX), when it is not the
 *  system VM and still there; such an event runs in that VM's context, on its client registers */
P.vmEventVM = function (e) { const v = e.vm && this.vmOf(e.vm); return v && !v.sys && !v.gone ? v : null; };
// (started by the host, it is a ring-0 run that can stop, as a time-out is: an event that blocks (SHELL's, which holds
// the VM until WinOldAp's next call signals it, SHELL 1:1158C) stops there and the system goes on; run inside a call it
// could not, and the wait was a ring-0 deadlock that froze the system. The VM does not run while its event is stopped)
P.vmEventRun = function (v, e) {
  // (inside a call it cannot stop: it waits in the queue for the host's next turn, as the VM's own time comes later)
  if (this.depth || this.runLevel) { (this.vxdEvents || (this.vxdEvents = [])).push(e); return; }
  const cur = this.curVM; this.curVM = v;
  try { this.vmToClient(v); this.r0Start(e.fn, { ebx: v.cb, edx: e.ref, ebp: v.client, esi: e.handle || 0 }, v); }
  finally { this.curVM = cur; }
};

// ---- VMM: I/O trapping. A VxD's handler for a port (Install_IO_Handler: ESI proc, EDX port) sees the VM's IN and OUT
// there while trapping is on for that VM (Enable/Disable_Local_Trapping, EBX VM, EDX port)
const ioh = p => p.ioHandlers || (p.ioHandlers = new Map());
svc(VMM, 0x96, function () { ioh(this).set(this.cpu.edx.value & 0xffff, { fn: u32(this.cpu.esi.value), on: true }); CF(this, false); });
svc(VMM, 0x116, function () { ioh(this).delete(this.cpu.edx.value & 0xffff); CF(this, false); });     // Remove_IO_Handler
// Enable_Local_Trapping / Disable_Local_Trapping (EBX the VM, EDX the port): that VM's alone. (Taken for every VM, VDD's
// untrapping of the system VM's display ports untrapped them for the MS-DOS VMs too: their mode sets never reached
// VDD, which then mapped them no screen, and their windows were blank)
svc(VMM, 0x98, function () { const h = ioh(this).get(this.cpu.edx.value & 0xffff); if (h) { if (u32(this.cpu.ebx.value) === this.sysVM()) h.on = true; else if (h.off) h.off.delete(u32(this.cpu.ebx.value)); } });
svc(VMM, 0x9a, function () { const h = ioh(this).get(this.cpu.edx.value & 0xffff); if (h) { if (u32(this.cpu.ebx.value) === this.sysVM()) h.on = false; else (h.off || (h.off = new Set())).add(u32(this.cpu.ebx.value)); } });
// Enable_Global_Trapping / Disable_Global_Trapping (EDX port): as the local ones, the one VM this machine traps for
svc(VMM, 0x97, function () { const h = ioh(this).get(this.cpu.edx.value & 0xffff); if (h) h.on = true; });
svc(VMM, 0x99, function () { const h = ioh(this).get(this.cpu.edx.value & 0xffff); if (h) h.on = false; });
// Install_Mult_IO_Handlers (EDI an I/O table: a word count, then each port's word and handler's dword): each port's
// handler installed as Install_IO_Handler installs one (VDD's VGA ports, 3B4h-3DFh); CF clear
svc(VMM, 0x95, function () {
  const t = u32(this.cpu.edi.value), n = this.r16(t);
  for (let i = 0; i < n; i++) ioh(this).set(this.r16(t + 2 + 6 * i), { fn: this.r32(t + 4 + 6 * i), on: true });
  CF(this, false);
});
/** a port access by VM code (ne16 portIO): the VxD's handler takes it when trapping is on. ECX the type (0 byte in,
 *  4 byte out, 8/0Ch word, 10h/14h dword), EAX the data; true if handled */
P.vxdTrapIO = function (port, size, isIn) {
  // (the VGA's ports, 3B0h-3DFh, are the display adapter's in the system VM: its display driver programs them, as
  // VDD lets it once the driver has registered (VDD_DRIVER_REGISTER), and VDD's traps are for the MS-DOS VMs, whose
  // machines take their own ports (v86.js). Trapped here, TSENG.DRV's and DIBENG's register writes went to VDD's
  // handlers, GDI's display failed to start (LogError 80), and USER and MSGSRV32 fell over after it)
  if (port >= 0x3b0 && port <= 0x3df) return false;
  const h = this.ioHandlers && this.ioHandlers.get(port); if (!h || !h.on || this.r0Depth) return false;
  const type = (isIn ? 0 : 4) | (size === 2 ? 8 : size === 4 ? 0x10 : 0), m = size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff;
  const r = this.vxdCall(h.fn, { eax: u32(this.cpu.eax.value) & m, ebx: this.sysVM(), ecx: type, edx: port, ebp: this.crs || (this.crs = this.alloc(0x60)) });
  if (isIn) this.cpu.eax.value = u32((this.cpu.eax.value & ~m) | (r.eax & m));
  return true;
};
/** an MS-DOS VM's access to a VGA port (v86.js o.vgaPort): the handler a VxD installed for it (VDD's), run as that
 *  VM (EBX its handle, EBP its client registers); the value read, or undefined when no VxD traps the port */
P.vmVgaIO = function (vm, port, size, isIn, eax) {
  const h = this.ioHandlers && this.ioHandlers.get(port); if (!h || (h.off && h.off.has(vm.cb))) return undefined;   // (h.on: the system VM's)
  const type = (isIn ? 0 : 4) | (size === 2 ? 8 : size === 4 ? 0x10 : 0), m = size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff;
  const cur = this.curVM; this.curVM = vm;
  try { return this.vxdCall(h.fn, { eax: u32(eax) & m, ebx: vm.cb, ecx: type, edx: port, ebp: vm.client }).eax & m; }
  finally { this.curVM = cur; }
};
// Simulate_IO (EAX data, EBX VM, ECX type, EDX port): the access as the hardware would take it
svc(VMM, 0x94, function () {
  const port = this.cpu.edx.value & 0xffff, type = this.cpu.ecx.value & 0xff, size = type & 0x10 ? 4 : type & 8 ? 2 : 1, isIn = !(type & 4);
  this.r0Out(() => { const h = this.ioHandlers && this.ioHandlers.get(port); const on = h && h.on; if (h) h.on = false; try { this.portIO(port, size, isIn); } finally { if (h) h.on = on; } });
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
  W.log('warn', 'vxd', `SHELL_Message: ${cap}: ${t}`); this.cpu.eax.value = 1; CF(this, false);
});

// ---- VXDLDR: LoadDevice (EDX file name, EAX flags: 1 send it SYS_DYNAMIC_DEVICE_INIT): EAX the DDB, EDX the device
// handle; a VxD the system bundle does not carry is a file the loader cannot open (3). UnloadDevice (EBX device id or
// EDX name)
const VXDLDR = 0x27;
svc(VXDLDR, 0x01, function () {
  const name = this.readA(u32(this.cpu.edx.value)) || '', v = this.cpu.eax.value & 1 ? this.vxdLoad(name) : this.vxd(name);
  if (!v) { this.cpu.eax.value = 3; CF(this, true); return; }
  this.cpu.eax.value = v.ddb; this.cpu.edx.value = this.vxdDeviceInfo(v); CF(this, false);
});
/** the loader's record of a VxD (struct DeviceInfo): DI_Next, DI_LoadCount, DI_DDB, DI_DeviceID, DI_ModuleName,
 *  DI_Signature, DI_ObjCount and DI_ObjInfo (one ObjectInfo: its image), the API entry points */
P.vxdDeviceInfo = function (v) {
  if (v.devInfo) { this.u8[v.devInfo + 4]++; return v.devInfo; }
  const a = v.devInfo = this.alloc(0x40), oi = a + 0x28, nm = a + 0x38;
  this.u8.fill(0, a, a + 0x40); this.u8[a + 4] = 1; this.w32(a + 8, v.ddb); this.w16(a + 0xc, v.id); this.w32(a + 0x10, nm);
  this.writeA(nm, v.name.slice(0, 7)); this.w32(a + 0x14, 0x52444c56); this.w32(a + 0x18, 1); this.w32(a + 0x1c, oi);
  this.w32(oi, v.base); this.w32(oi + 4, v.meta.size || 0x10000);
  return a;
};
// UnloadDevice (EBX device id, or -1 for the name at EDX): a VxD LoadDevice loaded drops one load; at none it gets
// SYS_DYNAMIC_DEVICE_EXIT and, agreeing, is gone (its image back as the file has it), so the next LoadDevice starts
// it afresh with SYS_DYNAMIC_DEVICE_INIT (VCOMM unloads a port driver when its last port closes, and loads it again
// on the next open). A device the loader did not load is not its to unload (VXDLDR_ERR_NO_SUCH_DEVICE, 8)
svc(VXDLDR, 0x02, function () {
  const id = this.cpu.ebx.value & 0xffff, name = id === 0xffff ? (this.readA(u32(this.cpu.edx.value)) || '').toUpperCase().replace(/^.*\\/, '') : null;
  const v = [...(this.vxds || new Map()).values()].find(x => x.inited && x.devInfo && (name ? x.file === name || x.file === name + '.VXD' || x.name.toUpperCase() === name : x.id === id));
  if (!v) { this.cpu.eax.value = 8; CF(this, true); return; }
  const n = this.u8[v.devInfo + 4]; if (n > 1) { this.u8[v.devInfo + 4] = n - 1; this.cpu.eax.value = 0; CF(this, false); return; }
  if (this.vxdControl(v, SYS_DYNAMIC_DEVICE_EXIT).cf) { this.cpu.eax.value = 9; CF(this, true); return; }   // VXDLDR_ERR_DEVICE_UNLOADABLE
  this.u8[v.devInfo + 4] = 0; v.inited = false;
  const d = window.W95SYSTEM.vxds[v.file]; if (d && d.imgBytes) this.u8.set(d.imgBytes, v.meta.base);
  this.cpu.eax.value = 0; CF(this, false);
});

// ---- PELDR: PE images at ring 0 (the NDIS miniports). _PELDR_AddExportTable(*ht, module, nFuncs, nNames, ordBase,
// names, ordinals, addrs, list): a module name other images import from (NDIS.SYS, HAL); _PELDR_LoadModuleEx(*hl,
// file, list, flags): the image loaded from the system bundle's recompiled drivers, its imports bound to those
// tables; _PELDR_GetEntryPoint(hl): its entry (DriverEntry); _PELDR_FreeModule(hl, list)
const peKey = n => n.toUpperCase().replace(/^.*\\/, '').replace(/\.(DLL|SYS)$/, '');
svc(VXDLDR, 0x0c, function (arg) {
  const t = this.peExports || (this.peExports = new Map()), name = peKey(this.readA(arg(1)) || ''), ex = new Map();
  const nf = arg(2), nn = arg(3), base = arg(4), names = arg(5), ords = arg(6), addrs = arg(7);
  for (let i = 0; i < nf; i++) ex.set('#' + (base + i), this.r32(addrs + 4 * i));
  for (let i = 0; i < nn; i++) ex.set(this.readA(this.r32(names + 4 * i)), this.r32(addrs + 4 * this.r16(ords + 2 * i)));
  t.set(name, ex); const h = this.alloc(8); this.w32(h, t.size);
  if (arg(0)) this.w32(arg(0), h); return 0;
});
svc(VXDLDR, 0x0d, function () { return 0; });                                                         // _PELDR_RemoveExportTable
svc(VXDLDR, 0x11, function (arg) {
  const file = (this.readA(arg(1)) || '').toUpperCase().replace(/^.*\\/, ''), d = ((window.W95SYSTEM || {}).drivers || {})[file];
  if (!d) return u32(-3);   // PELDR_ERR_FILE_UNABLETOOPEN
  const mods = this.peMods || (this.peMods = new Map());
  let m = mods.get(file);
  if (!m) {
    const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    d.bytes = d.bytes || b64(d.file); d.mod = d.mod || new WebAssembly.Module(b64(d.wasm));
    this.peResolve = (dll, nm) => { const t = this.peExports && this.peExports.get(peKey(dll)); return t ? t.get(nm) || 0 : 0; };
    m = this.loadImage(d.bytes, d.mod, d.meta, file); this.inits = this.inits.filter(x => x !== m); m.clock = true;
    mods.set(file, m); m.handle = this.alloc(8);
  }
  if (arg(0)) this.w32(arg(0), m.handle); return 0;
});
svc(VXDLDR, 0x07, function (arg) { return SVC[VXDLDR << 16 | 0x11].call(this, i => (i < 3 ? arg(i) : 0)); });   // _PELDR_LoadModule
svc(VXDLDR, 0x0a, function (arg) { const m = [...(this.peMods || new Map()).values()].find(x => x.handle === u32(arg(0))); return m ? m.meta.entry : 0; });
svc(VXDLDR, 0x0e, function () { return 0; });
svc(VXDLDR, 0x10, function () { return 0; });                                                        // _PELDR_InitCompleted

// ---- VKD: the keyboard as the VMM's keyboard device sees it. The keys reach Windows through its own driver; VKD sees
// each one first (P.vkdKey): a hot key a VxD defined calls it back, and in message mode (a blue screen) the keys go
// to the message-key queue instead. Define_Hot_Key (AL scan code, AH extended: FFh either, EBX the shift states that
// must be down (low word) among the ones compared (high word), CL flags (1 call on press), ESI callback, EDX ref): EAX
// the handle. VKD's shift state: 02h/200h left/right Shift, 04h/400h Ctrl, 08h/800h Alt, and 01h, 80h, 100h either one.
// A local hot key (CL 80h) works in the VMs it is enabled for (Local_Enable_Hot_Key): SHELL's are for MS-DOS
// programs' VMs, and the system VM gets none of them
const VKD = 0x0d;
svc(VKD, 0x01, function () {
  const h = this.alloc(16), hk = { scan: this.cpu.eax.value & 0xff, ext: (this.cpu.eax.value >> 8) & 0xff, want: this.cpu.ebx.value & 0xffff,
    mask: (this.cpu.ebx.value >>> 16) & 0xffff, flags: this.cpu.ecx.value & 0xf || 0xf, fn: u32(this.cpu.esi.value), ref: u32(this.cpu.edx.value), on: !(this.cpu.ecx.value & 0x80) };
  (this.hotKeys || (this.hotKeys = new Map())).set(h, hk); this.cpu.eax.value = h; CF(this, false);
});
svc(VKD, 0x02, function () { if (this.hotKeys) this.hotKeys.delete(u32(this.cpu.eax.value)); CF(this, false); });   // Remove_Hot_Key
const hotKey = p => p.hotKeys && p.hotKeys.get(u32(p.cpu.eax.value));
svc(VKD, 0x03, function () { const k = hotKey(this); if (k && u32(this.cpu.ebx.value) === this.sysVM()) k.on = true; CF(this, false); });    // Local_Enable_Hot_Key (EAX, EBX VM)
svc(VKD, 0x04, function () { const k = hotKey(this); if (k && u32(this.cpu.ebx.value) === this.sysVM()) k.on = false; CF(this, false); });   // Local_Disable_Hot_Key
svc(VKD, 0x07, function () { CF(this, false); });   // Force_Keys: the keys go to the VM (none here takes them)
svc(VKD, 0x08, function () { this.cpu.ebx.value = this.sysVM(); });   // Get_Kbd_Owner: the system VM
svc(VKD, 0x09, function () { CF(this, false); });   // Define_Paste_Mode
svc(VKD, 0x0a, function () { CF(this, true); });    // Start_Paste: nothing to paste into
svc(VKD, 0x0b, function () { CF(this, false); });   // Cancel_Paste
// Get_Msg_Key / Peek_Msg_Key: AL the scan code, AH the modifiers (02h Shift, 04h Ctrl, 08h Alt, 80h extended); ZF set
// when the queue is empty. Flush_Msg_Key_Queue empties it
svc(VKD, 0x0c, function () { const k = this.msgKeys && this.msgKeys.shift(); ZF(this, !k); if (k) this.cpu.eax.value = lo16(this.cpu.eax.value, k); });
svc(VKD, 0x0d, function () { const k = this.msgKeys && this.msgKeys[0]; ZF(this, !k); if (k) this.cpu.eax.value = lo16(this.cpu.eax.value, k); });
svc(VKD, 0x0e, function () { this.msgKeys = []; });
// Cancel_Hot_Key_State: the hot key's keys go on as they are. Reflect_Hot_Key (EBX the VM, CL the shift state): the
// callback hands the key it was called for on to the VM as an ordinary key (IFSMGR's Ctrl+C, which only notes the
// break), and its release with it
svc(VKD, 0x05, function () { CF(this, false); });
svc(VKD, 0x06, function () { this.hotReflected = true; CF(this, false); });
/** a key as the keyboard reports it (set 1 scan code, extended, released) with the shift states held: a hot key's
 *  callback (on press, as Define_Hot_Key asked), else in message mode the message-key queue. True when VKD took it;
 *  a hot key its callback reflected goes on, its press and its release */
P.vkdKey = function (scan, ext, up, mods) {
  const ss = (mods.shift ? 0x03 : 0) | (mods.ctrl ? 0x84 : 0) | (mods.alt ? 0x108 : 0);
  for (const [h, k] of this.hotKeys || []) {
    if (!k.on || k.scan !== scan || (k.ext !== 0xff && !!k.ext !== !!ext) || (ss & k.mask) !== k.want) continue;
    if (up && k.reflected) { k.reflected = false; return false; }
    if (!up && (k.flags & 1)) {
      this.hotReflected = false;
      this.r0Callback(k.fn, { eax: scan | (ext ? 0x100 : 0), ebx: h, ecx: 0, edx: k.ref, esi: 0 });
      if (this.hotReflected) { k.reflected = true; return false; }
    }
    return true;
  }
  if (!this.msgMode) return false;
  if (!up) (this.msgKeys || (this.msgKeys = [])).push(scan | ((mods.shift ? 2 : 0) | (mods.ctrl ? 4 : 0) | (mods.alt ? 8 : 0) | (ext ? 0x80 : 0)) << 8);
  return true;
};

// ---- VDD: the display in message mode, the text screen system-modal messages are written on (a blue screen): the
// VDD puts the adapter in its 80x25 text mode on Begin_Message_Mode and back on End_Message_Mode. Msg_ClrScrn (EAX the
// background): EAX columns, EDX rows; Msg_ForColor / Msg_BakColor (EAX the color); Msg_TextOut (ESI text, ECX length,
// EAX row, EDX column); Msg_SetCursPos (EAX row, EDX column)
const VDD = 0x0a;
P.textScreen = function () { return this.txt || (this.txt = { cols: 80, rows: 25, ch: new Uint8Array(2000), at: new Uint8Array(2000), fg: 7, bg: 0, cur: [0, 0], gen: 0 }); };
svc(VDD, 0x00, function () { this.cpu.eax.value = 0x400; CF(this, false); });   // VDD_Get_Version
svc(VDD, 0x01, function () {});                                                  // VDD_PIF_State
// VDD_Get_GrabRtn: ESI the routine that copies a VM's screen to the clipboard, which SHELL calls for Print Screen in
// a VM other than the system's: this machine has no other, so nothing to grab
svc(VDD, 0x02, function () {
  if (!W.API.VMMSVC) W.API.VMMSVC = {};
  if (!W.API.VMMSVC.VDDGRAB) W.API.VMMSVC.VDDGRAB = ['regs', function () { const sp = u32(this.cpu.esp.value), ret = this.r32(sp); this.cpu.esp.value = sp + 4; return ret; }];
  this.cpu.esi.value = this.thunkFor('VMMSVC', 'VDDGRAB');
});
svc(VDD, 0x04, function () {});                                                  // VDD_Set_VMType
svc(VDD, 0x07, function () { const t = this.textScreen(); t.bg = this.cpu.eax.value & 0xf; t.ch.fill(0x20); t.at.fill(t.bg << 4 | t.fg); t.gen++; this.cpu.eax.value = t.cols; this.cpu.edx.value = t.rows; });
svc(VDD, 0x08, function () { this.textScreen().fg = this.cpu.eax.value & 0xf; });
svc(VDD, 0x09, function () { this.textScreen().bg = this.cpu.eax.value & 0xf; });
svc(VDD, 0x0a, function () {
  const t = this.textScreen(), row = u32(this.cpu.eax.value), col = u32(this.cpu.edx.value), a = u32(this.cpu.esi.value), n = u32(this.cpu.ecx.value);
  for (let i = 0; i < n && col + i < t.cols && row < t.rows; i++) { const o = row * t.cols + col + i; t.ch[o] = this.u8[a + i]; t.at[o] = t.bg << 4 | t.fg; }
  t.gen++;
});
svc(VDD, 0x0b, function () { const t = this.textScreen(); t.cur = [u32(this.cpu.eax.value), u32(this.cpu.edx.value)]; t.gen++; });

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

// ---- VSD, the speaker, and VMD, the mouse, as VMM32 has them (version 3.0). VSD's bell sounds the PC speaker, which
// this machine has none of; its 3 takes the speaker's port (AL 1) and gives it back (AL 0), ENABLE's around its
// ToggleKeys clicks, and 2 does nothing. VMD's 2: EBX the VM that owns the mouse, the system's (ENABLE's MouseKeys)
const VSD = 0x0b, VMD = 0x0c;
svc(VSD, 0x00, function () { this.cpu.eax.value = 0x300; CF(this, false); });
svc(VSD, 0x01, function () {});
svc(VSD, 0x02, function () {});
svc(VSD, 0x03, function () { this.speakerTaken = this.cpu.eax.value & 0xff; CF(this, false); });
svc(VMD, 0x00, function () { this.cpu.eax.value = 0x300; CF(this, false); });
svc(VMD, 0x02, function () { this.cpu.ebx.value = this.sysVM(); });

// ---- V86MMGR (version 3.0Ah). Map_Pages (ESI linear, ECX size) puts a 32-bit buffer where V86 code can address it
// (EDI that address, ESI a handle for Free_Page_Map_Region), from a region of the first megabyte it maps pages into:
// one linear memory has no second mapping of a page, so a buffer already there is its own address and any other is
// what V86MMGR answers when the region is full (CF), and Get_Mapping_Info has that region empty (CH
// its pages, CL those free). Set_Mapping_Info sizes the region for VMs other than the system's
const V86MMGR = 6;
svc(V86MMGR, 0x00, function () { this.cpu.eax.value = 0x30a; CF(this, false); });
svc(V86MMGR, 0x04, function () {});
svc(V86MMGR, 0x05, function () { this.cpu.ecx.value = this.cpu.ecx.value & ~0xffff; });
svc(V86MMGR, 0x0d, function () {
  const lin = u32(this.cpu.esi.value), n = u32(this.cpu.ecx.value);
  if (!n) { this.cpu.edi.value = 0xffffffff; this.cpu.esi.value = 0xffff; CF(this, false); return; }
  if (lin + n <= 0x110000) { this.cpu.edi.value = lin; this.cpu.esi.value = 0; CF(this, false); return; }
  CF(this, true);
});
svc(V86MMGR, 0x0e, function () {});
// Allocate_V86_Pages (EBX the VM, ESI the memory wanted, EDI the least it takes, in KB as SHELL gives them from the
// program's properties: its last V86 page's end, 640, for all of it; ECX flags): EAX what its conventional memory has,
// the 640K below the video memory (a VM's DOS is the booted one's, its size fixed)
svc(V86MMGR, 0x01, function () {
  const v = this.vmOf(this.cpu.ebx.value); if (!v) { CF(this, true); return; }
  const want = u32(this.cpu.esi.value), least = u32(this.cpu.edi.value), have = 640;
  if (least !== 0xffffffff && least > have) { CF(this, true); return; }
  v.v86Pages = want === 0xffffffff ? have : Math.min(want, have); this.cpu.eax.value = v.v86Pages; CF(this, false);
});
// Set_EMS_XMS_Limits (EBX the VM, EAX/EDX EMS most and least KB, ESI/EDI XMS most and least KB, ECX flags): kept on the
// VM, whose XMS is its DOS's (the BIOS's)
svc(V86MMGR, 0x02, function () {
  const v = this.vmOf(this.cpu.ebx.value); if (!v) { CF(this, true); return; }
  v.limits = { ems: [u32(this.cpu.edx.value), u32(this.cpu.eax.value)], xms: [u32(this.cpu.edi.value), u32(this.cpu.esi.value)], flags: u32(this.cpu.ecx.value) };
  CF(this, false);
});

// ---- DOSMGR: what an MS-DOS VM runs. _DOSMGR_Set_Exec_VM_Data(VM, the program, its command tail, its folder), as
// SHELL gives them from the program's properties; DOSMGR_Copy_VM_Drive_State (EBX from, ESI to): the drives' current
// folders are Windows' own here (fs.js), shared by every VM; _DOSMGR_Exec_VM starts it. (DOSMGR_Get_Version answers
// as an absent device's does: IFSMgr takes the system VM's DOS through DOSMGR's other services when there is one)
const DOSMGR = 0x15;
svc(DOSMGR, 0x01, function (arg) {
  const v = this.vmOf(arg(0)), a = i => u32(arg(i)), s = i => (a(i) ? this.readA(a(i), 260) || '' : '');
  if (!v) return 0;
  const tail = a(1) ? [...this.u8.subarray(a(1), a(1) + Math.min(this.u8[a(1)], 126) + 2)] : [0, 13];   // (DOS's form: its length, the text, CR)
  v.exec = { tail, program: s(2), dir: s(3) };
  return 1;
});
svc(DOSMGR, 0x02, function () { CF(this, false); });
// _DOSMGR_Exec_VM(VM, its V86 pages, callback, reference): the program started in the VM, from its folder; the callback
// runs in the VM's context when the program has ended (vmEnd)
svc(DOSMGR, 0x03, function (arg) {
  const v = this.vmOf(arg(0)); if (!v || !v.m || !v.exec) return 0;
  v.execEnd = { fn: u32(arg(2)), ref: u32(arg(3)) }; v.m.ilog = [];
  if (v.exec.dir) v.m.vmCwd(v.exec.dir);
  v.m.vmExec(v.exec.program, v.exec.tail); v.started = true;
  return 1;
});

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
// the region and buffer services NDIS and LPT call (tools/staticmap.py): one address space, a region's physical address
// its linear one, contiguous, and the DMA buffer the region itself, so a copy to or from the buffer has nothing to do
svc(VDMAD, 0x09, function () { this.cpu.edx.value = this.cpu.esi.value; CF(this, false); });           // Lock_DMA_Region: EDX physical
svc(VDMAD, 0x0a, function () { CF(this, false); });                                                  // Unlock_DMA_Region
svc(VDMAD, 0x0c, function () { CF(this, false); });                                                  // Scatter_Unlock
// Scatter_Lock (EBX VM, EAX flags, EDI an extended DDS: +0 size, +4 linear, +8 selector, +0Ch entries available, +0Eh
// used, +10h the table): the region's physical pieces, (address, size) pairs, or with flag 1 a page table entry each
// page and ESI the offset in the first. Linear is physical here, so the region is one piece. EDX the entries used, ZF
// the whole region described (else its size is what the table holds), CF none
svc(VDMAD, 0x0b, function () {
  const d = u32(this.cpu.edi.value), sel = this.r16(d + 8), avail = this.r16(d + 0xc), size = this.r32(d);
  const lin = u32((sel ? SVC[VMM << 16 | 0x6e].call(this, i => [0, sel, 0][i]) : 0) + this.r32(d + 4));
  this.w16(d + 0xe, 0);
  if (!size || !avail || lin + size - 1 > 0xffffffff || (sel && lin === 0xffffffff)) { this.w32(d, 0); CF(this, true); return; }
  let used = 1;
  if (this.cpu.eax.value & 1) {
    const off = lin & 0xfff, pages = ((lin + size - 1) >>> 12) - (lin >>> 12) + 1; used = Math.min(pages, avail);
    for (let i = 0; i < used; i++) this.w32(d + 0x10 + 4 * i, u32(((lin >>> 12) + i) * 0x1000 | 7));
    if (used < pages) this.w32(d, used * 0x1000 - off);
    this.cpu.esi.value = off; ZF(this, used === pages);
  } else { this.w32(d + 0x10, lin); this.w32(d + 0x14, size); ZF(this, true); }
  this.w16(d + 0xe, used); this.cpu.edx.value = used; CF(this, false);
});
svc(VDMAD, 0x0d, function () { });                                                                   // Reserve_Buffer_Space
svc(VDMAD, 0x0e, function () { this.cpu.ebx.value = 1; this.cpu.edx.value = this.cpu.esi.value; CF(this, false); });   // Request_Buffer: EBX the id, EDX physical
svc(VDMAD, 0x0f, function () { CF(this, false); });                                                  // Release_Buffer
svc(VDMAD, 0x10, function () { CF(this, false); });                                                  // Copy_To_Buffer
svc(VDMAD, 0x11, function () { CF(this, false); });                                                  // Copy_From_Buffer
svc(VDMAD, 0x16, function () { });                                                                   // Set_EISA_Adr_Mode: an ISA machine
svc(VDMAD, 0x13, function () { CF(this, false); });                                                  // Disable_Translation
svc(VDMAD, 0x14, function () { CF(this, false); });                                                  // Enable_Translation
svc(VDMAD, 0x18, function () { const d = dmaOf(this); this.dmaChannel(d.ch).masked = true; });        // Phys_Mask_Channel
svc(VDMAD, 0x19, function () { const d = dmaOf(this); this.dmaChannel(d.ch).masked = false; });       // Phys_Unmask_Channel
svc(VDMAD, 0x1c, function () { const d = dmaOf(this); if (this.sound16) this.sound16(true); this.cpu.ecx.value = this.dmaChannel(d.ch).count; });   // Get_Phys_Count
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
/** CONFIGMG service n as ring-0 code calls it, with the arguments arg(i) gives (flat pointers); its CONFIGRET */
P.cmService = function (n, arg) { const fn = SVC[CONFIGMG << 16 | n]; if (!fn) throw new W.GuestError(`unimplemented CONFIGMG service ${n.toString(16)}h`); return u32(fn.call(this, arg)); };
svc(CONFIGMG, 0x03, function (arg) { const dn = this.cmNode(arg(1)); if (!dn) return CR.INVALID_DEVNODE; if (!dn.parent) return CR.NO_SUCH_DEVNODE; this.w32(arg(0), dn.parent.handle); return CR.SUCCESS; });   // Get_Parent
svc(CONFIGMG, 0x04, function (arg) { const dn = this.cmNode(arg(1)); if (!dn) return CR.INVALID_DEVNODE; const c = (dn.children || [])[0]; if (!c) return CR.NO_SUCH_DEVNODE; this.w32(arg(0), c.handle); return CR.SUCCESS; });   // Get_Child
svc(CONFIGMG, 0x08, function (arg) { const dn = this.cmNode(arg(1)); if (!dn) return CR.INVALID_DEVNODE; let d = 0; for (let x = dn; x.parent; x = x.parent) d++; this.w32(arg(0), d); return CR.SUCCESS; });   // Get_Depth
svc(CONFIGMG, 0x05, function (arg) {                                                                  // Get_Sibling
  const dn = this.cmNode(arg(1)); if (!dn || !dn.parent) return CR.INVALID_DEVNODE;
  const sib = dn.parent.children, n = sib[sib.indexOf(dn) + 1]; if (!n) return CR.NO_SUCH_DEVNODE; this.w32(arg(0), n.handle); return CR.SUCCESS;
});
// Create_DevNode(*dn, device ID, parent, flags): a devnode under the parent, its Enum key made
svc(CONFIGMG, 0x0b, function (arg) {
  const parent = this.cmNode(arg(2)); if (!parent) return CR.INVALID_DEVNODE;
  const id = (this.readA(arg(1)) || '').toUpperCase(), have = this.devnodes().find(d => d.id === id);
  if (have) { have.mark = true; this.w32(arg(0), have.handle); return 0x10; }   // CR_ALREADY_SUCH_DEVNODE (and it is found again: marked)
  const key = 'hklm\\enum\\' + id.toLowerCase(); W.regSet(key, null);
  const dn = { handle: 0xc1000000 + 0x100 * this.devnodes().length, id, key, cls: regStr(W.regGet(key, 'Class')), driver: regStr(W.regGet(key, 'Driver')), parent, children: [], created: true, mark: true };
  this.devnodes().push(dn); (parent.children = parent.children || []).push(dn);
  this.w32(arg(0), dn.handle); return CR.SUCCESS;
});
// Reset_Children_Marks(dn, flags) and Remove_Unmarked_Children(dn, flags): an enumerator's pass over a devnode's
// children, those it finds again (Create_DevNode) marked and the rest removed
svc(CONFIGMG, 0x35, function (arg) { const dn = this.cmNode(arg(0)); if (!dn) return CR.INVALID_DEVNODE; for (const c of dn.children || []) c.mark = false; return CR.SUCCESS; });
svc(CONFIGMG, 0x37, function (arg) {
  const dn = this.cmNode(arg(0)); if (!dn) return CR.INVALID_DEVNODE;
  const gone = (dn.children || []).filter(c => !c.mark); dn.children = (dn.children || []).filter(c => c.mark);
  const all = this.devnodes(); for (const c of gone) { const i = all.indexOf(c); if (i >= 0) all.splice(i, 1); }
  return CR.SUCCESS;
});
svc(CONFIGMG, 0x0f, function (arg) { const dn = this.cmNode(arg(0)); if (!dn) return CR.INVALID_DEVNODE; dn.enumerator = arg(1); return CR.SUCCESS; });   // Register_Enumerator
// Get/Set_Device_Driver_Private_DWord(dn, *dword | dword, flags): the DWORD a devnode's driver keeps with it
svc(CONFIGMG, 0x48, function (arg) { const dn = this.cmNode(arg(0)); if (!dn) return CR.INVALID_DEVNODE; this.w32(arg(1), dn.priv || 0); return CR.SUCCESS; });
svc(CONFIGMG, 0x49, function (arg) { const dn = this.cmNode(arg(0)); if (!dn) return CR.INVALID_DEVNODE; dn.priv = u32(arg(1)); return CR.SUCCESS; });
// Get_Bus_Info(dn, *busType, *size, info, flags): root-enumerated cards sit on no bus
svc(CONFIGMG, 0x44, function (arg) { const dn = this.cmNode(arg(0)); if (!dn) return CR.INVALID_DEVNODE; if (arg(1)) this.w32(arg(1), 0); if (arg(2)) this.w32(arg(2), 0); return CR.SUCCESS; });

// ---- CONFIGMG: logical configurations (BASIC 0, FILTERED 1, ALLOC 2, BOOT 3, FORCED 4) of resource descriptors.
// A card's requirements and assignment are the resources it decodes (P.cards): an IO_DES per port range, an IRQ_DES,
// a DMA_DES, the same in each list
const RES = { MEM: 1, IO: 2, DMA: 3, IRQ: 4 };
const cmObjs = p => p.cmObjs || (p.cmObjs = new Map());
const cmObj = (p, o) => { const h = p.alloc(8); o.handle = h; cmObjs(p).set(h, o); return o; };
// a resource descriptor: its handle is the address of its data, as CONFIGMG's are (VCOMM reads an IO_DES's base there)
const cmRd = (p, lc, rid, data) => { const h = p.alloc(Math.max(8, data.length)); p.u8.set(data, h); const o = { kind: 'rd', lc, rid, data, handle: h }; cmObjs(p).set(h, o); return o; };
P.cmLogConfs = function (dn, type) {
  dn.lcs = dn.lcs || {};
  if (dn.lcs[type]) return dn.lcs[type];
  const list = dn.lcs[type] = [];
  const hw = this.cards && this.cards().find(c => c.devnode === dn.id);
  if (hw && type !== 4) {
    const lc = cmObj(this, { kind: 'lc', dn, type, res: [] }); list.push(lc);
    // (a MEM_DES: count 0, MType_Range 14h, the window's first and last byte)
    for (const [b, n] of hw.mem || []) { const d = new Uint8Array(16), v = new DataView(d.buffer); v.setUint16(2, 0x14, true); v.setUint32(4, b, true); v.setUint32(8, b + n - 1, true); lc.res.push(cmRd(this, lc, RES.MEM, d)); }
    for (const [b, n] of hw.io) { const d = new Uint8Array(12), v = new DataView(d.buffer); v.setUint16(2, 12, true); v.setUint16(4, b, true); v.setUint16(6, b + n - 1, true); d[10] = 0xff; lc.res.push(cmRd(this, lc, RES.IO, d)); }
    for (const q of hw.irq) { const d = new Uint8Array(8), v = new DataView(d.buffer); v.setUint16(2, q, true); v.setUint16(4, 1 << q, true); lc.res.push(cmRd(this, lc, RES.IRQ, d)); }
    for (const c of hw.dma) { const d = Uint8Array.from([0, c, 1 << c, 0]); lc.res.push(cmRd(this, lc, RES.DMA, d)); }
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
  const rd = cmRd(this, lc, arg(2) & 0x7fff, this.u8.slice(arg(3), arg(3) + arg(4))); lc.res.push(rd);
  if (arg(0)) this.w32(arg(0), rd.handle); return CR.SUCCESS;
});
// Get_Next_Res_Des(*rd, log conf or res des, resource type (0 all), *resource, flags)
svc(CONFIGMG, 0x1f, function (arg) {
  const cur = cmObjs(this).get(u32(arg(1))); if (!cur) return 7;
  const lc = cur.kind === 'lc' ? cur : cur.lc, from = cur.kind === 'lc' ? 0 : lc.res.indexOf(cur) + 1, want = arg(2) & 0x7fff;
  const rd = lc.res.slice(from).find(r => !want || r.rid === want); if (!rd) return CR.NO_MORE_RES_DES;
  this.w32(arg(0), rd.handle); if (arg(3)) this.w32(arg(3), rd.rid); return CR.SUCCESS;
});
svc(CONFIGMG, 0x21, function (arg) { const rd = cmObjs(this).get(u32(arg(1))); if (!rd || rd.kind !== 'rd') return 8; this.w32(arg(0), rd.data.length); return CR.SUCCESS; });   // Get_Res_Des_Data_Size
svc(CONFIGMG, 0x22, function (arg) {                                                                  // Get_Res_Des_Data(rd, buf, len, flags)
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
// Write_Registry_Value(dn, subkey, name, type, buf, len, flags): VCOMM's, a port's settings under its devnode's key (a
// string to its terminating null)
svc(CONFIGMG, 0x3f, function (arg) {
  const dn = this.cmNode(arg(0)); if (!dn) return CR.INVALID_DEVNODE;
  const k = this.cmKey(dn, arg(1) && this.readA(arg(1)), arg(6)); if (!k) return CR.REGISTRY_ERROR;
  let data = this.u8.slice(arg(4), arg(4) + arg(5));
  if (arg(3) === 1) { const z = data.indexOf(0); if (z >= 0) data = data.slice(0, z + 1); }
  W.regSet('hklm\\' + k, (arg(2) && this.readA(arg(2))) || '', { type: arg(3), data }); return CR.SUCCESS;
});
// Set_DevNode_PowerState(dn, state, flags): a device state D0-D3 (1, 2, 4, 8); one it is in already answers at once,
// another goes to its driver as CONFIG_APM (8) with that state's subfunction (9 + 2 per state, + 1 with flag 1), and
// one it refuses is CR_FAILURE. VCOMM's, D0 as a port opens and D3 as it closes
svc(CONFIGMG, 0x64, function (arg) {
  const dn = this.cmNode(arg(0)), st = arg(1), fl = arg(2); if (!dn) return CR.INVALID_DEVNODE;
  if (st & ~0xf || fl & ~1) return 4;   // CR_INVALID_FLAG
  if (st & (st - 1)) return 0x1f;       // not one state
  if ((dn.power || 1) === st) return CR.SUCCESS;
  if (dn.handler && st) {
    const r = this.vxdCdecl(dn.handler, [8, 9 + 2 * Math.log2(st) + (fl & 1), dn.handle, dn.ref || 0, 0]);
    if ((r.eax & 0xffff) > 1) return CR.FAILURE;
  }
  dn.power = st; return CR.SUCCESS;
});

// ---- VMM: time. Get_System_Time: EAX the milliseconds since Windows started; Get_System_Time_Address: EAX the
// address of that count, which the timer keeps current
/** the system time, whole milliseconds since start: the clock time-outs and Get_System_Time share */
P.sysTime = function () { return Math.floor(this.now() - this.t0 + (this.timeSkew || 0)); };
/** ring 0 waits with nothing to run but a time-out: the clock moves on to it (no more than 10 s), as the processor would
 *  have idled until then; true if it did, or if one is already due */
P.r0Skip = function () {
  if (!this.vxdTimeOuts || !this.vxdTimeOuts.size) return false;
  const next = Math.min(...[...this.vxdTimeOuts.values()].map(t => t.due)), now = this.sysTime();
  if (next <= now) return true;   // one came due since the pump looked: it runs next
  if (next - now > 10000) return false;
  this.timeSkew = (this.timeSkew || 0) + (next - now); return true;
};
svc(VMM, 0x3f, function () { this.cpu.eax.value = u32(this.sysTime()); });
svc(VMM, 0x144, function () { if (!this.vmmTimeLin) this.vmmTimeLin = this.alloc(4); this.tick16(); this.cpu.eax.value = this.vmmTimeLin; });
// time-outs: Set_Global_Time_Out / Set_VM_Time_Out / Set_Async_Time_Out (EAX ms, ESI callback, EDX ref): ESI the handle.
// The callback gets EBX the VM, ECX how late it is, EDX the ref, EBP the client registers. Cancel_Time_Out (ESI)
// A time-out's or an event's handle is the VMM's token for it, no memory (the network's VxDs set thousands a minute)
const r0Handle = p => { p.r0Tokens = ((p.r0Tokens || 0) + 8) & 0x0ffffff8; return u32(0xf0000000 | p.r0Tokens || 8); };
const timeOut = function () {
  const q = this.vxdTimeOuts || (this.vxdTimeOuts = new Map()), h = r0Handle(this);
  q.set(h, { fn: u32(this.cpu.esi.value), ref: u32(this.cpu.edx.value), due: this.sysTime() + u32(this.cpu.eax.value) });
  this.cpu.esi.value = h; CF(this, false);
};
svc(VMM, 0x3c, timeOut); svc(VMM, 0x3d, timeOut); svc(VMM, 0xfe, timeOut);
svc(VMM, 0x3e, function () { if (this.vxdTimeOuts) this.vxdTimeOuts.delete(u32(this.cpu.esi.value)); });
// priority VM events: Call_Priority_VM_Event (EAX boost, EBX VM, ECX flags, EDX ref, ESI proc, EDI timeout): ESI the
// handle; the procedure runs with the VM (EBX, EDX the ref, EBP the client registers). Cancel_Priority_VM_Event (ESI)
svc(VMM, 0x14, function () {
  const q = this.vxdEvents || (this.vxdEvents = []), h = r0Handle(this);
  q.push({ fn: u32(this.cpu.esi.value), ref: u32(this.cpu.edx.value), handle: h, vm: u32(this.cpu.ebx.value) }); this.cpu.esi.value = h;
});
svc(VMM, 0x15, function () { if (this.vxdEvents) this.vxdEvents = this.vxdEvents.filter(e => e.handle !== u32(this.cpu.esi.value)); });
/** the time-outs that are due, run as the timer interrupt runs them */
P.vxdRunTimeOuts = function () {
  if (this.depth || (this.r0Runs && this.r0Runs.some(s => !(s.vm && s.wait))) || !this.vxdTimeOuts || !this.vxdTimeOuts.size) return;
  return this.asInterrupt(() => this.vxdRunTimeOutsIn());
};
P.vxdRunTimeOutsIn = function () {
  const now = this.sysTime();
  for (const [h, t] of [...this.vxdTimeOuts]) {
    if (now < t.due) continue;
    this.vxdTimeOuts.delete(h); this.tick16();
    const regs = { ebx: this.sysVM(), ecx: u32(now - t.due), edx: t.ref, esi: h, ebp: this.vmClientIdle() };
    if (this.runLevel) this.vxdCall(t.fn, regs);
    else if (this.r0Start(t.fn, regs) === null) return;   // it stopped (blocked, a blue screen): the rest once it is done
  }
};
/** the system VM's client registers as a VxD sees them between its slices: a Client_Reg_Struc */
P.vmClient = function () { if (this.curVM && this.curVM.client) return this.curVM.client; return this.crs || (this.crs = this.alloc(0x60)); };   // (a VM's own while it is the current one)
/** the client registers for an event or time-out run between slices: the VM stopped with its own 16-bit stack (SS:SP)
 *  for VxDs to call into it on */
P.vmClientIdle = function () {
  if (this.crsLevel > 0) return this.crs;   // a client's call is in progress (VM code called into a VxD): its registers, as they are
  const c = this.vmClient();
  if (!this.vmStackSel) { const a = this.alloc(0x4000); this.vmStackSel = this.allocSels(a, 0x4000); }
  this.u8.fill(0, c, c + 0x60);
  this.w32(c + 0x2c, 0x202); this.w32(c + 0x30, 0x3ff0); this.w32(c + 0x34, this.vmStackSel);
  return c;
};

// ---- VMM: running VM code from a VxD (nested execution). Begin_Nest_Exec; Simulate_Push (EAX: a word) and
// Simulate_Far_Call (ECX segment, EDX offset) build the call; Resume_Exec runs it with the client registers until it
// returns; End_Nest_Exec. Save_Client_State (EDI buffer) / Restore_Client_State (ESI buffer) copy the registers
svc(VMM, 0x8d, function () { this.u8.copyWithin(u32(this.cpu.edi.value), this.vmClient(), this.vmClient() + 0x60); });
svc(VMM, 0x8e, function () { this.u8.copyWithin(this.vmClient(), u32(this.cpu.esi.value), u32(this.cpu.esi.value) + 0x60); });
// Begin_Nest_Exec puts a protected-mode client on the VM's locked stack (unless it is on it already) and End_Nest_Exec
// gives it its own back, as the VMM's do: a VxD builds its call under the client's SS:SP. On the stack of the code it
// interrupted, VTDAPI's timer event wrote its callback's frame (and MMSYSTEM's callback ran) under WELCOME's SS:SP on
// DIBENG's 4Ah-byte blit stack: the line count at SS:0 written over, the blit's `dec dword ss:[0]` loop from 0, the
// first start's freeze
svc(VMM, 0x83, function () {
  if (this.curVM && this.curVM.m) { (this.nest = this.nest || []).push({ pushes: [], target: null, vm: this.curVM }); return; }   // (an MS-DOS VM's: in V86 mode on its own stack)
  const c = this.vmClient(), n = { pushes: [], target: null }, st = this.vmLockedStack();
  if ((this.r16(c + 0x34) & 0xffff) !== st.sel) { n.client = [this.r32(c + 0x30), this.r32(c + 0x34)]; this.w32(c + 0x30, st.sp); this.w32(c + 0x34, st.sel); }
  (this.nest = this.nest || []).push(n);
});
/** the VM's locked protected-mode stack (the selector and its top), where nested execution and events run its code */
P.vmLockedStack = function () {
  if (!this.vmStackSel) { const a = this.alloc(0x4000); this.vmStackSel = this.allocSels(a, 0x4000); }
  return { sel: this.vmStackSel, sp: 0x3ff0 };
};
svc(VMM, 0x82, function () { (this.nest = this.nest || []).push({ pushes: [], target: null, v86: true }); });   // Begin_Nest_V86_Exec
// (a push made after Simulate_Far_Call goes above the call's return frame, where the callee pops it first: VNETBIOS
// far-calls a `cli; retf` stub in V86 memory with the real-mode INT 5Ch vector pushed after the call, so the retf
// goes to the vector with the flags and the return pushed before it making its IRET frame)
svc(VMM, 0x4d, function () { const n = this.nest && this.nest[this.nest.length - 1]; if (n) (n.target ? n.after : n.pushes).push(['w', this.cpu.eax.value & 0xffff]); });
svc(VMM, 0x48, function () { const n = this.nest && this.nest[this.nest.length - 1]; if (n) { n.target = [this.cpu.ecx.value & 0xffff, this.cpu.edx.value & 0xffff]; n.after = []; } });
svc(VMM, 0x85, function () {
  const n = this.nest && this.nest[this.nest.length - 1];
  // the VM runs for a moment with nothing called (IFSMgr_Yield): what the processor would take meanwhile runs, the
  // interrupts and the time-outs and events that are due
  if (!n || !n.target) {
    if (this.msgMode && this.r0Stop()) return;   // a blue screen waiting for its key: the page's turn
    if (this.msgMode && this.msgWait) this.msgWait();   // (in a worker: its keys and its screen meanwhile)
    if (!this.r0Pump() && this.r0Skip()) this.r0Pump(); return;
  }
  this.tick16();
  // real-mode code the personality answers for (a DOS driver's entry, ne16 rmEntries): the words stay pushed on the
  // client's stack for the caller to pop, the function the last one pushed and a far pointer the two before it; DX:AX
  const rm = this.rmEntries && this.rmEntries.get(u32((n.target[0] << 16) | n.target[1]));
  if (rm) {
    const c = this.vmClient(), ss = this.r16(c + 0x34), w = n.pushes.map(([, v]) => v);
    let sp = this.r32(c + 0x30) & 0xffff; const base = u32(this.selBase(ss));
    for (const v of w) { sp = (sp - 2) & 0xffff; this.w16(base + sp, v); }
    this.w32(c + 0x30, (this.r32(c + 0x30) & 0xffff0000 | sp) >>> 0);
    const r = u32(rm(w[w.length - 1] || 0, u32(((w[w.length - 3] || 0) << 16) | (w[w.length - 2] || 0))));
    this.w32(c + 0x1c, (this.r32(c + 0x1c) & 0xffff0000 | (r & 0xffff)) >>> 0); this.w32(c + 0x14, (this.r32(c + 0x14) & 0xffff0000 | (r >>> 16)) >>> 0);
    n.target = null; n.pushes = []; return;
  }
  // (a V86 block's call, Begin_Nest_V86_Exec: real-mode code on the system VM's first megabyte, its segment a
  // paragraph. Run as protected-mode code, VNETBIOS's post stub's paragraph was taken for a selector of base 0, and
  // the call went to address 0 (SUWIN's fault as Windows 98 Setup saved its system files, NETBEUI's timer on its thread))
  if (n.v86 && !(this.curVM && this.curVM.m)) this.r0Out(() => this.rmFarCall(this.vmClient(), n.target[0], n.target[1], n.pushes, n.after || []));
  else this.r0Out(() => this.vmFarCall(this.vmClient(), n.target[0], n.target[1], [...n.pushes, ...(n.after || [])]));
  n.target = null; n.pushes = []; n.after = [];
});
/** a far call in real mode on the system VM's first megabyte, for a V86 nested execution block: the words pushed
 *  before the call, the return frame, then the words pushed after it, on the real-mode stack reflected real-mode code
 *  runs on (ne16.js rmReflect); the general registers from the client, and back into it as the code leaves them */
P.rmFarCall = function (c, seg, off, before = [], after = []) {
  const cpu = this.cpu, keep = {}; for (const k of Object.keys(cpu)) keep[k] = cpu[k].value;
  if (this.rmIvtInit) this.rmIvtInit();   // (the vector table in memory, for a call through a vector)
  const stack = this.rmStackGet(), ss = stack >>> 4, ret = stack + 0x10;   // (the return: an address no code is at, the stack's own first paragraph)
  const sreg = (s, b, v) => { cpu[s].value = v & 0xffff; cpu[b].value = (v & 0xffff) << 4; };
  let sp = 0xffe; const push = w => { sp -= 2; this.w16(stack + sp, w & 0xffff); };
  for (const [, v] of before) push(v);
  push(ss); push(0x10);
  for (const [, v] of after) push(v);
  const was = { v86: this.v86, hooks: this.v86Hooks, flags: this.v86Flags, rm: this.rmode };
  try {
    for (const [r, o] of CRS_REGS) cpu[r].value = this.r32(c + o);
    const fl = this.r32(c + 0x2c); for (const [f, b] of [['cf', 0], ['pf', 2], ['zf', 6], ['sf', 7], ['df', 10], ['of', 11]]) cpu[f].value = (fl >> b) & 1;
    sreg('ss', 'ssb', ss); cpu.esp.value = sp; sreg('ds', 'dsb', 0); sreg('es', 'esb', 0); sreg('fsel', 'fs', 0); sreg('gsel', 'gsb', 0); sreg('cs', 'csb', seg);
    this.v86 = 0; this.v86Hooks = N.RM_INTS; this.v86Flags = this.v86FlagsAt; this.rmode = true;
    this.rmRun(u32(cpu.csb.value + (off & 0xffff)), ret, `real-mode call ${seg.toString(16)}:${off.toString(16)}`);
    for (const [r, o] of CRS_REGS) this.w32(c + o, u32(cpu[r].value));
    let nf = fl & ~0x8d5; for (const [f, b] of [['cf', 0], ['pf', 2], ['zf', 6], ['sf', 7], ['df', 10], ['of', 11]]) nf |= (cpu[f].value & 1) << b; this.w32(c + 0x2c, u32(nf));
  } finally {
    Object.assign(this, { v86: was.v86, v86Hooks: was.hooks, v86Flags: was.flags, rmode: was.rm });
    for (const k of Object.keys(cpu)) cpu[k].value = keep[k];
  }
};
/** run a far call in the VM on its client registers (a Client_Reg_Struc): the words pushed and the return on the
 *  client's own stack (SS:SP), the general and data segment registers from it; afterwards its registers hold what the
 *  callee left, SP where its return left it */
P.vmFarCall = function (c, cs, ip, pushes = []) {
  const GP = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'], SG = [['cs', 'csb'], ['ds', 'dsb'], ['es', 'esb'], ['ss', 'ssb'], ['fsel', 'fs'], ['gsel', 'gsb']];
  const save = {}; for (const r of GP) save[r] = this.cpu[r].value; for (const [s, b] of SG) { save[s] = this.cpu[s].value; save[b] = this.cpu[b].value; }
  const savedEip = this.cpu.eip.value;
  const ss = this.r16(c + 0x34), ssb = u32(this.selBase(ss));
  let sp = this.r32(c + 0x30) & 0xffff;
  for (const [, v] of pushes) { sp = (sp - 2) & 0xffff; this.w16(ssb + sp, v); }
  sp = (sp - 2) & 0xffff; this.w16(ssb + sp, N.L.SENT); sp = (sp - 2) & 0xffff; this.w16(ssb + sp, 0);   // the return: the sentinel
  const sel = s => (this.selValid(s) ? s : 0);
  this.seg('ss', ss); this.cpu.esp.value = sp;
  this.seg('ds', sel(this.r16(c + 0x3c))); this.seg('es', sel(this.r16(c + 0x38)));
  for (const [r, o] of [['eax', 0x1c], ['ebx', 0x10], ['ecx', 0x18], ['edx', 0x14], ['esi', 4], ['edi', 0], ['ebp', 8]]) this.cpu[r].value = this.r32(c + o);
  this.seg('cs', cs); this.depth++;
  let r;
  try { r = this.runAt(u32(this.selBase(cs) + ip)); } finally { this.depth--; }
  if (r !== 0 || this.trapped) throw new W.GuestError(this.trapped || `VM call ${cs.toString(16)}:${ip.toString(16)} did not return`);
  for (const [rg, o] of [['eax', 0x1c], ['ebx', 0x10], ['ecx', 0x18], ['edx', 0x14], ['esi', 4], ['edi', 0], ['ebp', 8]]) this.w32(c + o, u32(this.cpu[rg].value));
  this.w32(c + 0x30, (this.r32(c + 0x30) & 0xffff0000 | (this.cpu.esp.value & 0xffff)) >>> 0);
  for (const r2 of GP) this.cpu[r2].value = save[r2]; for (const [s2, b] of SG) { this.cpu[s2].value = save[s2]; this.cpu[b].value = save[b]; }
  this.cpu.eip.value = savedEip;
};
svc(VMM, 0x86, function () {   // End_Nest_Exec: the client back on its own stack, if Begin_Nest_Exec moved it
  const n = this.nest && this.nest.pop();
  if (n && n.client) { const c = this.vmClient(); this.w32(c + 0x30, n.client[0]); this.w32(c + 0x34, n.client[1]); }
});
// Exec_Int (EAX the interrupt, EBX the VM): the interrupt run in the VM (its client registers, CB_Client_Pointer): the interrupt run in the VM inside a nested execution
// block, on the client's registers: what the personality answers for it (its INT 21h, 2Fh, ...), in real mode when
// the block is a V86 one (Begin_Nest_V86_Exec), its results left in the client registers
const CRS_REGS = [['edi', 0], ['esi', 4], ['ebp', 8], ['ebx', 0x10], ['edx', 0x14], ['ecx', 0x18], ['eax', 0x1c]];
P.vmInt = function (c, n, v86) {
  const keep = {}; for (const r of [...GPR, 'cf', 'zf']) keep[r] = this.cpu[r].value; for (const [sg, b] of SEGS) { keep[sg] = this.cpu[sg].value; keep[b] = this.cpu[b].value; }
  const rm = this.rmode;
  try {
    for (const [r, o] of CRS_REGS) this.cpu[r].value = this.r32(c + o);
    this.cpu.cf.value = this.r32(c + 0x2c) & 1; this.cpu.zf.value = (this.r32(c + 0x2c) >> 6) & 1;
    if (v86) { this.rmode = true; this.cpu.es.value = this.r16(c + 0x38); this.cpu.ds.value = this.r16(c + 0x3c); }
    else { const ok = sl => (this.selValid(sl) ? sl : 0); this.seg('es', ok(this.r16(c + 0x38))); this.seg('ds', ok(this.r16(c + 0x3c))); }
    const h = N.INTS[n]; let r;
    this.r0Out(() => { r = h ? h.call(this, W.LAYOUT.SENTINEL - 16) : undefined; });
    if (r === W.LAYOUT.SENTINEL || this.trapped) throw new W.GuestError(this.trapped || `Exec_Int ${n.toString(16)}h`);
    for (const [rg, o] of CRS_REGS) this.w32(c + o, u32(this.cpu[rg].value));
    this.w32(c + 0x2c, u32((this.r32(c + 0x2c) & ~0x41) | (this.cpu.cf.value & 1) | ((this.cpu.zf.value & 1) << 6)));
    this.w32(c + 0x38, this.cpu.es.value & 0xffff); this.w32(c + 0x3c, this.cpu.ds.value & 0xffff);
  } finally {
    this.rmode = rm;
    for (const r of [...GPR, 'cf', 'zf']) this.cpu[r].value = keep[r]; for (const [sg, b] of SEGS) { this.cpu[sg].value = keep[sg]; this.cpu[b].value = keep[b]; }
  }
};
// (the system VM is in V86 mode until the VxDs have initialized, as Windows' KERNEL has not yet switched it)
svc(VMM, 0x84, function () { if (this.curVM && this.curVM.m) { this.vmIntV86(this.curVM, this.cpu.eax.value & 0xff); return; } const n = this.nest && this.nest[this.nest.length - 1]; this.vmInt(this.r32(this.sysVM() + 8), this.cpu.eax.value & 0xff, !!(n && n.v86) || (this.vxdInitState !== undefined && this.vxdInitState < 0x40000000)); });
// Exec_VxD_Int (the interrupt pushed, the registers as the interrupt takes them, pointers flat): the VM's handler run on
// the VxD's registers, as a VxD calls DOS
svc(VMM, 0x8f, function () {
  const n = this.r32(u32(this.cpu.esp.value)) & 0xff; this.cpu.esp.value = u32(this.cpu.esp.value) + 4;
  const c = this.vxdIntCrs || (this.vxdIntCrs = this.alloc(0x60));
  for (const [r, o] of CRS_REGS) this.w32(c + o, u32(this.cpu[r].value));
  if (!this.flatSel) { this.flatSel = this.allocSels(0, 1); this.setDesc(this.flatSel, 0, 0xffffffff, 0xf300); }
  this.w32(c + 0x2c, 0x202); this.w32(c + 0x38, this.flatSel); this.w32(c + 0x3c, this.flatSel);
  this.vxdFlat = true; try { this.vmInt(c, n, false); } finally { this.vxdFlat = false; }
  for (const [r, o] of CRS_REGS) this.cpu[r].value = this.r32(c + o);
  this.cpu.cf.value = this.r32(c + 0x2c) & 1;
});

// ---- VMM: odds and ends
// Install_Exception_Handler(ESI: the VxD's Exception_Handler_Struc, a chain of code ranges with where a fault in each
// recovers): kept for a fault in ring-0 code to consult
svc(VMM, 0xef, function () { (this.r0ExcHandlers || (this.r0ExcHandlers = [])).push(u32(this.cpu.esi.value)); CF(this, false); });
svc(VMM, 0x6d, function () { return 0x000f; });                                                        // _GetAppFlatDSAlias: the ring-3 flat data selector (FLATDS, base 0, 4G)
svc(VMM, 0x6e, function (arg) { const sel = arg(1) & 0xffff; return this.selValid(sel) ? u32(this.selBase(sel)) : 0xffffffff; });   // _SelectorMapFlat(VM, sel, flags)
svc(VMM, 0x10c, function () { CF(this, false); });                                                   // Validate_Thread_Handle
svc(VMM, 0xf3, function () { this.cpu.esp.value = u32(this.cpu.esp.value) + 4; });                     // _Trace_Out_Service (debug output): it takes its string off the stack
svc(VWIN32, 0x0f, function (arg) { const e = this.r0Event(arg(0)); if (e) { this.signal(e); e.set = false; } return e ? 1 : 0; });   // _VWIN32_PulseWin32Event

// ---- VTD: the timer. Get_Version: EAX; Get_Interrupt_Period: EAX the ms between ticks (1: the host's clock);
// Begin/End_Min_Int_Period (EAX ms)
const VTD = 5;
svc(VTD, 0x00, function () { this.cpu.eax.value = 0x400; this.cpu.ebx.value = 1; this.cpu.ecx.value = 0x36; CF(this, false); });   // VTD_Get_Version: EBX and ECX the periods it can keep, 1 to 54 ms (VTDAPI's timeGetDevCaps)
svc(VTD, 0x02, function () { this.cpu.eax.value = 1; });
svc(VTD, 0x03, function () { CF(this, false); });
svc(VTD, 0x04, function () { CF(this, false); });

// ---------------------------------------------------------------- ring 0 that waits
// One processor runs everything here, so a VxD that blocks (a semaphore, an ID, a mutex someone holds) waits as the
// VMM's scheduler would let it: what can still run does (the hardware's interrupts, the events and time-outs that
// are due, the idle callbacks) until what it waits for happens. A wait nothing can end is the guest's deadlock
/** run what is pending at ring 0 once: true if anything ran */
P.r0Pump = function () { return this.asInterrupt(() => this.r0PumpIn()); };
P.r0PumpIn = function () {
  let ran = false;
  if (this.kernelApcs && this.kernelApcs.length) { const q = this.kernelApcs; this.kernelApcs = []; ran = true; for (const a of q) this.vxdCdecl(a.fn, [a.data]); }
  if (this.lanPoll && this.lanPoll()) ran = true;   // the network card's interrupt (lan.js)
  if (this.vxdTimeOuts && this.vxdTimeOuts.size) {
    const now = this.sysTime();
    for (const [h, t] of [...this.vxdTimeOuts]) {
      if (now < t.due || !this.vxdTimeOuts.has(h)) continue;
      this.vxdTimeOuts.delete(h); this.tick16(); ran = true;
      this.vxdCall(t.fn, { ebx: this.sysVM(), ecx: u32(now - t.due), edx: t.ref, esi: h, ebp: this.vmClientIdle() });
    }
  }
  // (the system VM's events; an MS-DOS VM's stays queued for the host's turn, vmEventRun, where it can stop)
  if (this.vxdEvents && this.vxdEvents.some(e => !this.vmEventVM(e))) {
    const q = this.vxdEvents; this.vxdEvents = q.filter(e => this.vmEventVM(e)); ran = true;
    for (const e of q) if (!this.vmEventVM(e) && !this.vmEventGone(e)) this.vxdCall(e.fn, { ebx: this.sysVM(), edx: e.ref, ebp: this.vmClientIdle(), esi: e.handle || 0 });
  }
  return ran;
};
/** a linear address as MODULE+offset, in the image that holds it */
P.r0Where = function (a) {
  a = u32(a || 0);
  let best = null;   // the image that starts nearest below it
  for (const m of this.modules || []) if (m.base && a >= m.base && (!best || m.base > best.base)) best = m;
  return best && a - best.base < 0x100000 ? `${best.name}+${(a - best.base).toString(16)}` : a.toString(16);
};
/** wait at ring 0 until `done()`: what is pending runs, and the clock moves on to the next time-out when nothing else can */
P.r0Wait = function (done, what) {
  const t0 = performance.now(), site = this.svcSite, frames = [];
  // the callers, through the frame pointers, for a deadlock's report
  for (let bp = u32(this.cpu.ebp.value), k = 0; k < 8 && bp && bp + 8 < this.u8.length; k++, bp = this.r32(bp)) frames.push(this.r0Where(this.r32(bp + 4)));
  // the interrupts held at the controller meanwhile are taken: a thread blocked at ring 0 waits with interrupts
  // enabled, and r0Pump polls the hardware as an interrupt (interrupts off), so the network card's interrupt for the
  // reply the redirector waits on was held there for good
  const held = () => {
    if (!this.irqPending) return false;
    const f = this.cpu.if, was = f ? f.value : 1; if (f) f.value = 1;
    try { return this.irqPending(); } finally { if (f) f.value = was; }
  };
  while (!done()) {
    if (this.trapped) throw new W.GuestError(this.trapped);
    if (this.r0Pump() || held()) continue;
    if (this.r0Idle && performance.now() - t0 <= 10000 && this.r0Idle()) continue;   // (in a worker: real time, the page's frames)
    if (!this.r0Skip() || performance.now() - t0 > 10000) {
      const next = this.vxdTimeOuts && this.vxdTimeOuts.size ? Math.min(...[...this.vxdTimeOuts.values()].map(t => t.due)) - this.sysTime() : null;
      // proven: nothing pending can end the wait, so the system is stuck there (the host's answer: win32.js hung)
      throw new W.HangError(`ring 0 deadlock: ${what} never comes (waiting at ${this.r0Where(site)}, thread ${this.currentThreadId ? this.currentThreadId() : 0}; called from ${frames.join(' < ')}; next time-out ${next === null ? 'none' : next + ' ms'})`);
    }
  }
};

// ---- VMM: semaphores (Create_Semaphore ECX tokens: EAX handle; Destroy, Wait (EAX, ECX flags), Signal (EAX))
const sems = p => p.vxdSems || (p.vxdSems = new Map());
svc(VMM, 0x25, function () { const h = this.alloc(8); sems(this).set(h, { n: this.cpu.ecx.value | 0 }); this.cpu.eax.value = h; CF(this, false); });
svc(VMM, 0x26, function () { sems(this).delete(u32(this.cpu.eax.value)); });
svc(VMM, 0x27, function () {
  const s = sems(this).get(u32(this.cpu.eax.value)); if (!s) return;
  this.r0Wait(() => s.n > 0, `semaphore ${u32(this.cpu.eax.value).toString(16)}`); s.n--;
});
svc(VMM, 0x28, function () { const s = sems(this).get(u32(this.cpu.eax.value)); if (s) s.n++; });
// _BlockOnID(id, flags): until _SignalID(id) (which wakes every thread blocked on it; a signal with none blocked is lost)
svc(VMM, 0xfa, function (arg) {
  const ids = this.r0Ids || (this.r0Ids = new Map()), id = u32(arg(0)), w = { woke: false };
  (ids.get(id) || ids.set(id, []).get(id)).push(w);
  if (this.r0Stop(() => w.woke)) return;   // a ring-0 run the host started: it waits off the host's stack
  this.r0Wait(() => w.woke, `_SignalID ${id.toString(16)}`);
});   // (the registers as they were: NDIS's EAX, the block it then tests)
svc(VMM, 0x127, function (arg) { const ids = this.r0Ids, l = ids && ids.get(u32(arg(0))); if (l) { for (const w of l) w.woke = true; ids.delete(u32(arg(0))); } });
// mutexes: _CreateMutex(boost, flags): EAX; _EnterMutex(h, flags), _LeaveMutex(h); one thread holds one, recursively
const mutexes = p => p.vxdMutexes || (p.vxdMutexes = new Map());
svc(VMM, 0x101, function () { const h = this.alloc(8); mutexes(this).set(h, { n: 0 }); return h; });
svc(VMM, 0x12e, function (arg) { const m = mutexes(this).get(u32(arg(0))); if (m) m.n++; });
svc(VMM, 0x12f, function (arg) { const m = mutexes(this).get(u32(arg(0))); if (m && m.n) m.n--; });
// the critical section: one holder, counted (Begin_Critical_Section ECX flags; End_Critical_Section)
svc(VMM, 0x1f, function () { this.vxdCrit = (this.vxdCrit || 0) + 1; });
svc(VMM, 0x20, function () { if (this.vxdCrit) this.vxdCrit--; });
// Get_Crit_Status_No_Block / Get_Crit_Status_Thread: ECX the claims, CF set when owned (EBX the owner), ZF set when
// unowned; unowned, EBX is the current VM, as its callers take it: IFSMGR compares it with its own when CF is set, and
// NETBEUI's time-out reads the VM's client registers through it when CF is clear ([EBX+8], then the client's flags).
// Given EBX 0, NETBEUI read a pointer from address 8, whatever a stray write had left there, and page-faulted
const critStatus = function () { const n = this.vxdCrit || 0; this.cpu.ecx.value = n; this.cpu.ebx.value = this.sysVM(); CF(this, n); ZF(this, !n); };
svc(VMM, 0xf1, critStatus);
// Get_Crit_Status_Thread: ECX the claims, and when there are any CF and EDI the thread that holds it (ring 0's work
// here is the current thread's); none, EDI the critical section itself, CF clear
svc(VMM, 0x145, function () {
  const n = this.vxdCrit || 0; this.cpu.ecx.value = n; CF(this, n); ZF(this, !n);
  this.cpu.edi.value = n ? this.r0Thread(this.currentThreadId()) : (this.r0CritLin || (this.r0CritLin = this.alloc(0x20)));
});
svc(VMM, 0x1a, function () {}); svc(VMM, 0x1b, function () {});                                      // Enable_VM_Ints, Disable_VM_Ints
svc(VMM, 0x1e, function () {});                                                                     // Adjust_Exec_Priority
svc(VMM, 0x38, function () { this.r0Pump(); });                                                      // Release_Time_Slice
svc(VMM, 0x161, function () { this.r0Pump(); });                                                     // Time_Slice_Sleep
svc(VMM, 0x39, function () {});                                                                     // Wake_Up_VM
svc(VMM, 0x36, function () { this.cpu.eax.value = 20; this.cpu.ecx.value = 1; this.cpu.esi.value = 0; });   // Get_Time_Slice_Info: 20 ms, one VM scheduled
// events: Cancel_Global_Event (ESI); Call_Restricted_Event (EAX boost, EBX VM, ECX flags, EDX ref, ESI proc, EDI
// time-out): ESI the handle, the procedure run when the VM can take it; Cancel_Restricted_Event (ESI)
svc(VMM, 0x12, function () { if (this.vxdEvents) this.vxdEvents = this.vxdEvents.filter((e, i) => e.handle !== u32(this.cpu.esi.value) && i + 1 !== u32(this.cpu.esi.value)); });
svc(VMM, 0x15a, function () { const q = this.vxdEvents || (this.vxdEvents = []), h = r0Handle(this); q.push({ fn: u32(this.cpu.esi.value), ref: u32(this.cpu.edx.value), handle: h }); this.cpu.esi.value = h; });
svc(VMM, 0x15b, function () { if (this.vxdEvents) this.vxdEvents = this.vxdEvents.filter(e => e.handle !== u32(this.cpu.esi.value)); });
// Call_When_Idle (ESI proc): run when the system is idle, until it returns carry clear; Cancel_Call_When_Idle (ESI)
svc(VMM, 0x3a, function () { (this.vxdIdle = this.vxdIdle || []).push(u32(this.cpu.esi.value)); CF(this, false); });
svc(VMM, 0x12b, function () { if (this.vxdIdle) this.vxdIdle = this.vxdIdle.filter(f => f !== u32(this.cpu.esi.value)); CF(this, false); });

// ---- VMM: threads. One VM and one thread at ring 0: the system VM's (Get_Initial/Next/Sys_Thread_Handle: EDI)
svc(VMM, 0x10a, function () { this.cpu.edi.value = this.r0Thread(this.currentThreadId()); });
svc(VMM, 0x10b, function () { ZF(this, true); });
svc(VMM, 0x10d, function () { this.cpu.edi.value = this.r0Thread(this.currentThreadId()); });
svc(VMM, 0x113, function () { this.cpu.edi.value = this.r0Thread(this.currentThreadId()); });
// _AllocateThreadDataSlot: EAX an offset into every thread's control block, whose first 100h bytes are the VMM's
svc(VMM, 0xff, function () { const at = this.thcbNext || 0x100; this.thcbNext = at + 4; return at; });
svc(VMM, 0x111, function () { return this.vxdInitState === undefined ? 0x50000000 : this.vxdInitState; });   // VMM_GetSystemInitState

// ---- VMM: SYSTEM.INI. Get_Profile_String (EDX default, ESI section or 0 for [386Enh], EDI key): EDX the string, CF
// when the key is absent; the number forms take EAX the default and return EAX, CF when absent, ZF when empty
const profile = p => {
  const sec = u32(p.cpu.esi.value) ? p.readA(u32(p.cpu.esi.value)) : '386Enh', key = p.readA(u32(p.cpu.edi.value));
  return W.iniGet(p.fs, 'SYSTEM.INI', sec, key);
};
svc(VMM, 0xb3, function () {
  const v = profile(this); if (v === null) { CF(this, true); return; }
  const a = this.alloc(v.length + 1); this.writeA(a, v); this.cpu.edx.value = a; CF(this, false);
});
const profNum = (parse) => function () {
  const v = profile(this); if (v === null) { CF(this, true); ZF(this, false); return; }
  if (!v.trim()) { CF(this, false); ZF(this, true); return; }
  const n = parse(v.trim()); if (n === null) { CF(this, true); return; } this.cpu.eax.value = u32(n); CF(this, false); ZF(this, false);
};
svc(VMM, 0xab, profNum(v => (/^-?\d+/.test(v) ? parseInt(v, 10) : null)));                           // Get_Profile_Decimal_Int
svc(VMM, 0xaf, profNum(v => (/^[0-9a-f]+/i.test(v) ? parseInt(v, 16) : null)));                       // Get_Profile_Hex_Int
svc(VMM, 0xad, profNum(v => (/^-?\d*\.?\d+/.test(v) ? Math.round(parseFloat(v) * 1000) : null)));     // Get_Profile_Fixed_Point (thousandths)
svc(VMM, 0xb1, profNum(v => (/^(1|on|yes|true)$/i.test(v) ? 0xffffffff : /^(0|off|no|false)$/i.test(v) ? 0 : null)));   // Get_Profile_Boolean
// Get_Config_Directory: EDX the Windows directory (with its backslash); Get_Exec_Path: EDX VMM32's path, ECX the
// length of its directory part
const lin = (p, k, s) => p[k] || (p[k] = (() => { const a = p.alloc(s.length + 1); p.writeA(a, s); return a; })());
svc(VMM, 0xb7, function () { this.cpu.edx.value = lin(this, 'cfgDirLin', 'C:\\WINDOWS\\'); this.cpu.ecx.value = 11; });   // (ECX: the characters up to the last backslash)
svc(VMM, 0xb6, function () { this.cpu.edx.value = lin(this, 'execPathLin', 'C:\\WINDOWS\\SYSTEM\\VMM32.VXD'); this.cpu.ecx.value = 'C:\\WINDOWS\\SYSTEM\\'.length; });
// OpenFile (EDX the name, EDI a buffer for the path found): the file found as DOS searches for it (the current
// directory, the Windows and system directories, the path), opened for reading: EAX its DOS handle
svc(VMM, 0xb8, function () {
  const name = this.readA(u32(this.cpu.edx.value)) || '', full = this.findFile16 && this.findFile16(name);
  const h = full ? this.dosOpen(full, 'r') : 0xffff;
  if (h === 0xffff) { CF(this, true); return; }
  if (u32(this.cpu.edi.value)) this.writeA(u32(this.cpu.edi.value), full.toUpperCase());
  this.cpu.eax.value = h; CF(this, false);
});
// Get_Machine_Info: EAX the DOS version (7.0), EBX the machine's flags (an ISA 486), ECX the BIOS model, EDX the equipment word
svc(VMM, 0xbb, function () { this.cpu.eax.value = 0x0700; this.cpu.ebx.value = 0x10000; this.cpu.ecx.value = 0xfc; this.cpu.edx.value = 0x0026; });
svc(VMM, 0x00, function () { this.cpu.eax.value = 0x0400; this.cpu.ecx.value = 0; CF(this, false); });   // Get_VMM_Version: 4.00
svc(VMM, 0xcf, function () { this.cpu.eax.value = u32(this.sysTime()); });                             // Get_Last_Updated_System_Time
svc(VMM, 0xb9, function () { this.cpu.eax.value = this.dosData ? this.dosData().pspSeg : 0; });     // Get_PSP_Segment: DOS's current PSP

// ---- VMM: memory the VMM accounts for (page counts) and V86 memory (conventional memory below 1 MB)
svc(VMM, 0x59, function () { this.cpu.edx.value = 0x2000; return 0x2000; });                         // _PageGetAllocInfo: 32 MB free
svc(VMM, 0x5a, function () { this.cpu.edx.value = 0x2000; return 0x2000; });                         // _GetFreePageCount
svc(VMM, 0x5b, function () { this.cpu.edx.value = 0x2000; return 0x100; });                             // _GetSysPageCount: EDX the system pages left (IFSMGR's), EAX 100h as the VMM's
svc(VMM, 0x5f, function () { return 0; });                                                            // _TestGlobalV86Mem: not global V86 memory
svc(VMM, 0x6b, function () { return 0x10; });                                                         // _GetFirstV86Page
svc(VMM, 0xd5, function () { return 0x9f; });                                                         // _GetLastV86Page
svc(VMM, 0x6c, function (arg) { return arg(0); });                                                    // _MapPhysToLinear: one address space
svc(VMM, 0x15d, function (arg) { return 1; });                                                        // _GetPhysPageInfo: present
svc(VMM, 0xa6, function () { return 1; });                                                            // _AddInstanceItem
const v86 = (p, n) => { const a = (p.dosTop + 15) & ~15; p.dosTop = a + ((n + 15) & ~15); p.u8.fill(0, a, a + n); return a; };
svc(VMM, 0xa8, function (arg) { return v86(this, arg(0)); });                                         // _Allocate_Global_V86_Data_Area(n, flags)
// _Allocate_Temp_V86_Data_Area(n, flags): one temporary area, which _Free_Temp_V86_Data_Area gives back
svc(VMM, 0xa9, function (arg) { if (!this.tempV86) this.tempV86 = v86(this, 0x10000); return arg(0) <= 0x10000 ? this.tempV86 : 0; });
svc(VMM, 0xaa, function () { return 1; });
// _PageReserve(page, n, flags): linear address space, not memory (the pages are committed later, _PageCommit): from
// the region VirtualAlloc reserves in (VMEM, above the layout), as a reservation; the heap only when that is full
// (VCACHE reserves 30 MB at boot, which took most of the 56 MB heap)
svc(VMM, 0x11d, function (arg) {
  const n = arg(1) * 4096, size = (n + 0xffff) & ~0xffff, end = this.mem.buffer.byteLength;
  if (this.vmTop !== undefined && this.vmTop + size <= end) { const b = this.vmTop; this.vmTop += size; (this.vregions || (this.vregions = new Map())).set(b, { size, heap: null }); return b; }
  const a = this.alloc(n + 4096); return (a + 4095) & ~4095;
});
svc(VMM, 0x11e, function (arg) { const a = arg(0) * 4096; this.u8.fill(0, a, a + arg(1) * 4096); return 1; });   // _PageCommit(page, n, ...)
svc(VMM, 0x11f, function () { return 1; });                                                            // _PageDecommit(page, n, flags): committed again zeroed (_PageCommit)
// _GetCurrentContext: the memory context in place, one address space here (a process's own image range is its view of
// the arena, win32.js arenaClaim, not a context of its own). _PageAttach(pagesrc, hcontext, pagedst, n) maps the
// source's pages at the destination too: one linear memory has no second mapping of a page, so 0, as the VMM answers
// a range it cannot attach (DSOUND's aliases of a hardware buffer)
svc(VMM, 0x157, function () { return this.r0Context || (this.r0Context = this.alloc(16)); });
svc(VMM, 0x125, function () { return 0; });
// _EnterMustComplete / _LeaveMustComplete: the current thread's count of must-complete sections, which hold off its
// termination; a thread here is not ended inside a VxD's call
svc(VMM, 0x135, function () {});
svc(VMM, 0x136, function () {});
svc(VMM, 0x17d, function (arg) { this.u8.copyWithin(arg(0), arg(1), arg(1) + arg(2)); return arg(0); });   // _lmemcpy
// Map_Lin_To_VM_Addr (EAX linear, ECX limit): CX:EDX a selector to it and offset 0
svc(VMM, 0x1d, function () { const s = this.allocSels(u32(this.cpu.eax.value), 1); this.setDesc(s, u32(this.cpu.eax.value), u32(this.cpu.ecx.value), 0xf300); this.cpu.ecx.value = lo16(this.cpu.ecx.value, s); this.cpu.edx.value = 0; CF(this, false); });

// ---- VMM: devices. Get_DDB (EAX device id, EDI name or 0): ECX the DDB, 0 if none
svc(VMM, 0x146, function () {
  const id = this.cpu.eax.value & 0xffff, nm = u32(this.cpu.edi.value) ? (this.readA(u32(this.cpu.edi.value), 8) || '').trim().toUpperCase() : null;
  const v = [...(this.vxds || new Map()).values()].find(x => x.inited && (id && id !== 0xffff ? x.id === id : x.name.toUpperCase() === nm));
  this.cpu.ecx.value = v ? v.ddb : 0; CF(this, !v);
});
// System_Control (EAX message, EBX VM, the rest as given): the message to every initialized VxD in turn
svc(VMM, 0x93, function () {
  const regs = { eax: u32(this.cpu.eax.value), ebx: u32(this.cpu.ebx.value), ecx: u32(this.cpu.ecx.value), edx: u32(this.cpu.edx.value), esi: u32(this.cpu.esi.value), edi: u32(this.cpu.edi.value) };
  // the devices that are the VMM's own here: the display enters and leaves message mode (VDD), and Reboot_Processor
  // pulses the keyboard controller's reset line (VKD): the machine restarts
  if (regs.eax === 0x10) { this.msgMode = true; this.msgKeys = []; if (this.host && this.host.msgMode) this.host.msgMode(true); }
  if (regs.eax === 0x11 || regs.eax === 0x2b) { this.msgMode = false; if (this.host && this.host.msgMode) this.host.msgMode(false); }
  if (regs.eax === 0x12) { if (this.host && this.host.reset) this.host.reset(); throw new W.GuestError('the processor was reset'); }
  // Create_VM is the VMM's to carry out (SHELL's VM for an MS-DOS program): EBX the new VM
  if (regs.eax === CREATE_VM) { const h = this.vmCreate(regs); if (!h) { CF(this, true); return; } this.cpu.ebx.value = h; CF(this, false); return; }
  for (const v of [...(this.vxds || new Map()).values()].filter(x => x.inited)) { const r = this.vxdCall(v.procs.control, regs); if (r.cf) { CF(this, true); return; } }
  CF(this, false);
});
// _Register_Win32_Services(ddb, table): the services ring-3 code calls by VxDCall (device << 16 | number) through
// VWIN32: the table's count, then { procedure, argument count } from +8
svc(VMM, 0x129, function (arg) { (this.w32Svcs || (this.w32Svcs = new Map())).set(this.r16(arg(0) + 6), u32(arg(1))); CF(this, false); });
/** a VxD's Win32 service called as KERNEL32 calls one (the ring-3 arguments after two dwords of VWIN32's) */
P.w32Svc = function (dev, n, args) {
  const t = this.w32Svcs && this.w32Svcs.get(dev); if (!t || n >= this.r32(t)) return null;
  return this.vxdCdecl(this.r32(t + 8 + 8 * n), [0, 0, ...args]);
};
// KERNEL32's Ctrl+Alt+Del: at start-up it gives REBOOT (Win32 service 0) the APC that puts up Close Program and the
// thread to run it on, and reports the dialog's state (service 1: 0 none, 2 coming, 3 up); REBOOT queues the APC on
// Ctrl+Alt+Del and shows its blue screen when the dialog does not come within its time
const REBOOT = 9, K32_TID = 0x3c;
P.k32RebootInit = function () {
  if (!this.w32Svcs || !this.w32Svcs.has(REBOOT)) return;
  this.w32Svc(REBOOT, 0, [this.thunkFor('KERNEL32', '__CloseProgram'), this.r0Thread(K32_TID)]);
  this.w32Svc(REBOOT, 1, [0]);
};
P.k32CloseState = function (n) { this.w32Svc(REBOOT, 1, [n]); };
/** the Close Program request REBOOT queued (its APC on KERNEL32's thread), taken once */
P.k32CloseRequest = function () { const q = this.apcQ && this.apcQ.get(K32_TID); return !!(q && q.length && q.splice(0).length); };
svc(VMM, 0x176, function () { return 1; });                                                          // _RegCreateDynKey: unsupported (ERROR_INVALID_FUNCTION)
// fatal errors stop the machine
svc(VMM, 0xbe, function () { throw new W.GuestError(`VxD fatal error: ${this.readA(u32(this.cpu.esi.value)) || ''}`); });
svc(VMM, 0xbf, function () { throw new W.GuestError('VxD fatal memory error'); });
// _LocalizeStackSprintf(table, id, inserts...): message `id` (its low 12 bits; 1-based) of a VxD's message table (a
// dword count, the strings' base, a word, then each message's offset from the base: message n's at +0Ah + 2n), its
// inserts (%1 .. %9, with an optional !printf format!) filled from the arguments that follow. The text goes on the
// caller's stack, below its arguments: ESP comes back pointing at a dword that is how far to move it to drop the text
// and the arguments (the caller's ADD ESP, [ESP]), the text after it; EAX the text
svc(VMM, 0x159, function () {
  const sp = u32(this.cpu.esp.value), tab = this.r32(sp), id = this.r32(sp + 4) & 0xfff;
  const n = this.r32(tab), base = this.r32(tab + 4);
  const fmt = id >= 1 && id <= n ? this.readA(u32(base + this.r16(tab + 0xa + 2 * id))) || '' : '';
  let args = 2;
  const text = fmt.replace(/%(\d)(?:!([^!]*)!)?/g, (m, k, f) => {
    k = +k; if (!k) return m; args = Math.max(args, k + 2);
    const v = this.r32(sp + 4 + 4 * k), c = f ? f.slice(-1) : 's';
    if (c === 's') return this.readA(v) || '';
    const w = f && /\.?(\d+)/.exec(f), t = c === 'd' ? String(v | 0) : c === 'u' ? String(u32(v)) : c === 'c' ? String.fromCharCode(v & 0xff) : u32(v).toString(16);
    return w ? t.padStart(+w[1], '0') : t;
  });
  const len = (text.length + 1 + 3) & ~3, nsp = sp - len - 4;
  this.writeA(nsp + 4, text, text.length + 1);
  this.w32(nsp, sp + 4 * args - nsp);
  this.cpu.esp.value = nsp; this.cpu.eax.value = nsp + 4;
});

// ---- VMM: the VM's interrupts. Protected-mode and V86 vectors VxDs set or hook are kept; the VM's own code reaches
// its interrupts through the personality (ne16 INTS), so a hook here sees only what a VxD reflects to it
const vec = p => p.vxdVecs || (p.vxdVecs = { pm: new Map(), v86: new Map(), hooks: new Map() });
// a vector no VxD has set leads to the personality's own handler for it (its DOS for 21h), as the VM's previous handler
// (ZF set when the vector is the default one, nothing having hooked it: IFSMGR asks of INT 24h's)
svc(VMM, 0x44, function () { const n = this.cpu.eax.value & 0xff, own = vec(this).pm.get(n), v = own || (N.INTS[n] ? this.thunk16For(`PMINT.#${n}`) : 0); this.cpu.ecx.value = lo16(this.cpu.ecx.value, v >>> 16); this.cpu.edx.value = v & 0xffff; ZF(this, !own); });   // Get_PM_Int_Vector: CX:EDX
for (const n of [0x21, 0x2f, 0x25, 0x26, 0x2a, 0x5c]) def16('PMINT', n, '', 'jmp', function () {   // an interrupt frame: IP, CS, flags
  const r = N.INTS[n] ? N.INTS[n].call(this, W.LAYOUT.SENTINEL - 16) : undefined;
  if (r === W.LAYOUT.SENTINEL) return r;
  const ssb = u32(this.cpu.ssb.value), sp = this.cpu.esp.value & 0xffff, ip = this.r16(ssb + sp), cs = this.r16(ssb + ((sp + 2) & 0xffff));
  this.cpu.esp.value = lo16(this.cpu.esp.value, sp + 6); this.seg('cs', cs); return u32(this.selBase(cs) + ip);
});
/** INT 21h as VM code issues it in protected mode, through the handler the file system manager installed (its PM
 *  vector): `regs` the registers, DS and ES a 64K transfer area (`vmXfer()`) whose offsets the pointers are; the
 *  registers it returns (with CF). It runs on a stack of its own: on the VM's locked stack, where nested execution
 *  starts at the top, an event while the redirector waited (VTDAPI's timer, SYSTEM.DRV's callback at SS:3FECh) wrote
 *  over the call's return frame, and the call came back at 0:28h */
P.vmXfer = function () { if (!this.xfer) { const a = this.alloc(0x10000); this.xfer = { lin: a, sel: this.allocSels(a, 0x10000) }; } return this.xfer; };
P.vmInt21 = function (regs) {
  const v = vec(this).pm.get(0x21); if (!v) throw new W.GuestError('no protected-mode INT 21h handler');
  const x = this.vmXfer(), c = this.vmInt21Crs || (this.vmInt21Crs = this.alloc(0x60));
  if (!this.vmInt21Sel) { const a = this.alloc(0x4000); this.vmInt21Sel = this.allocSels(a, 0x4000); }
  this.u8.fill(0, c, c + 0x60);
  for (const [r, o] of CRS_REGS) this.w32(c + o, u32(regs[r] || 0));
  this.w32(c + 0x30, 0x3ff0); this.w32(c + 0x34, this.vmInt21Sel); this.w32(c + 0x38, x.sel); this.w32(c + 0x3c, x.sel);
  this.tick16();
  this.r0Out(() => this.vmFarCall(c, v >>> 16, v & 0xffff, [['w', 0x202]]));
  const out = {}; for (const [r, o] of CRS_REGS) out[r] = this.r32(c + o);
  out.cf = this.cpu.cf.value & 1;
  return out;
};
svc(VMM, 0x45, function () { vec(this).pm.set(this.cpu.eax.value & 0xff, u32(((this.cpu.ecx.value & 0xffff) << 16) | (this.cpu.edx.value & 0xffff))); });
// (the V86 vectors are the system VM's table in its memory at linear 0 (ne16.js rmIvtInit), which VxDs read directly
// too; the map keeps what VxDs set, for the table's making when it comes later)
const v86Vec = (p, n) => (p.rmIvt ? p.r32(n * 4) : vec(p).v86.get(n) || 0);
svc(VMM, 0x42, function () { const v = v86Vec(this, this.cpu.eax.value & 0xff); this.cpu.ecx.value = lo16(this.cpu.ecx.value, v >>> 16); this.cpu.edx.value = v & 0xffff; });
svc(VMM, 0x43, function () { const n = this.cpu.eax.value & 0xff, v = u32(((this.cpu.ecx.value & 0xffff) << 16) | (this.cpu.edx.value & 0xffff)); vec(this).v86.set(n, v); if (this.rmIvt) this.w32(n * 4, v); });
// (141h, EAX the interrupt, EBX the VM: EAX that VM's vector as a far pointer, the rest as they were: IFSMGR's of 13h)
svc(VMM, 0x141, function () { this.cpu.eax.value = v86Vec(this, this.cpu.eax.value & 0xff); });
/** a real-mode interrupt in the system VM's V86 code (ne16.js rmInt) offered to the VxDs that hooked it
 *  (Hook_V86_Int_Chain), the last hook first, as the VMM offers it: EAX the interrupt, EBX the VM, EBP its client
 *  registers, which hold the processor's; a hook that clears CF has taken it, its client registers the result */
P.v86IntChain = function (n) {
  const list = vec(this).hooks.get(n); if (!list || !list.length) return false;
  const cpu = this.cpu, c = this.vmClient();
  for (const [r, o] of CRS_REGS) this.w32(c + o, u32(cpu[r].value));
  let fl = 0x20202; for (const [f, b] of FLAG_BITS) if (f !== 'if') fl |= (cpu[f].value & 1) << b;
  this.w32(c + 0x2c, fl); this.w32(c + 0x30, cpu.esp.value & 0xffff); this.w32(c + 0x34, cpu.ss.value & 0xffff);
  this.w32(c + 0x38, cpu.es.value & 0xffff); this.w32(c + 0x3c, cpu.ds.value & 0xffff); this.w32(c + 0x40, cpu.fsel.value & 0xffff); this.w32(c + 0x44, cpu.gsel.value & 0xffff);
  for (const h of list) {
    const r = this.vxdCall(h, { eax: n, ebx: this.sysVM(), ebp: c });
    if (r && r.cf) continue;
    for (const [rg, o] of CRS_REGS) cpu[rg].value = this.r32(c + o);
    const nf = this.r32(c + 0x2c); for (const [f, b] of FLAG_BITS) if (f !== 'if') cpu[f].value = (nf >> b) & 1;
    for (const [s, b, o] of [['es', 'esb', 0x38], ['ds', 'dsb', 0x3c]]) { const v = this.r16(c + o); cpu[s].value = v; cpu[b].value = v << 4; }
    return true;
  }
  return false;
};
svc(VMM, 0x41, function () { const h = vec(this).hooks, n = this.cpu.eax.value & 0xff; (h.get(n) || h.set(n, []).get(n)).unshift(u32(this.cpu.esi.value)); CF(this, false); });   // Hook_V86_Int_Chain
// callbacks: Allocate_PM_Call_Back / Allocate_V86_Call_Back (EDX ref, ESI proc): EAX a segment:offset that, called or
// jumped to, enters the procedure with EBX the VM, EDX the ref, EBP the client registers (CS:IP the callback itself)
svc(VMM, 0x0c, function () { const cbs = this.r0Callbacks || (this.r0Callbacks = []); cbs.push({ fn: u32(this.cpu.esi.value), ref: u32(this.cpu.edx.value) }); this.cpu.eax.value = this.thunk16For(`R0CB.#${cbs.length - 1}`); CF(this, false); });
svc(VMM, 0x0b, function () { const cbs = this.r0Callbacks || (this.r0Callbacks = []); cbs.push({ fn: u32(this.cpu.esi.value), ref: u32(this.cpu.edx.value), v86: true }); this.cpu.eax.value = 0xf000_0000 + cbs.length - 1; CF(this, false); });
for (let i = 0; i < 64; i++) def16('R0CB', i, '', 'jmp', function () { return this.vxdCallBack(this.r0Callbacks[i], `R0CB.#${i}`); });
/** a VM callback a VxD allocated, entered from VM code: the client registers as they are, CS:IP the callback */
P.vxdCallBack = function (cb, key) {
  const pool = this.crsPool || (this.crsPool = []), lvl = this.crsLevel = (this.crsLevel || 0) + 1;
  const outer = this.crs, c = this.crs = pool[lvl] || (pool[lvl] = this.alloc(0x60)), cpu = this.cpu;
  this.w32(this.sysVM() + 8, c);
  try {
    const at = this.thunk16For(key);
    let fl = 0x2; for (const [r, b] of [['cf', 0], ['pf', 2], ['af', 4], ['zf', 6], ['sf', 7], ['if', 9], ['df', 10], ['of', 11]]) if (cpu[r]) fl |= (cpu[r].value & 1) << b; else if (r === 'if') fl |= 0x200;
    const regs = [['edi', 0], ['esi', 4], ['ebp', 8], ['ebx', 0x10], ['edx', 0x14], ['ecx', 0x18], ['eax', 0x1c]];
    for (const [r, o] of regs) this.w32(c + o, u32(cpu[r].value));
    this.w32(c + 0x24, at & 0xffff); this.w32(c + 0x28, at >>> 16); this.w32(c + 0x2c, fl); this.w32(c + 0x30, cpu.esp.value & 0xffff); this.w32(c + 0x34, cpu.ss.value & 0xffff);
    this.w32(c + 0x38, cpu.es.value & 0xffff); this.w32(c + 0x3c, cpu.ds.value & 0xffff); this.w32(c + 0x40, cpu.fsel.value & 0xffff); this.w32(c + 0x44, cpu.gsel.value & 0xffff);
    this.vxdCall(cb.fn, { ebx: this.sysVM(), edx: cb.ref, ebp: c });
    for (const [r, o] of regs) cpu[r].value = this.r32(c + o);
    const nf = this.r32(c + 0x2c); for (const [r, b] of [['cf', 0], ['pf', 2], ['af', 4], ['zf', 6], ['sf', 7], ['if', 9], ['df', 10], ['of', 11]]) if (cpu[r]) cpu[r].value = (nf >> b) & 1;
    this.seg('es', this.r16(c + 0x38)); this.seg('ds', this.r16(c + 0x3c));
    this.seg('ss', this.r16(c + 0x34)); this.cpu.esp.value = lo16(this.cpu.esp.value, this.r32(c + 0x30));
    this.refreshSegs(); const rcs = this.r16(c + 0x28); this.seg('cs', rcs);
    return u32(this.selBase(rcs) + (this.r32(c + 0x24) & 0xffff));
  } finally { this.crsLevel--; this.crs = outer; this.w32(this.sysVM() + 8, this.vmClient()); }
};
// the client's stack and CS:IP (EBP the client registers): Simulate_Far_Jmp (CX:EDX), Simulate_Far_Ret, Simulate_Iret,
// Simulate_Pop (EAX), Build_Int_Stack_Frame (CX:EDX: the flags, CS and IP pushed, then there)
const cst = p => { const c = u32(p.cpu.ebp.value), ss = p.r16(c + 0x34), base = u32(p.selBase(ss)); return { c, base, get sp() { return p.r32(c + 0x30) & 0xffff; }, set sp(v) { p.w32(c + 0x30, (p.r32(c + 0x30) & 0xffff0000 | (v & 0xffff)) >>> 0); } }; };
const cpop = p => { const k = cst(p), v = p.r16(k.base + k.sp); k.sp = k.sp + 2; return v; };
const cpush = (p, v) => { const k = cst(p); k.sp = k.sp - 2; p.w16(k.base + k.sp, v); };
svc(VMM, 0x49, function () { const c = u32(this.cpu.ebp.value); this.w32(c + 0x28, this.cpu.ecx.value & 0xffff); this.w32(c + 0x24, this.cpu.edx.value & 0xffff); });
svc(VMM, 0x4a, function () { const c = u32(this.cpu.ebp.value); this.w32(c + 0x24, cpop(this)); this.w32(c + 0x28, cpop(this)); });
svc(VMM, 0x47, function () { const c = u32(this.cpu.ebp.value); this.w32(c + 0x24, cpop(this)); this.w32(c + 0x28, cpop(this)); const f = cpop(this); this.w32(c + 0x2c, (this.r32(c + 0x2c) & 0xffff0000 | f | 0x200) >>> 0); });
svc(VMM, 0x4e, function () { this.cpu.eax.value = cpop(this); });
svc(VMM, 0x4c, function () { const c = u32(this.cpu.ebp.value); cpush(this, this.r32(c + 0x2c) & 0xffff); cpush(this, this.r32(c + 0x28)); cpush(this, this.r32(c + 0x24)); this.w32(c + 0x28, this.cpu.ecx.value & 0xffff); this.w32(c + 0x24, this.cpu.edx.value & 0xffff); });
svc(VMM, 0x0d, function () { CF(this, true); });                                                    // Call_When_VM_Returns: no V86 returns to watch

// ---- VTD: Get_Real_Time: EDX:EAX in 838 ns ticks since start; Get_Date_And_Time: EAX ms since midnight, EDX days since 1 Jan 1980
svc(VTD, 0x07, function () { const t = Math.floor(this.sysTime() * 1193.182); this.cpu.eax.value = u32(t % 0x100000000); this.cpu.edx.value = u32(Math.floor(t / 0x100000000)); });
svc(VTD, 0x08, function () {
  const d = new Date(), mid = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  this.cpu.eax.value = u32(d - mid); this.cpu.edx.value = Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1980, 0, 1)) / 86400000);
});
// ---- VKD: Get_Version (the keyboard is Windows' own driver)
svc(VKD, 0x00, function () { this.cpu.eax.value = 0x400; CF(this, false); });
// ---- VPICD_Get_IRQ_Complete_Status (EAX handle): as Get_Complete_Status
svc(VPICD, 0x0b, function () { this.cpu.ecx.value = irqStatus(this); CF(this, !(this.cpu.ecx.value & 8)); });
// ---- VWIN32
svc(VWIN32, 0x00, function () { this.cpu.eax.value = 0x400; CF(this, false); });                     // VWIN32_Get_Version
svc(VWIN32, 0x0d, function () { return 0xc6000000 | 1; });                                          // VWIN32_GetCurrentProcessHandle
svc(VWIN32, 0x10, function (arg) { const e = this.r0Event(arg(0)); if (e) e.set = false; return e ? 1 : 0; });   // _VWIN32_ResetWin32Event
// _VWIN32_QueueKernelAPC(pfn, thread, data, flags): the ring-0 procedure called with the data when the thread next runs
svc(VWIN32, 0x19, function (arg) { (this.kernelApcs = this.kernelApcs || []).push({ fn: arg(0), data: arg(2) }); ZF(this, false); return 1; });   // (ZF from the result, which IFSMGR tests)
svc(VWIN32, 0x1a, function () { W.log('warn', 'vxd', 'VWIN32_SysErrorBox'); this.cpu.eax.value = 0; });
// ---- SHELL: SHELL_SYSMODAL_Message is the recompiled SHELL.VXD's (its blue screen when Windows cannot show the
// message); _SHELL_BroadcastSystemMessage: no window gets it here
svc(SHELL, 0x10, function () { return 0; });
// _SHELL_HookSystemBroadcast(callback, ref, order): a handle; _SHELL_UnhookSystemBroadcast(handle). The callbacks are
// kept for the broadcasts the system sends (SHELL_BroadcastSystemMessage's)
svc(SHELL, 0x11, function (arg) { const h = this.alloc(8); (this.sysbHooks || (this.sysbHooks = new Map())).set(h, { fn: arg(0), ref: arg(1), order: arg(2) }); return h; });
svc(SHELL, 0x12, function (arg) { if (this.sysbHooks) this.sysbHooks.delete(u32(arg(0))); });
// ---- CONFIGMG at ring 0, the rest the network's VxDs use
svc(CONFIGMG, 0x09, function (arg) { const dn = this.cmNode(arg(1)); if (!dn) return CR.INVALID_DEVNODE; this.w32(arg(0), dn.priv || 0); return CR.SUCCESS; });   // Get_Private_DWord(*v, dn, flags)
svc(CONFIGMG, 0x0a, function (arg) { const dn = this.cmNode(arg(0)); if (!dn) return CR.INVALID_DEVNODE; dn.priv = u32(arg(1)); return CR.SUCCESS; });         // Set_Private_DWord(dn, v, flags)
svc(CONFIGMG, 0x0c, function () { return CR.SUCCESS; });                                            // Query_Remove_SubTree
svc(CONFIGMG, 0x0d, function () { return CR.SUCCESS; });                                            // Remove_SubTree
svc(CONFIGMG, 0x32, function (arg) { (this.devLoaderDDBs = this.devLoaderDDBs || []).push(u32(arg(0))); return CR.SUCCESS; });   // Register_DevLoader(ddb, flags)
// Reenumerate_DevNode(dn, flags): its enumerator is told (CONFIG_ENUMERATE), and the children it made are started
svc(CONFIGMG, 0x33, function (arg) {
  const dn = this.cmNode(arg(0)); if (!dn) return CR.INVALID_DEVNODE;
  if (dn.enumerator) this.vxdCdecl(dn.enumerator, [5, 0, dn.handle, dn.handle, 0]);   // CONFIG_ENUMERATE
  for (const c of [...(dn.children || [])]) this.cmProcess(c);
  return CR.SUCCESS;
});
// Call_At_Appy_Time(pfn, refData, flags): as _SHELL_CallAtAppyTime
svc(CONFIGMG, 0x4e, function (arg) { this.appyCall(arg(0), arg(1)); return CR.SUCCESS; });
svc(CONFIGMG, 0x54, function () { return CR.FAILURE; });                                              // Call_Enumerator_Function: none registered
svc(CONFIGMG, 0x58, function () { return CR.SUCCESS; });                                            // Broadcast_Device_Change_Message
// ---- IOS, the block-device subsystem: IOS_Requestor_Service (an IRS: IRS_func, IRS_result, bytes, then the request's
// fields, IRS_drv the drive at 2): no block devices are IOS's here (the disks are the shell's), so every request finds
// none. (Answered as an ISP's word result at 2, it wrote over IFSMGR's drive letter: IFSMGR took drive 10h-41h for
// one of IOS's and wrote its current-directory entry, "\x10:\", through the end of its CDS table, at address 0)
const IOS = 0x10;
svc(IOS, 0x00, function () { this.cpu.eax.value = 0x400; CF(this, false); });
svc(IOS, 0x08, function (arg) { this.u8[u32(arg(0)) + 1] = 0x10; });   // IRS_result: IORS_INVALID_COMMAND
// ---- a service of a device that is not loaded: its Get_Version (service 0) answers CF set, as the VMM's default
// handler does, so a VxD can ask whether another one is there
P.absentService = function (dev, n) {
  if (dev === 0x40 && n === 0x6f) { this.cpu.eax.value = 1; return true; }   // IFSMgr's volume lock query with no IFSMgr: no lock to report
  if (n !== 0) return false; this.cpu.eax.value = 0; CF(this, true); return true;
};

// ---------------------------------------------------------------- static VxDs
// the ones VMM32 loads at boot (VTDAPI: the timer API for MMSYSTEM and WINMM), given Sys_Critical_Init, Device_Init
// and Init_Complete before Windows starts. The system's machine (host.lan) has the network's too: the file system
// manager and its cache and PERF, which VMM32 carries, and each one a Services\VxD key names (StaticVxD), every VxD
// given each message in turn in the order of their DDBs' Init_Order
const STATIC_VXDS = ['VDD.VXD', 'VTDAPI.VXD', 'ENABLE.VXD', 'SHELL.VXD', 'REBOOT.VXD', 'VCOMM.VXD'], VMM32_NET = ['IFSMGR.VXD', 'VCACHE.VXD', 'PERF.VXD'];
P.vxdStatics = function () {
  const files = [...STATIC_VXDS];
  if (this.host && this.host.lan) {   // (the system's machine, which has the network stack as Windows does)
    files.push(...VMM32_NET);
    const k = 'hklm\\system\\currentcontrolset\\services\\vxd';
    for (const d of W.regKids(k)) for (const f of regStr(W.regGet(`${k}\\${d}`, 'StaticVxD')).split(',').map(x => x.trim().toUpperCase()).filter(Boolean)) if (!files.includes(f)) files.push(f);
  }
  return files;
};
P.vxdBoot = function () {
  if (this.vxdBooted) return; this.vxdBooted = true;
  this.init16();
  const vs = this.vxdStatics().map(f => this.vxd(f)).filter(Boolean).sort((a, b) => this.r32(a.ddb + 0x14) - this.r32(b.ddb + 0x14));
  for (const v of vs) v.inited = true;
  const failed = new Set();
  for (const msg of [0, 1, 2]) for (const v of vs) {
    this.vxdInitState = [0, 0x10000000, 0x20000000][msg];
    if (failed.has(v)) continue;
    const r = this.vxdControl(v, msg);
    if (this.trapped) { W.log('warn', 'vxd', `${v.file} system control ${msg}: ${this.trapped}`); return; }
    if (r.cf) { W.log('warn', 'vxd', `${v.file} failed system control ${msg}`); failed.add(v); v.inited = false; }
  }
  this.vxdInitState = 0x40000000;
  this.k32RebootInit();
  // the devnodes, started as CONFIGMG starts them at boot: those whose device loader is a static VxD (DevLoader=*name:
  // NDIS for the network's, VCOMM for the ports), then those whose loader it loads (MMDEVLDR for the MEDIA devnodes,
  // whose API MMSYSTEM calls as MSGSRV32 has it start its devices, DriverProc 800h)
  this.vxdDevLoaders(true);
  if (window.W95SYSTEM.vxds && window.W95SYSTEM.vxds['MMDEVLDR.VXD']) this.vxdDevLoaders();
};

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
  // a client register structure per nested call: VM code the VxD runs (an interrupt it reflects) may call in again
  const pool = this.crsPool || (this.crsPool = []), lvl = this.crsLevel = (this.crsLevel || 0) + 1;
  const outer = this.crs, c = this.crs = pool[lvl] || (pool[lvl] = this.alloc(0x60)), cpu = this.cpu;
  // CB_Client_Pointer and the calling thread's (its TCB's): the registers of the client being served
  const th = this.r0Thread(this.currentThreadId()), thWas = this.r32(th + 0x10);
  this.w32(this.sysVM() + 8, c); this.w32(th + 0x10, c);
  try { return this.vxdPmApiOn(v, c, cpu); } finally { this.crsLevel--; this.crs = outer; this.w32(this.sysVM() + 8, this.vmClient()); this.w32(th + 0x10, thWas); }
};
P.vxdPmApiOn = function (v, c, cpu) {
  const ss = cpu.ss.value & 0xffff, sp = cpu.esp.value & 0xffff, ssb = u32(cpu.ssb.value), ip = this.r16(ssb + sp), cs = this.r16(ssb + sp + 2);
  let fl = 0x2; for (const [r, b] of [['cf', 0], ['pf', 2], ['af', 4], ['zf', 6], ['sf', 7], ['if', 9], ['df', 10], ['of', 11]]) if (cpu[r]) fl |= (cpu[r].value & 1) << b; else if (r === 'if') fl |= 0x200;
  const regs = [['edi', 0], ['esi', 4], ['ebp', 8], ['ebx', 0x10], ['edx', 0x14], ['ecx', 0x18], ['eax', 0x1c]];
  for (const [r, o] of regs) this.w32(c + o, u32(cpu[r].value));
  this.w32(c + 0x24, ip); this.w32(c + 0x28, cs); this.w32(c + 0x2c, fl); this.w32(c + 0x30, sp + 4); this.w32(c + 0x34, ss);
  this.w32(c + 0x38, cpu.es.value & 0xffff); this.w32(c + 0x3c, cpu.ds.value & 0xffff); this.w32(c + 0x40, cpu.fsel.value & 0xffff); this.w32(c + 0x44, cpu.gsel.value & 0xffff);
  this.vxdCall(v.procs.pm, { ebx: this.sysVM(), ebp: c });
  for (const [r, o] of regs) cpu[r].value = this.r32(c + o);
  const nf = this.r32(c + 0x2c); for (const [r, b] of [['cf', 0], ['pf', 2], ['af', 4], ['zf', 6], ['sf', 7], ['if', 9], ['df', 10], ['of', 11]]) if (cpu[r]) cpu[r].value = (nf >> b) & 1;
  this.seg('es', this.r16(c + 0x38)); this.seg('ds', this.r16(c + 0x3c));
  // back to the client's CS:IP and SS:SP as the client registers have them (the return was taken on the way in,
  // and VM code the VxD ran in between may have used the stack below it)
  this.seg('ss', this.r16(c + 0x34)); this.cpu.esp.value = lo16(this.cpu.esp.value, this.r32(c + 0x30));
  this.refreshSegs(); const rcs = this.r16(c + 0x28); this.seg('cs', rcs);
  return u32(this.selBase(rcs) + (this.r32(c + 0x24) & 0xffff));
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
/** the devnodes' device loaders run as Windows 95's configuration manager runs them, for the ROOT devnodes whose
 *  loader is a static VxD (statics: DevLoader=*name, NDIS for the network card's) or one loaded for it (MMDEVLDR.VXD for
 *  the MEDIA devnodes, at appy time) */
P.vxdDevLoaders = function (statics) {
  for (const dn of [...this.devnodes()]) {
    if (dn.created) continue;
    const sw = this.devSoftKey(dn), dl = sw && regStr(W.regGet(sw, 'DevLoader'));
    if (!dl || dl.startsWith('*') !== !!statics) continue;
    if (statics && ![...(this.vxds || new Map()).values()].some(x => x.inited && x.name.toUpperCase() === dl.slice(1).toUpperCase())) continue;   // (its VxD is another machine's: NDIS is the network's)
    this.cmProcess(dn);
  }
};
/** a devnode configured as CONFIGMG configures one: its device loader is sent PNP_NEW_DEVNODE (DLVXD_LOAD_DEVLOADER),
 *  its driver CONFIG_START, then its enumerator CONFIG_ENUMERATE, and each child that makes is configured in turn */
const CONFIG_ENUMERATE = 5;
P.cmProcess = function (dn) {
  if (dn.dlDone) return; dn.dlDone = true;
  const sw = this.devSoftKey(dn), dl = sw && regStr(W.regGet(sw, 'DevLoader'));
  if (dl) {
    const v = dl.startsWith('*') ? [...(this.vxds || new Map()).values()].find(x => x.inited && x.name.toUpperCase() === dl.slice(1).toUpperCase()) : this.vxdLoad(dl);
    if (!v) { W.log('warn', 'vxd', `${dn.id}: no device loader ${dl}`); return; }
    const r = this.vxdControl(v, PNP_NEW_DEVNODE, { ebx: dn.handle, edx: DLVXD_LOAD_DEVLOADER });
    if (r.eax && !dn.handler) { W.log('warn', 'vxd', `${dl} PNP_NEW_DEVNODE ${dn.id}: ${r.eax.toString(16)}`); return; }   // a CONFIGRET in EAX
  }
  this.cmStart(dn);
  if (dn.started && dn.enumerator) this.vxdCdecl(dn.enumerator, [CONFIG_ENUMERATE, 0, dn.handle, dn.handle, 0]);
  for (const c of [...(dn.children || [])]) this.cmProcess(c);
};
/** CONFIG_START to the devnode's registered driver (and its children's), its resources assigned: the first start, as
 *  the configuration manager starts devices while Windows boots (CONFIG_START_FIRST_START); CR_SUCCESS or CR_DEFAULT
 *  (the default action, which is the start) started it */
const CONFIG_START = 1, CONFIG_START_FIRST_START = 1;
P.cmStart = function (dn) {
  if (dn.started) return;
  if (dn.handler) { dn.started = true; const r = this.vxdCdecl(dn.handler, [CONFIG_START, CONFIG_START_FIRST_START, dn.handle, dn.ref || 0, 0]); dn.started = (r.eax & 0xffff) <= 1; }
  else dn.started = true;
  if (dn.started) this.cmDynData(dn);
  for (const c of dn.children || []) if (c.handler) this.cmStart(c);
};
/** a started devnode in HKEY_DYN_DATA\Config Manager\Enum, as CONFIGMG lists the live ones (key: the devnode handle):
 *  its hardware key, status and problem, which SPOOLSS walks for the ports (Class Ports, PortName) */
P.cmDynData = function (dn) {
  const k = 'hkdd\\config manager\\enum\\' + (dn.handle >>> 0).toString(16).toUpperCase().padStart(8, '0'), dw = v => ({ type: 4, data: new Uint8Array([v & 0xff, v >> 8 & 0xff, v >> 16 & 0xff, v >>> 24]) });
  W.regSet(k, 'HardWareKey', { type: 1, data: window.W95FS.encode(dn.id + '\0') });
  W.regSet(k, 'Status', dw(0x0a | 8)); W.regSet(k, 'Problem', dw(0));
};
})();
