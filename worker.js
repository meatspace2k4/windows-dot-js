'use strict';
// A machine of Windows 95's in a worker of its own: the processor, its memory (shared, so the page reads the screen
// from it) and everything the recompiled system runs on (win32.js, ne16.js, vmm.js, sound.js, dyn.js). The page keeps
// the shell, the windows it draws for the machine's and the file system; the worker reaches the file system through the
// page synchronously (bridge.js), and takes the page's input from its ring between instructions, as interrupts. Nothing
// the guest does here, a loop that never ends included, holds the page.
self.window = self;
// the Ethernet segment as this worker has it: its own stations (the card, in the system's machine), and the rest of the
// segment on the page (the other computer, lanhost.js; other machines' cards), frames passing both ways
self.W95LAN = { stations: new Set(), frames: 0 };
importScripts('bridge.js', 'fs.js', 'win32.js', 'gl.js', 'shell32.js', 'system.js', 'claude-exe.js', 'claude-app.js', 'session-dll.js', 'sesstray-exe.js', 'session-tray.js', 'dbwin-exe.js', 'dbwin.js','osclass.js', 'ne16.js', 'vmm.js', 'sound.js', 'lan.js', 'parallel.js', 'netfs.js', 'dyn.js', 'savers.js', 'saver-runtime.js');
const B = self.W95Bridge, W = self.W95Win32, { FSError, join, basename, extname } = self.W95FS;
const b64bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const sha256 = W.sha256;   // (a program's identity as the bundle records it: spawnProgram)
const post = (m, tr) => self.postMessage(m, tr || []);
self.W95CDAUDIO = (op, from, to) => post({ t: 'cdaudio', op, from, to });   // (the audio CD drive's play and stop, for the page's cdaudio.js: ne16.js cdRequest)
self.W95MIC = on => post({ t: 'mic', on });                                 // (the sound card's capture started or stopped: the page's microphone: sound.js)
self.W95CDTRACE = s => post({ t: 'cdtrace', s: `${Date.now() % 1000000} ${s}` });   // (MSCDEX's requests, for the page to send to the dev server's cd log)
self.W95CDGAIN = (l, r) => post({ t: 'cdaudio', op: 'gain', l, r });       // (the sound card's AUX1 gain the drive's output goes through: sound.js)

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
// the network's drives and shares, as this machine reaches them: through the system's machine (its redirector), in a
// worker of its own, called synchronously over a channel the page set up between the two (netLink); the system's
// machine itself through its own (ownNet). A file system of their own here (fs.js's remote volumes), whose descriptors
// are numbered apart from the page's
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
const ownNet = key => self.W95NetFS.backend({ get alive() { return !!(machine && machine.alive); }, get proc() { return machine && machine.proc; } }, key);
const netOf = key => (machine && machine.system ? ownNet(key) : netLink ? netBackend(key) : null);
const rfs = new self.W95FS.FileSystem();
rfs.nextFd = 0x10000000;
rfs.uncBackend = unc => { const b = netOf(unc); if (!b) return null; try { b.space(); return b; } catch (_) { return null; } };
const REMOTE_FD = 0x10000000;
// a UNC path the system's machine does not reach (no network yet, or the host's own share, \\COMPUTER\SHARE) is the
// page's file system's, which has the host's shares directly (win95.js fs.uncBackend)
const remotePath = p => { try { return typeof p === 'string' && !!rfs.remoteAt(p); } catch (_) { return false; } };
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
    Object.assign(this, o); this.keyq = []; this.mouseq = []; this.mods = {}; this.ax = -1; this.ay = -1; this.cursorOn = false; this.mouse = { x: -100, y: -100 };
    this.ring = o.ring; this.pending = new Map(); this.alive = true; this.savers = new Map();
  }
  async start() {
    const S = self.W95SYSTEM;
    await Promise.all([...Object.values(S.ne), ...Object.values(S.dlls), ...Object.values(S.net || {})].map(async m => { if (!m.mod) m.mod = await WebAssembly.compile(b64bytes(m.wasm)); }));
    if (self.fonts && typeof FontFace === 'function') await Promise.all(Object.entries((self.W95SAVERS || {}).fonts || {}).map(async ([family, data]) => {
      try { const font = await new FontFace(family, b64bytes(data)).load(); self.fonts.add(font); } catch (_) { /* bundled font unavailable in this worker */ }
    }));
    let prog = this.prog;
    if (!prog) prog = { name: 'MSGSRV32.EXE', meta: Object.values(S.programs)[0].meta, module: null };
    else prog.module = await WebAssembly.compile(b64bytes(S.programs[prog.name].wasm));
    const dlls = new Map();
    for (const [n, d] of Object.entries(S.dlls)) { d.bytes = d.bytes || b64bytes(d.file); dlls.set(n.replace(/\.DLL$/, ''), { file: d.bytes, module: d.mod, meta: d.meta }); }
    for (const [n, d] of Object.entries(S.net || {})) dlls.set(n.replace(/\.DLL$/, ''), {
      get file() { return d.bytes || (d.bytes = b64bytes(d.file)); }, meta: d.meta,
      get module() { return d.mod instanceof WebAssembly.Module ? d.mod : (d.modSync || (d.modSync = new WebAssembly.Module(b64bytes(d.wasm)))); } });
    for (const [n, d] of Object.entries((self.W95SAVERS || {}).dlls || {})) {
      let file; try { file = fs.readFile(`C:\\WINDOWS\\SYSTEM\\${n}`); } catch (_) { continue; }
      const bundled = b64bytes(d.file);
      if (file.length !== bundled.length || file.some((b, i) => b !== bundled[i])) continue;
      dlls.set(n.replace(/\.DLL$/, ''), { file, module: new WebAssembly.Module(b64bytes(d.wasm)), meta: d.meta });
    }
    this.saverDlls = new Map([...dlls].filter(([n]) => ['CRTDLL', 'GLU32'].includes(n)));
    const m = this;
    const host = {
      memWatch: this.memwatch ? this.memwatch.split(',').map(v => parseInt(v, 16)) : null,
      dynAt: this.dynat ? this.dynat.split(',').map(v => (/^[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : v)) : null,
      fs, width: this.sw, height: this.sh, path: this.path, now: () => performance.now(), lan: !!(this.system && lanRing), system: !!this.system, vmPages: 2048, shared: true,   // (lan: the network stack and its card, as the system's machine has them; system: the Win16 tasks' process is its own)
      cursor: () => ({ x: m.mouse.x, y: m.mouse.y }), surface: (h, w, hh, win, pc) => {
        const canvas = new OffscreenCanvas(Math.max(1, w), Math.max(1, hh));
        if (!h) m.w32DesktopSurface = { canvas, w: canvas.width, h: canvas.height, pc, version: 1 };
        return canvas.getContext('2d');
      }, surfaceChanged: (h, pc) => { if (!h && m.w32DesktopSurface && m.w32DesktopSurface.pc === pc) m.w32DesktopSurface.version++; }, setCursor: () => {},
      exited: (code, why) => m.exited(code, why), boot: p => p.bootUser16(), exec: (cmd, show) => m.exec(cmd, show),
      msgMode: on => { m.msg = on; post({ t: 'msgMode', on }); m.sendText(true); }, reset: () => post({ t: 'reset' }),
      faultDialog: f => post({ t: 'faultDialog', f }),
      console: (id, text) => post({ t: 'conOut', id, text }),   // (a console program's output, to its MS-DOS window: KERNEL32 WriteFile)
      consoleMode: (id, mode) => post({ t: 'conMode', id, mode }),   // (and its input's mode: line input, echo)
    };
    const exe = /\s/.test(this.path) ? `"${this.path}"` : this.path;
    try {
      if (this.system) { host.vmTop = 0x0a000000; host.vmPages = 2048; }
      this.proc = new W.Process(this.bytes, prog.module, { ...prog.meta, name: prog.name.replace(/\.EXE$/, '') }, host, this.arg ? `${exe} ${this.arg}` : exe, dlls);
      this.proc.soundQuiet = !!this.quiet;   // (sound.js: the card's output off for the one sound)
      if (this.system && this.session) this.proc.onIntent = i => post({ t: 'intent', i });   // (a shared session's: ne16.js hookIntents)
      if (this.system && this.session) this.proc.sessionClock = true;   // (its programs' first clock reads their start's: win32.js progTime)
      if (this.wallSkew) this.proc.wallSkew = this.wallSkew;   // (a shared session's wall clock: the server's, win32.js progTime)
      if (this.trace) this.traceOn(this.trace, this.traceNames || undefined);
      if (this.system && !this.proc.trapped && !this.startSystemTask()) throw new Error('MSGSRV32.EXE did not start');
    } catch (e) { console.error(e && e.stack ? e.stack : e); this.exited(-1, e.message); return; }
    if (this.proc.trapped) { this.exited(-1, this.proc.trapped); return; }
    const p = this.proc;
    { const a = p.scanout(); if (a.bpp) [this.sw, this.sh] = [a.w, a.h]; }
    if (!this.system) try {   // (the system's machine is the screen: its work area is its shell's to set, the taskbar's)
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
    const p = this.proc, cpu = p.cpu;
    // in the middle of a run (the budget's check) it is an interrupt (ne16.js asInterrupt)
    if (!p.runLevel || !cpu.ss) return this.pollIn();
    return p.asInterrupt(() => this.pollIn());
  }
  /** an error from ring 0 the poll ran (a VxD's time-out, VKD's key): a processor exception there is the machine's to
   *  answer (VWIN32's blue screen, step), and the run it interrupted goes no further; printed and passed over, the
   *  system ran on with the VxD's state broken (NETBEUI's time-out faulted, ran again from 0, and wrote over the screen) */
  r0Fault(e) {
    if (!(e instanceof W.FaultError)) { console.error(e); return; }
    this.proc.faulted(e.fault); throw e;
  }
  pollIn() {
    const p = this.proc; let r;
    // the timer's interrupt: the VMM's global time-outs that are due run now, unless ring 0 or its critical section has
    // the processor (a guest running on inside a call still gets them, as a hung Windows still runs REBOOT's)
    if (p.depth && !p.r0Depth && !p.vxdCrit && p.vxdTimeOuts && p.vxdTimeOuts.size && !this.inTimer) {
      this.inTimer = true; const d = p.depth; p.depth = 0;
      try { p.vxdRunTimeOuts(); } catch (e) { this.r0Fault(e); } finally { p.depth = d; this.inTimer = false; }
    }
    while ((r = B.ringTake(this.ring))) {
      this.ringTaken = (this.ringTaken || 0) + 1;   // (each frame says how many: the page paces a script's drag on it)
      if (r[0] === B.KEY) {
        const scan = r[1] & 0xff, ext = !!(r[1] & 0x100), up = !!(r[1] & 0x200), toUser = !!(r[1] & 0x400), mods = { shift: !!(r[2] & 1), ctrl: !!(r[2] & 2), alt: !!(r[2] & 4) };
        if (this.lagLog) this.lagLog.push({ k: 'key-in', vk: r[3], up, t: Date.now() });
        let taken = false; try { taken = scan && p.vkdKey ? p.vkdKey(scan, ext, up, mods) : false; } catch (e) { this.r0Fault(e); }
        if (!taken && toUser && r[3]) this.queueKey(r[3], scan | (ext ? 0x100 : 0), up, mods);
        if (!taken && toUser) p.dispatchInput(up ? W.WM.KEYUP : W.WM.KEYDOWN, r[3] || scan, 0);
        if (!up) this.stopFullSavers();
      } else if (r[0] === B.MOUSE) {
        if (this.lagLog) this.lagLog.push({ k: 'mouse-in', f: r[1], x: r[2], y: r[3], t: Date.now() });   // (a diagnostic: cmd 'lag')
        this.queueMouse(r[1], r[2], r[3]);
        if (r[1] & 1) this.stopFullSavers();
        p.dispatchInput(W.WM.MOUSEMOVE, 0, (r[3] << 16) | r[2]);
        if (r[1] & 2) p.dispatchInput(W.WM.LBUTTONDOWN, 0, (r[3] << 16) | r[2]);
        if (r[1] & 4) p.dispatchInput(W.WM.LBUTTONUP, 0, (r[3] << 16) | r[2]);
        if (r[1] & 8) p.dispatchInput(W.WM.RBUTTONDOWN, 0, (r[3] << 16) | r[2]);
        if (r[1] & 16) p.dispatchInput(W.WM.RBUTTONUP, 0, (r[3] << 16) | r[2]);
      }
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
  stopFullSavers() {
    // (a saver on the machine's own USER has the input itself and ends as its own code decides: scrnsave.lib lets the
    // pointer settle and ignores small moves)
    for (const proc of [...this.savers.values()]) if (proc.saverMode === 's' && !proc.nativeGdi) this.endSaver(proc.pid, 0);
  }
  // the mouse: absolute moves and button changes into USER's mouse_event, as the mouse driver reports them
  queueMouse(kind, x, y) {
    this.mouse = { x, y };
    const ax = Math.round(Math.max(0, Math.min(this.sw - 1, x)) * 65535 / (this.sw - 1)), ay = Math.round(Math.max(0, Math.min(this.sh - 1, y)) * 65535 / (this.sh - 1));
    const f = kind;
    const q = this.mouseq, last = q[q.length - 1];
    if (f !== 1 && (ax !== this.ax || ay !== this.ay)) q.push([0x8001, ax, ay]);
    // (the buttons held as of what is queued, not only what the machine has had: a drag's moves waiting behind its press)
    let qb = this.qbtn || 0; if (f & 2) qb |= 1; if (f & 4) qb &= ~1; if (f & 8) qb |= 2; if (f & 16) qb &= ~2; this.qbtn = qb;
    if (f === 1 && last && last[0] === 0x8001 && !qb) q[q.length - 1] = [0x8001, ax, ay];   // (moves the machine has not had yet: the latest; every one while a button is held, a drag's path being what the program draws)
    else q.push([0x8001 | f, ax, ay]);
    this.ax = ax; this.ay = ay;
  }
  /** the mouse into USER's mouse_event as the mouse driver's interrupt reports it: whatever the programs are doing
   *  (USER moves the cursor there, and queues the move for them), only not inside a call the host made or while ring 0
   *  has the processor */
  feedMouse() {
    const p = this.proc;
    if (p.depth || this.ring0() || this.focusing) return;   // (a window being brought to the front first: 'focus')
    // (another machine's person's stroke into a window here, fed first, whole, while this person's input waits:
    // USER has one mouse, and a program drawing takes one stroke at a time)
    if (this.feedStroke()) return;
    if (!this.mouseq.length) return;
    // (a drag's moves go in one to a slice of the machine's run, with the window's program given its slice between
    // them to take each: USER keeps only the latest of the moves waiting in its queue, and the path is what a
    // program drawing with them makes)
    while (this.mouseq.length) {
      if (this.btn && this.stroke && this.mouseq[0][0] === 0x8001) {
        // (a drag's moves run at most lagMax ahead of the program taking them: USER's DispatchMessage counts the
        // moves taken, ne16.js hookTaken; past 100 ms without one taken, the next goes in anyway. Four ahead
        // keep every point at a pace well past a mouse's; one a pass fed too slowly for a hand)
        const taken = p.movesTaken || 0, lag = (this.movesFed || 0) - taken, max = this.lagMax || 4;
        if (lag >= max && performance.now() - (this.lastFed || 0) < 100) break;
        if (lag >= max) this.movesFed = taken;
        this.movesFed = (this.movesFed || 0) + 1;
      }
      const m = this.mouseq.shift(); this.lastFed = performance.now();
      // (a button pressed: this machine's person has done something, ne16.js intentQuiet; a processor exception in the
      // drivers' handling is the machine's to answer, r0Fault)
      try { if (this.lagLog) this.lagLog.push({ k: 'mouse-fed', f: m[0] & 0xff, x: m[1], y: m[2], t: Date.now() }); if (m[0] & 0x2a) { p.personActed = true; if (p.personInput) try { p.personInput(...m); } catch (e) { this.r0Fault(e); } } p.mouseEvent16(...m); this.recordStroke(m); } catch (e) { this.r0Fault(e); }
    }
    this.postStroke(false);
  }
  // ---- a shared session's input: this person's mouse strokes (a button pressed, the moves while it is held, its
  // release) into a program's window are the session's, as its windows are: every machine feeds them into its own
  // copy of the program (the page: win95.js osStroke; the server keeps each object's for a machine joining). A stroke
  // is kept as offsets from the top-level window it went to (the same window on every machine), posted to the page
  // as it goes, in parts, with the object's window and, for a popup of the object's (a menu, a dialog), how the
  // others find theirs (ne16.js strokeTarget)
  /** this person's mouse event, as fed: into the stroke it is part of */
  recordStroke(m) {
    const f = m[0], p = this.proc, sw = this.sw, sh = this.sh;
    const sx = Math.round(m[1] * (sw - 1) / 65535), sy = Math.round(m[2] * (sh - 1) / 65535);
    const was = this.btn || 0;
    let btn = was; if (f & 2) btn |= 1; if (f & 4) btn &= ~1; if (f & 8) btn |= 2; if (f & 16) btn &= ~2; this.btn = btn;
    if (!was && (f & 0x0a)) {   // (a press with no button held: a stroke begins, at the window under it; one still to post goes first)
      if (this.stroke) { this.stroke.done = true; this.postStroke(true); }
      let t = null, why = null; try { t = p.strokeTarget(sx, sy); } catch (e) { why = String(e); console.error(e); }
      if (!t) { if (this.lagLog) this.lagLog.push({ k: 'stroke-miss', x: sx, y: sy, why, t: Date.now() }); return; }
      this.stroke = { n: (this.strokeN = (this.strokeN || 0) + 1), root: t.root, pop: t.pop, ox: t.x, oy: t.y, ev: [], done: false };
    }
    const s = this.stroke; if (!s || s.done) return;   // (a move after the release is not the stroke's)
    s.ev.push([f & 0x3f, sx - s.ox, sy - s.oy]);
    if (this.lagLog) this.lagLog.push({ k: 'stroke-rec', f: f & 0x3f, x: sx, y: sy, ox: s.ox, oy: s.oy, t: Date.now() });
    if (!btn) { s.done = true; this.postStroke(true); }
  }
  /** the stroke's events not yet posted, to the page (all of it so far at its end) */
  postStroke(force) {
    const s = this.stroke; if (!s) return;
    if (!s.ev.length && !s.done && !force) return;
    post({ t: 'stroke', n: s.n, root: s.root, pop: s.pop, ev: s.ev.splice(0), done: s.done });
    if (s.done) this.stroke = null;
  }
  /** another machine's stroke, from the page: appended to its entry by key (the machine and its number); fed when
   *  no button of this person's is held, into this machine's copy of the window (the object's, or its popup of
   *  that class and title, waited for a moment if it is not up yet) */
  feedStroke() {
    const p = this.proc, q = this.strokes || (this.strokes = []);
    if (!this.rs) {
      if (!q.length || this.btn) return false;
      const s = q[0], now = performance.now();
      // (this person's last events, fed, may not have been taken yet: posted messages are taken before them, so a
      // stroke posted now would come before this person's release. Until the moves fed have been taken, ne16.js
      // hookTaken, or 400 ms)
      if ((this.movesFed || 0) > (p.movesTaken || 0) && now - (this.lastFed || 0) < 100 && now - (s.since || (s.since = now)) < 400) return false;
      let h = s.root;
      if (s.pop) { h = p.findPopup(s.root, s.pop); if (!h) { if ((s.waited = (s.waited || 0) + 1) < 120) return true; q.shift(); return false; } }   // (its popup not up here yet: this person's input waits a while for it)
      const r = p.windowRect(h);
      if (!r) { q.shift(); return false; }
      if (!s.ev.length) return !s.done || (q.shift(), false);   // (nothing of it here yet)
      // (the window the stroke goes to: the one under its first point in the object's window, as the first press
      // found it there, whatever covers it on this screen; the stroke stays with it, as the capture would keep it)
      const [, dx0, dy0] = s.ev[0], target = p.childAt(h, r.x + dx0, r.y + dy0);
      this.rs = Object.assign(q.shift(), { hwnd: h, child: target, ox: r.x, oy: r.y, fed: 0, keys: 0 });
    }
    // (the stroke's events as the mouse messages they would be, posted to its window with its own coordinates, not
    // through the mouse driver: this person's pointer stays where it is, and the program sees the stroke as one of
    // its own. One at a time, the next once the program has taken it: a queue keeps only so many)
    // (as many as the window's queue takes, up to 16 a pass: a post refused by a full queue is kept for the next;
    // the stroke is over once its events are posted and the last has been taken)
    // (the stroke's events through the mouse driver, as this person's own go in, paced the same way, up to lagMax
    // moves ahead of the program taking them (ne16.js hookTaken): posted messages were taken only in part by a
    // program whose window was not the active one. This person's pointer goes with it and comes back at the end)
    const s = this.rs, sw = this.sw, sh = this.sh, max = this.lagMax || 4;
    let at = null;
    while (s.ev.length) {
      const [f, dx, dy] = s.ev[0], sx = Math.max(0, Math.min(sw - 1, s.ox + dx)), sy = Math.max(0, Math.min(sh - 1, s.oy + dy));
      if (f === 1) {
        const taken = p.movesTaken || 0, lag = (this.movesFed || 0) - taken;
        if (lag >= max && performance.now() - (this.lastFed || 0) < 100) break;
        if (lag >= max) this.movesFed = taken;
        this.movesFed = (this.movesFed || 0) + 1;
      }
      const ax = Math.round(sx * 65535 / (sw - 1)), ay = Math.round(sy * 65535 / (sh - 1));
      if (f & ~1) p.mouseEvent16(0x8001, ax, ay);   // (a button at a place: the move there first, as queueMouse sends them: USER takes the button where the cursor is)
      p.mouseEvent16(0x8000 | f, ax, ay); this.lastFed = performance.now();
      let keys = s.keys; if (f & 2) keys |= 1; if (f & 4) keys &= ~1; if (f & 8) keys |= 2; if (f & 16) keys &= ~2;
      s.ev.shift(); s.keys = keys; s.fed++; at = [sx, sy]; s.last = at;
      const c = this.posted || (this.posted = {}); c[f] = (c[f] || 0) + 1;
      if (this.lagLog) this.lagLog.push({ k: 'stroke-fed', f, x: sx, y: sy, t: Date.now() });
    }
    // (where the stroke has got to here, for the page to draw its person's pointer there, on the line as it is drawn)
    if (at) post({ t: 'strokeAt', key: s.key, x: at[0], y: at[1], done: !s.ev.length && s.done });
    // (over once posted: the next stroke's messages follow in the same queue, and this person's own input, which
    // waits meanwhile, comes after posted messages anyway. A program posting to itself, as MFC's idle does, never
    // shows an empty queue, so none is waited for)
    // (a stroke whose end never comes, its sender gone or its parts lost, is let go after 3 s without a part: a
    // release is posted so the program's drag ends, and the next stroke goes in)
    if (!s.ev.length && !s.done) { if (!s.idle) s.idle = performance.now(); else if (performance.now() - s.idle > 3000) { const [lx, ly] = s.last || [s.ox, s.oy], ax = Math.round(lx * 65535 / (sw - 1)), ay = Math.round(ly * 65535 / (sh - 1)); if (s.keys & 1) p.mouseEvent16(0x8004, ax, ay); if (s.keys & 2) p.mouseEvent16(0x8010, ax, ay); s.done = true; } }
    else s.idle = 0;
    if (!s.ev.length && s.done) {   // (its end: this person's pointer back where it is)
      this.rs = null;
      if (this.ax >= 0) p.mouseEvent16(0x8001, this.ax, this.ay);
      return this.feedStroke();
    }
    return true;
  }
  /** the screen's mode, DAC and cursor sprite for the page, which shows the screen from the shared memory */
  postScan() {
    const p = this.proc, a = p.scanout(), sp = p.sprite ? p.sprite() : null;
    // (USER's cursor, beside the sprite: the pointer's hot spot in its image; once the shell is up, USER taking the call)
    if (sp && this.system && !this.shellSeen) try { this.shellSeen = p.nativeWindows().list.some(x => x.cls === 'Progman'); } catch (_) { /* not yet */ }
    let cur = null; if (sp && this.shellSeen && p.cursorPos && !p.depth && !this.ring0()) try { cur = p.cursorPos(); } catch (_) { cur = null; }
    post({ t: 'scan', scan: { w: a.w, h: a.h, pitch: a.pitch || a.w, bpp: a.bpp, dacMode: a.hicolor, attr: Array.from(a.attr.subarray(0, 0x15)), vram: a.vram.byteOffset }, dac: Uint8Array.from(a.dac),
      sprite: sp ? { x: sp.x, y: sp.y, px: sp.px, py: sp.py, cpp: sp.cpp, row: sp.row, at: sp.bits.byteOffset } : null, cur });
  }
  /** the system's first task, MSGSRV32 (its message server: the drivers, SystemStart, then the shell). On the start
   *  after Setup, the items Setup left to it (RunOnce\Setup: GRPCONV's Start menu) run first, under RUNONCE's
   *  "Windows 95 Setup" screen on USER's bare desktop, as Setup's first-run screens run them before the shell;
   *  MSGSRV32 starts when RUNONCE has ended, so the shell and SystemStart come after the screen. False if it cannot start */
  /** the system's first task, MSGSRV32 (its message server: the drivers, SystemStart, then the shell). On the start
   *  after Setup, the items Setup left to it (RunOnce\Setup: GRPCONV's Start menu) run first, under RUNONCE's
   *  "Windows 95 Setup" screen on USER's bare desktop; MSGSRV32 starts when RUNONCE has ended, so SystemStart (which
   *  MSGSRV32 plays before it starts the shell) and the shell come after the screen. False if it cannot start */
  startSystemTask() {
    const p = this.proc, S = self.W95SYSTEM || {}, items = W.regVals('hklm\\software\\microsoft\\windows\\currentversion\\runonce\\setup');
    const exe = items.length && (S.programs || {})['RUNONCE.EXE'] ? ['C:\\WINDOWS\\RUNONCE.EXE', 'C:\\WINDOWS\\SYSTEM\\RUNONCE.EXE'].find(f => fs.exists(f)) : null;
    // (a first start, Setup's items still to run: every program of it is this machine's own to run, whatever session it
    // joins; a machine joining with them held never got its shell, which waits for them)
    this.firstStart = !!items.length;
    if (items.length && this.holdStartup) { this.holdStartup = false; post({ t: 'emit', ev: 'sync.firststart', data: {} }); }
    if (!exe) return this.startMsgsrv();
    p.init16();
    this.loadMpr();   // (before Setup's items: SHELL32 builds its desktop's items once in this address space, and RUNONCE is its first user)
    const pc = this.spawnProgram(exe, '');
    if (typeof pc !== 'object') return this.startMsgsrv();
    const was = pc.onExit; pc.onExit = code => { if (was) was(code); this.sysPending = true; };   // (started from step(), between slices, as at a boot without Setup's items)
    return true;
  }
  /** with a network client installed (NetworkProvider\Order), the Multiple Provider Router comes up before the system's
   *  first task, as Windows loads it at boot: USER's network functions connect to it (SM_NETWORK, which puts Network
   *  Neighborhood on the shell's desktop), and it starts the network's process, MPREXE. Once */
  loadMpr() {
    const p = this.proc; if (this.mprLoaded) return; this.mprLoaded = true;
    if (W.regGet('hklm\\system\\currentcontrolset\\control\\networkprovider\\order', 'ProviderOrder') === undefined) { post({ t: 'mpr', up: false }); return; }
    try {
      p.init16(); const m = p.loadDll('MPR'); if (m) { p.runPendingInits(); p.attach(m); }
      this.blankPasswordList();
      // the network's process, started as KERNEL32 starts it at boot and run to its first wait: it is its start that
      // connects USER's network functions (SM_NETWORK), which the shell reads when it first lays out the desktop
      const exe = ['C:\\WINDOWS\\SYSTEM\\MPREXE.EXE', 'C:\\WINDOWS\\MPREXE.EXE'].find(f => fs.exists(f));
      if (exe) { const pc = this.spawnProgram(exe, ''); if (typeof pc === 'object') p.runUntilIdle(pc, 4000); }
    } catch (e) { console.error(e); }
    post({ t: 'mpr', up: !!p.byName.get('MPR') });   // (the shell's network waits for it: win95.js netBoot)
  }
  /** there is no user to authenticate: the logon's user has a password list with an empty password before MPREXE logs
   *  on, so Windows Logon opens it with no password and asks nothing (Enter Windows Password, Set Windows Password),
   *  and the network client is logged on. MSPWL32 makes it, as Set Windows Password does; a list there already is kept */
  blankPasswordList() {
    // (the name upper-cased, as MPRSERV opens the list with it: under the name as typed, it opened as a wrong password)
    const p = this.proc, v = W.regGet('hklm\\network\\logon', 'username'), user = v && W95FS.decode(v.data).replace(/\0.*$/, '').toUpperCase();
    if (!user) return;
    const m = p.loadDll('MSPWL32'); if (!m) return;
    p.runPendingInits(); p.attach(m);
    const name = p.alloc(264);
    // (GetCacheFileName fails while system.ini's [Password Lists] names no list for the user)
    if (this.call32(m.exports.get('GetCacheFileName'), [user, name, 260]) !== 0 || !fs.exists(p.readA(name))) {
      const h = p.alloc(4), r = this.call32(m.exports.get('CreatePasswordCache'), [h, user, '']);
      if (r === 0) this.call32(m.exports.get('ClosePasswordCache'), [p.r32(h), 1]);
      p.free(h);
    }
    p.free(name);
  }
  /** a flat function of the system's process called on a thread of its own, run to its return before this returns */
  call32(fn, args) {
    const p = this.proc; if (!fn) return null;
    const le32 = v => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    const a = p.alloc(96), res = a + 88, ptr = a + 92, code = [];
    const vals = args.map(v => (typeof v === 'string' ? (() => { const s = p.alloc(v.length + 1); p.writeA(s, v); return s; })() : v));
    for (let i = vals.length - 1; i >= 0; i--) code.push(0x68, ...le32(vals[i]));   // push imm32
    code.push(0xff, 0x15, ...le32(ptr), 0xa3, ...le32(res), 0xc2, 0x04, 0x00);       // call [ptr]; mov [res], eax; ret 4
    p.w32(ptr, fn); p.u8.set(code, a);
    let done = false; const t = p.newThread(a, 0, 0x10000, true, false); t.onDone = () => { done = true; };
    for (let k = 0; k < 2000 && !done && !p.trapped; k++) p.threads16(true);
    const r = done ? p.r32(res) : null;
    p.free(a); for (let i = 0; i < vals.length; i++) if (typeof args[i] === 'string') p.free(vals[i]);
    return r;
  }
  startMsgsrv() {
    const p = this.proc; if (!this.alive || p.trapped) return true;
    this.loadMpr();
    const ok = !!p.startTask16('MSGSRV32.EXE'); if (!ok) this.exited(-1, 'MSGSRV32.EXE did not start');
    return ok;
  }
  /** a diagnostic: the imports the threads whose name matches re call (the JS-implemented ones: KERNEL, USER's
   *  hooks, KERNEL32), with the time and, for WinExec and LoadModule, the command line; cmd 'trace' reads them */
  traceOn(re, names) {
    const p = this.proc, want = new RegExp(re, 'i'), only = names ? new RegExp(names, 'i') : null, log = this.traceLog = [], t0 = performance.now();
    const name = () => { const t = p.thread16; if (!t) return 'host'; const m = t.task && t.task.hInst && p.neByHandle(t.task.hInst); return (m && m.name) || (t.pc && t.pc.path) || String(t.id); };
    // (the command line of WinExec and LoadModule; the key of RegOpenKey, RegCreateKey, RegQueryValue, RegQueryValueEx)
    const STR = { 74: 10, 166: 6, 45: 8, 217: 8, 218: 8, 219: 12, 220: 20, 95: 4, 97: 14, 127: 10, 128: 14, 70: 4, 69: 4 };   // (AddAtom, FindAtom: the name)   // (and the key of GetProfileInt/String, GetPrivateProfileInt/String)
    const arg = key => {
      const m = /KERNEL\.#(\d+)$/.exec(key), o = m && STR[m[1]];
      if (/^VXD\.#/.test(key)) return ['eax', 'ebx', 'ecx', 'edx'].map(r => `${r} ${(p.cpu[r].value >>> 0).toString(16)}`).join(' ');   // (a VxD's API: its function and arguments in the registers)
      try {
        const f = p.cpu.ssb.value + (p.cpu.esp.value & 0xffff);
        if (m && /^(533|534|537)$/.test(m[1])) return [4, 6, 8, 10].map(k => p.r16(f + k).toString(16)).join(' ');   // (the DDE conversions: their stack words)
        if (m && /^(484|485)$/.test(m[1])) { const o = m[1] === '484' ? 8 : 4; return `pid ${p.r32(f + o + 2).toString(16)} off ${(p.r16(f + o) << 16) >> 16}`; }   // (Get/SetProcessDword: the process and the field)
        if (m && /^(458|459|460)$/.test(m[1])) return 'h ' + p.r32(f + (m[1] === '460' ? 8 : 4)).toString(16);   // (Set/ResetW32Event, WaitForSingleObject: the handle)
        if (m && m[1] === '128') { const s = k => { const v = p.r32(f + k); return v >>> 16 ? p.readA(p.lin(v)) || '' : '#' + v; }; return `[${s(22)}] ${s(18)} (${s(4)})`; }   // (GetPrivateProfileString: the section, the key, the file)
        if (m && /^(49|60|61|64|65|81|82|84|85)$/.test(m[1])) return [4, 6, 8, 10, 12].map(k => p.r16(f + k).toString(16)).join(' ') + (m[1] === '85' ? ' ' + p.readA(p.lin(p.r32(f + 6))) : '');   // (the file and resource calls: their stack words; _lopen's name)
        if (m && /^(334|335|336|337|346|347)$/.test(m[1])) { const w = m[1] === '336' ? 0 : /^34/.test(m[1]) ? 4 : 2, sp = p.r32(f + 4 + w); return `${sp.toString(16)} n ${w ? (w === 4 ? p.r32(f + 4) : p.r16(f + 4)) : 1}`; }   // (IsBadReadPtr, IsBadWritePtr, IsBadCodePtr, IsBadStringPtr, the huge ones: the pointer and size)
        if (m && m[1] === '457') return 'manual ' + p.r32(f + 8) + ' set ' + p.r32(f + 4) + ' -> h ' + ((p.nextHandle || 0) >>> 0).toString(16);   // (CreateW32Event)
        if (m && m[1] === '461') { const n = p.r32(f + 16), ph = p.lin(p.r32(f + 12)); return [...Array(Math.min(n, 8))].map((_, i) => p.r32(ph + 4 * i).toString(16)).join(' ') + ' ms ' + p.r32(f + 4); }   // (WaitForMultipleObjects: the handles)
        if (m && m[1] === '18') { const h = p.r16(f + 4), b = p.gblock && p.gblock(h); let t = ''; try { t = b ? ' "' + (p.readA(b.lin, 60) || '').replace(/[^\x20-\x7e]/g, '.') + '"' : ''; } catch (_) {} return 'h' + h.toString(16) + t; }   // (GlobalLock: the block's text)
        if (m && /^(71|72)$/.test(m[1])) return 'atom ' + p.r16(f + (m[1] === '72' ? 10 : 4)).toString(16) + ' ds ' + (p.cpu.ds.value & 0xffff).toString(16);   // (DeleteAtom, GetAtomName: the atom, and whose table)
        if (m && /^(69|70)$/.test(m[1])) { const sp = p.r32(f + 4); return (sp >>> 16 ? p.readA(p.lin(sp)) : '#' + (sp & 0xffff)) + ' ds ' + (p.cpu.ds.value & 0xffff).toString(16); }
        if (!o) return '';
        const s = p.r32(f + o); return s >>> 16 ? p.readA(p.lin(s)) || '' : '';
      } catch (_) { return ''; }
    };
    const svm = p.setVideoMode; p.setVideoMode = function (mode, clear, hi) { log.push([Math.round(performance.now() - t0), name(), 'int10 mode', (mode & 0xff).toString(16) + (hi ? ' hicolor ' + hi : '')]); return svm.call(this, mode, clear, hi); };
    self.W95TRACE16 = t => { const th = name(); if (log.length < 20000 && want.test(th) && (!only || only.test(t.key))) log.push([Math.round(performance.now() - t0), th, t.key, arg(t.key)]); };
    // (the key or value name of the registry calls: the second argument on a stdcall frame at entry)
    const arg32 = t => {
      try {
        if (t.nm === '#18') return `pid ${p.r32(p.reg('esp') + 4).toString(16)} off ${p.r32(p.reg('esp') + 8) | 0}`;   // (GetProcessDword)
        if (/^Global(Alloc|ReAlloc|Lock|Unlock|Free|Size)$/.test(t.nm)) {   // (the block's handle, sizes and flags, and its text)
          const a = k => p.r32(p.reg('esp') + 4 * k) >>> 0, h = t.nm === 'GlobalAlloc' ? 0 : a(1);
          const txt = h > 0x10000 && h < p.u8.length ? ' "' + (p.readA(h, 48) || '').replace(/[^\x20-\x7e]/g, '.') + '"' : '';
          return t.nm === 'GlobalAlloc' ? `flags ${a(1).toString(16)} n ${a(2)}` : t.nm === 'GlobalReAlloc' ? `h ${h.toString(16)} n ${a(2)} flags ${a(3).toString(16)}${txt}` : `h ${h.toString(16)}${txt}`;
        }
        if (/^Global(Add|Find)AtomA$/.test(t.nm)) { const sp = p.r32(p.reg('esp') + 4); return sp >>> 16 ? p.readA(sp) || '' : '#' + sp; }
        if (/^(LoadLibraryA|GetPrivateProfileSectionA|GetPrivateProfileStringA|FindFirstFileA|CreateFileA|GetFileAttributesA|DeleteFileA|MoveFileA|GetModuleHandleA|WritePrivateProfileStringA|CreateDirectoryA)$/.test(t.nm)) { const sp = p.r32(p.reg('esp') + 4); return sp > 0x10000 && sp < p.u8.length ? p.readA(sp) || '' : String(sp); }
        if (t.nm === 'GetProcAddress') { const sp = p.r32(p.reg('esp') + 8); return sp > 0x10000 && sp < p.u8.length ? p.readA(sp) || '' : '#' + sp; }
        if (!/^Reg(Open|Create|Query|Enum)/.test(t.nm)) return '';
        const s = p.r32(p.reg('esp') + 8); return s > 0x10000 && s < p.u8.length ? p.readA(s) || '' : String(s);
      } catch (_) { return ''; }
    };
    // (and where the call came from: the module and offset of its return address)
    const caller = () => { try { return p.whereOf(p.r32(p.reg('esp'))); } catch (_) { return ''; } };
    self.W95TRACE = t => { const th = name(); if (log.length < 20000 && want.test(th) && (!only || only.test(t.dll + '!' + t.nm))) log.push([Math.round(performance.now() - t0), th, t.dll + '!' + t.nm, arg32(t), caller()]); };
    self.W95APPYTRACE = e => { if (log.length < 20000) log.push([Math.round(performance.now() - t0), name(), 'appy', (e.fn >>> 0).toString(16)]); };
  }
  ring0() { return !!(this.proc && this.proc.r0Runs && this.proc.r0Runs.length); }
  feedKeys() {
    const p = this.proc;
    if (!this.keyq.length || p.depth || this.ring0() || this.focusing) return;   // (a window being brought to the front first: 'focus')   // (the keyboard and mouse drivers report at interrupt time)
    try { if (p.inputPending()) return; } catch (e) { console.error(e); }   // USER has input not yet taken
    for (let n = 0; this.keyq.length && n < 16; n++) {
      const k = this.keyq.shift(); if (!n && p.personInput) try { p.personInput(); } catch (e) { this.r0Fault(e); } p.personActed = true;
      if (this.lagLog) this.lagLog.push({ k: 'key-fed', vk: k[0], up: k[2], t: Date.now() });
      try { p.keyEvent16(k[0], k[1] & 0xff, k[2], k[1] > 0xff); } catch (e) { this.r0Fault(e); }
    }
  }
  step() {
    clearTimeout(this.timer); this.timer = 0;
    if (!this.alive) return;
    const p = this.proc, t0 = performance.now();
    try { this.poll(); } catch (e) { if (!(e instanceof W.FaultError)) throw e; }   // (recorded by r0Fault, answered below)
    if (p.r0Runs && p.r0Runs.length) {
      try { p.r0Step(); } catch (e) { console.error(e && e.stack ? e.stack : e); this.exited(-1, e.message); return; }
      this.sendText();
      if (!(p.r0Runs && p.r0Runs.length) && this.afterR0) { const go = this.afterR0; this.afterR0 = null; go(); }
      if (this.alive) this.timer = setTimeout(() => this.step(), 16);
      return;
    }
    if (this.stopped) return;
    if (this.sysPending && !p.depth && !p.thread16) { this.sysPending = false; if (!this.startMsgsrv()) return; }   // Setup's items done: the system's first task
    if (this.wantMode && !p.depth && !p.thread16 && !p.win16Held) {   // the mode the page asked for while a thread held USER: made now that none does
      const [w, h] = this.wantMode; this.wantMode = null; const r = this.setMode(w, h); if (r) post({ t: 'mode', r }); else this.wantMode = [w, h];
    }
    if (!p.win16Held && p.k32CloseRequest && p.k32CloseRequest()) post({ t: 'closeProgram' });   // REBOOT's APC: Close Program
    try {
      this.feedMouse(); this.feedKeys();   // (a fault in the drivers' handling of it, r0Fault, answered below as any other)
      // (four slices a step; up to ten, within 12 ms of the step, while input waits to go in: a person drawing, or
      // another machine's stroke being fed, gets the program its moves at the pace they come)
      const busy = () => this.mouseq.length || this.rs || (this.strokes && this.strokes.length);
      for (let n = 0; this.alive && (n < 4 || (n < 10 && busy() && performance.now() - t0 < 12)); n++) {
        if (n) { this.poll(); this.feedMouse(); this.postScan(); }
        p.stats.slices++; const live = p.slice();
        if (!p.win16Held) { p.timers16(); p.systemPump(); p.appy16(); p.threads16(); }
        else { p.threads16(); if (p.vxdRunTimeOuts) p.vxdRunTimeOuts(); }
        if (p.sound16) p.sound16(); if (p.lanPoll) p.lanPoll();
        if (!live || p.preempted || p.win16Held) break;
      }
    } catch (e) {
      if (e instanceof W.FaultError) { p.depth = 0; p.faulted(e.fault); }
      else if (!(e instanceof W.HangError)) { console.error(e && e.stack ? e.stack : e); this.exited(-1, e.message); return; }
      else { p.hung('host', e); p.depth = 0; }
    }
    p.stats.guestMs += performance.now() - t0;
    if (p.fault && !this.faultTaken) {
      this.faultTaken = true;
      if (p.fault.ring === 0) { this.fatal(p.fault); if (this.alive) this.timer = setTimeout(() => this.step(), 16); return; }
      this.stopped = true; post({ t: 'fault', f: p.fault }); return;
    }
    for (const f of (p.pcFaults || []).splice(0)) { f.pc.fault = true; this.faultBox(f); }
    if (p.trapped && !p.failed) p.fail(p.trapped);
    if (p.exitCode !== null || p.trapped) { this.exited(p.exitCode, p.trapped); return; }
    if (!p.win16Held) this.frame();
    else {   // (who holds it: the main thread, or a thread with its id, program, state, what it waits on, where it stopped)
      const w = p.win16Held.who, t = typeof w === 'object' ? w : null, cs = t && t.ctx ? t.ctx.cs & 0xffff : null;
      const who = t ? { id: t.id, path: t.pc ? t.pc.path : null, state: t.state, blocked: !!t.blocked, wait: t.wait ? { set: !!t.wait.set } : null,
        preempted: !!t.preempted, cs, ip: t.ctx ? (t.ctx.eip >>> 0) : null } : w;
      post({ t: 'held', held: { hung: p.win16Held.hung, who, since: p.win16Held.since }, stats: { ...p.stats } }); this.postScan();
    }   // (no USER while a thread holds the lock: the page learns it is held, and has the screen)
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
    let nw; try { nw = p.nativeWindows(); } catch (e) { console.error(e && e.stack ? e.stack : e); this.exited(-1, e.message); return; }
    const a = p.scanout(), sp = p.sprite ? p.sprite() : null;
    let bg = 0; try { const c = p.user16(180, [['w', 1]]); bg = (c.dx & 0xff) << 16 | (c.ax & 0xffff); } catch (e) { console.error(e); }
    for (const w of nw.list) { const pc = w.task && [...(p.procs || new Map()).values()].find(c => c.tdb === w.task); w.prog = pc ? basename(pc.path).toUpperCase() : null; }
    // a Windows 3.x program started here: its first top-level window comes to the front, as USER brings forward the
    // first window a starting program shows (a 32-bit one's is, USER told of its start: pcStart); without it a game
    // opened behind the window that started it (ne16.js LoadModule: fgWanted)
    if (p.fgWanted && p.fgWanted.size) for (const w of nw.list) if (p.fgWanted.has(w.task) && !w.owner && w.title) { p.fgWanted.delete(w.task); this.onWindow('SetForegroundWindow', [w.hwnd]); }
    const pixels = [], win32 = [];
    const addWin32Windows = (proc, preview = false) => { for (const w of proc.windows.values()) {
      if (w.kind !== 'window' || (w.child && !w.previewChild) || (!(w.style & 0x10000000) && !w.hostPreview) || !w.ctx) continue;
      const [x, y] = proc.absPos(w);
      let data;
      try { data = new Uint8ClampedArray(w.ctx.getImageData(0, 0, w.w, w.h).data); } catch (_) { continue; }
      pixels.push(data.buffer); w._postedSurfaceVersion = w.surfaceVersion;
      win32.push({ hwnd: w.hwnd, key: `w32:${w.hwnd}`, win32: true, x, y, w: w.w, h: w.h,
        title: w.title || '', cls: w.cls && w.cls.name || '', owner: 0, ownerPid: w.pc && w.pc.pid || 0, iconic: false, task: 0, ex: w.ex || 0, parent: w.parent || 0, preview: !!w.previewChild || preview, pixels: data });
    } };
    addWin32Windows(p);
    post({ t: 'frame', list: [...nw.list, ...win32], active: nw.active, capture: nw.capture, cursorOn: this.cursorOn,
      scan: { w: a.w, h: a.h, pitch: a.pitch || a.w, bpp: a.bpp, dacMode: a.hicolor, attr: Array.from(a.attr.subarray(0, 0x15)), vram: a.vram.byteOffset }, dac: Uint8Array.from(a.dac), bg,
      sprite: sp ? { x: sp.x, y: sp.y, px: sp.px, py: sp.py, cpp: sp.cpp, row: sp.row, at: sp.bits.byteOffset } : null,
      stats: { ...p.stats }, held: p.win16Held ? { hung: p.win16Held.hung } : null,
      input: { taken: this.ringTaken || 0, mouse: this.mouseq.length } }, pixels);   // (the input it has taken from the ring, and the mouse events not yet fed)
    this.clip();
  }
  sendText(force) {
    const t = this.proc && this.proc.txt; if (!t || (!force && t.gen === this.txtGen)) return;
    this.txtGen = t.gen; post({ t: 'text', txt: { cols: t.cols, rows: t.rows, ch: t.ch.slice(), at: t.at.slice(), cur: t.cur, gen: t.gen } });
  }
  // WinExec and CreateProcess from the program: a program the system runs starts in this machine (P.spawn)
  exec(cmd, show) {
    if (this.traceLog) this.traceLog.push([Math.round(performance.now()), 'host', 'exec', `${cmd} (show ${show})`]);   // (a trace: every program start, with its command line)
    const m = /^\s*(?:"([^"]+)"|(\S+))\s*(.*)$/.exec(cmd || ''); if (!m) return 2;
    let path = m[1] || m[2]; const arg = m[3];
    if (!extname(path)) path += '.exe';
    const file = (/^[a-z]:|^\\/i.test(path) ? [path] : [join('C:\\WINDOWS', path), join('C:\\WINDOWS\\SYSTEM', path), join(fs.cwd, path)]).find(f => fs.exists(f));
    if (!file) return 2;
    // (a machine joining a shared session: a program the shell starts as Windows starts is the session's to start, if
    // the session runs it; the system's own still start)
    // (and Setup's first-start programs, which each machine runs itself, osclass.js derived: RUNONCE's GRPCONV makes
    // the Start menu over DDE with the shell, which waits for it)
    if (this.holdStartup && !/^(SYSTRAY|MPREXE|MMTASK|RUNDLL32|EXPLORER|MSGSRV32|RUNONCE|GRPCONV|SETUP|SUWIN)\.(EXE|TSK)$/i.test(basename(file))) return { elsewhere: true };
    // a Windows (16-bit) program of the system's: a task of this machine's, as KERNEL's WinExec starts one
    // (the file the bundle's module was made from: another program of that name is one from disk)
    let ne = Object.values((self.W95SYSTEM || {}).ne || {}).find(d => d.fileName === basename(file).toUpperCase() && /\.EXE$/.test(d.fileName));
    if (ne && fs.exists(file)) { try { if (sha256(fs.readFile(file)) !== ne.meta.sha256) ne = null; } catch (_) { /* as the bundle has it */ } }
    if (ne) return this.proc.winExec16(ne.fileName, arg || '', show === undefined ? 1 : show);
    // (one from disk the bundle does not carry: the same, its module mapped by KERNEL's loader; its instance, else the error)
    if (!this.bundled(file) && this.isNE(file)) return this.proc.winExec16(fs.realpath(file), arg || '', show === undefined ? 1 : show);
    // an MS-DOS program (or a .PIF or .BAT): KERNEL starts WinOldAp for it, as KRNL386's LoadModule does for a file
    // that is no Windows module, its command line the program's arguments, a NUL, then the program and a line feed
    // (WINOA386.MOD 2:1C1E)
    const woa = 'C:\\WINDOWS\\SYSTEM\\WINOA386.MOD';
    if (this.isDosProgram(file) && fs.exists(woa)) {
      let sp = file; try { sp = fs.stat(file).shortPath; } catch (_) { /* as given */ }
      return this.proc.winExec16(woa, `${arg || ''}\0${sp}\n`, show === undefined ? 1 : show);
    }
    const r = this.spawnProgram(file, arg);
    // WinExec's NE scheduler expects a process record with a 16-bit main thread. SCRs
    // are advanced independently as Win32 processes, so report successful launch
    // without handing that scheduler an incompatible process object.
    if (/\.SCR$/i.test(file) && r && typeof r === 'object') return r;
    // a second instance of a program: its image's place here is taken, so it starts in a machine of its own, as the
    // page starts one (runNative); this process gets no handle on it
    if (r === 8 && this.system) { rpc('host', 'runApart', [file, arg]); return { elsewhere: true }; }
    return r;
  }
  // the bundle's translation of the program in the file: the one made from these very bytes (its SHA-256, under any
  // name), as the page finds one (win95.js nativeProgram). By name alone, the Windows 98 CD's AUTORUN.EXE ran the
  // Windows 95 CD's translated code over its own image
  bundled(file) {
    const progs = (self.W95SYSTEM || {}).programs || {}, name = basename(file).toUpperCase();
    let b; try { b = fs.readFile(file); } catch (_) { return null; }
    const sha = sha256(b);
    if (progs[name] && progs[name].meta.sha256 === sha) return progs[name];
    return Object.values(progs).find(d => d.meta.sha256 === sha) || null;
  }
  spawnProgram(file, arg, o = {}) {
    const p = this.proc;
    if (/\.SCR$/i.test(file)) return this.spawnSaver(file, arg || '');
    const name = basename(file).toUpperCase(), d = this.bundled(file) || this.dynProgram(file);
    // (a Windows 3.x program the bundle does not carry: started as WinExec starts one, its module mapped by KERNEL's
    // loader and its code translated as it runs, ne16.js loadNEDynamic)
    if (!d && this.isNE(file)) { const r = p.winExec16(fs.realpath(file), arg || '', 1); this.kick(); return r > 32 ? { ok: true } : r; }
    if (!d) return 11;
    if (p.pc0 && p.pc0.exe && p.pc0.exe.base === d.meta.base) return 8;   // (the machine's own program: one instance)
    let pc;
    try {
      const mod = d.dynamic ? null : d.modSync || (d.modSync = new WebAssembly.Module(b64bytes(d.wasm))), real = fs.realpath(file);
      // (its command line names it in quotes when its path has a space in it: unquoted, the C run-time split
      // "C:\Program Files\Accessories\MSPAINT.EXE" there, and MFC opened "Files\...\MSPAINT.EXE" as a document)
      const prog = /\s/.test(real) ? `"${real}"` : real;
      pc = p.spawn(fs.readFile(file), mod, { ...d.meta, name: name.replace(/\.EXE$/, '') }, real, arg ? `${prog} ${arg}` : prog);
    } catch (e) { if (e && e.missingDll) { W.log('warn', 'spawn', e.message); return 2; } console.error(e); return 8; }   // (2: a DLL it needs is missing, as WinExec answers)
    // (its console: the MS-DOS machine's window it was started from, o.console, told when the program ends)
    if (o.console !== undefined) pc.console = o.console;
    pc.onExit = code => { if (!pc.fault) post({ t: 'emit', ev: 'program.exit', data: { path: pc.path, code } }); if (pc.console !== undefined) post({ t: 'conExit', id: pc.console, code: code >>> 0 }); };
    this.kick();
    return pc;
  }
  // a Win32 program the bundle does not carry: its image as the loader maps one (the base its header prefers, in its
  // process's own view where other programs are; else, when it can be relocated, in the arena the system's modules
  // leave free), its code translated as it runs (dyn.js); null when it is no Win32 program or has no room
  /** a 32-bit DLL's export names by ordinal from its .def (EXPORTS name @n) or .map file (its exports' "ordinal name"
   *  lines), looked for where its loader looks for the DLL; empty when there is neither (cmd 'watch') */
  ordNames(m) {
    if (m.ordNames) return m.ordNames;
    const out = m.ordNames = new Map(), read = f => { try { return W95FS.decode(fs.readFile(f)); } catch (_) { return null; } };
    for (const dir of ['C:\\WINDOWS\\SYSTEM', 'C:\\WINDOWS', ...[...(this.proc.procs || new Map()).values()].map(c => String(c.path || '').replace(/\\[^\\]*$/, ''))]) {
      const def = read(`${dir}\\${m.name}.DEF`), map = !def && read(`${dir}\\${m.name}.MAP`);
      if (def) { let on = false; for (const l of def.split(/\r?\n/)) { if (/^\s*EXPORTS\b/i.test(l)) { on = true; continue; } if (/^\s*[A-Z]+\s*$/.test(l)) on = false; const x = on && /^\s*([^\s=;][^\s=]*?)(?:\s*=\s*\S+)?\s+@\s*(\d+)/.exec(l); if (x) out.set(+x[2], x[1]); } }
      if (map) { let on = false; for (const l of map.split(/\r?\n/)) { if (/ordinal\s+name/i.test(l)) { on = true; continue; } const x = on && /^\s*(\d+)\s+(\S+)/.exec(l); if (x) out.set(+x[1], x[2]); } }
      if (def || map) break;
    }
    return out;
  }
  /** an MS-DOS program as KRNL386's loader tells one: a .COM, .BAT or .PIF, or an MZ file whose new header (at 3Ch, when
   *  its relocation table starts at 40h or later) is no Windows module's (NE, PE, LE, LX) */
  isDosProgram(file) {
    if (/\.(COM|BAT|PIF)$/i.test(file)) return true;
    let f; try { f = fs.readFile(file); } catch (_) { return false; }
    if (f.length < 0x1c || f[0] !== 0x4d || f[1] !== 0x5a) return false;
    if ((f[0x18] | f[0x19] << 8) < 0x40 || f.length < 0x40) return true;
    const at = (f[0x3c] | f[0x3d] << 8 | f[0x3e] << 16 | f[0x3f] << 24) >>> 0;
    return !(at + 2 <= f.length && /^(NE|PE|LE|LX)$/.test(String.fromCharCode(f[at], f[at + 1])));
  }
  isNE(file) {
    let f; try { f = fs.readFile(file); } catch (_) { return false; }
    if (f.length < 0x40 || f[0] !== 0x4d || f[1] !== 0x5a) return false;
    const at = (f[0x3c] | f[0x3d] << 8 | f[0x3e] << 16 | f[0x3f] << 24) >>> 0; return at + 2 <= f.length && f[at] === 0x4e && f[at + 1] === 0x45;
  }
  dynProgram(file) {
    let f; try { f = fs.readFile(file); } catch (_) { return null; }
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
    if (f.length < 0x40 || dv.getUint16(0, true) !== 0x5a4d) return null;
    const pe = dv.getUint32(0x3c, true); if (pe + 0x78 > f.length || dv.getUint32(pe, true) !== 0x4550) return null;
    const opt = pe + 24, pref = dv.getUint32(opt + 28, true), size = dv.getUint32(opt + 56, true), ep = dv.getUint32(opt + 16, true);
    const relocs = !(dv.getUint16(pe + 22, true) & 1) && dv.getUint32(opt + 96 + 5 * 8 + 4, true) > 0;
    // (its preferred base over other programs' images, in a view of its own, as each Windows 95 process has its own
    // arena: win32.js arenaClaim. Refused only where the system's modules are, 16-bit modules' segments counted too)
    const p = this.proc, base = p.imageRoom(pref, size, relocs, true);
    if (!base) { W.log('warn', 'spawn', `${file}: no room for its image at ${pref.toString(16)} (${relocs ? 'relocatable' : 'no relocations'})`); return null; }
    return { dynamic: true, meta: { base, entry: base + ep, textLo: 0, textHi: 0, blocks: [], size } };
  }
  async spawnSaverAsync(file, arg) {
    const savers = (self.W95SAVERS || {}).savers || {};
    const hit = self.W95SaverRuntime.findSaver(file, savers);
    if (!hit) return 11;
    const [name, d] = hit, bytes = fs.readFile(file);
    if (!await self.W95SaverRuntime.matchesImage(bytes, d)) return 11;
    const mod = await self.W95SaverRuntime.compileModule(d);
    return this.spawnSaver(file, arg, mod, name, bytes);
  }
  spawnSaver(file, arg, compiledModule = null, bundleName = null, imageBytes = null) {
    const p = this.proc, bytes = imageBytes || fs.readFile(file), savers = (self.W95SAVERS || {}).savers || {};
    // (by its long name: Display Properties starts it by the short one, 3DFLYI~1.SCR)
    const hit = bundleName ? [bundleName, savers[bundleName]] : self.W95SaverRuntime.findSaver(fs.realpath(file), savers);
    if (!hit) return 11;
    const [name, d] = hit;
    for (const run of [...this.savers.values()]) p.endProcess(run, 0);
    const mode = /^\s*\/p\b/i.test(arg) ? 'p' : /^\s*\/c\b/i.test(arg) ? 'c' : 's';
    // with the machine's own USER32 (the system's), the saver runs on it as Windows runs one: the command line its
    // starter gave (/p hwnd: Display Properties' monitor window, which the saver's window is a child of; /c:hwnd),
    // its windows USER's, drawn by GDI on the screen
    const u32 = p.byName && p.byName.get('USER32'), isWin = u32 && u32.exports.get('IsWindow');
    const named = mode === 'p' ? parseInt((/\/p\s*:?\s*(\d+)/i.exec(arg) || [])[1] || '0', 10) : 0;
    const native = !!isWin && (mode !== 'p' || (named > 0 && !!p.call(isWin, [named])));
    const real = fs.realpath(file), cmdline = native ? `"${real}" ${arg.trim() || '/s'}` : `"${real}" ${mode === 'p' ? '/p' : mode === 'c' ? '/c:0' : '/s'}`;
    try {
      const mod = compiledModule || d.modSync || (d.modSync = new WebAssembly.Module(b64bytes(d.wasm)));
      const rebound = [];
      for (const dll of native ? [] : ['USER32', 'GDI32', 'OPENGL32', 'GLU32']) {
        const native = p.loadDll(dll), api = W.API[dll];
        if (!native || !api) continue;
        for (const fn of Object.keys(api)) {
          const address = native.exports.get(fn);
          if (!address) continue;
          rebound.push([native, fn, address]); native.exports.set(fn, p.thunkFor(dll, fn));
        }
      }
      let pc;
      try { pc = p.spawn(bytes, mod, { ...d.meta, name: name.replace(/\.SCR$/, '') }, real, cmdline); }
      finally { for (const [native, fn, address] of rebound) native.exports.set(fn, address); }
      const run = { pid: pc.pid, path: real, mode, pc, previewHwnd: 0 };
      pc.onExit = code => {
        this.savers.delete(pc.pid);
        post({ t: 'emit', ev: 'program.exit', data: { path: pc.path, mode, code,
          ...(pc.trapped || pc.main && pc.main.fault ? { why: pc.trapped || pc.main.fault.why } : {}),
          threadExit: pc.main && pc.main.exitCode, ...(pc.exitDebug ? { exitDebug: pc.exitDebug } : {}),
          ...(pc.commandLineSeen ? { commandLineSeen: pc.commandLineSeen } : {}),
          ...(pc.versionInfoSeen ? { versionInfoSeen: pc.versionInfoSeen, saverPlatformFlag: p.r32(pc.exe.base + 0x19980) } : {}),
          ...(pc.messageDebug ? { messageDebug: pc.messageDebug } : {}),
          ...(pc.user32Calls ? { user32Calls: pc.user32Calls } : {}),
          ...(pc.isWindowCalls ? { isWindowCalls: pc.isWindowCalls } : {}) } });
      };
      if (mode === 'p' && !native) {
        const parent = self.W95SaverRuntime.createPreviewWindow(152, 104);
        parent.hwnd = p.newHandle(parent); run.previewHwnd = parent.hwnd;
        p.windows.set(parent.hwnd, parent);
        const previewCmd = `"${real}" /p ${parent.hwnd}`;
        pc.cmdPtr = p.alloc(previewCmd.length + 1); p.writeA(pc.cmdPtr, previewCmd);
      }
      pc.previewHwnd = run.previewHwnd;
      if (mode === 'p' && !native) pc.previewKey = `w32:${run.previewHwnd}`;
      pc.saverMode = mode; pc.nativeGdi = native;
      this.savers.set(run.pid, pc); this.kick();
      return pc;
    } catch (e) { console.error(e); return 8; }
  }
  endSaver(pid, code = 0) {
    const run = this.savers.get(pid); if (!run) return false;
    this.proc.endProcess(run, code); return true;
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
  /** a program's fault: KERNEL32's fault dialog (its dialog 1) in this machine, on a thread of the system's own, as
   *  Windows 95 shows it, with the system's screen and pointer (the page drew one of its own over the machine's
   *  screen, and two pointers fought over it); the page told it ended. Shown by the page only when this machine cannot
   *  show it (no KERNEL32 resources, no USER32 here) */
  faultBox(f) {
    const p = this.proc, S = self.W95SYSTEM || {}, W = self.W95Win32, path = f.pc.path || '';
    const k32 = this.k32Res || (this.k32Res = S.res && S.res['KERNEL32.DLL'] ? b64bytes(S.res['KERNEL32.DLL']) : null);
    const tmpl = k32 && W.peResource(k32, 5, 1), user = p.byName && p.byName.get('USER32');
    const prog = basename(path).replace(/\.[^.]*$/, '').toUpperCase();
    post({ t: 'pcFault', path, why: f.why, f: f.fault || null, shown: !!(tmpl && user) });
    if (!tmpl || !user) return;
    const text = W.peString(k32, 104) || 'This program has performed an illegal operation and will be shut down.';
    const details = (f.fault ? W.faultText(k32, prog, f.fault) : String(f.why || '')).replace(/\r?\n/g, '\r\n');
    const tb = p.alloc(tmpl.length + 4), t = (tb + 3) & ~3, strs = [prog, text, details].map(s => { const a = p.alloc(s.length + 1); p.writeA(a, s); return a; });
    const blk = p.alloc(12); strs.forEach((a, i) => p.w32(blk + 4 * i, a)); p.u8.set(tmpl, t);   // (the template DWORD-aligned, as USER reads it)
    const free = () => { for (const a of [tb, blk, ...strs]) p.free(a); };
    // (an instance a module of this machine's has: USER32's, as KERNEL32's own is a module here only in its resources;
    // 0 was USER's parameter error 6022)
    this.netCall('DialogBoxIndirectParamA', [user.base, t, 0, p.thunkFor('KERNEL32', 'FaultDlgProc'), blk], 'USER32').then(free, free);
  }
  /** the taskbar's window (Explorer's Shell_TrayWnd), the owner of what the Start menu opens; 0 before the shell is up */
  trayHwnd() { try { const w = this.proc.nativeWindows().list.find(x => x.cls === 'Shell_TrayWnd'); return w ? w.hwnd : 0; } catch (_) { return 0; } }
  /** until the shell's desktop (Progman, the window SetShellWindow names) is up, as Windows starts: a program started
   *  before it that opens a folder (Control Panel: SHELL32's ShellExecuteEx with an ID list) finds no shell and starts
   *  another Explorer, which made a second desktop and taskbar */
  async shellUp() {
    const up = () => { try { return this.proc.nativeWindows().list.some(x => x.cls === 'Progman'); } catch (_) { return false; } };
    for (let i = 0; i < (this.firstStart ? 1800 : 400) && !up(); i++) await new Promise(r => setTimeout(r, 50));   // (a first start takes its time under Setup's screen: the session's programs start after it)
  }
  /** USER32's `name` on a window (args[0]), made only while it is one (netBatch ifWindow) */
  onWindow(name, args) { return this.netBatch([{ dll: 'USER32', name, args, ifWindow: args[0] }]).then(r => r && r[0]); }
  netCall(name, args = [], dll = 'MPR') { return this.netBatch([{ dll, name, args }]).then(r => r && r[0]); }
  /** exports called one after another on one new thread of this process, each [dll, name, dword or string args]; their
   *  results, null when one is not there. The thread waits as a program's thread does (a SendMessage to another
   *  thread's window waits at its own top level), where a call made from the host would wait inside the host's call */
  netBatch(calls, remote = false) {
    // (KERNEL32's are this personality's, through their thunks; remote: the thread applies another machine's intent,
    // and makes none of its own, ne16.js intentQuiet)
    // (a call with `ifWindow`: made only while that window is one, as IsWindow says when its turn comes, else its
    // result 0; a window gone since the call was asked for (a dialog closed while its controls are read) is no
    // parameter error of USER's)
    const p = this.proc, le32 = v => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    // (a DLL of the personality's (KERNEL32, and any other with no image here): its stand-in, through its thunk)
    const fns = calls.map(c => { const m = p.byName.get(c.dll); if (m && m.exports.get(c.name)) return m.exports.get(c.name); return W.API[c.dll] && W.API[c.dll][c.name] ? p.thunkFor(c.dll, c.name) : 0; });
    const u32m = p.byName.get('USER32'), isWin = u32m && u32m.exports.get('IsWindow');
    if (!calls.length || fns.some(f => !f) || (calls.some(c => c.ifWindow) && !isWin)) return Promise.resolve(null);
    const strs = [], code = [], n = calls.length, size = (n + 1) * 8 + calls.reduce((s, c) => s + 5 * c.args.length + 11 + (c.ifWindow ? 19 : 0), 0) + 3;
    const a = p.alloc(size), ptrs = a + size - (n + 1) * 8, res = ptrs + (n + 1) * 4, isWinAt = ptrs + 4 * n;   // (the code, then the functions' addresses, then the results)
    p.w32(isWinAt, isWin || 0);
    calls.forEach((c, k) => {
      const vals = c.args.map(v => (typeof v === 'string' ? (() => { const s = p.alloc(v.length + 1); p.writeA(s, v); strs.push(s); return s; })() : v));
      if (c.ifWindow) code.push(0x68, ...le32(c.ifWindow), 0xff, 0x15, ...le32(isWinAt), 0x85, 0xc0, 0x0f, 0x84, ...le32(5 * vals.length + 6));   // push hwnd; call [IsWindow]; test eax, eax; jz (to the result: 0)
      for (let i = vals.length - 1; i >= 0; i--) code.push(0x68, ...le32(vals[i]));            // push imm32
      code.push(0xff, 0x15, ...le32(ptrs + 4 * k), 0xa3, ...le32(res + 4 * k));                // call [ptr]; mov [res], eax
      p.w32(ptrs + 4 * k, fns[k]);
    });
    code.push(0xc2, 0x04, 0x00);                                                               // ret 4
    p.u8.set(code, a);
    return new Promise(ok => { const t = p.newThread(a, 0, 0x10000, true, false); t.remote = remote; t.onDone = () => { const r = calls.map((_, k) => p.r32(res + 4 * k)); p.free(a); for (const s of strs) p.free(s); ok(r); }; this.kick(); });
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
    p.free(cnt); p.free(sz); p.free(buf); p.free(ph); if (nr) { for (const o of [20, 24, 28]) if (p.r32(nr + o)) p.free(p.r32(nr + o)); p.free(nr); }
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
  /** debugging: each thread (its state, its task's or process's name, what it waits on, where it stopped as a module
   *  and offset) and who holds the Win16Lock */
  probe() {
    const p = this.proc, S = self.W95SYSTEM || {};
    this.probe.whereOf = lin => where(lin);
    const segs = []; for (const d of Object.values(S.ne || {})) for (const g of (d.meta && d.meta.segs) || []) segs.push([d.meta.name, g.num, g.base, g.len]);
    // (an address as module, export and offset, win32.js whereOf; a system module's segment not loaded here by its build's place)
    const where = lin => { const w = p.whereOf(lin); if (!/^[0-9a-f]+$/.test(w)) return w; lin = lin >>> 0; for (const [n, num, b, l] of segs) if (lin >= b && lin < b + l) return `${n} ${num}:${(lin - b).toString(16)}`; return w; };
    const stack = (ctx) => {   // far return addresses on a 16-bit stack, innermost first
      if (!ctx || !ctx.ss) return [];
      const out = [], base = p.selBase(ctx.ss), sp = ctx.esp & 0xffff;
      for (let o = sp; o < Math.min(sp + 0x3000, 0xfffe) && out.length < 60; o += 2) {
        const off = p.r16(base + o), sel = p.r16(base + o + 2); if (sel < 0x100 || !p.selValid || !p.selValid(sel)) continue;
        const w = where(p.selBase(sel) + off); if (/ \d+:/.test(w)) out.push(`${o.toString(16)} ${w}`);
      }
      return out;
    };
    const frames = (ctx) => {   // the BP chain: each frame's return (far when a code selector follows the offset, else near in the caller's segment)
      if (!ctx || !ctx.ss) return [];
      const base = p.selBase(ctx.ss), out = []; let bp = ctx.ebp & 0xfffe, cs = p.r16(base + (ctx.esp & 0xffff) + 2);
      out.push(`ret ${where(p.selBase(cs) + p.r16(base + (ctx.esp & 0xffff)))}`);   // (the thunk's caller: a far call)
      for (let n = 0; n < 40 && bp && bp < 0xfffc; n++) {
        const next = p.r16(base + bp) & 0xfffe, ip = p.r16(base + bp + 2), sel = p.r16(base + bp + 4);
        const far = sel >= 0x100 && p.selValid(sel) && / \d+:/.test(where(p.selBase(sel) + ip));
        if (far) cs = sel;
        const w = where(p.selBase(cs) + ip); out.push(`${bp.toString(16)} ${w}${far ? '' : ' (near)'}`);
        if (next <= bp) break; bp = next;
      }
      return out;
    };
    const name = t => (t.task && t.task.hInst && p.neByHandle(t.task.hInst) ? p.neByHandle(t.task.hInst).name : t.pc && t.pc.path) || '';
    const crits = p.critSecs ? [...p.critSecs].filter(([, c]) => c.owner || c.waiters.size).map(([cs, c]) => ({ cs: cs.toString(16), at: where(cs), owner: c.owner, count: c.count, waiters: [...c.waiters].map(t => t.id) })) : [];
    const threads = [...(p.threadsById || new Map()).values()].map(t => ({ id: t.id, tdb: t.tdb, state: t.state, name: name(t), blocked: !!t.blocked, preempted: !!t.preempted, wake: t.wake || 0, execWait: !!t.execWait, flat: !!t.flat, wait: t.wait ? t.wait.kind || 'object' : null, waitOn: t.waitOn ? { ...t.waitOn, objs: t.waitOn.hs.map(h => { const o = p.obj(h); return o ? { kind: o.kind, set: o.set, count: o.count, id: o.id, pid: o.pid, name: o.name, site: o.site ? where(o.site) : undefined } : h; }) } : null,
      at: t.ctx ? where(t.ctx.eip) : null, stack: stack(t.ctx), frames: frames(t.ctx), regs: t.ctx ? { cs: t.ctx.cs, ss: t.ctx.ss, bp: t.ctx.ebp, sp: t.ctx.esp, all: Object.fromEntries(Object.entries(t.ctx).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, (v >>> 0).toString(16)])) } : null,
      raw: t.ctx && t.ctx.ss && p.selValid(t.ctx.ss) ? (() => { const b = p.selBase(t.ctx.ss), sp = t.ctx.esp & 0xffff, o = []; for (let i = sp; i < Math.min(0xfffe, sp + 0x400); i += 2) o.push(p.r16(b + i).toString(16)); return { sp: sp.toString(16), words: o.join(' ') }; })() : null,
      queue: t.queue && p.selValid(t.queue) ? (q => ({ q: t.queue, task: p.r16(q + 2), flags: p.r16(q + 0x14), wake: p.r16(q + 0x48), changed: p.r16(q + 0x4a), mask: p.r16(q + 0x4c), ev: p.r32(q + 0xc),
        // (the SendMessage it waits on: USER's record of it, at 4Eh in USER's data, its words)
        sent: (() => { const rec = p.r16(q + 0x4e), u = p.ne && p.ne.get('USER'), ds = u && u.segs && u.segs.find(s => s.num === 32); if (!rec || !ds || !p.selValid(ds.sel)) return null; const b = p.selBase(ds.sel) + rec, o = []; for (let i = 0; i < 0x30; i += 2) o.push(p.r16(b + i).toString(16)); return { rec: rec.toString(16), words: o.join(' ') }; })() }))(p.selBase(t.queue)) : null }));
    // every top-level window, hidden ones too, with its task (a window whose task has ended answers no message)
    const wins = [];
    if (!p.depth) {
      if (!p.wbufLin) { p.wbufLin = p.alloc(0x200); p.wbufSel = p.allocSels(p.wbufLin, 0x200); }
      const u = (o, args) => p.user16(o, args).ax, buf = (p.wbufSel << 16) >>> 0;
      for (let h = u(262, [['w', u(286)], ['w', 5]]), n = 0; h && n < 256; h = u(262, [['w', h], ['w', 2]]), n++) {
        const cl = u(58, [['w', h], ['l', buf + 0x180], ['w', 64]]);
        const x = p.byName && p.byName.get('USER32') && p.byName.get('USER32').exports, gt = x && x.get('GetWindowThreadProcessId');
        wins.push({ h, cls: cl ? p.readA(p.wbufLin + 0x180, cl) : '', task: u(224, [['w', h]]), vis: !!u(49, [['w', h]]), tid: gt ? p.call(gt, [h, 0]) : null });
      }
    }
    // MMSYSTEM's installed drivers (its list at DGROUP 30Ah: next at +0Ch, type at +0Ah, flags at +0Bh, devices at +6)
    const mmd = []; { const m = p.ne && p.ne.get('MMSYSTEM'), dg = m && m.segs && m.segs.find(g => g.num === 13);
      if (dg && p.selValid(dg.sel)) { const b = p.selBase(dg.sel); for (let n = p.r16(b + 0x30a), k = 0; n && k < 32; n = p.r16(b + n + 0xc), k++) mmd.push({ type: p.u8[b + n + 0xa], flags: p.u8[b + n + 0xb], devs: p.r16(b + n + 6), name: p.readA(b + n + 0x12, 16) }); } }
    const cdc = p.ad1848 ? { regs: Array.from(p.ad1848.regs || []), t: p.ad1848.t } : null;
    const procs = [...(p.procs || new Map()).values()].map(pc => ({ pid: pc.pid, path: pc.path, cmd: pc.cmdPtr ? p.readA(pc.cmdPtr) : '', exit: pc.exitCode }));   // the processes started here, with their command lines
    const smNetwork = p.depth || p.thread16 ? null : (() => { try { return p.user16(179, [['w', 63]]).ax; } catch (_) { return null; } })();   // GetSystemMetrics(SM_NETWORK)
    // the network card: its registers, the frames waiting at it, the ring's unread bytes (lan.js, the page's segment)
    const nic = p.nic ? { cr: p.nic.cr, isr: p.nic.isr, imr: p.nic.imr, rcr: p.nic.rcr, inbox: p.nic.inbox.length, mac: [...p.nic.par].map(x => x.toString(16).padStart(2, '0')).join(':'), curr: p.nic.curr, bnry: p.nic.bnry,
      ring: lanRing ? (() => { const c = new Int32Array(lanRing, 0, 2); return (Atomics.load(c, 0) - Atomics.load(c, 1) + (1 << 20)) % (1 << 20); })() : null, irqs: p.lanIrqs || 0 } : null;
    const dmod = p.ne && p.ne.get('DISPLAY'), dseg = dmod && dmod.segs && dmod.segs[dmod.segs.length - 1], dsb = dseg && p.selValid(dseg.sel) ? p.selBase(dseg.sel) : 0;
    const display = dsb ? { sel: dseg.sel, chip81e: p.r16(dsb + 0x81e), bpp2d: p.r16(dsb + 0x2d), mem7a: p.r32(dsb + 0x7a), w: [...p.u8.slice(dsb, dsb + 0x40)].map(b => b.toString(16).padStart(2, '0')).join('') } : null;
    const metrics = p.depth || p.thread16 ? null : (() => { try { return [0, 1, 4].map(i => p.user16(179, [['w', i]]).ax); } catch (e) { return e.message; } })();   // GetSystemMetrics: CXSCREEN, CYSCREEN, CYCAPTION
    return { crits, metrics, display, nic, stats: { ...p.stats, upMs: Math.round(performance.now()) }, sizes: { threads: p.threadsById ? p.threadsById.size : 0, entryHooks: p.entryHooks ? p.entryHooks.size : 0, retPend: p.retPend ? [...p.retPend.values()].reduce((n, l) => n + l.length, 0) : 0, tdbs: (p.tdbList || []).length, remoteClosed: p.remoteClosed ? p.remoteClosed.size : 0, lagLog: this.lagLog ? this.lagLog.length : 0, watchLog: (p.watchLog || []).length, effects: (p.effects || []).length, effectSeen: p.effectSeen ? p.effectSeen.size : 0, handles: p.handles ? p.handles.size : 0, dynCache: p.dynCache ? p.dynCache.size : 0, traceLog: (this.traceLog || []).length, keyq: this.keyq.length, mouseq: this.mouseq.length, procs: p.procs ? p.procs.size : 0, selUsed: p.selUsed ? p.selUsed.reduce((n, v) => n + v, 0) : 0 }, tdbs: (p.tdbList || []).map(s => ({ sel: s, name: p.selValid(s) ? p.readA(p.selBase(s) + 0xf2, 8) : null })), thhook: p.thhookLin ? Array.from(p.u8.subarray(p.thhookLin, p.thhookLin + 0x20)) : null, jsDlls: p.jsDlls ? Object.fromEntries(p.jsDlls) : null, nullJumps: (p.nullJumps || []).map(j => ({ ...j, fromIn: j.from !== undefined ? where(j.from) : undefined })),
      mods32: (p.modules || []).filter(m => m.meta && m.meta.textHi).map(m => [m.name, m.base >>> 0, m.meta.textLo >>> 0, m.meta.textHi >>> 0]), thunkFails: p.thunkFails || [], thunkConns: p.thunkConns || [], gl: [...(p.glContexts || [])].map(c => ({ w: c.canvas && c.canvas.width, h: c.canvas && c.canvas.height, lost: !c.g || c.g.isContextLost(), err: c.g ? c.g.getError() : null, dc: c.dc ? { native: !!c.dc.native, bpp: c.dc.bpp, w: c.dc.w, h: c.dc.h, hwnd: c.dc.hwnd, hdc: c.dc.hdc, gdi: c.dc.native ? (() => {
      const g = p.byName.get('GDI32'), f = n => g.exports.get(n), r = p.alloc(32); try {
        const bm = p.call(f('GetCurrentObject'), [c.dc.hdc, 7]), got = bm ? p.call(f('GetObjectA'), [bm, 24, r]) : 0, type = p.call(f('GetObjectType'), [c.dc.hdc]);
        const gdi16 = p.ne && p.ne.get('GDI'), segs = gdi16 && gdi16.segs ? gdi16.segs.map(s => ({ num: s.num, sel: s.sel, base: s.base, alloc: s.alloc, lim: p.selValid(s.sel) ? p.selLimit(s.sel) : null, now: p.selValid(s.sel) ? p.selBase(s.sel) : null })) : null;
        const stock = p.call(f('GetStockObject'), [0]), sdc = p.call(f('CreateCompatibleDC'), [0]);
        const gb = g.base, look = p.call(gb + 0x4368, [stock]);
        const path = []; p.runHook = e => { if (path.length < 60) path.push((e >>> 0).toString(16)); }; p.call(f('GetObjectType'), [stock]); p.runHook = null;
        const types = { path, gb, look, lookMagic: p.r16(look + 2), table: [...p.u8.slice(gb + 0x499a, gb + 0x49a6)], lar: (() => { const lb = 0; return null; })(), stock, stockType: p.call(f('GetObjectType'), [stock]), sdc, sdcType: p.call(f('GetObjectType'), [sdc]), bmType: p.call(f('GetObjectType'), [bm]) };
        p.call(f('DeleteDC'), [sdc]);
        return { bm, got, type, bmW: p.r32(r + 4), bmH: p.r32(r + 8), bpp: p.u8[r + 18], types, gdiSegs: segs && segs.filter(s => s.now !== s.base) };
      } catch (e) { return { err: e.message }; } finally { p.free(r); } })() : null } : null })),bigAllocs: p.bigAllocs || [], heapMB: ((p.heapTop || 0) - 0x2000000) >> 20, cdc, procs, smNetwork, wss: p.wssRecs ? [...p.wssRecs.keys()] : null, mods16: p.ne ? [...p.ne.keys()] : [], mmd, sound: p.soundStats ? { ...p.soundStats, quiet: !!p.soundQuiet } : null, th16: (p.th16 || []).length, wins, threads, held: p.win16Held ? (p.win16Held.who === 'main' ? 'main' : p.win16Held.who && p.win16Held.who.id) : null, depth: p.depth,
      main: { at: p.resumeEip ? where(p.resumeEip) : null, stack: stack(p.mainCtx) } };
  }
  // the page's requests: what a window gets done to it, and questions about the machine
  /** the display mode changed to w by h at the page's request (its viewport holds another of the adapter's modes): the
   *  display configuration the mini-VDD reports becomes it, and USER's ChangeDisplaySettings makes the change as a
   *  Display Properties change does (the driver re-enabled in the new mode, the desktop resized, WM_DISPLAYCHANGE to
   *  every window). The machine's screen size after it, with USER's answer; null while a thread holds USER */
  setMode(w, h, fields = 0x180000, flags = 0x80000000) {
    const p = this.proc; if (!p || p.depth || p.thread16 || p.win16Held) return null;
    p.host.width = w; p.host.height = h;
    // a DEVMODE (its 4.0 form, 7Ch bytes) naming the mode: dmFields DM_PELSWIDTH and DM_PELSHEIGHT (naming the depth too, or
  // the registry update flag, has USER answer DISP_CHANGE_RESTART); the change made now, as QuickRes asks for it (flag 80000000h)
    const dm = p.alloc(0x7c), sel = p.allocSels(dm, 0x7c);
    p.w16(dm + 32, 0x400); p.w16(dm + 36, 0x7c); p.w32(dm + 40, fields);
    const slot = p.displaySlot ? p.displaySlot(w, h, p.displayConfig().bpp) : { w, h };   // (a size the driver does not list: its custom mode's entry at the depth, ne16.js)
    p.w32(dm + 104, 8); p.w32(dm + 108, slot.w); p.w32(dm + 112, slot.h);
    let r;
    try { r = p.user16(620, [['l', sel << 16], ['l', flags]]).dxax | 0; }   // ChangeDisplaySettings(lpDevMode, flags)
    catch (e) { console.error(e); r = -1; }   // (DISP_CHANGE_FAILED: the machine stays as it is)
    finally { p.freeSels(sel); p.free(dm); }
    const a = p.scanout(); if (a.bpp) [this.sw, this.sh] = [a.w, a.h];
    return { r, sw: this.sw, sh: this.sh };
  }
  cmd(name, args) {
    const p = this.proc, u = (o, a) => p.user16(o, a);
    switch (name) {
      // a window brought to the front (a minimized one restored), from a thread of its own as 'place' is: a call made
      // as the window's thread while it waits on its own SendMessage takes its reply, and it waits for good
      // (the keys and clicks that come after it wait for it, feedKeys: fed before it was made, a key went to the window
      // that had been in front)
      case 'focus': return (async () => {
        const [hwnd, min] = args;
        this.focusing = (this.focusing || 0) + 1;
        try {
          if (min) await this.onWindow('ShowWindow', [hwnd, 9]);
          else await this.onWindow('SetForegroundWindow', [hwnd]);
        } finally { this.focusing--; }
      })();
      case 'minimize': u(42, [['w', args[0]], ['w', 6]]); return;
      // a window put where another machine in a shared session has it (shared.js): ShowWindow to its state (3
      // maximized, 7 minimized, 9 restored), then MoveWindow to its place. On a thread of its own, as another
      // program's thread asks it: the window's thread gets the messages as sent to it, whatever it is doing (a call
      // made as that thread while it waits on its own SendMessage takes over its queue's one send, and it waits for good)
      case 'place': return (async () => {
        const [hwnd, x, y, w, h, show] = args;
        if (show) await this.onWindow('ShowWindow', [hwnd, show]);
        if (show !== 3 && show !== 7) await this.onWindow('MoveWindow', [hwnd, x, y, w, h, 1]);
      })();
      // a window closed as its close box closes it (this machine's person: the page's close box, win95.close)
      case 'close': u(110, [['w', args[0]], ['w', 0x10], ['w', 0], ['l', 0]]); return;
      // (one closed here because another machine's person closed it there: under a remote cause, ne16.js
      // remoteClose, so the page sends no close of its own for it, oslogic.js read)
      case 'closeRemote': p.remoteClose(args[0]); u(110, [['w', args[0]], ['w', 0x10], ['w', 0], ['l', 0]]); return;
      // a program another machine's person closed (its window gone there, after anything it asked there: "Save
      // changes?"): ended here as Windows ends a program, without its asking again, its contents being the session's
      // already. A Windows 3.x program's task is asked to close (WM_CLOSE)
      case 'end': {
        p.remoteClose(args[0]);
        const task = u(224, [['w', args[0]]]).ax, pc = task && [...(p.procs || new Map()).values()].find(c => c.tdb === task);   // (GetWindowTask: AX)
        if (pc && pc.exitCode === null) {
          p.endProcess(pc, 0);
          // (what its windows covered is painted again: a process ended this way leaves no WM_PAINT behind it)
          const repaint = () => { try { if (!p.depth && !this.ring0()) u(125, [['w', 0], ['l', 0], ['w', 1]]); } catch (_) { /* USER busy */ } };   // InvalidateRect(all windows, erase)
          repaint(); setTimeout(() => { repaint(); this.kick(); }, 400);
          return true;
        }
        u(110, [['w', args[0]], ['w', 0x10], ['w', 0], ['l', 0]]); return false;
      }
      case 'clipOut': return this.clipOut();
      case 'clipIn': this.clipIn(args[0]); return;
      case 'closeState': p.k32CloseState(args[0]); return;
      case 'spawn': {
        const result = r => typeof r === 'object' ? { ok: true, pid: r.pid, ...(r.previewKey ? { previewHwnd: r.previewHwnd, previewKey: r.previewKey } : {}) } : { err: r };
        return /\.SCR$/i.test(args[0] || '') ? this.spawnSaverAsync(args[0], args[1] || '').then(result) : this.shellUp().then(() => result(this.spawnProgram(args[0], args[1], args[2] || {})));
      }
      case 'endProcess': { const p = this.proc, pc = p.procs && p.procs.get(args[0]); if (pc) p.endProcess(pc, args[1] || 0); return pc ? true : this.endSaver(args[0], args[1] || 0); }
      case 'closeWin32': return this.proc.sendMsg(args[0], W.WM.CLOSE);
      case 'children': return p.depth ? null : p.nativeChildren(args[0]);
      // a shared session's OS objects (ne16.js osWorld), and a control set as another machine has it
      // (its controls' contents asked from a thread of its own, all in one: WM_GETTEXT, BM_GETCHECK)
      case 'world': return p.depth ? null : (async () => {
        const got = p.osWorld(), asks = got.list.flatMap(w => w.ask.map(q => ({ w, q })));
        const bufs = asks.map(({ q }) => (q[2] === 'text' ? (b => (p.u8[b] = 0, b))(p.alloc(0x400)) : 0));
        const r = asks.length ? await this.netBatch(asks.map(({ q }, i) => ({ dll: 'USER32', name: 'SendMessageA', args: q[2] === 'text' ? [q[1], 0x0d, 0x400, bufs[i]] : [q[1], 0xf0, 0, 0], ifWindow: q[1] }))) : [];
        for (const w of got.list) w.ctrls = {};
        asks.forEach(({ w, q }, i) => { w.ctrls[q[0]] = q[2] === 'text' ? (r ? p.readA(bufs[i], 0x400) : null) : r ? r[i] : null; });
        for (const b of bufs) if (b) p.free(b);
        for (const w of got.list) delete w.ask;
        return got;
      })();
      // a folder opened as the shell opens one (SHELL32's ShellExecute, in Explorer's process): another machine's
      // folder window, here too
      // (owned by the taskbar's window, as the Start menu's opens are: with none, the shell asked USER about window 0,
      // GetWindow's parameter error 6040)
      case 'shellOpen': return this.netCall('ShellExecuteA', [this.trayHwnd(), 'open', args[0], 0, 0, 1], 'SHELL32');
      // a folder of the shell's own (Control Panel, Printers, My Computer: a CSIDL), opened as the Start menu opens one:
      // its ID list (SHGetSpecialFolderLocation), then ShellExecuteEx with it (SEE_MASK_IDLIST)
      case 'shellOpenSpecial': return (async () => {
        const pp = p.alloc(4), owner = this.trayHwnd(); p.w32(pp, 0);
        try {
          if (await this.netCall('SHGetSpecialFolderLocation', [owner, args[0], pp], 'SHELL32') !== 0 || !p.r32(pp)) return false;
          const sei = p.alloc(60), verb = p.alloc(8); p.u8.fill(0, sei, sei + 60); p.writeA(verb, 'open');
          p.w32(sei, 60); p.w32(sei + 4, 4); p.w32(sei + 8, owner); p.w32(sei + 12, verb); p.w32(sei + 28, 1); p.w32(sei + 36, p.r32(pp));
          try { return !!(await this.netCall('ShellExecuteExA', [sei], 'SHELL32')); } finally { p.free(sei); p.free(verb); }
        } finally { p.free(pp); }
      })();
      // the programs the shell starts as Windows starts, held while a machine joining a shared session catches up
      // with it (the session's are started for it instead), and let go
      case 'holdStartup': this.holdStartup = !!args[0]; return;
      // another machine's intent made here as the call that made it there (ne16.js hookIntents): SystemParametersInfo
      // with its flags (this Windows keeps the setting and tells its programs), a settings file's line written
      case 'intent': return (async () => {
        const i = args[0];
        if (i.kind === 'spi') {
          let pv = 0, own = 0;
          if (i.str != null) pv = i.str;
          else if (i.ints) { pv = own = p.alloc(12); i.ints.forEach((v, k) => p.w32(own + 4 * k, v)); }
          else if (i.bytes) { pv = own = p.alloc(i.bytes.length); p.u8.set(i.bytes, own); }   // (a structure: the Appearance tab's metrics and fonts)
          try { return await this.netBatch([{ dll: 'USER32', name: 'SystemParametersInfoA', args: [i.action, i.ui, pv, i.flags] }], true); } finally { if (own) p.free(own); }
        }
        if (i.kind === 'color') {   // (a system colour: SetSysColors with the one element)
          const b = p.alloc(8); p.w32(b, i.index); p.w32(b + 4, i.rgb);
          try { return await this.netBatch([{ dll: 'USER32', name: 'SetSysColors', args: [1, b, b + 4] }], true); } finally { p.free(b); }
        }
        // (a registry value no other call carries: set as the program set it, by ADVAPI32's stand-in's registry)
        if (i.kind === 'reg') { W.regSet(i.path, i.name, { type: i.type, data: Uint8Array.from(i.data || []), name: i.name }); return true; }
        if (i.kind === 'ini') return this.netBatch([{ dll: 'KERNEL32', name: 'WritePrivateProfileStringA', args: [i.app, i.name == null ? 0 : i.name, i.value == null ? 0 : i.value, i.file] }], true);
        return null;
      })();
      // a command line run as Windows runs one (WinExec, CreateProcess: a 16-bit program or a 32-bit one): a shared
      // session's program, started here as another machine runs it
      // the other people in a shared session ([{ client, user, color }]), for SESSTRAY.EXE's icons (session-tray.js),
      // told to its window
      case 'tray': {
        self.W95TrayPeople = args[0] || []; self.W95TrayOwner = args[1] || null; const st = self.W95TrayState;
        return st && st.hwnd ? this.netCall('PostMessageA', [st.hwnd, 0x8005, 0, 0], 'USER32') : false;
      }
      // (a program another machine runs in a shared session: its clock as of its start there, args[1], ne16.js startClock)
      // (and where it comes from, args[2]: 'remote', another machine's person's, for its cause, ne16.js causeOf)
      case 'run': return this.shellUp().then(() => { const held = this.holdStartup; this.holdStartup = false; p.nextClock = args[1] || null; p.nextOrigin = args[2] || null; try { const r = this.exec(args[0], 1); return typeof r === 'number' ? (r > 32 ? { ok: true } : { err: r }) : r && r.err ? r : { ok: true }; } finally { this.holdStartup = held; p.nextClock = null; p.nextOrigin = null; } });
      case 'effects': return (p.effects || []).slice();   // (what the machine did, with its causes: ne16.js effect)
      // another machine's person's stroke (or part of one) into the session's object whose window here is root: fed
      // between this person's own (feedStroke)
      case 'pace': this.lagMax = Math.max(1, args[0] | 0); return this.lagMax;   // (a diagnostic: how many of a drag's moves may be fed ahead of the program taking them)
      case 'strokes': {   // (a diagnostic: the strokes of others waiting and being fed, this person's going; with a window, its queue's state)
        let pending = null; try { pending = p.inputPending(); } catch (e) { pending = String(e); }
        const h = args[0], q = h ? { posted: p.postedPending(h), input: p.inputPendingFor(h), status: (p.asWindowTask(h, () => p.user16(334, [['w', 0xff]]).dxax) >>> 0).toString(16), child: p.childAt(h, args[1] || 0, args[2] || 0) } : null;
        return { waiting: (this.strokes || []).map(s => ({ key: s.key, root: s.root, pop: s.pop, ev: s.ev.length, done: s.done, waited: s.waited || 0 })), feeding: this.rs ? { key: this.rs.key, left: this.rs.ev.length, fed: this.rs.fed, lost: this.rs.lost || 0, done: this.rs.done } : null, btn: this.btn || 0, pending, own: this.stroke ? { n: this.stroke.n, ev: this.stroke.ev.length } : null, q, taken: p.movesTaken || 0, movesFed: this.movesFed || 0, mouseq: this.mouseq.length, posted: this.posted || {}, msgTaken: p.msgTaken || {} };
      }
      case 'stroke': {
        const [key, root, pop, ev, done] = args, q = this.strokes || (this.strokes = []);
        let s = q.find(x => x.key === key) || (this.rs && this.rs.key === key ? this.rs : null);
        if (!s) { s = { key, root, pop: pop || null, ev: [], done: false }; q.push(s); }
        s.ev.push(...(ev || [])); if (done) s.done = true; s.idle = 0;
        this.kick(); return true;
      }
      // (a diagnostic: the input's times in this machine, Date.now() each: a mouse or key event taken from the ring
      // ('mouse-in', 'key-in'), and fed into USER's drivers ('mouse-fed', 'key-fed'); [true] starts recording, [] reads
      // and clears, [false] ends it. The sprite's move the page sees itself: win95.lag())
      case 'lag': { if (args.length && args[0] === true) { this.lagLog = []; return true; } if (args.length && args[0] === false) { this.lagLog = null; return true; } const l = this.lagLog || []; this.lagLog = this.lagLog ? [] : null; return l; }
      // (a diagnostic: selectors allocated and not freed since [true], each with where it was allocated; [] gives them
      // by site, [false] ends it)
      case 'seltrace': {
        if (args[0] === true) { const live = p.selTrace = new Map(), od = p.setDesc, of = p.freeSels; p.setDesc = function (s, ...a) { if (!this.selUsed[(s & 0xfff8) >> 3]) live.set(s & 0xfff8, new Error().stack.split('\n').slice(2, 8).map(x => x.trim().replace(/^at /, '').replace(/\(.*\//, '(')).join(' < ')); return od.call(this, s, ...a); }; p.freeSels = function (s, ...a) { live.delete(s & 0xfff8); return of.call(this, s, ...a); }; return true; }
        if (args[0] === false) { delete p.setDesc; delete p.freeSels; p.selTrace = null; return true; }
        const by = new Map(); for (const st of (p.selTrace || new Map()).values()) by.set(st, (by.get(st) || 0) + 1);
        return [...by].sort((x, y) => y[1] - x[1]).slice(0, 10);
      }
      case 'log': return W.log.lines(args[0] || 0);   // (the machine's log since line n: win32.js log; the page keeps its own copy as the lines come)
      // (a line said by the page, into this machine's log: the Debug Monitor shows the page's too)
      case 'logPut': W.log.put(args[0]); return;
      // a control set as another machine has it: an edit's or combo box's text (WM_SETTEXT), a button's check
      // (BM_SETCHECK), sent from a thread of its own as 'place' is
      case 'setCtrl': return (async () => {
        const [hwnd, id, kind, value] = args, c = await this.onWindow('GetDlgItem', [hwnd, id]);
        if (!c) return false;
        if (kind === 'button') await this.onWindow('SendMessageA', [c, 0xf1, value | 0, 0]);
        else await this.onWindow('SendMessageA', [c, 0x0c, 0, String(value)]);
        return true;
      })();
      case 'listItem': return p.depth ? null : p.listItem(args[0], args[1], !!args[2]);   // a list view's item selected, or opened (the scripting API's click, dblclick)
      case 'peek': { const at = args[2] ? (p.selValid(args[2]) ? p.selBase(args[2]) + args[0] : -1) : args[0]; return at < 0 ? null : Array.from(p.u8.subarray(at, at + Math.min(args[1], 4096))); }   // a diagnostic: memory bytes, at a linear address or [offset, n, selector]
      case 'menuscan': {   // a diagnostic: every menu handle USER has (IsMenu over the handle range), its item count and first item, and whether USER32's GetMenuItemRect places its first item in the window given
        if (p.depth) return null;
        const u16 = (o, a) => p.user16(o, a).ax, x32 = p.byName && p.byName.get('USER32'), rectFn = x32 && x32.exports && x32.exports.get('GetMenuItemRect'), out = [], buf = p.alloc(256), sel = p.allocSels(buf, 256);
        try {
          for (let h = 4; h < 0x8000; h += 4) {
            if (!u16(358, [['w', h]])) continue;
            const n = u16(263, [['w', h]]), tl = n ? u16(161, [['w', h], ['w', 0], ['l', (sel << 16) >>> 0], ['w', 128], ['w', 0x400]]) : 0;
            let rect = null;
            if (args[0] && rectFn) { p.u8.fill(0, buf + 128, buf + 144); if (p.call(rectFn, [args[0], h, 0, buf + 128])) rect = [0, 4, 8, 12].map(o => p.r32(buf + 128 + o) | 0); }
            out.push([h, n, tl ? p.readA(buf, tl) : '', rect]);
          }
        } finally { p.freeSels(sel); p.free(buf); }
        return { rectFn: !!rectFn, menus: out };
      }
      case 'userdata': { const u = p.ne && p.ne.get('USER'), g = u && u.meta.segs.find(s => s.num === u.meta.autodata); return g ? (g.sel ? p.selBase(g.sel) : g.base) : 0; }   // a diagnostic: USER's data segment's address, where it is now (its heap grew and moved it)
      case 'user16': {   // a diagnostic: USER.ord called with args, each ['w'|'l', v] or ['buf', n] (a buffer the call fills, returned as bytes)
        if (p.depth) return null;
        const bufs = [], a = args[1].map(x => { if (x[0] !== 'buf') return x; const lin = p.alloc(x[1]), sel = p.allocSels(lin, x[1]); bufs.push({ lin, sel, n: x[1] }); return ['l', (sel << 16) >>> 0]; });
        try { const r = p.user16(args[0], a); return { ax: r.ax, dxax: r.dxax, bufs: bufs.map(b => Array.from(p.u8.subarray(b.lin, b.lin + b.n))) }; }
        finally { for (const b of bufs) { p.freeSels(b.sel); p.free(b.lin); } }
      }
      case 'call16': {   // a diagnostic: a 16-bit module's export (loaded from disk if need be) called with args as 'user16' takes them: [module, name or ordinal, args]
        if (p.depth) return null;
        const m = p.loadLibrary16(args[0], true); if (!m) return { err: 'no module' };
        if (m.meta && m.meta.dynamic && !m.inited) { m.inited = true; if (!p.initNE(m)) return { err: 'LibEntry failed' }; }   // (as KERNEL's LoadLibrary runs a module's LibMain)
        const key = /^#?\d+$/.test(String(args[1])) ? +String(args[1]).replace('#', '') : String(args[1]), at = p.neExport(m, key); if (!at) return { err: 'no export' };
        const bufs = [], a = (args[2] || []).map(x => { if (x[0] !== 'buf') return x; const lin = p.alloc(x[1]), sel = p.allocSels(lin, x[1]); if (x[2]) p.u8.set(x[2], lin); else p.u8.fill(0, lin, lin + x[1]); bufs.push({ lin, sel, n: x[1] }); return ['l', (sel << 16) >>> 0]; });
        const path = args[3] ? [] : null; if (path) p.runHook = e => { path.push(e >>> 0); if (path.length > 20000) path.splice(0, 10000); };   // (args[3]: the blocks it ran, as symbols)
        try { const r = p.call16(at >>> 16, at & 0xffff, a); return { ax: r.ax, dxax: r.dxax, bufs: bufs.map(b => Array.from(p.u8.subarray(b.lin, b.lin + b.n))), path: path && path.slice(-(args[3] | 0 || 400)).map(e => p.whereOf(e)) }; }
        finally { if (path) p.runHook = null; for (const b of bufs) { p.freeSels(b.sel); p.free(b.lin); } }
      }
      case 'hung': {   // USER32's IsHungThread for the thread that owns each window
        const x = p.byName && p.byName.get('USER32') && p.byName.get('USER32').exports, tid = x && x.get('GetWindowThreadProcessId'), hung = x && x.get('IsHungThread');
        return args[0].map(h => (tid && hung && !p.depth ? !!p.call(hung, [p.call(tid, [h, 0])]) : false));
      }
      case 'trayPost': p.post(...args); return;
      // the network as the system's machine has it: MPR's exports called on a thread of its own (its dialogs run there),
      // its enumerations, the drives it has connected, and a drive's or share's files (netfs.js) for the page
      case 'printerWindow': return this.printerWindow(args[0], args[1]);
      case 'netCall': return this.netCall(args[0], args[1]);
      // (a diagnostic: any module's export called on a thread of its own, dword or string arguments: [dll, name, args])
      case 'call': return this.netCall(args[1], args[2] || [], args[0]);
      // (a diagnostic: the call above with the blocks it ran recorded, each as module segment:offset or linear, the last
      // `n`: [dll, name, args, n])
      case 'callPath': return (async () => {
        const path = [], n = args[3] || 400, where = this.probe.whereOf || (lin => (lin >>> 0).toString(16));
        p.runHook = e => { path.push(e >>> 0); if (path.length > 20000) path.splice(0, 10000); };
        let r; try { r = await this.netCall(args[1], args[2] || [], args[0]); } finally { p.runHook = null; }
        if (!this.probe.whereOf) this.probe();
        return { r, path: path.slice(-n).map(e => this.probe.whereOf(e)) };
      })();
      // (a diagnostic: each entry to a module's export recorded with its first n stack arguments (dwords of a 32-bit
      // module's, words of a 16-bit one's), its caller and thread, and once the call returns to its caller, its result
      // (eax, or AX and DX:AX): [dll, name, n], name an export's name, #ordinal, or /regexp/ over the module's names;
      // the exports hooked. [] reads and clears the log; [dll] ends that module's watches)
      case 'watch': {
        if (!args.length) { const l = p.watchLog || []; p.watchLog = []; return l; }
        const [dll, name, n = 4] = args, m = p.byName.get(String(dll).toUpperCase()) || p.byName.get(dll); if (!m) return false;
        const offs = p.watchOff || (p.watchOff = new Map());
        if (name === undefined) { for (const f of offs.get(m) || []) f(); offs.delete(m); return true; }
        const ne = m.kind === 'ne', re = /^\/(.*)\/$/.exec(String(name)), want = re && new RegExp(re[1], 'i');
        const names = [];   // [name, linear]
        if (ne) {
          const byOrd = new Map(); for (const [k, v] of Object.entries(m.names || {})) { if (typeof v === 'number') byOrd.set(v, k); else if (/^\d+$/.test(k)) byOrd.set(+k, v); }
          const lin = a => a && p.selValid(a >>> 16) ? (p.selBase(a >>> 16) + (a & 0xffff)) >>> 0 : 0;
          if (want) { for (const [ord, a] of m.exports) { const nm = byOrd.get(ord) || `#${ord}`; if (want.test(nm) && lin(a)) names.push([nm, lin(a)]); } }
          else { const key = /^#?\d+$/.test(String(name)) ? +String(name).replace('#', '') : String(name), a = lin(p.neExport(m, key)); if (a) names.push([typeof key === 'number' ? byOrd.get(key) || `#${key}` : key, a]); }
        } else {
          // (an export by ordinal only, as MFC30's all are: named from a .def or .map file beside the DLL when there is
          // one, else by its ordinal with the modules that import it)
          const named = this.ordNames(m), label = nm => !/^#\d+$/.test(nm) ? nm : named.get(+nm.slice(1)) || (m.importers && m.importers.has(nm) ? `${nm} (${[...m.importers.get(nm)].join(', ')})` : nm);
          const hasName = new Set([...m.exports].filter(([nm]) => nm[0] !== '#').map(([, a]) => a));
          if (want) { for (const [nm, a] of m.exports) if (typeof a === 'number' && a && !(nm[0] === '#' && hasName.has(a)) && want.test(label(nm))) names.push([label(nm), a >>> 0]); }
          else { const k = [...named].find(([, v]) => v === name), a = m.exports.get(k ? `#${k[0]}` : name); if (a) names.push([label(k ? `#${k[0]}` : name), a >>> 0]); }
        }
        if (!names.length) return false;
        const log = () => p.watchLog || (p.watchLog = []), t0 = performance.now();
        for (const [nm, at] of names) {
          const off = p.addEntryHook(at, function () {
            const seg = !!(this.cpu.ss.value & 0xffff), sp = seg ? (this.cpu.ssb.value >>> 0) + (this.cpu.esp.value & 0xffff) : this.reg('esp') >>> 0, a = [];
            if (seg) for (let i = 0; i < n; i++) a.push(this.r16(sp + 4 + 2 * i).toString(16)); else for (let i = 1; i <= n; i++) a.push((this.r32(sp + 4 * i) >>> 0).toString(16));
            const ret = seg ? (this.selBase(this.r16(sp + 2)) + this.r16(sp)) >>> 0 : this.r32(sp) >>> 0;
            const rec = { t: Math.round(performance.now() - t0), name: `${m.name}!${nm}`, args: a, from: this.whereOf(ret), thread: this.thread16 ? this.thread16.id : 'main' };
            if (log().length < 20000) log().push(rec);
            this.onReturn((eax, edx) => { rec.eax = eax.toString(16); if (seg) { rec.ax = (eax & 0xffff).toString(16); rec.dxax = (((edx & 0xffff) << 16 | (eax & 0xffff)) >>> 0).toString(16); } });
          });
          if (!offs.has(m)) offs.set(m, []); offs.get(m).push(off);
        }
        return names.map(x => x[0]);
      }
      // (a diagnostic: a write watch on linear [lo, lo+len): [lo, len] starts one, [] gives its hits so far (each the
      // first changed byte, how many, the bytes before and after, and what ran last) and the count, [null] ends it)
      case 'memwatch': {
        if (!args.length) return p.memW ? { hits: p.memW.hits.splice(0), n: p.memW.n } : null;
        if (args[0] == null) { p.memWatch(null); return true; }
        p.memWatch(args[0], args[1] || 4); return true;
      }
      case 'netEnum': return this.netEnum(args[0], args[1]);
      case 'netConnections': return this.netConnections();
      case 'netfs': return ownNet(args[0])[args[1]](...(args[2] || []));
      case 'mode': { const r = this.setMode(args[0], args[1]); if (!r) this.wantMode = [args[0], args[1]]; return r; }   // (null: made once no thread holds USER, step())
      case 'probe': return this.probe();
      // (offsets in a module, by name: EAX each time execution comes to one from another module, as a call into
      // another DLL returns there; into the trace's log; no offsets ends it)
      case 'watchAt': {
        const [name, offs] = args, want = new Set(offs || []), log = this.traceLog || (this.traceLog = []);
        if (!want.size) { const seen = p.runHook && p.runHook.seen; p.runHook = null; return seen || true; }   // (ending it: how many dispatches came into the module, and the offsets most often)
        // (a program's own image by its file's name, AUTORUN or AUTORUN.EXE: each process's EXE, which is in no module list)
        const own = x => x && x.exe && x.path && (x.path.replace(/^.*\\/, '').toUpperCase() === name.toUpperCase() || x.path.replace(/^.*\\/, '').replace(/\.[^.]*$/, '').toUpperCase() === name.toUpperCase());
        p.runHook = eip => {
          const exes = [p.pc0, p.pc, ...(p.procs || new Map()).values()].filter(own).map(x => x.exe);
          const m = [...p.modules.filter(x => x.name === name), ...exes].find(x => eip >= x.base && eip < x.base + (x.size || (x.meta && x.meta.textHi - x.base) || 0));
          if (m) { const s = p.runHook.seen; s.n++; const k = (eip - m.base).toString(16); s.at[k] = (s.at[k] || 0) + 1; }
          if (m && want.has(eip - m.base)) { const sp = p.reg('esp') >>> 0; log.push([Math.round(performance.now()), p.thread16 && p.thread16.pc ? p.thread16.pc.path : 'host', 'watch', `${name}+${(eip - m.base).toString(16)}`, `eax ${(p.reg('eax') >>> 0).toString(16)}`, `args ${[4, 8, 12, 16, 20].map(k => (p.r32(sp + k) >>> 0).toString(16)).join(' ')}`]); }   // (the stack's first five arguments, as a stdcall function sees them on entry)
        };
        p.runHook.seen = { n: 0, at: {} };
        return true;
      }
      case 'blocks': {   // (the blocks of run-time code the threads of programs whose path matches run, in order, the last n kept; with no arguments, what was kept, as symbols, and the hook ended)
        if (args[0]) {
          const want = new RegExp(args[0], 'i'), n = args[1] || 4000, log = [];
          // (named as each runs: a program's image is its own process's, which is in place only while its thread runs)
          // (a Windows 3.x task by its module's name, as trace names it; a Win32 process by its program's path)
          const named = t => { const m = t.task && t.task.hInst && p.neByHandle(t.task.hInst); return (t.pc && t.pc.path) || (m && m.name) || ''; };
          p.dynHook = eip => { const t = p.thread16; if (t && want.test(named(t))) { log.push(`${t.id} ${p.whereOf(eip)}`); if (log.length > n) log.splice(0, log.length - n); } };
          p.dynHook.log = log; return true;
        }
        const l = (p.dynHook && p.dynHook.log) || []; p.dynHook = null; return l;
      }
      case 'trace': { if (args[0]) this.traceOn(args[0], args[1]); const l = this.traceLog || []; return l.splice(0); }   // (the calls traced so far; a thread regexp, and one for the import names, starts a trace)
      case 'faults': return (p.faultLog || []).splice(0);   // (a diagnostic: the code the machine found none at, and why)
      // a script of the machine's (a stand-in: claude-app.js, shell32.js, ...) loaded again from the page's server into
      // the running machine, no restart: its def()s replace the functions in place (win32.js def), so the thunks made
      // already call the new ones; what the script keeps across a reload is its own affair (claude-app.js keeps its state)
      case 'reload': {
        const f = String(args[0] || '');
        if (!/^[\w.-]+\.js$/.test(f)) throw new Error(`reload: a script of the site's, by name (${f})`);
        importScripts(`${f}?reload=${Date.now()}`);
        return { reloaded: f };
      }
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
    rpcSab = m.rpc; lanRing = m.o.lan || null; regStore.held = m.registry; W.regAttach(regStore); if (m.o.exp) Object.assign(self, m.o.exp);
    W.log.watch(line => { if (!line.posted) post({ t: 'log', line }); });   // (this machine's log lines, to the page's ring)
    machine = new Machine(m.o); machine.start().catch(err => { console.error(err); post({ t: 'exited', code: -1, why: String(err && err.message || err) }); });
  } else if (m.t === 'cmd') {
    const reply = (value, error) => { if (m.id) post({ t: 'reply', id: m.id, value: value === undefined ? null : value, error }); };
    let value, error = null;
    try { value = machine && machine.alive ? machine.cmd(m.name, m.args || []) : undefined; } catch (err) { console.error(err); error = String(err.message || err); }
    if (value && typeof value.then === 'function') value.then(v => reply(v, null), err => reply(null, String(err && err.message || err)));
    else reply(value, error);
    if (machine) machine.kick();
  } else if (m.t === 'lan') lanSend(pageSide, m.frame);   // a frame from the rest of the segment
  else if (m.t === 'netport') {   // (the system's machine) another machine's channel for its network files
    const sab = m.sab;
    m.port.onmessage = e => {
      let v; const { key, op, args } = e.data;
      try { v = ownNet(key)[op](...args); } catch (err) { v = err; }
      B.answer(sab, v === undefined ? null : v);
    };
  } else if (m.t === 'netlink') netLink = m.port ? { port: m.port, sab: m.sab } : null;   // the system's machine, or none
  else if (m.t === 'netmounts') {   // the drives the network has connected, as this machine's
    for (const v of [...rfs.vols.values()]) if (!m.list.some(x => x.letter === v.letter && x.unc.toUpperCase() === v.unc.toUpperCase())) rfs.unmount(v.letter);
    for (const x of m.list) if (!rfs.vols.has(x.letter)) rfs.mount(x.letter, { remote: netOf(x.letter), unc: x.unc, label: x.unc.split('\\').pop() || '' });
  } else if (m.t === 'regop') W.regApply(m.o, true);
  else if (m.t === 'micIn' && machine && machine.proc) machine.proc.micIn(m.samples, m.rate);   // (the microphone's samples, for the codec's capture)
  else if (m.t === 'conIn' && machine && machine.proc) { const p = machine.proc, c = p.conIn || (p.conIn = new Map()); c.set(m.id, (c.get(m.id) || '') + m.text); machine.kick && machine.kick(); }   // (a line typed in a console program's window)
  else if (m.t === 'ccdReply' && self.W95ClaudeReply) self.W95ClaudeReply(m);   // (a tool's answer for the Claude program: claude-app.js)
  else if (m.t === 'ccdAsk') { if (self.W95ClaudeAsk) self.W95ClaudeAsk(m); else post({ t: 'ccdAnswer', id: m.id, yes: false }); }   // (and a tool's question for it)
  else if (m.t === 'kick') { if (machine) machine.kick(); }
};
