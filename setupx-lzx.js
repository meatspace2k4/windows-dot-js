// Windows 98 Setup's cabinet decompression answered in JS: SETUPX.DLL's LDIDecompress (its LZX decoder, segment 23
// offset 0128h, cdecl far; FDI calls it once per CFDATA block, seg 18:18FB) taken at its entry, the 32 KB frame decoded
// here into the caller's buffer. Every Win98 SE .CAB folder is LZX with a 2 MB window (CFFOLDER typeCompress 1503h).
// The stream's state (window, R0-R2, trees' lengths, block in progress, E8 header) lives on the process (lzxJS), so a
// moment carries it with the memory; a stream the native decoder began goes on natively until LDIReset (the
// internal context's byte count at +2B0Ch back to 0). Each machine's worker loads it after ne16.js (worker.js
// importScripts); a travel puts the hook back (worker.js braidTravel, lzxInstall)
(() => {
  const W = self.W95Win32, P = W && W.Process.prototype; if (!P || P.__lzxjs) return;
  const SEG = 23, OFF = 0x128, SIG = [0xc8, 0x0c, 0x00, 0x00, 0x57, 0x56, 0x66, 0xc7, 0x46, 0xf4];
  const EXTRA = new Uint8Array(52), BASE = new Uint32Array(52);
  for (let i = 0, j = 0; i < 52; i += 2) { EXTRA[i] = EXTRA[i + 1] = j; if (i !== 0 && j < 17) j++; }
  for (let i = 1; i < 52; i++) BASE[i] = BASE[i - 1] + (1 << EXTRA[i - 1]);
  const slotsFor = w => { let s = 4, t = 4; while (w > t && s < 51) { t += 1 << EXTRA[s]; s++; } return s; };   // (as SETUPX 23:082E counts them)
  const fresh = wsize => {
    const nmain = 256 + 8 * slotsFor(wsize);
    return { wsize, win: new Uint8Array(wsize), pos: 0, R0: 1, R1: 1, R2: 1, nmain, mainLen: new Uint8Array(nmain + 64), lenLen: new Uint8Array(249 + 64), alignLen: new Uint8Array(8),
      btype: 0, brem: 0, blen: 0, hdr: 0, intelSize: 0, intelStarted: 0, frame: 0, total: 0, gen: 0 };
  };
  const bad = m => { throw new Error(`lzxjs: ${m}`); };
  const build = (lens, n) => {
    let max = 0; for (let i = 0; i < n; i++) if (lens[i] > max) max = lens[i];
    if (!max) return null;
    const size = 1 << max, t = new Uint16Array(size).fill(0xffff);
    for (let L = 1, code = 0; L <= max; L++, code <<= 1) for (let s = 0; s < n; s++) if (lens[s] === L) {
      const span = 1 << (max - L), at = code * span; if (at + span > size) bad('over-subscribed tree'); t.fill(s, at, at + span); code++;
    }
    return { t, bits: max, lens: lens.slice(0, n) };
  };
  // (the trees made from the lengths, kept beside the state, not in it: a moment carries the lengths; a state come back
  // from one, or a cache of another block, builds them again)
  const tables = new WeakMap(), genBase = (Math.random() * 0x40000000) | 0; let gen = 0;
  const trees = st => {
    let c = tables.get(st);
    if (!c || c.gen !== st.gen) {
      c = { gen: st.gen, main: build(st.mainLen, st.nmain), len: build(st.lenLen, 249), align: st.btype === 2 ? build(st.alignLen, 8) : null };
      tables.set(st, c);
    }
    return c;
  };
  // one frame: `inp` the CFDATA's bytes, `size` its uncompressed bytes; the frame's bytes, E8-translated
  const frame = (st, inp, size) => {
    const n = inp.length, win = st.win, mask = st.wsize - 1, out = new Uint8Array(size);
    let p = 0, bb = 0, bl = 0, pos = st.pos, o = 0;
    const need = k => { while (bl < k) { const w = p + 1 < n ? inp[p] | (inp[p + 1] << 8) : p < n ? inp[p] : 0; p += 2; bb = ((bb << 16) | w) >>> 0; bl += 16; } };
    const peek = k => (bb >>> (bl - k)) & ((1 << k) - 1);
    const drop = k => { bl -= k; bb = bl ? (bb & ((1 << bl) - 1)) >>> 0 : 0; };
    const bits = k => { if (!k) return 0; need(k); const v = peek(k); drop(k); return v; };
    const sym = tr => { if (!tr) bad('empty tree used'); need(tr.bits); const s = tr.t[peek(tr.bits)]; if (s === 0xffff) bad('bad code'); drop(tr.lens[s]); return s; };
    const readLens = (lens, first, last) => {
      const pl = new Uint8Array(20); for (let i = 0; i < 20; i++) pl[i] = bits(4);
      const pre = build(pl, 20);
      for (let x = first; x < last;) {
        let z = sym(pre);
        if (z === 17) { let y = bits(4) + 4; while (y--) lens[x++] = 0; }
        else if (z === 18) { let y = bits(5) + 20; while (y--) lens[x++] = 0; }
        else if (z === 19) { let y = bits(1) + 4; z = sym(pre); z = lens[x] - z; if (z < 0) z += 17; while (y--) lens[x++] = z; }
        else { z = lens[x] - z; if (z < 0) z += 17; lens[x++] = z; }
      }
    };
    if (!st.hdr) { st.intelSize = bits(1) ? bits(16) * 65536 + bits(16) : 0; st.hdr = 1; }
    let tr = st.btype === 1 || st.btype === 2 ? trees(st) : null;
    while (o < size) {
      if (st.brem === 0) {
        if (st.btype === 3 && (st.blen & 1)) p++;   // (the pad byte after an uncompressed block of odd length)
        st.btype = bits(3); st.brem = st.blen = bits(16) * 256 + bits(8);
        if (st.btype === 2) for (let i = 0; i < 8; i++) st.alignLen[i] = bits(3);
        if (st.btype === 1 || st.btype === 2) {
          readLens(st.mainLen, 0, 256); readLens(st.mainLen, 256, st.nmain);
          if (st.mainLen[0xe8]) st.intelStarted = 1;
          readLens(st.lenLen, 0, 249);
          st.gen = genBase + ++gen; tr = trees(st);
          if (!tr.main) bad('empty main tree');
        } else if (st.btype === 3) {
          st.intelStarted = 1;
          if (bl === 0) need(16);
          bl = 0; bb = 0;
          if (p + 12 > n) bad('uncompressed header past input');
          const r = i => (inp[p + i] | (inp[p + i + 1] << 8) | (inp[p + i + 2] << 16) | (inp[p + i + 3] << 24)) >>> 0;
          st.R0 = r(0); st.R1 = r(4); st.R2 = r(8); p += 12;
          tr = null;
        } else bad(`block type ${st.btype}`);
      }
      const start = o, end = o + Math.min(st.brem, size - o);
      if (st.btype === 3) {
        const k = end - o; if (p + k > n) bad('uncompressed data past input');
        for (let i = 0; i < k; i++) { const c = inp[p++]; win[pos] = c; out[o++] = c; pos = (pos + 1) & mask; }
      } else {
        const aligned = st.btype === 2, main = tr.main, len = tr.len, al = tr.align;
        let R0 = st.R0, R1 = st.R1, R2 = st.R2;
        while (o < end) {
          let m = sym(main);
          if (m < 256) { win[pos] = m; out[o++] = m; pos = (pos + 1) & mask; continue; }
          m -= 256;
          let ml = m & 7; if (ml === 7) ml += sym(len); ml += 2;
          let off = m >> 3;
          if (off > 2) {
            const ex = off >= 36 ? 17 : EXTRA[off];
            if (!aligned) off = off !== 3 ? BASE[off] - 2 + bits(ex) : 1;
            else {
              const b = BASE[off] - 2;
              if (ex > 3) off = b + (bits(ex - 3) << 3) + sym(al);
              else if (ex === 3) off = b + sym(al);
              else if (ex > 0) off = b + bits(ex);
              else off = 1;
            }
            R2 = R1; R1 = R0; R0 = off;
          } else if (off === 0) off = R0;
          else if (off === 1) { off = R1; R1 = R0; R0 = off; }
          else { off = R2; R2 = R0; R0 = off; }
          if (off > st.wsize) bad('match offset past window');
          let s = (pos - off) & mask;
          for (let i = 0; i < ml; i++) { const c = win[s]; win[pos] = c; out[o++] = c; pos = (pos + 1) & mask; s = (s + 1) & mask; }
        }
        st.R0 = R0; st.R1 = R1; st.R2 = R2;
      }
      const made = o - start; if (made > st.brem) bad('match past block'); st.brem -= made;
    }
    if (o !== size) bad('frame overrun');
    if (st.intelStarted && st.intelSize && st.frame < 32768 && size > 10) {
      const fsz = st.intelSize | 0; let cur = st.total | 0;
      for (let i = 0, e = size - 10; i < e;) {
        if (out[i++] !== 0xe8) { cur++; continue; }
        const abs = out[i] | (out[i + 1] << 8) | (out[i + 2] << 16) | (out[i + 3] << 24);
        if (abs >= -cur && abs < fsz) { const rel = abs >= 0 ? abs - cur : abs + fsz; out[i] = rel; out[i + 1] = rel >> 8; out[i + 2] = rel >> 16; out[i + 3] = rel >> 24; }
        i += 4; cur += 5;
      }
    }
    st.frame++; st.pos = pos;
    return out;
  };
  P.lzxFrame = frame; P.lzxFresh = fresh;   // (for a test from outside)
  // LDIDecompress(hmd, pbSrc, cbSrc, pbDst, pcbResult): cdecl far, its 12h bytes left to the caller; ax 0, 2 (not a
  // context), 3 (*pcbResult over the context's block maximum, +20h) or 4 (failed, *pcbResult 0)
  const answer = function (at) {
    const rec = this.ne && this.ne.get('SETUPX'), sg = rec && rec.segs && rec.segs[SEG - 1];
    if (!sg || ((sg.base + OFF) >>> 0) !== at) return undefined;
    for (let i = 0; i < SIG.length; i++) if (this.u8[at + i] !== SIG[i]) return undefined;
    const ssb = this.cpu.ssb.value >>> 0, sp = this.cpu.esp.value & 0xffff, w = k => this.r16(ssb + ((sp + k) & 0xffff));
    const far = k => { const sel = w(k + 2); return sel && this.selValid(sel) ? (this.selBase(sel) + w(k)) >>> 0 : -1; };
    const ctx = far(4), src = far(8), cbSrc = w(12), dst = far(14), pcb = far(18);
    if (ctx < 0 || src < 0 || dst < 0 || pcb < 0) return undefined;
    const ret = v => { this.ax(v); return this.retf16(0); };
    if (this.r32(ctx) !== 0x444c) return ret(2);
    const cbDest = this.r16(pcb);
    if (this.r16(ctx + 0x20) < cbDest) return ret(3);
    const isel = this.r16(ctx + 0x26); if (!isel || !this.selValid(isel)) return undefined;
    const ictx = (this.selBase(isel) + this.r16(ctx + 0x24)) >>> 0, total = this.r32(ictx + 0x2b0c) >>> 0, key = ictx.toString(16);
    const all = this.lzxJS || (this.lzxJS = {});
    let st = all[key];
    if (total === 0) { const ws = this.r32(ictx) >>> 0; if (ws < 0x8000 || ws > 0x200000 || (ws & (ws - 1))) return undefined; st = all[key] = fresh(ws); }
    else if (!st) return undefined;   // (begun natively, before this mod: natively to its end)
    const fail = why => { delete all[key]; (this.lzxLog || (this.lzxLog = [])).push({ at: total, why }); if (this.lzxLog.length > 20) this.lzxLog.shift(); this.w16(pcb, 0); return ret(4); };
    if (st.total !== total) return fail(`stream at ${total}, state at ${st.total}`);
    let out; try { out = frame(st, this.u8.slice(src, src + cbSrc), cbDest); } catch (e) { return fail(e.message); }
    this.u8.set(out, dst);
    this.w16(pcb, cbDest);
    st.total = (total + cbDest) >>> 0; this.w32(ictx + 0x2b0c, st.total);
    this.lzxFrames = (this.lzxFrames || 0) + 1;
    return ret(0);
  };
  const install = p => {
    const rec = p && p.ne && p.ne.get('SETUPX'), sg = rec && rec.segs && rec.segs[SEG - 1]; if (!sg || !sg.base) return false;
    const at = (sg.base + OFF) >>> 0;
    for (let i = 0; i < SIG.length; i++) if (p.u8[at + i] !== SIG[i]) return false;
    const l = p.entryLists && p.entryLists.get(at), h = p.entryHooks && p.entryHooks.get(at);
    if ((l && l.fns.some(f => f.__lzxjs)) || (h && h.__lzxjs)) return true;
    const fn = function () { return answer.call(this, at); }; fn.__lzxjs = true;
    p.addEntryHook(at, fn);
    return true;
  };
  P.lzxInstall = function () { return install(this); };
  // (SETUPX loaded from its file after this; the hooks made again for a moment from another computer, worker.js
  // import, which ends in hookTaken; a travel, whose entryHooks are the moment's, calls lzxInstall itself)
  const wasLoad = P.loadNEDynamic;
  P.loadNEDynamic = function (key, file) { const r = wasLoad.apply(this, arguments); if (r && r.name === 'SETUPX') install(this); return r; };
  const wasTaken = P.hookTaken;
  P.hookTaken = function (user) { const r = wasTaken.apply(this, arguments); install(this); return r; };
  P.__lzxjs = true;
  // (loaded over a running machine (cmd 'reload'): its SETUPX hooked now. At the worker's import, worker.js's `let
  // machine` is not yet initialized, and reading it throws)
  try { if (machine && machine.proc) install(machine.proc); } catch (_) { /* at import: no machine yet */ }
})();
