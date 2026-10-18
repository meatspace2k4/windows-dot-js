'use strict';
// A machine of Windows 95's in a worker of its own: the processor, its memory (shared, so the page reads the screen
// from it) and everything the recompiled system runs on (win32.js, ne16.js, vmm.js, sound.js, dyn.js). The page keeps
// the shell, the windows it draws for the machine's and the file system; the worker reaches the file system through the
// page synchronously (bridge.js), and takes the page's input from its ring between instructions, as interrupts. Nothing
// the guest does here, a loop that never ends included, holds the page.
self.window = self;
// the Ethernet segment as this worker has it: its own stations (the card, in the network's machine), and the rest of the
// segment on the page (the other computer, lanhost.js; other machines' cards), frames passing both ways
self.W95LAN = { stations: new Set(), frames: 0 };
importScripts('bridge.js', 'fs.js', 'win32.js', 'gl.js', 'shell32.js', 'system.js', 'ne16.js', 'vmm.js', 'sound.js', 'lan.js', 'parallel.js', 'netfs.js', 'dyn.js');
const B = self.W95Bridge, W = self.W95Win32, { FSError, join, basename, extname } = self.W95FS;
const b64bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const post = (m, tr) => self.postMessage(m, tr || []);

// ---------------------------------------------------------------- the page, called synchronously
let rpcSab = null;
const mkErr = v => v.name === 'FSError' ? Object.assign(new FSError(v.code, v.path), { message: v.message }) : Object.assign(new Error(v.message), { name: v.name, code: v.code });
function rpc(target, method, args = []) {
  const ctl = new Int32Array(rpcSab, 0, 4);
  Atomics.store(ctl, 0, 1);
  post({ t: 'rpc', target, method, args });
  while (Atomics.load(ctl, 0) === 1) Atomics.wait(ctl, 0, 1);
  const r = B.take(rpcSab, mkErr); Atomics.store(ctl, 0, 0);
  if (r && r.$err) throw r.e;
  if (r instanceof Error) throw r;
  return r;
}
// the network's drives and shares, as this machine reaches them: through the network's machine (its redirector), in a
// worker of its own, called synchronously over a channel the page set up between the two (netLink); a file system of
// their own here (fs.js's remote volumes), whose descriptors are numbered apart from the page's
let netLink = null;
function netCall(key, op, args) {
  if (!netLink) throw new FSError(53, key);   // no network: the network path was not found
  const ctl = new Int32Array(netLink.sab, 0, 4);
  Atomics.store(ctl, 0, 1);
  netLink.port.postMessage({ key, op, args });
  while (Atomics.load(ctl, 0) === 1) Atomics.wait(ctl, 0, 1);
  const r = B.take(netLink.sab, mkErr); Atomics.store(ctl, 0, 0);
  if (r instanceof Error) throw r;
  return r;
}
const netBackend = key => new Proxy({}, { get: (_, op) => (...args) => netCall(key, op, args) });
const rfs = new self.W95FS.FileSystem();
rfs.nextFd = 0x10000000;
rfs.uncBackend = unc => { if (!netLink) return null; const b = netBackend(unc); try { b.space(); return b; } catch (_) { return null; } };
const REMOTE_FD = 0x10000000;
const remotePath = p => { try { return typeof p === 'string' && !!rfs.remoteAt(p); } catch (_) { return /^[\\/]{2}/.test(p); } };
// the file system, the page's: each call made there (its errors thrown here as they were there); the network's paths
// and descriptors here
const pathOps = new Set(['exists', 'stat', 'readdir', 'readFile', 'writeFile', 'open', 'unlink', 'mkdir', 'rmdir', 'realpath', 'setAttrs', 'statvfs', 'chdir', 'resolve', 'shortPath', 'setLabel', 'truncate']);
const fdOps = new Set(['read', 'write', 'close', 'seek', 'fstat', 'ftruncate']);
const fs = new Proxy({}, {
  get(_, k) {
    if (k === 'cwd') return rpc('fs', 'getCwd');
    if (k === 'vols') { const m = new Map(rpc('fs', 'vols').map(v => [v.letter, v])); for (const v of rfs.vols.values()) m.set(v.letter, { letter: v.letter, kind: 'remote', label: v.label, remote: true, unc: v.unc }); return m; }
    return (...args) => {
      if (pathOps.has(k) && remotePath(args[0])) return rfs[k](...args);
      if (fdOps.has(k) && args[0] >= REMOTE_FD) return rfs[k](...args);
      if ((k === 'rename' || k === 'copy') && (remotePath(args[0]) || remotePath(args[1]))) {
        if (remotePath(args[0]) && remotePath(args[1])) return rfs[k](...args);
        const data = remotePath(args[0]) ? rfs.readFile(args[0]) : rpc('fs', 'readFile', [args[0]]);
        if (remotePath(args[1])) rfs.writeFile(args[1], data); else rpc('fs', 'writeFile', [args[1], data]);
        if (k === 'rename') { if (remotePath(args[0])) rfs.unlink(args[0]); else rpc('fs', 'unlink', [args[0]]); }
        return;
      }
      return rpc('fs', k, args);
    };
  },
  set(_, k, v) { if (k === 'cwd') rpc('fs', 'setCwd', [v]); return true; },
});
self.W95SHELL = new Proxy({}, { get(_, k) { return k === 'fs' ? fs : (...args) => { post({ t: 'shell', fn: k, args: JSON.parse(JSON.stringify(args.filter(a => typeof a !== 'object' || a === null || a.constructor === Object))) }); return true; }; } });

// ---------------------------------------------------------------- the segment: frames to and from the page's part of it
const LAN = self.W95LAN, lanSend = LAN.send, pageSide = { rx() {} };
LAN.send = (from, frame) => { lanSend(from, frame); if (from !== pageSide) post({ t: 'lan', frame: frame.slice() }); };
// the page's frames arrive in a ring the card takes them from as it is polled, ring 0 waiting for them included
let lanRing = null;
const lanDrain = () => { let f, any = false; while (lanRing && (f = B.frameTake(lanRing))) { lanSend(pageSide, f); any = true; } return any; };
const lanPoll0 = W.Process.prototype.lanPoll;
if (lanPoll0) W.Process.prototype.lanPoll = function () { lanDrain(); return lanPoll0.call(this); };
// ring 0 waiting with nothing to run: real time passes until a frame or the next time-out comes (the page answers the
// network in its own time, which the clock must not run past)
W.Process.prototype.r0Idle = function () {
  const due = this.vxdTimeOuts && this.vxdTimeOuts.size ? Math.min(...[...this.vxdTimeOuts.values()].map(t => t.due)) - this.sysTime() : null;
  if (due !== null && due <= 0) return true;
  const ms = due === null ? 200 : Math.min(due, 50);
  const got = lanRing ? B.frameWait(lanRing, ms) : (Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), false);
  if (machine) machine.poll();
  return got || due !== null;
};

// ---------------------------------------------------------------- the registry: this machine's copy of the page's
const regStore = { held: null, load() { return this.held; }, op(o) { post({ t: 'regop', o }); } };

// ---------------------------------------------------------------- sound: the samples go to the page's output
self.W95AudioSink = (proc, rate, L, R, n) => {
  const l = Float32Array.from(L.subarray(0, n)), r = Float32Array.from(R.subarray(0, n));
  post({ t: 'audio', rate, l, r }, [l.buffer, r.buffer]); return false;
};

// ---------------------------------------------------------------- the machine
const NATIVE = { exec: null };
class Machine {
  constructor(o) {
    Object.assign(this, o); this.keyq = []; this.mods = {}; this.ax = -1; this.ay = -1; this.cursorOn = false; this.mouse = { x: -100, y: -100 };
    this.ring = o.ring; this.pending = new Map(); this.alive = true;
  }
  async start() {
    const S = self.W95SYSTEM;
    await Promise.all([...Object.values(S.ne), ...Object.values(S.dlls), ...Object.values(S.net || {})].map(async m => { if (!m.mod) m.mod = await WebAssembly.compile(b64bytes(m.wasm)); }));
    let prog = this.prog;
    if (!prog) prog = { name: 'MSGSRV32.EXE', meta: Object.values(S.programs)[0].meta, module: null };
    else prog.module = await WebAssembly.compile(b64bytes(S.programs[prog.name].wasm));
    const dlls = new Map();
    for (const [n, d] of Object.entries({ ...S.dlls, ...(this.net ? S.net : {}) })) { d.bytes = d.bytes || b64bytes(d.file); dlls.set(n.replace(/\.DLL$/, ''), { file: d.bytes, module: d.mod, meta: d.meta }); }
    if (!this.net) for (const [n, d] of Object.entries(S.net || {})) dlls.set(n.replace(/\.DLL$/, ''), {
      get file() { return d.bytes || (d.bytes = b64bytes(d.file)); }, meta: d.meta,
      get module() { return d.mod instanceof WebAssembly.Module ? d.mod : (d.modSync || (d.modSync = new WebAssembly.Module(b64bytes(d.wasm)))); } });
    const m = this;
    const host = {
      fs, width: this.sw, height: this.sh, path: this.path, now: () => performance.now(), net: this.net, vmPages: 2048, shared: true,
      cursor: () => ({ x: m.mouse.x, y: m.mouse.y }), surface: (h, w, hh) => new OffscreenCanvas(Math.max(1, w), Math.max(1, hh)).getContext('2d'), setCursor: () => {},
      exited: (code, why) => m.exited(code, why), boot: p => p.bootUser16(), exec: (cmd, show) => m.exec(cmd, show),
      msgMode: on => { m.msg = on; post({ t: 'msgMode', on }); m.sendText(true); }, reset: () => post({ t: 'reset' }),
      faultDialog: f => post({ t: 'faultDialog', f }),
    };
    const exe = /\s/.test(this.path) ? `"${this.path}"` : this.path;
    try {
      this.proc = new W.Process(this.bytes, prog.module, { ...prog.meta, name: prog.name.replace(/\.EXE$/, '') }, host, this.arg ? `${exe} ${this.arg}` : exe, dlls);
      if (this.system && !this.proc.trapped && !this.proc.startTask16('MSGSRV32.EXE')) throw new Error('MSGSRV32.EXE did not start');
    } catch (e) { console.error(e); this.exited(-1, e.message); return; }
    if (this.proc.trapped) { this.exited(-1, this.proc.trapped); return; }
    const p = this.proc;
    { const a = p.scanout(); if (a.bpp) [this.sw, this.sh] = [a.w, a.h]; }
    try {
      this.cursorOn = true; this.showCursor(false);   // (USER shows its cursor at the screen's centre as it starts: hidden until the pointer comes)
      const r = p.wbufLin || (p.nativeWindows(), p.wbufLin);
      p.w16(r, 0); p.w16(r + 2, 0); p.w16(r + 4, Math.min(this.sw, this.shellW)); p.w16(r + 6, Math.min(this.sh, this.workH));
      p.user16(483, [['w', 47], ['w', 0], ['l', p.wbufSel << 16], ['w', 0]]);   // SPI_SETWORKAREA
    } catch (e) { console.error(e); }
    // interrupts: the page's input as the machine reaches an instruction boundary (the budget's check), and while ring 0
    // waits in message mode
    p.inputPoll = () => this.poll();
    // a blue screen's wait for its key in ring 0 that cannot stop (inside a call): the screen to the page, the keys from it
    p.msgWait = () => { this.sendText(); Atomics.wait(this.ring, 0, Atomics.load(this.ring, 0), 16); this.poll(); };
    post({ t: 'started', sw: this.sw, sh: this.sh, mem: p.mem.buffer });
    this.step();
  }
  /** the input ring: keys through VKD first (its hot keys, message mode's keys), the rest queued for USER */
  poll() {
    const p = this.proc; let r;
    // the timer's interrupt: the VMM's global time-outs that are due run now, unless ring 0 or its critical section has
    // the processor (a guest running on inside a call still gets them, as a hung Windows still runs REBOOT's)
    if (p.depth && !p.r0Depth && !p.vxdCrit && p.vxdTimeOuts && p.vxdTimeOuts.size && !this.inTimer) {
      this.inTimer = true; const d = p.depth; p.depth = 0;
      try { p.vxdRunTimeOuts(); } catch (e) { console.error(e); } finally { p.depth = d; this.inTimer = false; }
    }
    while ((r = B.ringTake(this.ring))) {
      if (r[0] === B.KEY) {
        const scan = r[1] & 0xff, ext = !!(r[1] & 0x100), up = !!(r[1] & 0x200), toUser = !!(r[1] & 0x400), mods = { shift: !!(r[2] & 1), ctrl: !!(r[2] & 2), alt: !!(r[2] & 4) };
        let taken = false; try { taken = scan && p.vkdKey ? p.vkdKey(scan, ext, up, mods) : false; } catch (e) { console.error(e); }
        if (!taken && toUser && r[3]) this.queueKey(r[3], scan | (ext ? 0x100 : 0), up, mods);
      } else if (r[0] === B.MOUSE) this.queueMouse(r[1], r[2], r[3]);
    }
  }
  queueKey(vk, sc, up, mods) {
    for (const [m, on, code] of [[16, mods.shift, 0x2a], [17, mods.ctrl, 0x1d], [18, mods.alt, 0x38]]) {
      if (m === vk || !!this.mods[m] === !!on) continue;
      this.mods[m] = on; this.keyq.push([m, code, !on]);
    }
    if (vk === 16 || vk === 17 || vk === 18) this.mods[vk] = !up;
    this.keyq.push([vk, sc, up]);
  }
  // the mouse: absolute moves and button changes into USER's mouse_event, as the mouse driver reports them
  queueMouse(kind, x, y) {
    this.mouse = { x, y };
    const ax = Math.round(Math.max(0, Math.min(this.sw - 1, x)) * 65535 / (this.sw - 1)), ay = Math.round(Math.max(0, Math.min(this.sh - 1, y)) * 65535 / (this.sh - 1));
    const f = kind;
    if (f !== 1 && (ax !== this.ax || ay !== this.ay)) this.keyq.push({ mouse: [0x8001, ax, ay] });
    this.keyq.push({ mouse: [0x8001 | f, ax, ay] }); this.ax = ax; this.ay = ay;
    if (!this.cursorOn) this.showCursor(true);
  }
  // USER's cursor shown or hidden as the pointer comes onto the machine's windows or leaves them for the shell's. Its
  // show count is a thread's (ShowCursor): the thread whose cursor is on the screen hides it, and the same thread shows
  // it again (its count back where it was)
  showCursor(on) {
    const p = this.proc; if (on === this.cursorOn || !p || p.win16Held || this.ring0()) return;
    this.cursorOn = on;
    try {
      if (!on) this.cursorThread = p.cursorOwnerThread();
      p.asThread(this.cursorThread, () => p.user16(71, [['w', on ? 1 : 0]]));
    } catch (e) { console.error(e); }
  }
  /** the cursor kept hidden while the pointer is on the shell: when another thread comes to own it (its count shown),
   *  the thread that hid it shows it again and the new owner hides it */
  syncCursor() {
    const p = this.proc; if (this.cursorOn || !p || p.win16Held || this.ring0()) return;
    const o = p.cursorOwnerThread(); if (o === this.cursorThread) return;
    try {
      p.asThread(this.cursorThread, () => p.user16(71, [['w', 1]]));
      this.cursorThread = o; p.asThread(o, () => p.user16(71, [['w', 0]]));
    } catch (e) { console.error(e); }
  }
  ring0() { return !!(this.proc && this.proc.r0Runs && this.proc.r0Runs.length); }
  feedKeys() {
    const p = this.proc;
    if (!this.keyq.length || p.depth || this.ring0()) return;   // (the keyboard and mouse drivers report at interrupt time)
    try { if (p.user16(335).ax) return; } catch (e) { console.error(e); }   // GetInputState: USER has input not yet taken
    for (let n = 0; this.keyq.length && n < 16; n++) {
      const k = this.keyq.shift();
      try { if (k.mouse) p.mouseEvent16(...k.mouse); else p.keyEvent16(k[0], k[1] & 0xff, k[2], k[1] > 0xff); } catch (e) { console.error(e); }
    }
  }
  step() {
    clearTimeout(this.timer); this.timer = 0;
    if (!this.alive) return;
    const p = this.proc, t0 = performance.now();
    this.poll();
    if (p.r0Runs && p.r0Runs.length) {
      try { p.r0Step(); } catch (e) { console.error(e); this.exited(-1, e.message); return; }
      this.sendText();
      if (!(p.r0Runs && p.r0Runs.length) && this.afterR0) { const go = this.afterR0; this.afterR0 = null; go(); }
      if (this.alive) this.timer = setTimeout(() => this.step(), 16);
      return;
    }
    if (this.stopped) return;
    if (!p.win16Held && p.k32CloseRequest && p.k32CloseRequest()) post({ t: 'closeProgram' });   // REBOOT's APC: Close Program
    this.feedKeys();
    try {
      for (let n = 0; this.alive && n < 4; n++) {
        p.stats.slices++; const live = p.slice();
        if (!p.win16Held) { p.timers16(); p.threads16(); p.systemPump(); p.appy16(); }
        else { p.threads16(); if (p.vxdRunTimeOuts) p.vxdRunTimeOuts(); }
        if (p.sound16) p.sound16(); if (p.lanPoll) p.lanPoll();
        if (!live || p.preempted || p.win16Held) break;
      }
    } catch (e) {
      if (e instanceof W.FaultError) { p.depth = 0; p.faulted(e.fault); }
      else if (!(e instanceof W.HangError)) { console.error(e); this.exited(-1, e.message); return; }
      else { p.hung('host', e); p.depth = 0; }
    }
    p.stats.guestMs += performance.now() - t0;
    if (p.fault && !this.faultTaken) {
      this.faultTaken = true;
      if (p.fault.ring === 0) { this.fatal(p.fault); if (this.alive) this.timer = setTimeout(() => this.step(), 16); return; }
      this.stopped = true; post({ t: 'fault', f: p.fault }); return;
    }
    for (const f of (p.pcFaults || []).splice(0)) { f.pc.fault = true; post({ t: 'pcFault', path: f.pc.path, why: f.why, f: f.fault || null }); }
    if (p.trapped && !p.failed) p.fail(p.trapped);
    if (p.exitCode !== null || p.trapped) { this.exited(p.exitCode, p.trapped); return; }
    if (!p.win16Held) { this.syncCursor(); this.frame(); }
    this.timer = setTimeout(() => this.step(), this.keyq.length ? 0 : 16);
  }
  kick() { if (this.alive && this.timer) { clearTimeout(this.timer); this.timer = setTimeout(() => this.step(), 0); } }
  /** VWIN32's blue screen for a fault at ring 0 (its text from the page), then the current application ends */
  fatal(f) {
    const p = this.proc, msg = rpc('host', 'fatalText', [f]), at = p.vxdService && p.vxdService(0x17, 3);
    if (!msg || !at) { this.exited(-1); return; }
    const a = p.alloc(msg.length + 1); p.writeA(a, msg);
    this.afterR0 = () => this.exited(-1);
    try { if (p.r0Start(at, { ebx: p.sysVM(), eax: 0x40001000, ecx: a, edi: 0, esi: 0, edx: 0 }) !== null) this.exited(-1); }
    catch (e) { console.error(e); this.exited(-1); }
    this.sendText();
  }
  /** what the page draws: USER's windows, the screen's mode and palette, the cursor sprite, the text screen */
  frame() {
    const p = this.proc;
    let nw; try { nw = p.nativeWindows(); } catch (e) { console.error(e); this.exited(-1, e.message); return; }
    const a = p.scanout(), sp = p.sprite ? p.sprite() : null;
    let bg = 0; try { const c = p.user16(180, [['w', 1]]); bg = (c.dx & 0xff) << 16 | (c.ax & 0xffff); } catch (e) { console.error(e); }
    for (const w of nw.list) { const pc = w.task && [...(p.procs || new Map()).values()].find(c => c.tdb === w.task); w.prog = pc ? basename(pc.path).toUpperCase() : null; }
    post({ t: 'frame', list: nw.list, active: nw.active, capture: nw.capture, cursorOn: this.cursorOn,
      scan: { w: a.w, h: a.h, pitch: a.pitch || a.w, bpp: a.bpp, vram: a.vram.byteOffset }, dac: Uint8Array.from(a.dac), bg,
      sprite: sp ? { x: sp.x, y: sp.y, px: sp.px, py: sp.py, row: sp.row, at: sp.bits.byteOffset } : null,
      stats: { ...p.stats }, held: p.win16Held ? { hung: p.win16Held.hung } : null });
    this.clip();
  }
  sendText(force) {
    const t = this.proc && this.proc.txt; if (!t || (!force && t.gen === this.txtGen)) return;
    this.txtGen = t.gen; post({ t: 'text', txt: { cols: t.cols, rows: t.rows, ch: t.ch.slice(), at: t.at.slice(), cur: t.cur, gen: t.gen } });
  }
  // WinExec and CreateProcess from the program: a program the system runs starts in this machine (P.spawn)
  exec(cmd) {
    const m = /^\s*(?:"([^"]+)"|(\S+))\s*(.*)$/.exec(cmd || ''); if (!m) return 2;
    let path = m[1] || m[2]; const arg = m[3];
    if (!extname(path)) path += '.exe';
    if (this.system && /^explorer\.exe$/i.test(basename(path))) return 0x21;   // the shell SYSTEM.INI names: the page, running
    const file = (/^[a-z]:|^\\/i.test(path) ? [path] : [join('C:\\WINDOWS', path), join('C:\\WINDOWS\\SYSTEM', path), join(fs.cwd, path)]).find(f => fs.exists(f));
    if (!file) return 2;
    const r = this.spawnProgram(file, arg);
    // a second instance of a program: its image's place here is taken, so it starts in a machine of its own, as the
    // page starts one (runNative); this process gets no handle on it
    if (r === 8 && this.system) { rpc('host', 'runApart', [file, arg]); return { elsewhere: true }; }
    return r;
  }
  spawnProgram(file, arg) {
    const S = self.W95SYSTEM || {}, p = this.proc;
    const name = basename(file).toUpperCase(), d = (S.programs || {})[name]; if (!d) return 11;
    const live = (p.pc0 && p.pc0.exe && p.pc0.exe.base === d.meta.base) || [...(p.procs || new Map()).values()].some(x => x.exe.base === d.meta.base);
    if (live) return 8;
    p.modules = p.modules.filter(x => x.base !== d.meta.base);
    let pc;
    try {
      const mod = d.modSync || (d.modSync = new WebAssembly.Module(b64bytes(d.wasm))), real = fs.realpath(file);
      pc = p.spawn(fs.readFile(file), mod, { ...d.meta, name: name.replace(/\.EXE$/, '') }, real, arg ? `${real} ${arg}` : real);
    } catch (e) { console.error(e); return 8; }
    pc.onExit = code => { if (!pc.fault) post({ t: 'emit', ev: 'program.exit', data: { path: pc.path, code } }); };
    this.kick();
    return pc;
  }
  // one clipboard across machines: the shell's text is given to USER when the page says this machine has the
  // keyboard, and USER's CF_TEXT taken back when it loses it (clipIn / clipOut commands)
  clip() {}
  clipOut() {
    const p = this.proc; if (!p || p.depth) return null;
    const code = p.exitCode; p.exitCode = null;
    try {
      if (!p.user16(137, [['w', 0]]).ax) return null;
      const h = p.user16(142, [['w', 1]]).ax, b = h && p.gblock(h);
      const t = b ? p.readA(b.lin, b.size).replace(/\r\n/g, '\n') : null;
      p.user16(138); return t;
    } catch (e) { console.error(e); return null; } finally { p.exitCode = code; }
  }
  clipIn(text) {
    const p = this.proc; if (!p || p.depth) return;
    try {
      if (!p.user16(137, [['w', 0]]).ax) return;
      p.user16(139);
      if (text) {
        const bytes = self.W95FS.encode(text.replace(/\r?\n/g, '\r\n')), h = p.globalAlloc16(0x2002, bytes.length + 1);
        p.u8.set(bytes, p.gblock(h).lin); p.u8[p.gblock(h).lin + bytes.length] = 0;
        p.user16(141, [['w', 1], ['w', h]]);
      }
      p.user16(138);
    } catch (e) { console.error(e); }
  }
  /** MPR's export `name` called on a new thread of this process, with dword (or string) arguments; its result */
  /** a printer's window, as SHELL32's Printers folder opens it: its command block { 0 (open), the printer's name } in
   *  COMCTL32's shared heap (Alloc, #71; the window frees it, #73) and RUNDLL32 SHELL32,PrintersGetCommand_RunDLL on its
   *  address */
  printerWindow(rundll, name) {
    const p = this.proc; let cc = p.byName.get('COMCTL32');
    if (!cc && (cc = p.loadDll('COMCTL32'))) { p.runPendingInits(); p.attach(cc); }   // (as Explorer has it loaded, under SHELL32)
    const alloc = cc && cc.exports.get('#71'); if (!alloc) return Promise.resolve(false);
    const le32 = v => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    const a = p.alloc(32), res = a + 24, ptr = a + 28, size = 12 + name.length + 1;
    p.u8.set([0x68, ...le32(size), 0xff, 0x15, ...le32(ptr), 0xa3, ...le32(res), 0xc2, 0x04, 0x00], a);   // push size; call [ptr]; mov [res], eax; ret 4
    p.w32(ptr, alloc);
    return new Promise(ok => {
      const t = p.newThread(a, 0, 0x10000, true, false);
      t.onDone = () => {
        const blk = p.r32(res); if (!blk) return ok(false);
        p.w32(blk, 0); p.w32(blk + 4, blk + 12); p.w32(blk + 8, 0); p.writeA(blk + 12, name);
        setTimeout(() => ok(typeof this.spawnProgram(rundll, `SHELL32,PrintersGetCommand_RunDLL ${blk >>> 0}`) === 'object'), 0);   // (from the top level, as 'spawn' starts a program)
      };
      this.kick();
    });
  }
  netCall(name, args = []) {
    const p = this.proc, mpr = p.byName.get('MPR'), fn = mpr && mpr.exports.get(name); if (!fn) return Promise.resolve(null);
    const le32 = v => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    const a = p.alloc(96), res = a + 88, ptr = a + 92, code = [];
    const vals = args.map(v => (typeof v === 'string' ? (() => { const s = p.alloc(v.length + 1); p.writeA(s, v); return s; })() : v));
    for (let i = vals.length - 1; i >= 0; i--) code.push(0x68, ...le32(vals[i]));   // push imm32
    code.push(0xff, 0x15, ...le32(ptr), 0xa3, ...le32(res), 0xc2, 0x04, 0x00);       // call [ptr]; mov [res], eax; ret 4
    p.w32(ptr, fn); p.u8.set(code, a);
    return new Promise(ok => { const t = p.newThread(a, 0, 0x10000, true, false); t.onDone = () => ok(p.r32(res)); this.kick(); });
  }
  /** WNetOpenEnum / WNetEnumResource: the resources at a scope (under one, `res`) */
  async netEnum(scope, res) {
    const p = this.proc, s = x => (x ? (() => { const a = p.alloc(x.length + 1); p.writeA(a, x); return a; })() : 0), nr = res ? p.alloc(32) : 0, ph = p.alloc(4), out = [];
    if (res) { p.w32(nr, res.scope); p.w32(nr + 4, res.type); p.w32(nr + 8, res.disp); p.w32(nr + 12, res.usage); p.w32(nr + 16, 0); p.w32(nr + 20, s(res.remote)); p.w32(nr + 24, s(res.comment)); p.w32(nr + 28, s(res.provider)); }
    if (await this.netCall('WNetOpenEnumA', [scope, 0, 0, nr, ph]) !== 0) return out;
    const h = p.r32(ph), cnt = p.alloc(4), sz = p.alloc(4), buf = p.alloc(0x4000);
    for (;;) {
      p.w32(cnt, 0xffffffff); p.w32(sz, 0x4000);
      if (await this.netCall('WNetEnumResourceA', [h, cnt, buf, sz]) !== 0) break;
      for (let i = 0, n = p.r32(cnt); i < n; i++) {
        const a = buf + 32 * i, str = o => p.readA(p.r32(a + o)) || '';
        out.push({ scope: 2, type: p.r32(a + 4), disp: p.r32(a + 8), usage: p.r32(a + 12), remote: str(20), comment: str(24), provider: str(28) });
      }
    }
    await this.netCall('WNetCloseEnum', [h]);
    return out;
  }
  /** each drive letter MPR has connected, with its share (WNetGetConnectionA) */
  netConnections() {
    const p = this.proc, fn = p.byName.get('MPR') && p.byName.get('MPR').exports.get('WNetGetConnectionA'); if (!fn) return [];
    const loc = p.alloc(8), buf = p.alloc(264), pn = p.alloc(4), out = [];
    for (let c = 65; c <= 90; c++) {
      const L = String.fromCharCode(c); p.writeA(loc, L + ':'); p.w32(pn, 260);
      try { if (p.call(fn, [loc, buf, pn]) === 0) out.push({ letter: L, unc: p.readA(buf) }); } catch (e) { console.error(e); }
    }
    p.free(loc); p.free(buf); p.free(pn);
    return out;
  }
  exited(code, why) {
    if (!this.alive) return;
    this.alive = false; clearTimeout(this.timer);
    post({ t: 'exited', code, why: why || null });
  }
  // the page's requests: what a window gets done to it, and questions about the machine
  cmd(name, args) {
    const p = this.proc, u = (o, a) => p.user16(o, a);
    switch (name) {
      case 'focus': { const [hwnd, min] = args; p.asWindowTask(hwnd, () => { if (min) u(42, [['w', hwnd], ['w', 9]]); else { u(59, [['w', hwnd]]); u(45, [['w', hwnd]]); } }); return; }
      case 'minimize': u(42, [['w', args[0]], ['w', 6]]); return;
      case 'close': u(110, [['w', args[0]], ['w', 0x10], ['w', 0], ['l', 0]]); return;
      case 'showCursor': this.showCursor(args[0]); return;
      case 'clipOut': return this.clipOut();
      case 'clipIn': this.clipIn(args[0]); return;
      case 'closeState': p.k32CloseState(args[0]); return;
      case 'spawn': { const r = this.spawnProgram(args[0], args[1]); return typeof r === 'object' ? { ok: true } : { err: r }; }
      case 'children': return p.depth ? null : p.nativeChildren(args[0]);
      case 'hung': {   // USER32's IsHungThread for the thread that owns each window
        const x = p.byName && p.byName.get('USER32') && p.byName.get('USER32').exports, tid = x && x.get('GetWindowThreadProcessId'), hung = x && x.get('IsHungThread');
        return args[0].map(h => (tid && hung && !p.depth ? !!p.call(hung, [p.call(tid, [h, 0])]) : false));
      }
      case 'systemStarted': {   // KERNEL32 tells MSGSRV32 its start is done (SHELL_PostMessage of 501h)
        const task = [...(p.threadsById || new Map()).values()].find(t => t.task && t.task.hInst && p.neByHandle(t.task.hInst) && p.neByHandle(t.task.hInst).name === 'MSGSRV32');
        if (!task || !(task.state === 'waiting' && task.slept)) return false;
        // (quiet: SystemStart plays with the card's output off, as after an unclean shutdown; sound.js soundQuiet)
        const h = p.taskWindows(task.tdb)[0]; if (h) { p.soundQuiet = !!args[0]; p.shellPostMessage(h, 0x501, 0, 0); } return true;
      }
      case 'trayPost': p.post(...args); return;
      // the network's machine: MPR's exports called on a thread of its own (its dialogs run there), its enumerations,
      // the drives it has connected, and a drive's or share's files (netfs.js) for the page and for other machines
      case 'printerWindow': return this.printerWindow(args[0], args[1]);
      case 'netCall': return this.netCall(args[0], args[1]);
      case 'netEnum': return this.netEnum(args[0], args[1]);
      case 'netConnections': return this.netConnections();
      case 'netfs': { const b = self.W95NetFS.backend({ alive: true, proc: p }, args[0]); return b[args[1]](...(args[2] || [])); }
      case 'kick': return;
      case 'exit': this.exited(args[0] || 0); return;
    }
    throw new Error(`unknown command ${name}`);
  }
}

let machine = null;
self.onmessage = e => {
  const m = e.data;
  if (m.t === 'start') {
    rpcSab = m.rpc; lanRing = m.o.lan || null; regStore.held = m.registry; W.regAttach(regStore);
    machine = new Machine(m.o); machine.start().catch(err => { console.error(err); post({ t: 'exited', code: -1, why: String(err && err.message || err) }); });
  } else if (m.t === 'cmd') {
    const reply = (value, error) => { if (m.id) post({ t: 'reply', id: m.id, value: value === undefined ? null : value, error }); };
    let value, error = null;
    try { value = machine && machine.alive ? machine.cmd(m.name, m.args || []) : undefined; } catch (err) { console.error(err); error = String(err.message || err); }
    if (value && typeof value.then === 'function') value.then(v => reply(v, null), err => reply(null, String(err && err.message || err)));
    else reply(value, error);
    if (machine) machine.kick();
  } else if (m.t === 'lan') lanSend(pageSide, m.frame);   // a frame from the rest of the segment
  else if (m.t === 'netport') {   // (the network's machine) another machine's channel for its network files
    const sab = m.sab;
    m.port.onmessage = e => {
      let v; const { key, op, args } = e.data;
      try { v = self.W95NetFS.backend({ alive: !!(machine && machine.alive), proc: machine && machine.proc }, key)[op](...args); } catch (err) { v = err; }
      B.answer(sab, v === undefined ? null : v);
    };
  } else if (m.t === 'netlink') netLink = m.port ? { port: m.port, sab: m.sab } : null;   // the network's machine, or none
  else if (m.t === 'netmounts') {   // the drives the network has connected, as this machine's
    for (const v of [...rfs.vols.values()]) if (!m.list.some(x => x.letter === v.letter && x.unc.toUpperCase() === v.unc.toUpperCase())) rfs.unmount(v.letter);
    for (const x of m.list) if (!rfs.vols.has(x.letter)) rfs.mount(x.letter, { remote: netBackend(x.letter), unc: x.unc, label: x.unc.split('\\').pop() || '' });
  } else if (m.t === 'regop') W.regApply(m.o, true);
  else if (m.t === 'kick') { if (machine) machine.kick(); }
};
