// (a test: SHLWAPI's ShellExecuteExW wrapper (#335, +22DE3) entered: its caller, the SHELLEXECUTEINFOW's fields, and the
// stack's return addresses as symbols, into the console; hooked as SHLWAPI loads)
(() => {
  const p = typeof machine !== 'undefined' && machine.proc; if (!p || p.__seiHook) return; p.__seiHook = true;
  const hook = m => p.addEntryHook(m.base + 0x22de3, function () {
    const sp = this.cpu.esp.value >>> 0, sei = this.r32(sp + 4), f = Array.from({ length: 15 }, (_, k) => this.r32(sei + 4 * k).toString(16));
    const rets = Array.from({ length: 64 }, (_, k) => this.r32(sp + 4 * k)).filter(v => this.modules.some(x => x.size && v >= x.base && v < x.base + x.size)).slice(0, 14).map(v => this.whereOf(v));
    console.warn(`[sei] from ${this.whereOf(this.r32(sp))} thread ${this.thread16 ? this.thread16.id : 'main'} sei ${sei.toString(16)}: ${f.join(' ')} | ${rets.join(' < ')}`);
  });
  const was = p.onModuleLoad; p.onModuleLoad = function (name, m) { if (was) was.call(this, name, m); if (name === 'SHLWAPI') hook(m); };
  const m = p.byName.get('SHLWAPI'); if (m) hook(m);
})();
