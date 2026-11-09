// Saver image: a .SCR whose bytes are not the image the bundle's translation was made from (another build of it:
// OSR2's or Plus!'s 3D Pipes, 161040 bytes against the bundle's SSPIPES.SCR) runs from its file, its code translated
// as it runs (dyn.js), not with the bundle's translation over it. Over the wrong image that translation read the C
// run-time's small-block heap at address 0 at the saver's start (3D PIPES.SCR+fb74), and the saver ended before it
// drew. WinExec's path (Display Properties, Start > Run) checked no image at all; the page's path refused it (11).
// worker.js has this itself (spawnSaverDynamic); this mod gives a machine started from an older worker.js the same
// methods, no restart: sysApp.cmd('reload', ['mod-saverimage.js']) or #mod=saverimage. Ended (cmd 'modOff'), the
// machine's own methods are back.
(() => {
  const m = machine, proto = m && Object.getPrototypeOf(m), log = t => self.W95Win32.log('info', 'mod', `saverimage: ${t}`);
  if (!proto || typeof proto.spawnSaver !== 'function') { log('no machine'); return; }
  if (proto.spawnSaverDynamic && !proto.spawnSaverDynamic.fromMod) { log('worker.js has it already'); return; }
  const fs = self.W95SHELL.fs, W = self.W95Win32, basename = self.W95FS.basename;
  const post = msg => self.postMessage(msg);
  const b64bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const own = proto.spawnSaverOwn || (proto.spawnSaverOwn = { spawnSaver: proto.spawnSaver, spawnSaverAsync: proto.spawnSaverAsync });
  const base = own.spawnSaver;
  const matches = (bytes, d) => {
    const b = d.scrBytes || (d.scrBytes = b64bytes(d.scr));
    if (bytes.length !== b.length) return false;
    for (let i = 0; i < b.length; i++) if (bytes[i] !== b[i]) return false;
    return true;
  };
  const dynamic = function (file, arg) {
    const p = this.proc, d = this.dynProgram(file);
    log(`${file}: not the bundle's image, run from its file${d ? '' : ': no room for its image'}`);
    if (!d) return 11;
    for (const run of [...this.savers.values()]) p.endProcess(run, 0);
    const mode = /^\s*\/p\b/i.test(arg) ? 'p' : /^\s*\/c\b/i.test(arg) ? 'c' : 's';
    const real = fs.realpath(file), cmdline = `"${real}" ${String(arg || '').trim() || '/s'}`;
    let pc;
    try { pc = p.spawn(fs.readFile(file), null, { ...d.meta, name: basename(real).toUpperCase().replace(/\.SCR$/, '') }, real, cmdline); }
    catch (e) { if (e && e.missingDll) { W.log('warn', 'spawn', e.message); return 2; } console.error(e); return 8; }
    pc.onExit = code => {
      this.savers.delete(pc.pid);
      post({ t: 'emit', ev: 'program.exit', data: { path: pc.path, mode, code, dynamic: true,
        ...(pc.trapped || pc.main && pc.main.fault ? { why: pc.trapped || pc.main.fault.why } : {}) } });
    };
    pc.saverMode = mode; pc.nativeGdi = true; pc.previewHwnd = 0;
    this.savers.set(pc.pid, pc); this.kick();
    return pc;
  };
  dynamic.fromMod = true;
  proto.spawnSaverDynamic = dynamic;
  proto.saverImageMatches = matches;
  proto.spawnSaver = function (file, arg, compiledModule = null, bundleName = null, imageBytes = null) {
    const savers = (self.W95SAVERS || {}).savers || {};
    const hit = bundleName ? [bundleName, savers[bundleName]] : self.W95SaverRuntime.findSaver(fs.realpath(file), savers);
    if (!hit || (!imageBytes && !matches(fs.readFile(file), hit[1]))) return this.spawnSaverDynamic(file, arg);
    return base.call(this, file, arg, compiledModule, bundleName, imageBytes);
  };
  proto.spawnSaverAsync = async function (file, arg) {
    const savers = (self.W95SAVERS || {}).savers || {};
    const hit = self.W95SaverRuntime.findSaver(fs.realpath(file), savers), bytes = fs.readFile(file);
    if (!hit || !await self.W95SaverRuntime.matchesImage(bytes, hit[1])) return this.spawnSaverDynamic(file, arg);
    const mod = await self.W95SaverRuntime.compileModule(hit[1]);
    return base.call(this, file, arg, mod, hit[0], bytes);
  };
  (self.W95ModOff || (self.W95ModOff = {}))['mod-saverimage.js'] = () => {
    proto.spawnSaver = own.spawnSaver; proto.spawnSaverAsync = own.spawnSaverAsync;
    delete proto.spawnSaverDynamic; delete proto.saverImageMatches; delete proto.spawnSaverOwn;
    log('ended');
  };
  log('loaded: a saver that is not the bundle\'s image runs from its file');
})();
