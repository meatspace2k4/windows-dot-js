// (a test: SETUPAPI opening C:\RGI_2.INF and listing [InstallBrowseUINonShell]'s lines as it parsed them (key, field 1),
// and SetupFindFirstLineA for AddReg, into the console)
(() => {
  const p = typeof machine !== 'undefined' && machine.proc; if (!p) return;
  const m = p.loadDll('SETUPAPI'); if (!m) { console.warn('[setupapi] no SETUPAPI'); return; }
  p.runPendingInits(); for (const d of p.importClosure(m)) p.attach(d);
  const ex = n => m.exports.get(n), buf = p.alloc(0x1000), s = (o, t) => { p.writeA(buf + o, t); return buf + o; };
  const inf = p.call(ex('SetupOpenInfFileA'), [s(0, 'C:\\RGI_2.INF'), 0, 2, buf + 0x200]);   // INF_STYLE_WIN4
  const out = [`open ${(inf >>> 0).toString(16)} err ${p.r32(buf + 0x200)} le ${(p.lastError >>> 0).toString(16)}`];
  if ((inf >>> 0) !== 0xffffffff) {
    const sec = s(0x300, 'InstallBrowseUINonShell'), ctx = buf + 0x400;
    const cnt = p.call(ex('SetupGetLineCountA'), [inf, sec]); out.push(`lines ${cnt | 0}`);
    for (let i = 0; i < Math.min(cnt, 10); i++) {
      const ok = p.call(ex('SetupGetLineByIndexA'), [inf, sec, i, ctx]);
      const k = p.call(ex('SetupGetStringFieldA'), [ctx, 0, buf + 0x500, 0x100, 0]), kv = k ? p.readA(buf + 0x500) : '-';
      const v = p.call(ex('SetupGetStringFieldA'), [ctx, 1, buf + 0x600, 0x100, 0]), vv = v ? p.readA(buf + 0x600) : '-';
      out.push(`#${i} ok ${ok} key ${JSON.stringify(kv)} f1 ${JSON.stringify(vv)}`);
    }
    const f = p.call(ex('SetupFindFirstLineA'), [inf, sec, s(0x700, 'AddReg'), ctx]); out.push(`find AddReg ${f} le ${(p.lastError >>> 0).toString(16)}`);
    const cntS = p.call(ex('SetupGetLineCountA'), [inf, s(0x300, 'Strings')]); out.push(`Strings lines ${cntS | 0}`);
    p.call(ex('SetupCloseInfFile'), [inf]);
  }
  console.warn('[setupapi] ' + out.join(' | '));
  p.free(buf);
})();
