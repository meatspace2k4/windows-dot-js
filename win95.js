'use strict';
// Windows 95 shell rendered on a single canvas. All bitmaps, icons, cursors and
// fonts come from assets.js, which is extracted from the OSR2 CD's WIN95_02.CAB.
(() => {
const A = window.W95;
const cv = document.getElementById('screen');
const ctx = cv.getContext('2d', { alpha: false });
const kbd = document.createElement('textarea');
kbd.setAttribute('autocapitalize', 'off'); kbd.setAttribute('autocomplete', 'off'); kbd.spellcheck = false;
kbd.style.cssText = 'position:fixed;left:-1000px;top:0;width:10px;height:10px;opacity:0';
document.body.appendChild(kbd);
const ZOOM = Math.max(1, parseInt(new URLSearchParams(location.search).get('zoom'), 10) || 1);
const TB = 28;
let W = 640, H = 480;

const K = {
  desk: '#008080', face: '#c0c0c0', lt: '#c0c0c0', hl: '#ffffff', sh: '#808080', dk: '#000000',
  cap: '#000080', icap: '#808080', icapText: '#c0c0c0', sel: '#000080', win: '#ffffff', tip: '#ffffe1',
};

// ---------------------------------------------------------------- assets
const IMG = {}, CUR = {};
const ready = [];
for (const [k, src] of Object.entries(A.img)) {
  const i = new Image(); ready.push(new Promise(r => (i.onload = r))); i.src = src; IMG[k] = i;
}
for (const [k, [src, hx, hy]] of Object.entries(A.cursors)) {
  const i = new Image(); ready.push(new Promise(r => (i.onload = r))); i.src = src; CUR[k] = { i, hx, hy };
}

// ---------------------------------------------------------------- primitives
const fill = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
function edge(x, y, w, h, tl, br) {
  fill(x, y, w - 1, 1, tl); fill(x, y, 1, h - 1, tl);
  fill(x + w - 1, y, 1, h, br); fill(x, y + h - 1, w, 1, br);
}
const frameRaised = (x, y, w, h) => { edge(x, y, w, h, K.lt, K.dk); edge(x + 1, y + 1, w - 2, h - 2, K.hl, K.sh); };
const btnUp = (x, y, w, h) => { fill(x, y, w, h, K.face); edge(x, y, w, h, K.hl, K.dk); edge(x + 1, y + 1, w - 2, h - 2, K.lt, K.sh); };
const btnDown = (x, y, w, h, bg = K.face) => {
  ctx.fillStyle = bg; ctx.fillRect(x, y, w, h); edge(x, y, w, h, K.dk, K.hl); edge(x + 1, y + 1, w - 2, h - 2, K.sh, K.lt);
};
const field = (x, y, w, h, bg = K.win) => { fill(x, y, w, h, bg); edge(x, y, w, h, K.sh, K.hl); edge(x + 1, y + 1, w - 2, h - 2, K.dk, K.lt); };
const inR = (r, x, y) => r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function patCanvas(c1, c2) {
  const p = document.createElement('canvas'); p.width = p.height = 2;
  const g = p.getContext('2d');
  if (c2) { g.fillStyle = c2; g.fillRect(0, 0, 2, 2); }
  g.fillStyle = c1; g.fillRect(0, 0, 1, 1); g.fillRect(1, 1, 1, 1);
  return p;
}
const PAT = {
  track: ctx.createPattern(patCanvas(K.hl, K.face), 'repeat'),
  dim: ctx.createPattern(patCanvas(K.dk), 'repeat'),
  xor: ctx.createPattern(patCanvas('#fff'), 'repeat'),
  sel: patCanvas(K.sel),
};

function focusRect(x, y, w, h) {
  ctx.save(); ctx.globalCompositeOperation = 'difference'; ctx.fillStyle = '#fff';
  for (let i = 0; i < w; i += 2) { ctx.fillRect(x + i, y, 1, 1); ctx.fillRect(x + i, y + h - 1, 1, 1); }
  for (let j = 2; j < h - 1; j += 2) { ctx.fillRect(x, y + j, 1, 1); ctx.fillRect(x + w - 1, y + j, 1, 1); }
  ctx.restore();
}
function xorFrame(r, t) {
  ctx.save(); ctx.globalCompositeOperation = 'difference'; ctx.fillStyle = PAT.xor;
  ctx.fillRect(r.x, r.y, r.w, t); ctx.fillRect(r.x, r.y + r.h - t, r.w, t);
  ctx.fillRect(r.x, r.y + t, t, r.h - 2 * t); ctx.fillRect(r.x + r.w - t, r.y + t, t, r.h - 2 * t);
  ctx.restore();
}

// ---------------------------------------------------------------- bitmap text
const tcache = new Map();
function amp(s) {
  let out = '', ul = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '&') { if (s[i + 1] === '&') { out += '&'; i++; } else ul = out.length; } else out += s[i];
  }
  return [out, ul];
}
const esc = s => s.replace(/&/g, '&&');
const mnemonicOf = s => { if (!s) return ''; const [t, u] = amp(s); return u < 0 ? '' : t[u].toLowerCase(); };
function glyph(f, ch) { let c = ch.charCodeAt(0); if (c > 255) c = 63; return f.g[c] || f.g[f.default]; }
function rawW(s, bold, f) { let w = 0; for (const ch of s) w += glyph(f, ch)[0] + (bold ? 1 : 0); return w; }
const textW = (s, bold = false, f = A.font) => rawW(amp(s)[0], bold, f);
const rgb = c => { const n = parseInt(c.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };

function bitsCanvas(w, h, color, plot) {
  const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = h;
  const g = c.getContext('2d'); const id = g.createImageData(c.width, h); const d = id.data; const [r, gg, b] = rgb(color);
  plot((x, y) => {
    if (x < 0 || y < 0 || x >= c.width || y >= h) return;
    const o = (y * c.width + x) * 4; d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
  });
  g.putImageData(id, 0, 0); return c;
}
function textImg(s, color, bold, f) {
  const key = s + '\u0001' + color + (bold ? 'b' : '') + (f === A.font ? '' : 'x');
  let c = tcache.get(key); if (c) return c;
  if (tcache.size > 4000) tcache.clear();
  const [str, ul] = amp(s);
  c = bitsCanvas(rawW(str, bold, f), f.h, color, set => {
    let ox = 0, i = 0;
    for (const ch of str) {
      const [gw, rows] = glyph(f, ch), bw = gw + (bold ? 1 : 0);
      for (let y = 0; y < f.h; y++) {
        const bits = rows[y]; if (!bits) continue;
        for (let x = 0; x < gw; x++) if ((bits >> (gw - 1 - x)) & 1) { set(ox + x, y); if (bold) set(ox + x + 1, y); }
      }
      if (i === ul) for (let x = 0; x < bw; x++) set(ox + x, f.ascent + 1);
      ox += bw; i++;
    }
  });
  tcache.set(key, c); return c;
}
function text(s, x, y, color = K.dk, bold = false, f = A.font) {
  if (!s) return 0; const c = textImg(s, color, bold, f); ctx.drawImage(c, x, y); return c.width;
}
function textEmboss(s, x, y, bold) { text(s, x + 1, y + 1, K.hl, bold); text(s, x, y, K.sh, bold); }
function ellipsis(s, maxW, bold) {
  if (textW(s, bold) <= maxW) return s;
  let t = s; while (t.length && textW(t + '...', bold) > maxW) t = t.slice(0, -1);
  return t + '...';
}
function wrap(s, maxW) {
  const out = [];
  for (const para of s.split('\n')) {
    let cur = '';
    for (const w of para.split(' ')) {
      const t = cur ? cur + ' ' + w : w;
      if (!cur || textW(t) <= maxW) cur = t; else { out.push(cur); cur = w; }
    }
    // hard-break single words wider than the box
    while (textW(cur) > maxW && cur.length > 1) {
      let n = cur.length; while (n > 1 && textW(cur.slice(0, n)) > maxW) n--;
      out.push(cur.slice(0, n)); cur = cur.slice(n);
    }
    out.push(cur);
  }
  return out;
}

const gcache = new Map();
function mglyph(name, x, y, color = K.dk) {
  const key = name + color; let c = gcache.get(key);
  if (!c) {
    const [w, h, rows] = A.glyphs[name];
    c = bitsCanvas(w, h, color, set => { for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if ((rows[yy] >> (w - 1 - xx)) & 1) set(xx, yy); });
    gcache.set(key, c);
  }
  ctx.drawImage(c, x, y);
}

const icache = new Map();
function icon(name, x, y, selected) {
  const im = IMG[name]; if (!im) return;
  if (!selected) { ctx.drawImage(im, x, y); return; }
  let c = icache.get(name);
  if (!c) {
    c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    g.globalCompositeOperation = 'source-atop'; g.fillStyle = g.createPattern(PAT.sel, 'repeat'); g.fillRect(0, 0, c.width, c.height);
    icache.set(name, c);
  }
  ctx.drawImage(c, x, y);
}

function sizeGrip(rx, by) { // rx, by: right/bottom edge (exclusive)
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
    const d = i + j - 11; if (d < 0) continue;
    const m = d % 4; if (m === 3) continue;
    fill(rx - 12 + i, by - 12 + j, 1, 1, m === 0 ? K.hl : K.sh);
  }
}

const RAD_O = ['....xxxx....', '..xx....xx..', '.x........x.', '.x........x.', 'x..........x', 'x..........x',
  'x..........x', 'x..........x', '.x........x.', '.x........x.', '..xx....xx..', '....xxxx....'];
const RAD_I = ['............', '....xxxx....', '..xx....xx..', '..x......x..', '.x........x.', '.x........x.',
  '.x........x.', '.x........x.', '..x......x..', '..xx....xx..', '....xxxx....', '............'];
function radio(x, y, on) {
  for (let r = 0; r < 12; r++) {
    const a = RAD_I[r].indexOf('x'), b = RAD_I[r].lastIndexOf('x');
    if (a >= 0 && b - a > 1) fill(x + a + 1, y + r, b - a - 1, 1, K.win);
    for (let c = 0; c < 12; c++) {
      if (RAD_O[r][c] === 'x') fill(x + c, y + r, 1, 1, c + r < 11 ? K.sh : K.hl);
      if (RAD_I[r][c] === 'x') fill(x + c, y + r, 1, 1, c + r < 11 ? K.dk : K.lt);
    }
  }
  if (on) { fill(x + 5, y + 4, 2, 1, K.dk); fill(x + 4, y + 5, 4, 2, K.dk); fill(x + 5, y + 7, 2, 1, K.dk); }
}

function pushButton(x, y, w, h, label, o = {}) {
  if (o.pressed) { fill(x, y, w, h, K.face); edge(x, y, w, h, K.dk, K.dk); edge(x + 1, y + 1, w - 2, h - 2, K.sh, K.sh); }
  else if (o.def) { fill(x, y, w, h, K.face); edge(x, y, w, h, K.dk, K.dk); btnUp(x + 1, y + 1, w - 2, h - 2); }
  else btnUp(x, y, w, h);
  const off = o.pressed ? 1 : 0;
  const tx = x + ((w - textW(label)) >> 1) + off, ty = y + ((h - 13) >> 1) + off;
  if (o.disabled) textEmboss(label, tx, ty); else text(label, tx, ty);
  if (o.focus) focusRect(x + 4, y + 4, w - 8, h - 8);
}

// ---------------------------------------------------------------- state
let windows = [], tasks = [], active = null, modals = [];
let menus = [], menuSrc = null, menuTimer = 0;
let cap = null, drag = null, ghost = null;
let mouse = { x: -100, y: -100 }, lastDown = { t: 0, x: 0, y: 0 };
let screen = 'desktop', blinkOn = true, tip = null, tipTimer = 0;
let cascadeN = 0;
const modal = () => modals[modals.length - 1] || null;

let rafPending = false, observing = false, seen = null;
const mods = { shift: false };   // modifier keys held at the last pointer press
function dirty() { if (!rafPending) { rafPending = true; requestAnimationFrame(render); } if (!observing) { observing = true; queueMicrotask(observe); } }

// ---------------------------------------------------------------- scroll bars
class ScrollBar {
  constructor(vert, onchange) { this.v = vert; this.pos = 0; this.max = 1; this.page = 1; this.onchange = onchange; this.r = { x: 0, y: 0, len: 0 }; this.hot = null; }
  set(x, y, len, max, page) { this.r = { x, y, len }; this.max = max; this.page = Math.max(1, page); this.clampPos(); }
  get enabled() { return this.max > this.page; }
  clampPos() { this.pos = clamp(this.pos, 0, Math.max(0, this.max - this.page)); }
  setPos(p) { const o = this.pos; this.pos = p; this.clampPos(); if (o !== this.pos && this.onchange) this.onchange(this.pos); }
  geom() {
    const track = this.r.len - 32; if (!this.enabled || track < 8) return null;
    const tl = Math.max(8, Math.floor(track * this.page / this.max));
    return { track, tl, tp: 16 + Math.round((track - tl) * this.pos / (this.max - this.page)) };
  }
  rect(a, b) { return this.v ? { x: this.r.x, y: this.r.y + a, w: 16, h: b } : { x: this.r.x + a, y: this.r.y, w: b, h: 16 }; }
  draw() {
    const len = this.r.len, g = this.geom(), tr = this.rect(16, len - 32);
    ctx.fillStyle = PAT.track; ctx.fillRect(tr.x, tr.y, tr.w, tr.h);
    if (g && this.hot === 'pgup') { const r = this.rect(16, g.tp - 16); fill(r.x, r.y, r.w, r.h, K.dk); }
    if (g && this.hot === 'pgdn') { const r = this.rect(g.tp + g.tl, len - 16 - g.tp - g.tl); fill(r.x, r.y, r.w, r.h, K.dk); }
    this.arrow(this.rect(0, 16), this.v ? 'up' : 'left', this.hot === 'dec');
    this.arrow(this.rect(len - 16, 16), this.v ? 'down' : 'right', this.hot === 'inc');
    if (g) { const t = this.rect(g.tp, g.tl); btnUp(t.x, t.y, t.w, t.h); }
  }
  arrow(r, name, pressed) {
    if (pressed) { fill(r.x, r.y, r.w, r.h, K.face); edge(r.x, r.y, r.w, r.h, K.sh, K.sh); } else btnUp(r.x, r.y, r.w, r.h);
    const [gw, gh] = A.glyphs[name], o = pressed ? 1 : 0;
    const gx = r.x + ((16 - gw) >> 1) + o, gy = r.y + ((16 - gh) >> 1) + o;
    if (this.enabled) mglyph(name, gx, gy); else { mglyph(name, gx + 1, gy + 1, K.hl); mglyph(name, gx, gy, K.sh); }
  }
  hit(x, y) {
    const a = this.v ? y - this.r.y : x - this.r.x;
    if (a < 16) return 'dec'; if (a >= this.r.len - 16) return 'inc';
    const g = this.geom(); if (!g) return null;
    return a < g.tp ? 'pgup' : a >= g.tp + g.tl ? 'pgdn' : 'thumb';
  }
  contains(x, y) { return inR(this.rect(0, this.r.len), x, y); }
  down(x, y) {
    const h = this.hit(x, y); if (!h || !this.enabled) return null;
    if (h === 'thumb') {
      const g = this.geom(), s = this.v ? y : x, p0 = this.pos, range = this.max - this.page;
      return { move: (mx, my) => this.setPos(Math.round(p0 + ((this.v ? my : mx) - s) * range / Math.max(1, g.track - g.tl))) };
    }
    const delta = { dec: -1, inc: 1, pgup: -Math.max(1, this.page - 1), pgdn: Math.max(1, this.page - 1) }[h];
    let px = x, py = y;
    const step = () => { if (this.hit(px, py) === h) { this.hot = h; this.setPos(this.pos + delta); } else this.hot = null; dirty(); };
    step();
    let t = setTimeout(function rep() { step(); t = setTimeout(rep, 50); }, 400);
    return { move: (mx, my) => { px = mx; py = my; this.hot = this.hit(mx, my) === h ? h : null; }, up: () => { clearTimeout(t); this.hot = null; } };
  }
}

// ---------------------------------------------------------------- windows
class Win {
  constructor(o) {
    Object.assign(this, {
      x: 40, y: 40, w: 300, h: 200, title: '', icon: null, resizable: true, minimizable: true, maximizable: true,
      menu: null, body: null, max: false, min: false, minW: 120, minH: 60, noTask: false, dim: false,
    }, o);
    this.b = this.resizable ? 4 : 3;
    this.saved = null; this.pressBtn = null; this.barOpen = -1;
  }
  get capR() { return { x: this.x + this.b, y: this.y + this.b, w: this.w - 2 * this.b, h: 18 }; }
  get barR() { return this.menu ? { x: this.x + this.b, y: this.y + this.b + 19, w: this.w - 2 * this.b, h: 19 } : null; }
  get clientR() {
    const top = this.y + this.b + 19 + (this.menu ? 19 : 0);
    return { x: this.x + this.b, y: top, w: this.w - 2 * this.b, h: this.y + this.h - this.b - top };
  }
  buttons() {
    const c = this.capR, y = c.y + 2, out = [];
    let x = c.x + c.w - 2 - 16;
    out.push({ id: 'close', x, y, w: 16, h: 14 });
    if (this.maximizable || this.minimizable) {
      x -= 18; out.push({ id: this.max ? 'restore' : 'max', x, y, w: 16, h: 14, disabled: !this.maximizable });
      x -= 16; out.push({ id: 'min', x, y, w: 16, h: 14, disabled: !this.minimizable });
    }
    return out;
  }
  barItems() {
    if (!this.menu) return [];
    const r = this.barR; let x = r.x;
    return this.menu.map(m => { const w = textW(m.label) + 12; const it = { x, y: r.y, w, h: 18, m }; x += w; return it; });
  }
  get isActive() { return this === active || this === modal(); }
  draw() {
    const { x, y, w, h } = this;
    fill(x, y, w, h, K.face); frameRaised(x, y, w, h);
    const c = this.capR, act = this.isActive;
    fill(c.x, c.y, c.w, c.h, act ? K.cap : K.icap);
    let tx = c.x + 3;
    if (this.icon) { icon(this.icon + '16', c.x + 2, c.y + 1); tx = c.x + 21; }
    const btns = this.buttons(), limit = btns[btns.length - 1].x - 4 - tx;
    text(ellipsis(esc(this.title), limit, true), tx, c.y + 2, act ? K.hl : K.icapText, true);
    for (const b of btns) {
      const p = this.pressBtn === b.id;
      if (p) btnDown(b.x, b.y, b.w, b.h); else btnUp(b.x, b.y, b.w, b.h);
      const [gw, gh] = A.glyphs[b.id], o = p ? 1 : 0;
      const gx = b.x + ((16 - gw) >> 1) + o;
      const gy = b.id === 'min' ? b.y + 9 + o : b.y + ((14 - gh) >> 1) + o;
      if (b.disabled) { mglyph(b.id, gx + 1, gy + 1, K.hl); mglyph(b.id, gx, gy, K.sh); } else mglyph(b.id, gx, gy);
    }
    for (const [i, it] of this.barItems().entries()) {
      const open = this.barOpen === i, o = open ? 1 : 0;
      if (open) edge(it.x, it.y, it.w, it.h, K.sh, K.hl);
      text(it.m.label, it.x + 6 + o, it.y + 3 + o);
    }
    const cr = this.clientR;
    if (this.body && cr.w > 0 && cr.h > 0) {
      ctx.save(); ctx.beginPath(); ctx.rect(cr.x, cr.y, cr.w, cr.h); ctx.clip();
      this.body.draw(cr, this);
      ctx.restore();
    }
  }
  hit(px, py) {
    if (!inR(this, px, py)) return null;
    for (const b of this.buttons()) if (inR(b, px, py)) return b.id;
    if (this.resizable && !this.max) {
      const l = px < this.x + this.b, r = px >= this.x + this.w - this.b, t = py < this.y + this.b, bt = py >= this.y + this.h - this.b;
      if (l || r || t || bt) {
        const cl = px < this.x + 16, cr = px >= this.x + this.w - 16, ct = py < this.y + 16, cb = py >= this.y + this.h - 16;
        return ((t || (ct && (l || r))) ? 'n' : (bt || (cb && (l || r))) ? 's' : '') +
               ((l || (cl && (t || bt))) ? 'w' : (r || (cr && (t || bt))) ? 'e' : '');
      }
    }
    const c = this.capR;
    if (inR(c, px, py)) return (this.icon && px < c.x + 18) ? 'sysicon' : 'caption';
    if (inR(this.barR, px, py)) return 'bar';
    if (inR(this.clientR, px, py)) return 'client';
    return 'frame';
  }
}

// Taskbar options (Taskbar Properties), kept where Explorer keeps them: the flags word of StuckRects
// (1 auto hide, 2 always on top, 4 small icons in the Start menu, 8 clock hidden)
const tbar = { ontop: true, autohide: false, small: false, clock: true, shown: 1 };
const STUCK = 'hkcu\\software\\microsoft\\windows\\currentversion\\explorer';
function loadTaskbar() {
  const v = W95Win32.regGet(STUCK, 'StuckRects'); if (!v || !v.data || v.data.length < 12) return;
  const f = v.data[8] | v.data[9] << 8;
  Object.assign(tbar, { autohide: !!(f & 1), ontop: !!(f & 2), small: !!(f & 4), clock: !(f & 8) }); tbar.shown = tbar.autohide ? 0 : 1;
}
function saveTaskbar() {
  const d = new Uint8Array(40), f = (tbar.autohide ? 1 : 0) | (tbar.ontop ? 2 : 0) | (tbar.small ? 4 : 0) | (tbar.clock ? 0 : 8);
  d[0] = 40; d[8] = f; W95Win32.regSet(STUCK, 'StuckRects', { type: 3, name: 'StuckRects', data: d });
}
// where windows may go, and where the taskbar is now (an auto-hidden one slides down to a 2-pixel edge)
const workH = () => (tbar.autohide ? H - 2 : H - TB);
const barTop = () => Math.round(H - 2 - (TB - 2) * (tbar.autohide ? tbar.shown : 1));
let slide = 0;
function slideTaskbar(show) {
  if (!tbar.autohide) return;
  const want = show ? 1 : 0; if (tbar.shown === want && !slide) return;
  cancelAnimationFrame(slide); const from = tbar.shown, t0 = performance.now();
  const step = () => { const k = Math.min(1, (performance.now() - t0) / 120); tbar.shown = from + (want - from) * k; dirty(); slide = k < 1 ? requestAnimationFrame(step) : 0; };
  slide = requestAnimationFrame(step);
}
const maxRect = b => ({ x: -b, y: -b, w: W + 2 * b, h: workH() + 2 * b });

function openWin(w) {
  windows.push(w); if (!w.noTask) tasks.push(w);
  activate(w); dirty(); return w;
}
function activate(w) {
  if (w && w.native && !w.app.syncing) w.app.focus(w);
  if (w && modal() && w !== modal()) w = modal();
  if (w) { w.min = false; windows = windows.filter(v => v !== w); windows.push(w); }
  active = w; blinkOn = true; dirty();
}
function topVisible() { for (let i = windows.length - 1; i >= 0; i--) if (!windows[i].min) return windows[i]; return null; }
function closeWin(w, force) {
  if (!windows.includes(w)) return;
  if (w.native && !force) { w.app.close(w); return; }
  if (!force && w.body && w.body.canClose && !w.body.canClose(() => closeWin(w, true))) return;
  if (w.body && w.body.onClose) w.body.onClose();
  windows = windows.filter(v => v !== w); tasks = tasks.filter(v => v !== w); modals = modals.filter(v => v !== w);
  if (menuSrc && menuSrc.win === w) closeMenus();
  if (active === w || !windows.includes(active)) active = modal() || topVisible();
  dirty();
}
function minimize(w) { if (!w.minimizable) return; if (w.native) { w.app.minimize(w); return; } w.min = true; if (active === w) active = topVisible(); dirty(); }
function toggleMax(w) {
  if (!w.maximizable) return;
  if (w.max) { Object.assign(w, w.saved); w.max = false; }
  else { w.saved = { x: w.x, y: w.y, w: w.w, h: w.h }; Object.assign(w, maxRect(w.b)); w.max = true; }
  dirty();
}
function nextPos(w, h) {
  const k = cascadeN++ % 8;
  return { x: clamp(24 + k * 22, 0, Math.max(0, W - w)), y: clamp(16 + k * 22, 0, Math.max(0, workH() - h)) };
}
function centered(w, h) { return { x: Math.max(0, (W - w) >> 1), y: Math.max(0, (workH() - h) >> 1) }; }

// ---------------------------------------------------------------- menus
function makeMenu(items, kind) {
  if (typeof items === 'function') items = items();
  if (!items.length) items = [{ label: '(Empty)', disabled: true }];
  const m = { items, kind, x: 0, y: 0, hover: -1 };
  const start = kind === 'start', icons = items.some(i => i.icon);
  const ih = start ? 32 : icons ? 20 : 17;
  let y = 3, tw = 0, aw = 0;
  m.rows = items.map(it => {
    const h = it.sep ? 8 : ih, r = { y, h }; y += h;
    if (!it.sep) { tw = Math.max(tw, textW(it.label, it.bold)); if (it.acc) aw = Math.max(aw, textW(it.acc)); }
    return r;
  });
  m.left = start ? 24 : 3;
  m.ix = start ? 32 : 6;
  m.tx = start ? 69 : icons ? 28 : 19;
  m.ax = m.tx + tw + 16;
  m.w = (aw ? m.ax + aw + 8 : m.tx + tw) + (start ? 22 : 18) + 3;
  m.h = y + 3;
  return m;
}
function placeMenu(m, x, y) {
  m.x = clamp(x, 0, Math.max(0, W - m.w)); m.y = clamp(y, 0, Math.max(0, H - m.h));
}
function closeMenus(depth = 0) {
  if (depth === 0) {
    if (menuSrc && menuSrc.win) menuSrc.win.barOpen = -1;
    menuSrc = null;
  }
  menus.length = Math.min(menus.length, depth);
  clearTimeout(menuTimer); dirty();
}
function openStart() {
  closeMenus(); menuSrc = { kind: 'start' };
  const m = makeMenu(START, tbar.small ? 'startsmall' : 'start'); placeMenu(m, 2, barTop() + 2 - m.h); menus = [m];
}
function openBar(w, i) {
  closeMenus(); const it = w.barItems()[i]; if (!it) return;
  menuSrc = { kind: 'bar', win: w, idx: i }; w.barOpen = i;
  const m = makeMenu(it.m.items, 'popup'); placeMenu(m, it.x, it.y + it.h); menus = [m];
}
function openPopup(items, x, y) {
  closeMenus(); menuSrc = { kind: 'ctx' };
  const m = makeMenu(items, 'popup'); placeMenu(m, x, y); menus = [m];
}
function openSub(d, i) {
  const p = menus[d], it = p.items[i];
  closeMenus(d + 1);
  const m = makeMenu(it.sub, 'popup'); m.parent = i;
  let x = p.x + p.w - 3; if (x + m.w > W) x = p.x - m.w + 3;
  placeMenu(m, x, p.y + p.rows[i].y - 3); menus.push(m); dirty();
}
function menuAt(x, y) { for (let d = menus.length - 1; d >= 0; d--) if (inR({ x: menus[d].x, y: menus[d].y, w: menus[d].w, h: menus[d].h }, x, y)) return d; return -1; }
function rowAt(m, x, y) {
  if (x < m.x + m.left || x >= m.x + m.w - 3) return -1;
  const ry = y - m.y;
  return m.rows.findIndex((r, i) => !m.items[i].sep && ry >= r.y && ry < r.y + r.h);
}
function setHover(d, i) {
  const m = menus[d]; if (m.hover === i) return;
  m.hover = i; clearTimeout(menuTimer); dirty();
  menuTimer = setTimeout(() => {
    if (!menus[d] || menus[d].hover !== i) return;
    if (menus[d + 1] && menus[d + 1].parent === i) return;
    const it = m.items[i];
    if (it && it.sub && !it.disabled) openSub(d, i); else closeMenus(d + 1);
  }, 300);
}
function activateItem(it) {
  if (!it || it.disabled || it.sep || it.sub) return;
  closeMenus(); if (it.fn) it.fn(); else emit('menu.noop', { label: amp(it.label || '')[0] });
}
function drawMenu(m) {
  const { x, y, w, h } = m, start = m.kind === 'start';
  fill(x, y, w, h, K.face); frameRaised(x, y, w, h);
  if (start) { fill(x + 3, y + 3, 21, h - 6, K.sh); ctx.drawImage(IMG.banner, x + 3, y + h - 3 - IMG.banner.height); }
  m.items.forEach((it, i) => {
    const r = m.rows[i], iy = y + r.y, left = x + m.left, rw = x + w - 3 - left;
    if (it.sep) { fill(left, iy + 3, rw, 1, K.sh); fill(left, iy + 4, rw, 1, K.hl); return; }
    const hot = m.hover === i;
    if (hot) fill(left, iy, rw, r.h, K.sel);
    if (it.icon) { const sz = start ? 32 : 16; icon(it.icon + sz, x + m.ix, iy + ((r.h - sz) >> 1)); }
    const color = hot ? (it.disabled ? K.sh : K.hl) : K.dk, ty = iy + ((r.h - 13) >> 1);
    if (it.check) { const gl = it.radio ? 'bullet' : 'check', gh = A.glyphs[gl][1]; mglyph(gl, x + 6, iy + ((r.h - gh) >> 1), color); }
    if (it.disabled && !hot) textEmboss(it.label, x + m.tx, ty, it.bold); else text(it.label, x + m.tx, ty, color, it.bold);
    if (it.acc) { if (it.disabled && !hot) textEmboss(it.acc, x + m.ax, ty); else text(it.acc, x + m.ax, ty, color); }
    if (it.sub) mglyph('submenu', x + w - 3 - 6 - 4, iy + ((r.h - 7) >> 1), color);
  });
}

// ---------------------------------------------------------------- disk
const { FileSystem, FSError, ATTR, join, basename, dirname, extname, is83 } = window.W95FS;
const fs = new FileSystem();
const WINDIR = 'C:\\WINDOWS', DESKTOP_DIR = 'C:\\WINDOWS\\Desktop', RECENT = 'C:\\WINDOWS\\Recent';
const PROGRAMS = 'C:\\WINDOWS\\Start Menu\\Programs', BIN = 'C:\\RECYCLED', BIN_INFO = 'C:\\RECYCLED\\INFO';

// Executables on C: are placeholders: an MZ header plus the DOS stub message.
function exeStub() {
  const b = new Uint8Array(128); b[0] = 0x4d; b[1] = 0x5a; b[0x3c] = 0x40;
  b.set(W95FS.encode('This program cannot be run in DOS mode.\r\n$'), 0x40); return b;
}
const lnk = target => `[Shortcut]\r\nTarget=${target}\r\n`;
// WIN.INI [fonts] as Windows 95 Setup writes it (USER loads these with AddFontResource at startup)
const WIN_INI_FONTS = [['MS Sans Serif 8,10,12,14,18,24', 'SSERIFE.FON'], ['MS Serif 8,10,12,14,18,24', 'SERIFE.FON'], ['Courier 10,12,15', 'COURE.FON'],
  ['Small Fonts', 'SMALLE.FON'], ['Symbol 8,10,12,14,18,24', 'SYMBOLE.FON'], ['Modern', 'MODERN.FON'],
  ['Arial (TrueType)', 'ARIAL.TTF'], ['Arial Bold (TrueType)', 'ARIALBD.TTF'], ['Arial Bold Italic (TrueType)', 'ARIALBI.TTF'], ['Arial Italic (TrueType)', 'ARIALI.TTF'],
  ['Courier New (TrueType)', 'COUR.TTF'], ['Courier New Bold (TrueType)', 'COURBD.TTF'], ['Courier New Bold Italic (TrueType)', 'COURBI.TTF'], ['Courier New Italic (TrueType)', 'COURI.TTF'],
  ['Times New Roman (TrueType)', 'TIMES.TTF'], ['Times New Roman Bold (TrueType)', 'TIMESBD.TTF'], ['Times New Roman Bold Italic (TrueType)', 'TIMESBI.TTF'], ['Times New Roman Italic (TrueType)', 'TIMESI.TTF'],
  ['Symbol (TrueType)', 'SYMBOL.TTF'], ['Wingdings (TrueType)', 'WINGDING.TTF']];
// the disc in the CD drive: the image of the CD whose tree cdrom.js has, read a sector range at a time. The app's host
// reads the image the person chose (File > Insert CD Image); a plain browser reads cdrom.iso from the server, which
// must answer byte ranges. An image whose label and size are not the tree's is no disc
function cdDisc() {
  const want = window.W95CD || {}, host = window.W95HOST && window.W95HOST.cd;
  const label = b => String.fromCharCode(...b.subarray(40, 72)).trim();
  const ok = b => !!b && b.length === 2048 && String.fromCharCode(...b.subarray(1, 6)) === 'CD001' && label(b) === want.label;
  if (host) return { read: (sector, len) => { if (!len) return new Uint8Array(0); const b = host.read(sector, len); return b ? new Uint8Array(b) : null; } };
  const get = (at, len) => {
    const x = new XMLHttpRequest(); x.open('GET', 'cdrom.iso', false);
    x.setRequestHeader('Range', `bytes=${at}-${at + len - 1}`); x.overrideMimeType('text/plain; charset=x-user-defined');
    x.send(); if (x.status !== 206 || x.responseText.length !== len) return null;
    const t = x.responseText, b = new Uint8Array(len); for (let i = 0; i < len; i++) b[i] = t.charCodeAt(i) & 0xff; return b;
  };
  let present;
  return { read(sector, len) {
    if (!len) return new Uint8Array(0);
    if (present === undefined) { try { present = ok(get(16 * 2048, 2048)); } catch (_) { present = false; } }
    return present ? get(sector * 2048, len) : null;
  } };
}
function mountDrives() {
  fs.mount('A', { kind: 'removable', ready: true, total: 1457664, cluster: 512 });
  fs.mount('C', { kind: 'fixed', total: 536870912, cluster: 8192 });
  fs.mount('D', { kind: 'cdrom', label: window.W95CD.label, readonly: true, cluster: 2048, fsname: 'CDFS', disc: cdDisc() });
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const conv = e => (e[2] ? [e[0], e[1], e[2].map(conv)] : e[4] ? [e[0], e[1], null, e[3], b64(e[4])] : e);
  fs.load('A', window.W95FLOPPY.tree.map(conv));
  fs.load('D', window.W95CD.tree.map(conv));
}
// Setup's first boot: C: as a fresh install leaves it
function makeDisk(mounted) {
  firstRun = true;
  if (!mounted) mountDrives();
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const sysFonts = (window.W95SYSTEM || {}).fonts || {};
  for (const d of ['WINDOWS\\SYSTEM', 'WINDOWS\\COMMAND', 'WINDOWS\\FONTS', 'WINDOWS\\Desktop', 'WINDOWS\\Recent',
    'WINDOWS\\SendTo', 'WINDOWS\\TEMP', 'WINDOWS\\Start Menu\\Programs\\Accessories', 'WINDOWS\\Start Menu\\Programs\\StartUp',
    'Program Files\\Accessories', 'My Documents']) fs.mkdir('C:\\' + d, { recursive: true });
  fs.mkdir(BIN, { attrs: ATTR.HIDDEN | ATTR.SYSTEM });
  fs.writeFile(BIN_INFO, ''); fs.setAttrs(BIN_INFO, ATTR.HIDDEN | ATTR.SYSTEM);
  const txt = (p, s, attrs) => { fs.writeFile(p, s.replace(/\n/g, '\r\n')); if (attrs !== undefined) fs.setAttrs(p, attrs); };
  const HSR = ATTR.HIDDEN | ATTR.SYSTEM | ATTR.READONLY;
  fs.writeFile('C:\\IO.SYS', exeStub()); fs.setAttrs('C:\\IO.SYS', HSR);
  txt('C:\\MSDOS.SYS', '[Paths]\nWinDir=C:\\WINDOWS\nWinBootDir=C:\\WINDOWS\nHostWinBootDrv=C\n\n[Options]\nBootGUI=1\nLogo=1\n', HSR);
  fs.writeFile('C:\\COMMAND.COM', exeStub());
  txt('C:\\AUTOEXEC.BAT', '@ECHO OFF\nSET PATH=C:\\WINDOWS;C:\\WINDOWS\\COMMAND\nSET TEMP=C:\\WINDOWS\\TEMP\n');
  txt('C:\\CONFIG.SYS', 'DEVICE=C:\\WINDOWS\\HIMEM.SYS\nDOS=HIGH,UMB\nFILES=60\n');
  txt(WINDIR + '\\WIN.INI', '[windows]\nload=\nrun=\nNullPort=None\nScreenSaveActive=0\nScreenSaveTimeOut=900\n\n[Desktop]\nWallpaper=(None)\nTileWallpaper=0\nWallpaperStyle=0\n\n[intl]\nsCountry=United States\n\n[fonts]\n' + WIN_INI_FONTS.filter(([, f]) => sysFonts[f]).map(([n, f]) => `${n}=${f}\n`).join(''));
  txt(WINDIR + '\\SYSTEM.INI', '[boot]\nshell=Explorer.exe\nSCRNSAVE.EXE=\nsystem.drv=system.drv\ndisplay.drv=pnpdrvr.drv\ndrivers=mmsystem.dll\n\n[386Enh]\nmouse=*vmouse, msmouse.vxd\n\n[boot.description]\ndisplay.drv=Standard Display Adapter (VGA)\n');
  for (const e of ['NOTEPAD.EXE', 'EXPLORER.EXE', 'REGEDIT.EXE', 'CALC.EXE', 'WRITE.EXE', 'TASKMAN.EXE', 'PROGMAN.EXE', 'WINFILE.EXE', 'SOL.EXE'])
    fs.writeFile(join(WINDIR, e), exeStub());
  for (const e of ['USER.EXE', 'GDI.EXE', 'KRNL386.EXE', 'USER32.DLL', 'GDI32.DLL', 'KERNEL32.DLL', 'SHELL32.DLL', 'COMCTL32.DLL', 'VMM32.VXD'])
    fs.writeFile(join(WINDIR, 'SYSTEM', e), exeStub());
  for (const e of ['FORMAT.COM', 'XCOPY.EXE', 'EDIT.COM', 'MEM.EXE', 'DELTREE.EXE']) fs.writeFile(join(WINDIR, 'COMMAND', e), exeStub());
  // the fonts a VGA install puts in C:\WINDOWS\FONTS, from the CD when the native system modules are present
  for (const e of ['SSERIFE.FON', 'VGAFIX.FON', 'VGASYS.FON', 'MARLETT.TTF', 'ARIAL.TTF', 'TIMES.TTF', 'COUR.TTF']) if (!sysFonts[e]) fs.writeFile(join(WINDIR, 'FONTS', e), exeStub());
  for (const [e, d] of Object.entries(sysFonts)) fs.writeFile(join(WINDIR, 'FONTS', e), b64(d));
  fs.writeFile('C:\\Program Files\\Accessories\\WORDPAD.EXE', exeStub());
  installPrograms(); setupFonts(); setupRegistry(); setupDisplay(); setupSavers(); setupSound(); setupHelp(); setupNetwork(); setupPorts(); setupPrinting(); setupStartMenu();
  fs.chdir('C:\\');
}
// the CD's screen savers, byte for byte, under the long names APPLETS.INF gives them in LDID_SYS, and the DLLs they
// use; each one the disk lacks (a disk made before the bundle carried them gets them too)
function setupSavers() {
  const LONG = { 'BEZIER.SCR': 'Curves and Colors.scr', 'SSMARQUE.SCR': 'Scrolling Marquee.scr', 'SSMYST.SCR': 'Mystify Your Mind.scr',
    'SCRNSAVE.SCR': 'Blank Screen.scr', 'SSFLYWIN.SCR': 'Flying Windows.scr', 'SSSTARS.SCR': 'Flying Through Space.scr',
    'SS3DFO.SCR': '3D Flying Objects.scr', 'SSFLWBOX.SCR': '3D Flower Box.scr', 'SSMAZE.SCR': '3D Maze.scr', 'SSPIPES.SCR': '3D Pipes.scr', 'SSTEXT3D.SCR': '3D Text.scr' };
  const put = (p, b64s) => { if (!fs.exists(p)) fs.writeFile(p, Uint8Array.from(atob(b64s), c => c.charCodeAt(0))); };
  for (const [name, s] of Object.entries((window.W95SAVERS || {}).savers || {})) {
    put(join(WINDIR, 'SYSTEM', LONG[name] || name), s.scr);
    if (LONG[name] && fs.exists(join(WINDIR, 'SYSTEM', name))) fs.unlink(join(WINDIR, 'SYSTEM', name));   // (the same saver under its short name, from an earlier start: one copy)
  }
  for (const [name, d] of Object.entries((window.W95SAVERS || {}).dlls || {})) put(join(WINDIR, 'SYSTEM', name), d.file);
}

// ---------------------------------------------------------------- notification area
// Icons programs put in the taskbar with Shell_NotifyIcon. Mouse messages go back to the owner's window as its
// callback message, wParam the icon's id and lParam the mouse message, as Explorer sends them.
const trayIcons = [];
function trayMouse(t, msg) { if (t.msg && t.proc && t.proc.exitCode === null) t.proc.post(t.hwnd, t.msg, t.id, msg); }
function traySet(proc, hwnd, id, o) {
  let t = trayIcons.find(v => v.proc === proc && v.hwnd === hwnd && v.id === id);
  if (o === null) { if (!t) return false; trayIcons.splice(trayIcons.indexOf(t), 1); dirty(); return true; }
  if (o.add === !!t) return false;
  if (!t) { t = { proc, hwnd, id, icon: 'app', tip: '', msg: 0 }; trayIcons.push(t); }
  if (o.msg !== undefined) t.msg = o.msg;
  if (o.icon !== undefined) t.icon = o.icon;
  if (o.tip !== undefined) t.tip = o.tip;
  dirty(); return true;
}
function trayDrop(proc) { for (let i = trayIcons.length - 1; i >= 0; i--) if (trayIcons[i].proc === proc) trayIcons.splice(i, 1); dirty(); }

// ---------------------------------------------------------------- tree of folders (and optionally files)
// o.roots: [{ path, label, icon }] shown at depth 0; o.files: list files too; o.top: a non-selectable first row
// (My Computer). The control's `sel` is the selected path; `open` the expanded folders.
function treeControl(o) {
  const sb = new ScrollBar(true, () => dirty());
  const kids = p => { try { return fs.readdir(p).filter(i => (i.isDir || o.files) && !i.hidden).sort(byName); } catch (_) { return []; } };
  const t = {
    type: 'custom', x: o.x, y: o.y, w: o.w, h: o.h, sel: o.sel || null, open: new Set(o.open || []),
    reveal(p) { for (let q = p && dirname(p); q && !isRoot(q) && q !== dirname(q); q = dirname(q)) this.open.add(q); if (p && fs.exists(p) && fs.stat(p).isDir) this.open.add(p); },
    rows() {
      const out = o.top ? [{ path: null, depth: 0, label: o.top.label, icon: o.top.icon }] : [], base = o.top ? 1 : 0;
      const walk = (p, d, label, ic) => {
        const st = (() => { try { return fs.stat(p); } catch (_) { return null; } })(), dir = !st || st.isDir;
        out.push({ path: p, depth: d, dir, label, icon: ic || (dir ? (t.open.has(p) ? 'folderopen' : 'folder') : iconFor(st)) });
        if (dir && t.open.has(p)) for (const k of kids(p)) walk(k.path, d + 1, k.isDir ? k.name : dispName(k.name));
      };
      for (const r of o.roots()) walk(r.path, base, r.label, r.icon);
      return out;
    },
    draw(a, foc, w) {
      field(a.x, a.y, a.w, a.h);
      const list = this.rows(), inner = { x: a.x + 2, y: a.y + 2, w: a.w - 20, h: a.h - 4 }, n = Math.floor(inner.h / 17);
      sb.set(inner.x + inner.w, inner.y, inner.h, list.length, n);
      ctx.save(); ctx.beginPath(); ctx.rect(inner.x, inner.y, inner.w, inner.h); ctx.clip();
      for (let i = sb.pos; i < Math.min(list.length, sb.pos + n + 1); i++) {
        const r = list[i], y = inner.y + (i - sb.pos) * 17 + 1, x = inner.x + 2 + r.depth * 19, label = esc(r.label), tw = textW(label);
        const on = r.path !== null && this.sel && r.path.toUpperCase() === this.sel.toUpperCase();
        icon(r.icon + '16', x, y, on && w.isActive);
        if (on) fill(x + 18, y + 1, tw + 4, 14, w.isActive ? K.sel : K.face);
        text(label, x + 20, y + 2, on && w.isActive ? K.hl : K.dk);
        if (on && foc) focusRect(x + 18, y + 1, tw + 4, 14);
      }
      ctx.restore(); sb.draw(); this.inner = inner; this.list = list; this.top = sb.pos;
    },
    down(x, y, btn, dbl) {
      if (sb.contains(x, y)) return sb.down(x, y);
      const r = this.rows()[sb.pos + Math.floor((y - this.inner.y) / 17)];
      if (!r || r.path === null) return null;
      this.sel = r.path;
      if (r.dir && (dbl || (o.top && r.depth === 1))) { if (this.open.has(r.path) && dbl) this.open.delete(r.path); else this.open.add(r.path); }
      if (o.onSelect) o.onSelect(r.path);
      return null;
    },
    key(e) {
      const list = this.rows().filter(r => r.path !== null), i = list.findIndex(r => this.sel && r.path.toUpperCase() === this.sel.toUpperCase());
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { this.sel = list[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, list.length - 1)].path; if (o.onSelect) o.onSelect(this.sel); return true; }
      if (e.key === 'ArrowRight' && this.sel) { this.open.add(this.sel); return true; }
      if (e.key === 'ArrowLeft' && this.sel) { if (this.open.has(this.sel)) this.open.delete(this.sel); else { const p = list.find(r => r.path.toUpperCase() === dirname(this.sel).toUpperCase()); if (p) this.sel = p.path; } return true; }
      return false;
    },
  };
  t.reveal(t.sel);
  return t;
}

// ---------------------------------------------------------------- Browse for Folder (SHBrowseForFolder)
function browseFolder(o) {
  let win;
  const tree = treeControl({ x: 12, y: 40, w: 270, h: 170, top: { label: 'My Computer', icon: 'mycomputer' }, open: ['C:\\'],
    roots: () => fs.volumes().map(v => ({ path: v.root, label: driveLabel(v.letter), icon: driveIcon(v.letter) })) });
  const finish = p => { closeWin(win); o.done(p); };
  win = dialog('Browse for Folder', 294, 252, [
    { type: 'label', text: o.title || '', x: 12, y: 10, w: 270 },
    tree,
    { type: 'button', label: 'OK', x: 126, y: 220, w: 75, h: 23, def: true, fn: () => { if (tree.sel) finish(tree.sel); } },
    { type: 'button', label: 'Cancel', x: 207, y: 220, w: 75, h: 23, cancel: true, fn: () => finish(null) },
  ]);
  return win;
}

// ---------------------------------------------------------------- Taskbar Properties
const START_MENU = 'C:\\WINDOWS\\Start Menu';
function taskbarProperties(page = 0) {
  const open = windows.find(w => w.title === 'Taskbar Properties'); if (open) return activate(open);
  let win;
  const opt = { ...tbar };
  const chk = (label, key, y) => ({ type: 'check', page: 0, label, x: 18, y, checked: key === 'clock' ? opt.clock : opt[key], onChange() { opt[key] = this.checked; dirty(); } });
  // the picture above the options: the Start menu (large or small icons) over the taskbar, the clock shown or not,
  // a window over the taskbar when it is not on top, the taskbar gone to an edge when it hides
  const preview = {
    type: 'custom', page: 0, x: 48, y: 36, w: 274, h: 130,
    draw(a) {
      const sc = IMG.tpscene, bar = IMG.tpbar, by = a.y + a.h - bar.height;
      ctx.drawImage(sc, a.x, a.y);
      if (!opt.small) ctx.drawImage(IMG.tpstartlarge, a.x, by - IMG.tpstartlarge.height);
      if (!opt.autohide) {
        ctx.drawImage(bar, a.x + 2, by);
        if (!opt.clock) ctx.drawImage(IMG.tpnoclock, a.x + 2 + bar.width - IMG.tpnoclock.width, by + ((bar.height - IMG.tpnoclock.height) >> 1));
      }
      if (!opt.ontop) ctx.drawImage(IMG.tpwindow, a.x + 150, by - 14);
    },
  };
  const apply = () => {
    Object.assign(tbar, { ontop: opt.ontop, autohide: opt.autohide, small: opt.small, clock: opt.clock });
    tbar.shown = tbar.autohide ? 0 : 1; saveTaskbar(); resize(); return true;
  };
  const clear = () => { fsTry('clear', 'Documents', () => { for (const i of fs.readdir(RECENT)) fs.unlink(i.path); }); clearBtn.disabled = true; };
  const clearBtn = { type: 'button', page: 1, x: 270, y: 252, w: 75, h: 23, label: '&Clear', disabled: !fs.readdir(RECENT).length, fn: clear };
  win = dialog('Taskbar Properties', 370, 330, [
    { type: 'tabs', x: 6, y: 6, w: 358, h: 290, tabs: ['Taskbar Options', 'Start Menu Programs'] },
    preview,
    chk('&Always on top', 'ontop', 196), chk('A&uto hide', 'autohide', 216), chk('Show &small icons in Start menu', 'small', 236), chk('Show &Clock', 'clock', 256),
    { type: 'group', page: 1, x: 16, y: 36, w: 338, h: 170, label: 'Customize Start Menu' },
    { type: 'icon', page: 1, name: 'programs32', x: 28, y: 58 },
    { type: 'label', page: 1, x: 70, y: 60, w: 270, text: 'You can customize your Start menu by adding or removing items from it.' },
    { type: 'button', page: 1, x: 70, y: 166, w: 75, h: 23, label: '&Add...', fn: () => createShortcutWizard(PROGRAMS) },
    { type: 'button', page: 1, x: 150, y: 166, w: 75, h: 23, label: '&Remove...', fn: removeShortcuts },
    { type: 'button', page: 1, x: 230, y: 166, w: 90, h: 23, label: 'A&dvanced...', fn: () => openPath(START_MENU) },
    { type: 'group', page: 1, x: 16, y: 216, w: 338, h: 70, label: 'Documents Menu' },
    { type: 'icon', page: 1, name: 'documents32', x: 28, y: 238 },
    { type: 'label', page: 1, x: 70, y: 240, w: 190, text: 'Click to remove the contents of the Documents menu.' },
    clearBtn,
    { type: 'button', x: 130, y: 302, w: 75, h: 23, label: 'OK', def: true, fn: () => { apply(); closeWin(win); } },
    { type: 'button', x: 210, y: 302, w: 75, h: 23, label: 'Cancel', cancel: true, fn: () => closeWin(win) },
    { type: 'button', x: 290, y: 302, w: 75, h: 23, label: '&Apply', fn: apply },
  ], { modal: false, noTask: false, icon: 'taskbar' });
  win.body.page = page;
  return win;
}

// Create Shortcut, as the Start menu's Add... and a folder's New > Shortcut run it: the command line, then the
// Start Menu folder to put it in (when started from Taskbar Properties), then its name
function createShortcutWizard(startIn) {
  let win, step = 0;
  const cmd = { type: 'edit', page: 0, x: 120, y: 120, w: 220, h: 21, value: '', caret: 0, focus: true };
  const tree = treeControl({ x: 120, y: 40, w: 230, h: 160, page: 1, open: [START_MENU], sel: startIn,
    roots: () => [{ path: START_MENU, label: 'Start Menu', icon: 'programs' }] });
  tree.page = 1;
  const name = { type: 'edit', page: 2, x: 120, y: 70, w: 220, h: 21, value: '', caret: 0 };
  const back = { type: 'button', x: 120, y: 236, w: 75, h: 23, label: '< &Back', disabled: true, fn: () => go(step - 1) };
  const next = { type: 'button', x: 195, y: 236, w: 75, h: 23, label: '&Next >', def: true, fn: () => go(step + 1) };
  const titles = ['Create Shortcut', 'Select Program Folder', 'Select a Title for the Program'];
  const target = () => resolveArg(cmd.value.replace(/^"([^"]*)".*$/, '$1').trim());
  const go = n => {
    if (n === 1 && step === 0) {
      if (!cmd.value.trim()) return;
      if (!fs.exists(target())) return msgBox(titles[0], `The file ${cmd.value.trim()} specified on the command line cannot be found. Make sure the path and file name are correct.`, 'error');
      if (!startIn) n = 2;   // New > Shortcut in a folder skips choosing a folder
      name.value = dispName(basename(target())); name.caret = name.value.length;
    }
    if (n === 1 && !startIn) n = 0;
    if (n === 3) {
      const dir = startIn ? tree.sel || PROGRAMS : win.dir, nm = name.value.trim();
      if (!nm) return;
      if (fsTry('create', nm, () => fs.writeFile(join(dir, nm + '.lnk'), lnk(fs.realpath(target()))))) closeWin(win);
      return;
    }
    step = n; win.body.page = n; win.title = titles[n];
    back.disabled = n === 0; next.label = n === 2 ? 'Finish' : '&Next >';
    win.body.focus = win.body.c.indexOf(n === 0 ? cmd : n === 1 ? tree : name); dirty();
  };
  win = dialog(titles[0], 440, 270, [
    { type: 'icon', name: 'app32', x: 30, y: 40 },
    { type: 'label', page: 0, x: 120, y: 30, w: 300, text: 'Type the location and name of the item you want to create a shortcut to. Or, search for the item by clicking Browse.' },
    { type: 'label', page: 0, x: 120, y: 102, text: 'Command &line:', amp: true }, cmd,
    { type: 'button', page: 0, x: 265, y: 150, w: 75, h: 23, label: 'B&rowse...', fn: () => fileDialog({ title: 'Browse', dir: WINDIR, onOk: p => { cmd.value = p; cmd.caret = p.length; } }) },
    { type: 'label', page: 1, x: 120, y: 18, text: 'Select folder to place shortcut in:' }, tree,
    { type: 'button', page: 1, x: 120, y: 206, w: 90, h: 23, label: 'New &Folder...', fn: () => {
      const base = tree.sel || START_MENU; let n = 'New Folder', k = 2; while (fs.exists(join(base, n))) n = `New Folder (${k++})`;
      if (fsTry('create', n, () => fs.mkdir(join(base, n)))) { tree.open.add(base); tree.sel = join(base, n); }
    } },
    { type: 'label', page: 2, x: 120, y: 50, text: 'Select a &name for the shortcut:', amp: true }, name,
    { type: 'line', x: 8, y: 226, w: 424 },
    back, next,
    { type: 'button', x: 290, y: 236, w: 75, h: 23, label: 'Cancel', cancel: true, fn: () => closeWin(win) },
  ], { modal: false, noTask: false });
  win.dir = startIn;
  return win;
}

// Remove Shortcuts/Folders: the Start Menu's Programs tree; Remove sends the item to the Recycle Bin
function removeShortcuts() {
  let win;
  const tree = treeControl({ x: 12, y: 40, w: 280, h: 200, open: [PROGRAMS], files: true,
    roots: () => [{ path: PROGRAMS, label: 'Programs', icon: 'programs' }] });
  win = dialog('Remove Shortcuts/Folders', 386, 252, [
    { type: 'label', x: 12, y: 8, w: 360, text: 'To remove an item from the Start menu, select the item and click Remove.' },
    tree,
    { type: 'button', x: 300, y: 40, w: 75, h: 23, label: '&Remove', fn: () => {
      const p = tree.sel; if (!p || p.toUpperCase() === PROGRAMS.toUpperCase()) return;
      const it = fsItem(fs.stat(p)); confirmDelete(it);
    } },
    { type: 'button', x: 300, y: 217, w: 75, h: 23, label: 'Close', cancel: true, def: true, fn: () => closeWin(win) },
  ]);
  return win;
}

// ---------------------------------------------------------------- what SHELL32 asks of the shell (shell32.js)
window.W95SHELL = {
  fs,
  open: (path, arg) => { if (!fs.exists(path)) return false; shellOpen(fs.realpath(path), arg); return true; },
  explore: path => { if (!fs.exists(path)) return false; openPath(fs.realpath(path)); return true; },
  typeOf: (name, isDir) => isDir ? { desc: 'Folder', icon: 'folder' } : TYPES[extname(name)] || { desc: extname(name) ? `${extname(name).toUpperCase()} File` : 'File', icon: 'windoc' },
  displayName: (name, isDir) => dispName(name, isDir),
  special: id => ({ desktop: DESKTOP_DIR, programs: PROGRAMS, recent: RECENT, startmenu: dirname(PROGRAMS), startup: join(PROGRAMS, 'StartUp'),
    sendto: join(WINDIR, 'SendTo'), fonts: join(WINDIR, 'FONTS'), templates: join(WINDIR, 'ShellNew'), personal: 'C:\\My Documents' })[id] || null,
  addRecent: path => addRecent(path),
  recycle: path => recycle(path),
  emptyBin: () => emptyBin(),
  about: (app, other, done) => msgBox(`About ${app}`, `${app}\nMicrosoft Windows 95\n4.00.950 B\nCopyright \u00a9 1981-1996 Microsoft Corp.${other ? '\n\n' + other : ''}`, 'info', ['OK'], () => done()),
  browseFolder: (title, done) => browseFolder({ title, done }),
  traySet, trayDrop,
};

// ---------------------------------------------------------------- persistence
// C: and the registry are written through to the app's store as they change (W95HOST, from the Electron preload).
// An empty store is a first boot: Setup builds C: and every file it writes goes through. A plain browser has no
// store and starts from Setup each time.
function bootDisk() {
  const host = window.W95HOST;
  if (!host) { makeDisk(); return; }
  mountDrives();
  W95Win32.regAttach(host.registry);
  if (!fs.attach('C', host.disk)) makeDisk(true);
  installPrograms(); setupFonts(); setupRegistry(); setupDisplay(); setupSavers(); setupSound(); setupHelp(); setupNetwork(); setupPorts(); setupPrinting(); setupStartMenu();
  fs.chdir('C:\\');
}

// ---------------------------------------------------------------- shell namespace
const TYPES = {
  txt: { desc: 'Text Document', icon: 'textdoc', open: p => runNotepad(p) },
  log: { desc: 'Text Document', icon: 'textdoc', open: p => runNotepad(p) },
  ini: { desc: 'Configuration Settings', icon: 'sysfile', open: p => runNotepad(p) },
  inf: { desc: 'Setup Information', icon: 'sysfile', open: p => runNotepad(p) },
  bat: { desc: 'MS-DOS Batch File', icon: 'batch', open: p => runNotepad(p) },
  sys: { desc: 'System file', icon: 'sysfile' }, dll: { desc: 'Application Extension', icon: 'sysfile' },
  vxd: { desc: 'Virtual device driver', icon: 'sysfile' }, drv: { desc: 'Device driver', icon: 'sysfile' },
  fon: { desc: 'Font file', icon: 'sysfile' }, ttf: { desc: 'TrueType Font file', icon: 'sysfile' },
  exe: { desc: 'Application', icon: 'app', open: (p, arg) => runExe(p, arg) },
  com: { desc: 'MS-DOS Application', icon: 'app', open: (p, arg) => runExe(p, arg) },
  lnk: { desc: 'Shortcut', icon: 'app', open: p => openLnk(p) },
  hlp: { desc: 'Help File', icon: 'help' }, scr: { desc: 'Screen Saver', icon: 'app' },
  cpl: { desc: 'Control Panel extension', icon: 'sysfile' },
  // MIDI files open in Media Player (MOTOWN.INF: .mid and .rmi are midfile, opened by mplayer.exe %1)
  mid: { desc: 'MIDI Sequence', icon: 'windoc', open: p => runExe(join(WINDIR, 'MPLAYER.EXE'), /\s/.test(p) ? `"${p}"` : p) },
  rmi: { desc: 'MIDI Sequence', icon: 'windoc', open: p => runExe(join(WINDIR, 'MPLAYER.EXE'), /\s/.test(p) ? `"${p}"` : p) },
};
const EXE_ICON = { 'NOTEPAD.EXE': 'notepad', 'EXPLORER.EXE': 'explorer', 'WINHLP32.EXE': 'help' };
const isRoot = p => /^[A-Z]:\\$/i.test(p);
const inBin = p => /^C:\\RECYCLED(\\|$)/i.test(p);
const num = n => n.toLocaleString('en-US');
function fmtSize(n) {
  if (n < 1024) return `${n} bytes`;
  const u = ['KB', 'MB', 'GB']; let v = n / 1024, i = 0;
  while (v >= 1024 && i < 2) { v /= 1024; i++; }
  const t = v >= 100 ? Math.floor(v) : v >= 10 ? Math.floor(v * 10) / 10 : Math.floor(v * 100) / 100;
  return t + u[i];
}
// Explorer shows all-uppercase 8.3 names in mixed case and hides registered extensions.
function dispName(name, isDir) {
  let n = name;
  if (!/[a-z]/.test(n) && is83(n)) n = n[0] + n.slice(1).toLowerCase();
  const e = extname(n);
  return !isDir && TYPES[e] && n.length > e.length + 1 ? n.slice(0, -e.length - 1) : n;
}
const typeDesc = i => i.isDir ? 'Folder' : TYPES[extname(i.name)] ? TYPES[extname(i.name)].desc : extname(i.name) ? extname(i.name).toUpperCase() + ' File' : 'File';
// the shell's own folders as a shortcut names them (its target the folder's class: ::{CLSID}), by item key
const NS_CLSID = { 'sys:mc': '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}', 'sys:net': '::{208D2C60-3AEA-1069-A2D7-08002B30309D}',
  'sys:bin': '::{645FF040-5081-101B-9F08-00AA002F954E}', 'v:cp': '::{21EC2020-3AEA-1069-A2DD-08002B30309D}', 'v:pr': '::{2227A280-3AEA-1069-A2DE-08002B30309D}' };
/** the namespace folder a ::{CLSID} target names: { key, label, icon, open } */
const nsItem = t => {
  const key = Object.keys(NS_CLSID).find(k => NS_CLSID[k].toUpperCase() === String(t || '').toUpperCase()); if (!key) return null;
  return { 'sys:mc': { label: 'My Computer', icon: 'mycomputer', open: () => openFolder(MyComputer) },
    'sys:net': { label: 'Network Neighborhood', icon: 'network', open: () => { Network.refresh(); openFolder(Network); } },
    'sys:bin': { label: 'Recycle Bin', icon: 'recycle', open: () => openFolder(RecycleBin) },
    'v:cp': { label: 'Control Panel', icon: 'controlpanel', open: () => openFolder(ControlPanel) },
    'v:pr': { label: 'Printers', icon: 'printers', open: () => openFolder(Printers) } }[key];
};
function readLnk(p) { try { const m = /^Target=(.*)$/m.exec(fs.readText(p)); return m ? m[1].trim() : null; } catch (_) { return null; } }
function driveIcon(l) { const v = fs.vols.get(l); return v.kind === 'removable' ? 'floppy' : v.kind === 'cdrom' ? 'cdrom' : v.kind === 'remote' ? 'netdrive' : 'hdd'; }
// a network name as Windows 95 shows one: its first letter capital, the rest small
const netCap = x => (x ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x);
const isUncRoot = p => /^\\\\[^\\]+\\[^\\]+\\?$/.test(p || '');
/** a share as Windows 95 names one: Public on 'Host' */
const shareLabel = unc => { const [, server = '', share = ''] = /^\\\\([^\\]*)\\([^\\]*)/.exec(unc) || []; return `${netCap(share)} on '${netCap(server)}'`; };
function driveLabel(l) {
  const v = fs.vols.get(l);
  if (v.kind === 'removable') return `3\u00bd Floppy (${l}:)`;
  if (v.kind === 'remote') return `${shareLabel(v.unc)} (${l}:)`;
  return (v.label ? v.label[0] + v.label.slice(1).toLowerCase() + ' ' : '') + `(${l}:)`;
}
function iconFor(i, depth = 0) {
  if (i.isDir) return isRoot(i.path) ? driveIcon(i.drive) : 'folder';
  const e = extname(i.name);
  if (e === 'lnk') { const t = readLnk(i.path), ns = nsItem(t); if (ns) return ns.icon; try { return t && depth < 4 ? iconFor(fs.stat(t), depth + 1) : 'app'; } catch (_) { return 'app'; } }
  if (e === 'exe') return EXE_ICON[i.name.toUpperCase()] || 'app';
  return (TYPES[e] && TYPES[e].icon) || 'windoc';
}
const byName = (a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
function fsItem(i) {
  return { key: i.ino, label: dispName(i.name, i.isDir), icon: iconFor(i), overlay: !i.isDir && extname(i.name) === 'lnk',
    path: i.path, info: i, open: () => shellOpen(i.path) };
}
class FsSource {
  constructor(path) { this.ino = fs.inoOf(path); this.id = 'fs:' + this.ino; }
  get path() { return fs.pathOfIno(this.ino); }
  get gone() { const p = this.path; return !p || inBin(p); }
  get title() { const p = this.path; return isRoot(p) ? driveLabel(p[0]) : isUncRoot(p) ? shareLabel(p) : dispName(basename(p), true); }
  get icon() { return isRoot(this.path) ? driveIcon(this.path[0]) : isUncRoot(this.path) ? 'netshare' : 'folder'; }
  get readonly() { return fs.statvfs(this.path).readonly; }
  list() {
    const all = fs.readdir(this.path).sort(byName);
    this.hidden = all.filter(i => i.hidden).length;
    return all.filter(i => !i.hidden).map(fsItem);
  }
}
const virt = (id, title, icon, list) => ({ id, title, icon, list, readonly: true, path: null, gone: false });
const ControlPanel = virt('cp', 'Control Panel', 'controlpanel', () => []);
// the Printers folder: Add Printer, which runs SHELL32's (MSPRINT2's wizard, through RUNDLL32 as SHHelpShortcuts_RunDLL
// starts it), and each printer the spooler has, as SPOOLSS keeps them under Control\Print\Printers
const PRINTERS_KEY = 'hklm\\system\\currentcontrolset\\control\\print\\printers';
const Printers = virt('printers', 'Printers', 'printers', () => [
  { key: 'pr:add', label: 'Add Printer', icon: 'addprinter', virt: true, open: addPrinter },
  ...W95Win32.regKids(PRINTERS_KEY).map(n => {
    const val = v => W95FS.decode(((W95Win32.regGet(PRINTERS_KEY + '\\' + n, v) || {}).data) || new Uint8Array(0)).replace(/\0.*$/, '');
    return { key: 'pr:' + n, label: val('Name') || n, icon: val('Port').startsWith('\\\\') ? 'netprinter' : 'printer', virt: true, open: () => printerWindow(val('Name') || n) };
  }),
]);
// a printer's window (its queue: Printer, Document, Pause Printing, Purge Print Documents), SHELL32's, in the system
async function printerWindow(name) {
  closeMenus();
  const sys = await startSystem();
  if (sys && sys.remote) await sys.cmd('printerWindow', [join(WINDIR, 'RUNDLL32.EXE'), name]);
}
function addPrinter() { closeMenus(); runNative(join(WINDIR, 'RUNDLL32.EXE'), 'shell32.dll,SHHelpShortcuts_RunDLL AddPrinter'); }
const MyComputer = virt('mycomputer', 'My Computer', 'mycomputer', () => [
  ...fs.volumes().map(v => ({ key: 'drv:' + v.letter, label: driveLabel(v.letter), icon: driveIcon(v.letter), drive: v.letter, path: v.root, open: () => openPath(v.root) })),
  { key: 'v:cp', label: 'Control Panel', icon: 'controlpanel', virt: true, open: () => openFolder(ControlPanel) },
  { key: 'v:pr', label: 'Printers', icon: 'printers', virt: true, open: () => openFolder(Printers) },
]);
// the network as the Multiple Provider Router browses it (WNetOpenEnum, WNetEnumResource, on threads of the network's
// process): Network Neighborhood is the workgroup's computers (the context's resources), Entire Network the
// workgroups, a workgroup its computers, a computer its shares. What a folder lists comes as the provider answers; its
// window shows it when it does
const netLists = new Map();   // a container's key -> { items } once enumerated
const NET_ICON = { 1: 'workgroup', 2: 'netserver', 3: 'netshare', 7: 'globe' };   // by RESOURCEDISPLAYTYPE
/** the resources MPR has under `res` (null: the scope's top) */
async function netEnum(scope, res) {
  if (!await netBoot()) return [];
  if (netApp.remote) return (netApp.alive && await netApp.cmd('netEnum', [scope, res])) || [];
  const p = netApp.proc, s = x => (x ? netStr(x) : 0), nr = res ? p.alloc(32) : 0, ph = p.alloc(4), out = [];
  if (res) { p.w32(nr, res.scope); p.w32(nr + 4, res.type); p.w32(nr + 8, res.disp); p.w32(nr + 12, res.usage); p.w32(nr + 16, 0); p.w32(nr + 20, s(res.remote)); p.w32(nr + 24, s(res.comment)); p.w32(nr + 28, s(res.provider)); }
  if (await netCall('WNetOpenEnumA', [scope, 0, 0, nr, ph]) !== 0) return out;
  const h = p.r32(ph), cnt = p.alloc(4), sz = p.alloc(4), buf = p.alloc(0x4000);
  for (;;) {
    p.w32(cnt, 0xffffffff); p.w32(sz, 0x4000);
    if (await netCall('WNetEnumResourceA', [h, cnt, buf, sz]) !== 0) break;   // ERROR_NO_MORE_ITEMS, or what stops it
    for (let i = 0, n = p.r32(cnt); i < n; i++) {
      const a = buf + 32 * i, str = o => p.readA(p.r32(a + o)) || '';
      out.push({ scope: 2, type: p.r32(a + 4), disp: p.r32(a + 8), usage: p.r32(a + 12), remote: str(20), comment: str(24), provider: str(28) });
    }
  }
  await netCall('WNetCloseEnum', [h]);
  for (const a of [nr, ph, cnt, sz, buf]) if (a) p.free(a);
  return out;
}
/** a folder of the network: `res` the container (null: Network Neighborhood itself) */
function netFolder(id, title, icon, scope, res) {
  const f = virt(id, title, icon, () => {
    const l = netLists.get(id);
    if (!l) { netLists.set(id, { items: [] }); netEnum(scope, res).then(r => { netLists.set(id, { items: r }); fs.version++; dirty(); }); }
    return (netLists.get(id).items).filter(r => r.disp !== 3 || r.type === 1).map(r => netItem(r));
  });
  f.refresh = () => netLists.delete(id);
  return f;
}
const netName = r => (r.disp === 3 ? netCap(r.remote.split('\\').pop()) : r.disp === 2 ? netCap(r.remote.replace(/^\\+/, '')) : r.disp === 7 ? r.comment || 'Entire Network' : netCap(r.remote));
function netItem(r) {
  const key = 'net:' + (r.disp === 7 ? 'entire' : r.remote.toUpperCase()), icon = NET_ICON[r.disp] || 'network', label = netName(r);
  if (r.disp === 3) return { key, label, icon, virt: true, net: r, open: () => openPath(r.remote) };   // a share: its files
  const sub = r.disp === 7 ? EntireNetwork : netFolder(key, label, icon, 2, r);
  return { key, label, icon, virt: true, net: r, open: () => { if (sub.refresh) sub.refresh(); openFolder(sub); } };
}
const EntireNetwork = netFolder('net:entire', 'Entire Network', 'globe', 2, { scope: 2, type: 0, disp: 7, usage: 2, remote: '', comment: 'Entire Network', provider: '' });
EntireNetwork.res = { scope: 2, type: 0, disp: 7, usage: 2, remote: '', comment: 'Entire Network', provider: '' };
const Network = netFolder('net', 'Network Neighborhood', 'network', 5, null);
EntireNetwork.refresh = () => netLists.delete('net:entire');
const RecycleBin = virt('bin', 'Recycle Bin', 'recycle', () => binItems().map(e => ({
  key: 'bin:' + e.file, label: dispName(basename(e.orig), e.info.isDir), icon: e.info.isDir ? 'folder' : iconFor({ ...e.info, name: basename(e.orig) }),
  bin: e, info: e.info, open: () => binProps(e),
})));
Object.defineProperty(RecycleBin, 'icon', { get: () => (binItems().length ? 'recyclefull' : 'recycle') });

function fsMsg(path, e) { return `${path} is not accessible.\n\n${e.message}`; }
function openPath(path) {
  try { const i = fs.stat(path); if (!i.isDir) return shellOpen(path); fs.readdir(path); }
  catch (e) { if (e instanceof FSError) return msgBox(isRoot(path) ? driveLabel(path[0].toUpperCase()) : basename(path), fsMsg(path, e), 'error'); throw e; }
  return openFolder(new FsSource(path));
}
function shellOpen(path, arg) {
  let i; try { i = fs.stat(path); } catch (e) { return msgBox(basename(path), fsMsg(path, e), 'error'); }
  if (i.isDir) return openPath(path);
  const t = TYPES[extname(i.name)];
  if (t && t.open) return t.open(i.path, arg);
  msgBox(dispName(i.name), `Windows cannot open this file:\n\n${i.name}\n\nThere is no program associated with this type of file.`, 'info');
}
function runExe(path, arg) {
  const n = basename(path).toUpperCase();
  if (n === 'NOTEPAD.EXE') return runNotepad(arg ? resolveArg(arg) : null, path);
  if (n === 'EXPLORER.EXE') return arg ? openPath(resolveArg(arg)) : openFolder(MyComputer);
  // any other program the system bundle carries runs natively
  runNative(path, arg || '').then(ok => { if (!ok) msgBox(dispName(basename(path)), `${path} is not a valid Windows application.`, 'error'); });
}
// Notepad: the CD's NOTEPAD.EXE on the native USER when the system bundle has it, the shell's own otherwise
function runNotepad(file, exe = join(WINDIR, 'NOTEPAD.EXE')) {
  runNative(exe, file ? (/\s/.test(file) ? `"${file}"` : file) : '').then(ok => { if (!ok) notepad(file); });
}
const resolveArg = a => { a = a.trim().replace(/^"(.*)"$/, '$1'); return /^[a-z]:|^\\/i.test(a) ? a : join(fs.cwd, a); };
function openLnk(path) {
  const t = readLnk(path), ns = nsItem(t);
  if (ns) return ns.open();
  if (t && fs.exists(t)) return shellOpen(t);
  msgBox('Problem with Shortcut', `The item '${basename(t || path)}' that this shortcut refers to has been changed or moved, so this shortcut will no longer work properly.`, 'warning');
}
function addRecent(path) {
  try {
    if (inBin(path)) return;
    fs.writeFile(join(RECENT, basename(path) + '.lnk'), lnk(path));
    const all = fs.readdir(RECENT).sort((a, b) => b.mtime - a.mtime);
    for (const x of all.slice(15)) fs.unlink(x.path);
  } catch (_) { /* Recent is best effort, like the real shell */ }
}

// ---------------------------------------------------------------- file operations
const OP_TITLE = { delete: 'Error Deleting File or Folder', rename: 'Error Renaming File or Folder', copy: 'Error Copying File or Folder',
  move: 'Error Moving File or Folder', create: 'Error Creating File or Folder', save: 'Notepad', restore: 'Error Restoring File' };
function fsTry(op, name, fn) {
  try { fn(); return true; } catch (e) {
    if (!(e instanceof FSError)) throw e;
    msgBox(OP_TITLE[op] || 'Error', `Cannot ${op} ${name}: ${e.message}`, 'error'); return false;
  }
}
function deleteTree(p) {
  const i = fs.stat(p);
  if (i.readonly) fs.setAttrs(p, i.attrs & ~ATTR.READONLY);
  if (i.isDir) { for (const k of fs.readdir(p)) deleteTree(k.path); fs.rmdir(p); } else fs.unlink(p);
}
function moveAny(src, dst) {
  try { fs.rename(src, dst); } catch (e) {
    if (e.code !== W95FS.E.NOT_SAME_DEVICE) throw e;
    fs.copy(src, dst); deleteTree(src);
  }
}
// INFO as Windows 95 keeps it, so SHELL32 (deleting from a native program's file dialog) and the shell share one bin:
// a 20-byte header (0, live records, next index, record size 118h, total size) and 118h-byte records of the original
// path (260 bytes, a first byte of 0 marking a removed record), index, drive (0 = A:), deletion FILETIME and allocated
// size. The file in the bin is D<drive letter><index><original extension>.
const BIN_REC = 0x118, ftMs = (lo, hi) => (hi * 4294967296 + lo) / 10000 - 11644473600000;
const binName = (orig, drv, idx, isDir) => { const ext = isDir ? '' : extname(basename(orig)); return `D${String.fromCharCode(65 + drv)}${idx}${ext ? '.' + ext.toUpperCase() : ''}`; };
function binItems() {
  let b; try { b = fs.readFile(BIN_INFO); } catch (_) { return []; }
  const u32 = o => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0, out = [];
  if (b.length >= 20 && u32(12) === BIN_REC) {
    for (let o = 20; o + BIN_REC <= b.length; o += BIN_REC) {
      if (!b[o]) continue;
      let n = 0; while (n < 260 && b[o + n]) n++;
      const orig = W95FS.decode(b.subarray(o, o + n)), idx = u32(o + 0x104), drv = u32(o + 0x108);
      out.push({ orig, idx, drv, t: ftMs(u32(o + 0x10c), u32(o + 0x110)) });
    }
  } else {   // the shell's earlier text index: file, original path, time per line
    for (const l of W95FS.decode(b).split('\r\n').filter(Boolean)) {
      const [file, orig, t] = l.split('\t'), m = /^D([A-Z])(\d+)/i.exec(file || '');
      if (m) out.push({ orig, idx: +m[2], drv: m[1].toUpperCase().charCodeAt(0) - 65, t: +t, file });
    }
  }
  return out.map(e => {
    const path = join(BIN, e.file || binName(e.orig, e.drv, e.idx, false));
    const alt = join(BIN, binName(e.orig, e.drv, e.idx, true));
    const p = fs.exists(path) ? path : fs.exists(alt) ? alt : null;
    return p ? { ...e, file: basename(p), path: p, info: fs.stat(p) } : null;
  }).filter(Boolean);
}
function binWrite(list) {
  const next = list.reduce((m, e) => Math.max(m, e.idx + 1), 0), b = new Uint8Array(20 + BIN_REC * list.length), dv = new DataView(b.buffer);
  let total = 0;
  list.forEach((e, k) => {
    const o = 20 + BIN_REC * k, ft = BigInt(Math.round(e.t)) * 10000n + 116444736000000000n;
    const size = e.info ? (e.info.isDir ? fs.du(e.path).bytes : e.info.alloc || e.info.size) : 0; total += size;
    b.set(W95FS.encode(e.orig).subarray(0, 259), o);
    dv.setUint32(o + 0x104, e.idx, true); dv.setUint32(o + 0x108, e.drv, true);
    dv.setUint32(o + 0x10c, Number(ft & 0xffffffffn), true); dv.setUint32(o + 0x110, Number(ft >> 32n), true); dv.setUint32(o + 0x114, size, true);
  });
  dv.setUint32(4, list.length, true); dv.setUint32(8, next, true); dv.setUint32(12, BIN_REC, true); dv.setUint32(16, total, true);
  fs.writeFile(BIN_INFO, b);
}
function recycle(path) {
  const items = binItems(), i = fs.stat(path), orig = i.path;
  let next = 0; try { const b = fs.readFile(BIN_INFO); if (b.length >= 20) next = (b[8] | b[9] << 8 | b[10] << 16 | b[11] << 24) >>> 0; } catch (_) {}
  const idx = Math.max(next, items.reduce((m, e) => Math.max(m, e.idx + 1), 0)), drv = orig.toUpperCase().charCodeAt(0) - 65;
  const file = binName(orig, drv, idx, i.isDir);
  fs.rename(orig, join(BIN, file));
  binWrite([...items, { file, orig, idx, drv, t: Date.now(), path: join(BIN, file), info: fs.stat(join(BIN, file)) }]);
}
function restoreBin(e) {
  fsTry('restore', basename(e.orig), () => {
    fs.mkdir(dirname(e.orig), { recursive: true });
    fs.rename(e.path, e.orig);
    binWrite(binItems().filter(x => x.file !== e.file));
  });
}
function purgeBin(e) { fsTry('delete', basename(e.orig), () => { deleteTree(e.path); binWrite(binItems()); }); }
function emptyBin() {
  const items = binItems(); if (!items.length) return;
  const msg = items.length === 1 ? `Are you sure you want to delete '${dispName(basename(items[0].orig), items[0].info.isDir)}'?` : `Are you sure you want to delete these ${items.length} items?`;
  msgBox(items.length === 1 ? 'Confirm File Delete' : 'Confirm Multiple File Delete', msg, 'warning', ['&Yes', '&No'], b => {
    if (b !== '&Yes') return;
    fsTry('delete', 'items', () => { for (const e of items) deleteTree(e.path); binWrite([]); });
  });
}
function binProps(e) {
  msgBox(`${dispName(basename(e.orig), e.info.isDir)} Properties`,
    `Origin: ${dirname(e.orig)}\nDeleted: ${fmtDate(e.t)}\nSize: ${fmtSize(e.info.isDir ? fs.du(e.path).bytes : e.info.size)}`, null);
}
function confirmDelete(it, perm) {
  if (it.bin) return msgBox('Confirm File Delete', `Are you sure you want to delete '${it.label}'?`, 'warning', ['&Yes', '&No'], b => b === '&Yes' && purgeBin(it.bin));
  if (!it.info || isRoot(it.path)) return;
  const dir = it.info.isDir, toBin = !perm && it.path[0].toUpperCase() === 'C' && !inBin(it.path);
  const msg = toBin
    ? (dir ? `Are you sure you want to remove the folder '${it.label}' and move all its contents to the Recycle Bin?` : `Are you sure you want to send '${it.label}' to the Recycle Bin?`)
    : (dir ? `Are you sure you want to remove the folder '${it.label}' and all its contents?` : `Are you sure you want to delete '${it.label}'?`);
  msgBox(dir ? 'Confirm Folder Delete' : 'Confirm File Delete', msg, toBin ? 'recyclefull32' : 'warning', ['&Yes', '&No'], b => {
    if (b !== '&Yes') return;
    if (fsTry('delete', it.label, () => (toBin ? recycle(it.path) : deleteTree(it.path)))) {
      const e = toBin && binItems().find(x => x.orig === it.path);
      if (e) setUndo('Undo Delete', () => restoreBin(e)); else undoOp = null;
    }
  });
}
let clip = null;
function cutCopy(it, mode) { if (it.info && !isRoot(it.path)) clip = { mode, path: it.path }; }
function sameDir(a, b) { try { return fs.realpath(a).toUpperCase() === fs.realpath(b).toUpperCase(); } catch (_) { return false; } }
function pasteInto(dir) {
  if (!clip || !dir) return;
  const src = clip.path; if (!fs.exists(src)) { clip = null; return; }
  const i = fs.stat(src), name = dispName(i.name, i.isDir);
  let dst = join(dir, i.name);
  if (clip.mode === 'cut') {
    if (sameDir(dirname(src), dir)) return;
    if (fsTry('move', name, () => moveAny(src, dst))) { clip = null; setUndo('Undo Move', () => moveAny(dst, src)); }
    return;
  }
  if (fs.exists(dst)) {
    if (sameDir(dirname(src), dir)) {
      for (let k = 1; ; k++) { dst = join(dir, k === 1 ? `Copy of ${i.name}` : `Copy (${k}) of ${i.name}`); if (!fs.exists(dst)) break; }
    } else if (!i.isDir) {
      return msgBox('Confirm File Replace', `This folder already contains a file named '${name}'.\n\nWould you like to replace the existing file?`, 'question', ['&Yes', '&No'],
        b => b === '&Yes' && fsTry('copy', name, () => fs.copy(src, dst, { overwrite: true })));
    }
  }
  if (fsTry('copy', name, () => fs.copy(src, dst))) setUndo('Undo Copy', () => deleteTree(dst));
}
function pasteShortcut(dir) { if (clip && dir) makeShortcut(clip.path, dir); }
function makeShortcut(target, dir) {
  const ns = nsItem(target), base = ns ? ns.label : isRoot(target) ? driveLabel(target[0]) : dispName(basename(target), fs.stat(target).isDir);
  let p; for (let k = 1; ; k++) { p = join(dir, `Shortcut${k > 1 ? ` (${k})` : ''} to ${base.replace(/[\\/:*?"<>|]/g, '')}.lnk`); if (!fs.exists(p)) break; }
  return fsTry('create', 'shortcut', () => fs.writeFile(p, lnk(target))) ? p : null;
}
function createShortcut(view, it) {
  const target = it.path || NS_CLSID[it.key]; if (!target) return;
  const dir = view.src.path;
  if (!dir || view.src.readonly) {
    return msgBox('Shortcut', 'Windows cannot create a shortcut here.\n\nDo you want the shortcut to be placed on the desktop instead?', 'question', ['&Yes', '&No'],
      b => b === '&Yes' && makeShortcut(target, DESKTOP_DIR));
  }
  view.created(makeShortcut(target, dir));
}
function newItem(dir, kind) {
  const base = kind === 'folder' ? 'New Folder' : 'New Text Document', ext = kind === 'folder' ? '' : '.txt';
  let p; for (let k = 1; ; k++) { p = join(dir, base + (k > 1 ? ` (${k})` : '') + ext); if (!fs.exists(p)) break; }
  return fsTry('create', base, () => (kind === 'folder' ? fs.mkdir(p) : fs.writeFile(p, ''))) ? p : null;
}

// ---------------------------------------------------------------- inline rename
let ren = null;
function startRename(view, it) {
  if (!it || !it.info || it.bin || isRoot(it.path) || fs.vols.get(it.path[0]).readonly) return;
  ren = { view, key: it.key, it, value: it.label, caret: it.label.length, all: true, box: null };
}
function commitRename() {
  const r = ren; ren = null; if (!r) return;
  const v = r.value.trim(); if (!v || v === r.it.label) return;
  const i = r.it.info, e = extname(i.name);
  const name = !i.isDir && TYPES[e] && dispName(i.name) !== i.name && !v.toLowerCase().endsWith('.' + e) ? `${v}.${e}` : v;
  const to = join(dirname(i.path), name), from = i.path;
  if (fsTry('rename', r.it.label, () => fs.rename(from, to))) setUndo('Undo Rename', () => fs.rename(to, from));
}
function renameKey(e) {
  const r = ren, k = e.key;
  if (k === 'Enter') { commitRename(); return true; }
  if (k === 'Escape') { ren = null; return true; }
  if (k.length === 1 && !e.ctrlKey && !e.metaKey) {
    if (r.all) { r.value = ''; r.caret = 0; r.all = false; }
    r.value = r.value.slice(0, r.caret) + k + r.value.slice(r.caret); r.caret++;
  } else if (k === 'Backspace' || k === 'Delete') {
    if (r.all) { r.value = ''; r.caret = 0; r.all = false; }
    else if (k === 'Backspace' && r.caret > 0) { r.value = r.value.slice(0, r.caret - 1) + r.value.slice(r.caret); r.caret--; }
    else if (k === 'Delete') r.value = r.value.slice(0, r.caret) + r.value.slice(r.caret + 1);
  } else if (k === 'ArrowLeft') { r.caret = r.all ? 0 : Math.max(0, r.caret - 1); r.all = false; }
  else if (k === 'ArrowRight') { r.caret = r.all ? r.value.length : Math.min(r.value.length, r.caret + 1); r.all = false; }
  else if (k === 'Home') { r.caret = 0; r.all = false; } else if (k === 'End') { r.caret = r.value.length; r.all = false; }
  else return false;
  blinkOn = true; return true;
}

// ---------------------------------------------------------------- icon views (folder windows and desktop)
function cellFor(it, x, y, wrapW) {
  const lines = wrap(esc(it.label), wrapW), lw = Math.max(1, ...lines.map(l => textW(l)));
  return { it, ix: x, iy: y, lines, lw, lx: x + 16 - (lw >> 1), ly: y + 35 };
}
const cellHit = (c, x, y) => c.small
  ? inR({ x: c.ix, y: c.iy, w: c.lx - c.ix + c.lw + 2, h: 16 }, x, y)
  : inR({ x: c.ix, y: c.iy, w: 32, h: 32 }, x, y) || inR({ x: c.lx - 1, y: c.ly, w: c.lw + 2, h: c.lines.length * 13 }, x, y);
function drawIconLabel(c, view, sel, focused, fg) {
  icon(c.it.icon + '32', c.ix, c.iy, sel && focused);
  if (c.it.overlay) icon('lnkover32', c.ix, c.iy, sel && focused);
  if (ren && ren.view === view && ren.key === c.it.key) {
    const tw = textW(esc(ren.value)), w = Math.max(tw + 6, 20), x = c.ix + 16 - (w >> 1), y = c.ly - 1;
    fill(x, y, w, 15, K.win); edge(x, y, w, 15, K.dk, K.dk); ren.box = { x, y, w, h: 15 };
    if (ren.all) { fill(x + 2, y + 1, tw + 2, 13, K.sel); text(esc(ren.value), x + 3, y + 1, K.hl); }
    else { text(esc(ren.value), x + 3, y + 1); if (blinkOn) fill(x + 3 + textW(esc(ren.value.slice(0, ren.caret))), y + 1, 1, 13, K.dk); }
    return;
  }
  const lh = c.lines.length * 13;
  if (sel) fill(c.lx - 1, c.ly, c.lw + 2, lh, focused ? K.sel : K.face);
  c.lines.forEach((l, j) => text(l, c.lx + ((c.lw - textW(l)) >> 1), c.ly + j * 13, sel && focused ? K.hl : fg));
  if (sel && focused) focusRect(c.lx - 1, c.ly, c.lw + 2, lh);
}
function viewSelItem(v) { return v.cells.find(c => c.it.key === v.selKey)?.it || null; }
function itemMenu(view, it) {
  if (it.bin) return [{ label: '&Restore', bold: true, fn: () => restoreBin(it.bin) }, { sep: true }, { label: '&Delete', fn: () => confirmDelete(it) }, { sep: true }, { label: 'P&roperties', fn: () => binProps(it.bin) }];
  const real = !!it.info && !isRoot(it.path), ro = real && fs.vols.get(it.path[0]).readonly;
  const out = [{ label: '&Open', bold: true, fn: () => it.open() }];
  if ((it.info && it.info.isDir) || it.drive || it.key === 'sys:mc') out.push({ label: '&Explore', fn: () => it.open() });
  out.push({ sep: true });
  if (real) out.push({ label: 'Cu&t', disabled: ro, fn: () => cutCopy(it, 'cut') }, { label: '&Copy', fn: () => cutCopy(it, 'copy') }, { sep: true });
  if (it.key === 'sys:bin') out.push({ label: 'Empty Recycle &Bin', disabled: !binItems().length, fn: emptyBin }, { sep: true });
  const net = !!((window.W95SYSTEM || {}).net || {})['MPR.DLL'];
  if (net && (it.key === 'sys:mc' || it.key === 'sys:net')) out.push({ label: 'Ma&p Network Drive...', fn: mapNetDrive }, { label: 'Dis&connect Network Drive...', fn: disconnectNetDrive }, { sep: true });
  if (net && it.drive && fs.vols.get(it.drive).remote) out.push({ label: 'Dis&connect', fn: () => netCall('WNetCancelConnection2A', [netStr(it.drive + ':'), 1, 0]).then(syncNetDrives) }, { sep: true });
  out.push({ label: 'Create &Shortcut', disabled: !(real || it.drive || NS_CLSID[it.key]), fn: () => createShortcut(view, it) });
  if (real) out.push({ label: '&Delete', disabled: ro, fn: () => confirmDelete(it) }, { label: 'Rena&me', disabled: ro, fn: () => startRename(view, it) });
  out.push({ sep: true }, { label: 'P&roperties', fn: () => properties(it) });
  return out;
}
function newMenu(view) {
  const dir = view.src.path, ro = !dir || view.src.readonly;
  return { label: 'Ne&w', disabled: ro, sub: [
    { label: '&Folder', icon: 'folder', fn: () => view.created(newItem(dir, 'folder')) }, { sep: true },
    { label: '&Shortcut', icon: 'app', disabled: !clip, fn: () => view.created(clip && makeShortcut(clip.path, dir)) },
    { label: 'Text Document', icon: 'textdoc', fn: () => view.created(newItem(dir, 'text')) },
  ] };
}
function bgMenu(view, desktop) {
  const dir = view.src.path, ro = !dir || view.src.readonly;
  const out = [];
  if (!desktop) out.push({ label: '&View', sub: viewModeItems(view) }, { sep: true });
  out.push({ label: 'Arrange &Icons', sub: arrangeItems(view) },
    { label: 'Line &up Icons', fn: () => view.lineUp() }, { sep: true },
    { label: '&Paste', disabled: ro || !clip, fn: () => pasteInto(dir) }, { label: 'Paste &Shortcut', disabled: ro || !clip, fn: () => pasteShortcut(dir) }, { sep: true },
    newMenu(view), { sep: true }, { label: 'P&roperties', disabled: !desktop && !dir, fn: () => desktop ? displayProperties() : dir && properties(fsItem(fs.stat(dir))) });
  return out;
}
const viewModeItems = view => [['Lar&ge Icons', 'large'], ['S&mall Icons', 'small'], ['&List', 'list'], ['&Details', 'details']]
  .map(([label, m]) => ({ label, radio: true, check: view.mode === m, fn: () => view.setMode(m) }));
const arrangeItems = view => [['by &Name', 'name'], ['by &Type', 'type'], ['by Si&ze', 'size'], ['by &Date', 'date']].map(([label, by]) => ({ label, fn: () => view.arrange(by) }));
// Keyboard commands shared by folder windows and the desktop.
function viewKey(view, e) {
  const it = viewSelItem(view), ctl = e.ctrlKey || e.metaKey, k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (ctl && k === 'c' && it) { cutCopy(it, 'copy'); return true; }
  if (ctl && k === 'x' && it) { cutCopy(it, 'cut'); return true; }
  if (ctl && k === 'v') { pasteInto(view.src.path); return true; }
  if (k === 'Delete' && it) { confirmDelete(it, e.shiftKey); return true; }
  if (k === 'F2' && it) { startRename(view, it); return true; }
  if (k === 'Enter' && it) { if (e.altKey) properties(it); else it.open(); return true; }
  if (k === 'F5') { view.refresh(); return true; }
  const cells = view.cells; if (!cells.length) return false;
  const i = cells.findIndex(c => c.it.key === view.selKey);
  const d = view.navStep(k);
  if (d) { view.selKey = cells[i < 0 ? 0 : clamp(i + d, 0, cells.length - 1)].it.key; return true; }
  return false;
}

const CW = 75, CH = 70;
// Explorer's four views, its sort orders (folders first), and the folder toolbar and status bar
const VIEW_MODES = ['large', 'small', 'list', 'details'];
const SORTS = {
  name: (a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }),
  type: (a, b) => itemType(a).localeCompare(itemType(b)) || SORTS.name(a, b),
  size: (a, b) => ((a.info && !a.info.isDir ? a.info.size : 0) - (b.info && !b.info.isDir ? b.info.size : 0)) || SORTS.name(a, b),
  date: (a, b) => ((b.info ? b.info.mtime : 0) - (a.info ? a.info.mtime : 0)) || SORTS.name(a, b),
};
function itemType(it) {
  if (it.drive) { const v = fs.vols.get(it.drive); return { fixed: 'Local Disk', removable: '3½ Inch Floppy Disk', cdrom: 'CD-ROM Disc', remote: 'Network Connection' }[v.kind]; }
  if (it.info) return typeDesc(it.info);
  return 'System Folder';
}
const fmtShort = t => { const d = new Date(t), h = d.getHours() % 12 || 12; return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)} ${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`; };
const DETAIL_COLS = [{ id: 'name', label: 'Name', w: 150 }, { id: 'size', label: 'Size', w: 64, right: true }, { id: 'type', label: 'Type', w: 110 }, { id: 'date', label: 'Modified', w: 104 }];
// toolbar buttons: [strip, index, tip, action id]; null is a separator
const FOLDER_TB = [['tbview', 8, 'Up One Level', 'up'], null, ['tbstd', 0, 'Cut', 'cut'], ['tbstd', 1, 'Copy', 'copy'], ['tbstd', 2, 'Paste', 'paste'], null,
  ['tbstd', 3, 'Undo', 'undo'], null, ['tbstd', 5, 'Delete', 'delete'], ['tbstd', 10, 'Properties', 'props'], null,
  ['tbview', 0, 'Large Icons', 'large'], ['tbview', 1, 'Small Icons', 'small'], ['tbview', 2, 'List', 'list'], ['tbview', 3, 'Details', 'details']];
function tbGlyph(strip, i, x, y, enabled) {
  const im = IMG[strip]; if (!im) return;
  if (enabled) { ctx.drawImage(im, i * 16, 0, 16, 16, x, y, 16, 16); return; }
  // disabled: the glyph's shape embossed, white offset under grey
  const c = tbGlyph.cache || (tbGlyph.cache = new Map()), k = `${strip}:${i}`;
  if (!c.has(k)) {
    const m = mkc(16, 16), g = m.getContext('2d'); g.drawImage(im, i * 16, 0, 16, 16, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16), mk = col => { const o = new ImageData(16, 16); for (let p = 0; p < 256; p++) { const a = d.data[p * 4 + 3], r = d.data[p * 4], gg = d.data[p * 4 + 1], b = d.data[p * 4 + 2]; if (a && r + gg + b < 600) { o.data.set(col, p * 4); o.data[p * 4 + 3] = 255; } } const cc = mkc(16, 16); cc.getContext('2d').putImageData(o, 0, 0); return cc; };
    c.set(k, [mk([255, 255, 255]), mk([128, 128, 128])]);
  }
  const [hl, sh] = c.get(k); ctx.drawImage(hl, x + 1, y + 1); ctx.drawImage(sh, x, y);
}
// one level of Undo, as Explorer's Edit menu has it
let undoOp = null;
const setUndo = (label, fn) => { undoOp = { label, fn }; };
function undoLast() { const u = undoOp; undoOp = null; if (u) fsTry('undo', u.label, u.fn); }

class FolderView {
  constructor(src) {
    this.src = src; this.selKey = null; this.cells = []; this.cache = null; this.pending = null;
    this.sb = new ScrollBar(true, () => dirty()); this.hsb = new ScrollBar(false, () => dirty());
    this.mode = 'large'; this.sort = null; this.status = true; this.toolbar = false; this.tbDown = -1;
  }
  refresh() { this.cache = null; this.lay = null; }
  arrange(by) { if (by) this.sort = by; this.refresh(); }
  lineUp() { this.refresh(); }
  setMode(m) { this.mode = m; this.sb.pos = this.hsb.pos = 0; this.refresh(); dirty(); }
  navStep(k) {
    const across = this.mode === 'list' ? this.rows : 1, down = this.mode === 'list' || this.mode === 'details' ? 1 : this.cols;
    return { ArrowLeft: -across, ArrowRight: across, ArrowUp: -down, ArrowDown: down }[k] || 0;
  }
  created(path) { if (path) { this.pending = fs.inoOf(path); this.refresh(); } }
  items() {
    if (!this.cache || this.cache.v !== fs.version) {
      let list = []; try { list = this.src.list(); } catch (_) { list = []; }
      if (this.sort) list = [...list].sort((a, b) => ((b.info && b.info.isDir) - (a.info && a.info.isDir)) || SORTS[this.sort](a, b));
      this.cache = { v: fs.version, list }; this.lay = null;
    }
    return this.cache.list;
  }
  layout(r) {
    const items = this.items(), key = `${r.x},${r.y},${r.w},${r.h},${this.sb.pos},${this.hsb.pos},${this.cache.v},${this.mode},${this.status},${this.toolbar}`;
    if (this.lay === key) return;
    const tbH = this.toolbar ? 28 : 0, stH = this.status ? 22 : 0;
    this.tb = { x: r.x, y: r.y, w: r.w, h: tbH };
    this.fr = { x: r.x, y: r.y + tbH, w: r.w, h: r.h - tbH - stH };
    this.st = this.status ? { x: r.x, y: r.y + r.h - 20, w: r.w, h: 20 } : null;
    const n = items.length, m = this.mode;
    let iw = this.fr.w - 4, ih = this.fr.h - 4;
    this.showSb = this.showHsb = false;
    const head = m === 'details' ? 17 : 0;
    if (m === 'large' || m === 'small') {
      const cw = m === 'large' ? CW : Math.min(160, Math.max(80, ...items.map(it => textW(esc(it.label)) + 26))), ch = m === 'large' ? CH : 18;
      let cols = Math.max(1, Math.floor(iw / cw)), content = Math.ceil(n / cols) * ch;
      if (content > ih) { this.showSb = true; iw -= 16; cols = Math.max(1, Math.floor(iw / cw)); content = Math.ceil(n / cols) * ch; }
      this.cols = cols; this.inner = { x: this.fr.x + 2, y: this.fr.y + 2, w: iw, h: ih };
      this.sb.set(this.inner.x + iw, this.inner.y, ih, content, ih); if (!this.showSb) this.sb.pos = 0;
      this.cells = items.map((it, i) => {
        const x = this.inner.x + (i % cols) * cw, y = this.inner.y + Math.floor(i / cols) * ch - this.sb.pos;
        return m === 'large' ? cellFor(it, x + 21, y + 2, CW - 4) : smallCell(it, x + 2, y + 1, cw - 24);
      });
    } else if (m === 'list') {
      const cw = Math.min(200, Math.max(80, ...items.map(it => textW(esc(it.label)) + 26)));
      let rows = Math.max(1, Math.floor(ih / 18)), content = Math.ceil(n / rows) * cw;
      if (content > iw) { this.showHsb = true; ih -= 16; rows = Math.max(1, Math.floor(ih / 18)); content = Math.ceil(n / rows) * cw; }
      this.rows = rows; this.inner = { x: this.fr.x + 2, y: this.fr.y + 2, w: iw, h: ih };
      this.hsb.set(this.inner.x, this.inner.y + ih, iw, content, iw); if (!this.showHsb) this.hsb.pos = 0;
      this.cells = items.map((it, i) => smallCell(it, this.inner.x + Math.floor(i / rows) * cw - this.hsb.pos + 2, this.inner.y + (i % rows) * 18 + 1, cw - 24));
    } else {
      const total = DETAIL_COLS.reduce((a, c) => a + c.w, 0), content = n * 17;
      if (content > ih - head) { this.showSb = true; iw -= 16; }
      if (total > iw) { this.showHsb = true; ih -= 16; }
      this.inner = { x: this.fr.x + 2, y: this.fr.y + 2 + head, w: iw, h: ih - head };
      this.head = { x: this.fr.x + 2 - this.hsb.pos, y: this.fr.y + 2, h: head };
      this.sb.set(this.inner.x + iw, this.fr.y + 2, ih, content + head, ih); if (!this.showSb) this.sb.pos = 0;
      this.hsb.set(this.inner.x, this.fr.y + 2 + ih, iw, total, iw); if (!this.showHsb) this.hsb.pos = 0;
      this.cells = items.map((it, i) => ({ ...smallCell(it, this.inner.x + 2 - this.hsb.pos, this.inner.y + i * 17 - this.sb.pos, DETAIL_COLS[0].w - 24), row: true }));
    }
    this.lay = key;
    if (this.pending) {
      const c = this.cells.find(x => x.it.key === this.pending); this.pending = null;
      if (c) { this.selKey = c.it.key; startRename(this, c.it); }
    }
  }
  tbButtons() {
    if (!this.toolbar) return [];
    const out = []; let x = this.tb.x + 4;
    for (const b of FOLDER_TB) {
      if (!b) { x += 8; continue; }
      out.push({ b, x, y: this.tb.y + 3, w: 23, h: 22 }); x += 23;
    }
    return out;
  }
  tbEnabled(id) {
    const it = viewSelItem(this), real = !!(it && it.info && !it.bin && !isRoot(it.path)), ro = !this.src.path || !!this.src.readonly;
    return { up: !!this.src.path || this.src !== MyComputer, cut: real && !ro, copy: !!real, paste: !ro && !!clip, undo: !!undoOp,
      delete: !!real && !ro, props: !!it || !!this.src.path }[id] ?? true;
  }
  tbAction(id, win) {
    const it = viewSelItem(this);
    if (id === 'up') { const p = this.src.path; if (p) { if (isRoot(p)) openFolder(MyComputer); else openPath(dirname(p)); } return; }
    if (id === 'cut' && it) return cutCopy(it, 'cut');
    if (id === 'copy' && it) return cutCopy(it, 'copy');
    if (id === 'paste') return pasteInto(this.src.path);
    if (id === 'undo') return undoLast();
    if (id === 'delete' && it) return confirmDelete(it);
    if (id === 'props') return it ? properties(it) : this.src.path && properties(fsItem(fs.stat(this.src.path)));
    if (VIEW_MODES.includes(id)) this.setMode(id);
  }
  draw(r, win) {
    if (this.src.gone) { setTimeout(() => closeWin(win, true)); return; }
    win.title = this.src.title; win.icon = this.src.icon;
    this.layout(r);
    if (this.toolbar) {
      fill(this.tb.x, this.tb.y + this.tb.h - 2, this.tb.w, 1, K.sh); fill(this.tb.x, this.tb.y + this.tb.h - 1, this.tb.w, 1, K.hl);
      for (const [i, t] of this.tbButtons().entries()) {
        const on = this.tbEnabled(t.b[3]), checked = t.b[3] === this.mode, down = this.tbDown === i || checked;
        if (down) { if (checked && this.tbDown !== i) { ctx.fillStyle = PAT.track; ctx.fillRect(t.x, t.y, t.w, t.h); } edge(t.x, t.y, t.w, t.h, K.sh, K.hl); }
        tbGlyph(t.b[0], t.b[1], t.x + 4 + (down ? 1 : 0), t.y + 3 + (down ? 1 : 0), on);
      }
    }
    field(this.fr.x, this.fr.y, this.fr.w, this.fr.h);
    if (this.mode === 'details') {
      ctx.save(); ctx.beginPath(); ctx.rect(this.fr.x + 2, this.head.y, this.inner.w, this.head.h); ctx.clip();
      let hx = this.head.x;
      for (const c of DETAIL_COLS) { btnUp(hx, this.head.y, c.w, this.head.h); text(c.label, c.right ? hx + c.w - 6 - textW(c.label) : hx + 6, this.head.y + 2); hx += c.w; }
      if (hx < this.fr.x + 2 + this.inner.w) btnUp(hx, this.head.y, this.fr.x + 2 + this.inner.w - hx, this.head.h);
      ctx.restore();
    }
    ctx.save(); ctx.beginPath(); ctx.rect(this.inner.x, this.inner.y, this.inner.w, this.inner.h); ctx.clip();
    for (const c of this.cells) {
      if (c.iy > this.inner.y + this.inner.h || c.ly + 40 < this.inner.y || c.ix > this.inner.x + this.inner.w || c.ix + 200 < this.inner.x) continue;
      const sel = c.it.key === this.selKey;
      if (this.mode === 'large') drawIconLabel(c, this, sel, win.isActive, K.dk);
      else drawSmallCell(c, this, sel, win.isActive);
      if (this.mode === 'details') {
        let x = c.ix - 2 + DETAIL_COLS[0].w;
        const i = c.it.info, vals = { size: i && !i.isDir ? fmtSize(i.size).replace(/ bytes$/, ' bytes') : '', type: itemType(c.it), date: i ? fmtShort(i.mtime) : '' };
        for (const col of DETAIL_COLS.slice(1)) {
          const v = ellipsis(esc(vals[col.id]), col.w - 12);
          text(v, col.right ? x + col.w - 6 - textW(v) : x + 6, c.iy + 1); x += col.w;
        }
      }
    }
    ctx.restore();
    if (this.showSb) this.sb.draw();
    if (this.showHsb) this.hsb.draw();
    if (this.showSb && this.showHsb) fill(this.inner.x + this.inner.w, this.hsb.r.y, 16, 16, K.face);
    if (this.st) {
      const s = this.st, n = this.cells.length, it = viewSelItem(this), lw = Math.floor((s.w - 16) * 0.55);
      edge(s.x, s.y, lw - 2, s.h, K.sh, K.hl); edge(s.x + lw, s.y, s.w - lw - 16, s.h, K.sh, K.hl);
      const hid = this.src.hidden ? ` (plus ${this.src.hidden} hidden)` : '';
      let left = it ? '1 object(s) selected' : `${n} object(s)${hid}`, right = '';
      if (it && it.drive) {
        try { const v = fs.statvfs(it.path); left = `Free Space: ${fmtSize(v.free)}, Capacity: ${fmtSize(v.total)}`; } catch (_) { left = '1 object(s) selected'; }
      } else if (it && it.info) right = it.info.isDir ? '' : fmtSize(it.info.size);
      else if (this.src.path) right = fmtSize(this.cells.reduce((a, c) => a + (c.it.info && !c.it.info.isDir ? c.it.info.size : 0), 0));
      ctx.save(); ctx.beginPath(); ctx.rect(s.x + 2, s.y, lw - 6, s.h); ctx.clip(); text(left, s.x + 3, s.y + 4); ctx.restore();
      text(right, s.x + lw + 3, s.y + 4);
    }
    if (!win.max) sizeGrip(r.x + r.w, r.y + r.h);
  }
  down(x, y, btn, dbl, win) {
    const tb = this.tbButtons(), ti = tb.findIndex(t => inR(t, x, y));
    if (ti >= 0) {
      const t = tb[ti]; if (!this.tbEnabled(t.b[3])) return null;
      this.tbDown = ti;
      return { move: (mx, my) => { this.tbDown = inR(t, mx, my) ? ti : -1; }, up: (mx, my) => { this.tbDown = -1; if (inR(t, mx, my)) this.tbAction(t.b[3], win); } };
    }
    if (this.showSb && this.sb.contains(x, y)) return this.sb.down(x, y);
    if (this.showHsb && this.hsb.contains(x, y)) return this.hsb.down(x, y);
    if (this.mode === 'details' && y >= this.head.y && y < this.head.y + this.head.h) {
      let hx = this.head.x;
      for (const c of DETAIL_COLS) { if (x >= hx && x < hx + c.w) { this.arrange(c.id); return null; } hx += c.w; }
      return null;
    }
    if (!inR(this.inner, x, y)) return null;
    const c = this.cells.find(cc => cellHit(cc, x, y));
    this.selKey = c ? c.it.key : null;
    if (btn === 2) openPopup(c ? itemMenu(this, c.it) : bgMenu(this), x, y);
    else if (dbl && c) c.it.open();
    return null;
  }
  key(e) {
    if (e.key === 'Backspace') {
      const p = this.src.path;
      if (p) { if (isRoot(p)) openFolder(MyComputer); else openPath(dirname(p)); }
      return true;
    }
    if (e.key === 'Enter' && !viewSelItem(this)) return false;
    return viewKey(this, e);
  }
}
// small icons, list and details: a 16-pixel icon with the name beside it
function smallCell(it, x, y, maxW) {
  const label = ellipsis(esc(it.label), maxW), lw = Math.max(1, textW(label));
  return { it, ix: x, iy: y, lines: [label], lw, lx: x + 19, ly: y + 1, small: true };
}
function drawSmallCell(c, view, sel, focused) {
  icon(c.it.icon + '16', c.ix, c.iy, sel && focused);
  if (c.it.overlay) icon('lnkover16', c.ix, c.iy, sel && focused);
  if (ren && ren.view === view && ren.key === c.it.key) {
    const tw = textW(esc(ren.value)), w = Math.max(tw + 6, 20), x = c.lx - 1, y = c.ly - 1;
    fill(x, y, w, 15, K.win); edge(x, y, w, 15, K.dk, K.dk); ren.box = { x, y, w, h: 15 };
    text(esc(ren.value), x + 3, y + 1); if (blinkOn) fill(x + 3 + textW(esc(ren.value.slice(0, ren.caret))), y + 1, 1, 13, K.dk);
    return;
  }
  if (sel) fill(c.lx - 1, c.ly - 1, c.lw + 2, 15, focused ? K.sel : K.face);
  text(c.lines[0], c.lx, c.ly, sel && focused ? K.hl : K.dk);
  if (sel && focused) focusRect(c.lx - 1, c.ly - 1, c.lw + 2, 15);
}
function openFolder(src) {
  const open = windows.find(w => w.body instanceof FolderView && w.body.src.id === src.id);
  if (open) { activate(open); return open; }
  const view = new FolderView(src), p = nextPos(330, 240);
  const isBin = src === RecycleBin;
  let win;
  const fileMenu = () => {
    const it = viewSelItem(view), out = [];
    if (isBin) out.push({ label: 'Empty Recycle &Bin', disabled: !binItems().length, fn: emptyBin }, { sep: true });
    if (it) out.push(...itemMenu(view, it), { sep: true });
    else if (!isBin) out.push(newMenu(view), { sep: true }, { label: 'Create &Shortcut', disabled: true }, { label: '&Delete', disabled: true }, { label: 'Rena&me', disabled: true }, { label: 'P&roperties', disabled: !src.path, fn: () => properties(fsItem(fs.stat(src.path))) }, { sep: true });
    out.push({ label: '&Close', fn: () => closeWin(win) });
    return out;
  };
  const editMenu = () => {
    const it = viewSelItem(view), real = it && it.info && !it.bin && !isRoot(it.path), ro = !src.path || src.readonly;
    return [{ label: undoOp ? `&${undoOp.label}` : '&Undo', disabled: !undoOp, acc: 'Ctrl+Z', fn: undoLast }, { sep: true },
      { label: 'Cu&t', acc: 'Ctrl+X', disabled: !real || ro, fn: () => cutCopy(it, 'cut') }, { label: '&Copy', acc: 'Ctrl+C', disabled: !real, fn: () => cutCopy(it, 'copy') },
      { label: '&Paste', acc: 'Ctrl+V', disabled: ro || !clip, fn: () => pasteInto(src.path) }, { label: 'Paste &Shortcut', disabled: ro || !clip, fn: () => pasteShortcut(src.path) }];
  };
  win = openWin(new Win({
    ...p, w: 330, h: 240, title: src.title, icon: src.icon, minW: 160, minH: 100, body: view,
    menu: [
      { label: '&File', items: fileMenu }, { label: '&Edit', items: editMenu },
      { label: '&View', items: () => [
        { label: '&Toolbar', check: view.toolbar, fn: () => { view.toolbar = !view.toolbar; view.refresh(); } },
        { label: 'Status &Bar', check: view.status, fn: () => { view.status = !view.status; view.refresh(); } }, { sep: true },
        ...viewModeItems(view), { sep: true },
        { label: 'Arrange &Icons', sub: arrangeItems(view) }, { label: 'Line &up Icons', disabled: view.mode === 'list' || view.mode === 'details', fn: () => view.lineUp() }, { sep: true },
        { label: '&Refresh', fn: () => view.refresh() }] },
      { label: '&Help', items: [{ label: '&Help Topics', disabled: !hasHelp(), fn: () => winHelp() }, { sep: true }, { label: '&About Windows 95', fn: aboutWin95 }] },
    ],
  }));
  return win;
}

// ---------------------------------------------------------------- properties
function fmtDate(t) { return new Date(t).toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }); }
function propSheet(title, page, onApply) {
  let win;
  const apply = () => onApply ? onApply() : true;
  win = dialog(title, 360, 414, [
    { type: 'tabs', x: 6, y: 6, w: 348, h: 370, tabs: ['General'] },
    ...page.map(c => ({ ...c, x: c.x + 6, y: c.y + 26 })),
    { type: 'button', label: 'OK', x: 122, y: 384, w: 75, h: 23, def: true, fn: () => { if (apply()) closeWin(win); } },
    { type: 'button', label: 'Cancel', x: 200, y: 384, w: 75, h: 23, cancel: true, fn: () => closeWin(win) },
    { type: 'button', label: '&Apply', x: 278, y: 384, w: 75, h: 23, fn: apply },
  ]);
  return win;
}
const row = (y, k, v, w = 230) => [{ type: 'label', text: k, x: 14, y }, { type: 'label', text: v, x: 100, y, w, ell: true }];
function properties(it) {
  if (it.bin) return binProps(it.bin);
  if (it.drive) return driveProps(it.drive);
  if (!it.path) return;
  let i; try { i = fs.stat(it.path); } catch (e) { return msgBox('Properties', fsMsg(it.path, e), 'error'); }
  const name = dispName(i.name, i.isDir), du = i.isDir ? fs.du(i.path) : null;
  const size = i.isDir ? du.bytes : i.size, alloc = i.isDir ? du.alloc : i.alloc;
  const ro = fs.vols.get(i.drive).readonly;
  const chk = (label, x, y, on, dis) => ({ type: 'check', label, x, y, checked: on, disabled: ro || dis });
  const cRo = chk('&Read-only', 100, 286, i.readonly), cHid = chk('H&idden', 220, 286, i.hidden);
  const cArc = chk('Ar&chive', 100, 306, i.archive), cSys = chk('S&ystem', 220, 306, i.system, true);
  const page = [
    { type: 'icon', name: iconFor(i) + '32', x: 14, y: 12 }, { type: 'label', text: name, x: 100, y: 22, w: 230, ell: true },
    { type: 'line', x: 14, y: 54, w: 320 },
    ...row(66, 'Type:', typeDesc(i)), ...row(86, 'Location:', dirname(i.path)),
    ...row(106, 'Size:', `${fmtSize(size)} (${num(size)} bytes), ${num(alloc)} bytes used`),
    ...(i.isDir ? row(126, 'Contains:', `${du.files} Files, ${du.dirs} Folders`) : []),
    { type: 'line', x: 14, y: 150, w: 320 },
    ...row(162, 'MS-DOS name:', i.shortName), ...row(182, 'Created:', fmtDate(i.ctime)),
    ...(i.isDir ? [] : [...row(202, 'Modified:', fmtDate(i.mtime)), ...row(222, 'Accessed:', new Date(i.atime).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }))]),
    { type: 'line', x: 14, y: 250, w: 320 },
    { type: 'label', text: 'Attributes:', x: 14, y: 288 }, cRo, cHid, cArc, cSys,
  ];
  propSheet(`${name} Properties`, page, () => {
    if (ro) return true;
    const a = (cRo.checked ? ATTR.READONLY : 0) | (cHid.checked ? ATTR.HIDDEN : 0) | (cArc.checked ? ATTR.ARCHIVE : 0) | (cSys.checked ? ATTR.SYSTEM : 0);
    return a === (i.attrs & 39) || fsTry('change attributes of', name, () => fs.setAttrs(i.path, a));
  });
}
function driveProps(l) {
  let v; try { v = fs.statvfs(l + ':\\'); } catch (e) { return msgBox(driveLabel(l), fsMsg(l + ':\\', e), 'error'); }
  const kind = { fixed: 'Local Disk', removable: '3\u00bd Inch Floppy Disk', cdrom: 'CD-ROM Disk', remote: 'Network Connection' }[v.kind];
  const label = { type: 'edit', x: 100, y: 18, w: 160, h: 21, value: v.label, caret: v.label.length, readonly: v.readonly };
  const swatch = (y, c) => ({ type: 'custom', x: 14, y, w: 13, h: 13, draw: a => { fill(a.x, a.y, 13, 13, c); edge(a.x, a.y, 13, 13, K.dk, K.dk); } });
  const pie = { type: 'custom', x: 100, y: 196, w: 160, h: 100, draw: a => drawPie(a.x + 80, a.y + 34, 70, 30, 12, v.total ? v.used / v.total : 0) };
  const page = [
    { type: 'icon', name: driveIcon(l) + '32', x: 14, y: 12 }, { type: 'label', text: '&Label:', amp: true, x: 54, y: 22 }, label,
    { type: 'line', x: 14, y: 54, w: 320 },
    ...row(66, 'Type:', kind),
    { type: 'line', x: 14, y: 88, w: 320 },
    swatch(100, '#0000ff'), { type: 'label', text: 'Used space:', x: 34, y: 100 }, { type: 'label', text: `${num(v.used)} bytes`, x: 130, y: 100 }, { type: 'label', text: fmtSize(v.used), x: 270, y: 100 },
    swatch(120, '#ff00ff'), { type: 'label', text: 'Free space:', x: 34, y: 120 }, { type: 'label', text: `${num(v.free)} bytes`, x: 130, y: 120 }, { type: 'label', text: fmtSize(v.free), x: 270, y: 120 },
    { type: 'line', x: 14, y: 142, w: 320 },
    { type: 'label', text: 'Capacity:', x: 34, y: 154 }, { type: 'label', text: `${num(v.total)} bytes`, x: 130, y: 154 }, { type: 'label', text: fmtSize(v.total), x: 270, y: 154 },
    pie, { type: 'label', text: `Drive ${l}`, x: 158, y: 304 },
  ];
  propSheet(driveLabel(l) + ' Properties', page, () => label.readonly || label.value === v.label || fsTry('change the label of', `drive ${l}`, () => fs.setLabel(l + ':\\', label.value)));
}
function drawPie(cx, cy, rx, ry, depth, frac) {
  const a = Math.PI * 2 * frac;
  const wedge = (y, a0, a1, c) => { ctx.beginPath(); ctx.moveTo(cx, y); ctx.ellipse(cx, y, rx, ry, 0, a0, a1); ctx.closePath(); ctx.fillStyle = c; ctx.fill(); };
  for (let d = depth; d > 0; d--) { wedge(cy + d, 0, a || 0.0001, '#000080'); if (frac < 1) wedge(cy + d, a, Math.PI * 2, '#800080'); }
  if (frac > 0) wedge(cy, 0, a, '#0000ff');
  if (frac < 1) wedge(cy, a, Math.PI * 2, '#ff00ff');
  ctx.strokeStyle = K.dk; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(cx + 0.5, cy + 0.5, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - rx + 0.5, cy + 0.5); ctx.lineTo(cx - rx + 0.5, cy + depth + 0.5);
  ctx.ellipse(cx + 0.5, cy + depth + 0.5, rx, ry, 0, Math.PI, 0, true); ctx.lineTo(cx + rx + 0.5, cy + 0.5); ctx.stroke();
}

// ---------------------------------------------------------------- notepad
// Notepad is an EDIT control: one text, a caret and an anchor (the selection runs between them), tab stops every
// eight columns, one level of undo, and word wrap to the window's width.
let textClip = '';   // the clipboard's text, shared by every edit in the shell
let clipOwner = null;   // the native program whose USER holds the clipboard now (NativeApp.clipHandoff)
class Notepad {
  constructor() {
    this.t = ''; this.c = 0; this.a = 0; this.path = null; this.modified = false; this.wrap = false;
    this.top = 0; this.left = 0; this.undo = null; this.typing = false; this.find = { what: '', matchCase: false, down: true };
    this.vs = new ScrollBar(true, p => { this.top = p; dirty(); });
    this.hs = new ScrollBar(false, p => { this.left = p; dirty(); });
    this.f = A.fixed; this.cw = this.f.g[77][0]; this.lh = this.f.h;
  }
  setText(t) { this.t = t.replace(/\r\n?/g, '\n'); this.c = this.a = this.top = this.left = 0; this.modified = false; this.undo = null; this.vl = null; }
  get title() { return `${this.path ? dispName(basename(this.path)) : 'Untitled'} - Notepad`; }
  get sel() { return [Math.min(this.a, this.c), Math.max(this.a, this.c)]; }
  get selected() { const [s, e] = this.sel; return this.t.slice(s, e); }
  // display width of t[from, to) on a line starting at `from`, with tabs to the next multiple of eight
  cols(from, to) { let n = 0; for (let i = from; i < to; i++) n = this.t[i] === '\t' ? (n >> 3) + 1 << 3 : n + 1; return n; }
  // the visual lines, as index ranges; wrapped at the last space that fits, or mid-word when none does
  lines() {
    if (this.vl && this.vl.t === this.t && this.vl.w === (this.wrap ? this.colsVis : 0)) return this.vl.list;
    const out = [], t = this.t;
    for (let s = 0; ;) {
      let e = t.indexOf('\n', s); if (e < 0) e = t.length;
      if (!this.wrap) out.push({ s, e });
      else {
        let ls = s;
        while (this.cols(ls, e) > this.colsVis) {
          let cut = ls, n = 0;
          while (cut < e && (n = t[cut] === '\t' ? (n >> 3) + 1 << 3 : n + 1) <= this.colsVis) cut++;
          const sp = t.lastIndexOf(' ', cut - 1);
          if (sp >= ls && sp < cut) cut = sp + 1;
          if (cut === ls) cut = ls + 1;
          out.push({ s: ls, e: cut, soft: true }); ls = cut;
        }
        out.push({ s: ls, e });
      }
      if (e >= t.length) break;
      s = e + 1;
    }
    this.vl = { t, w: this.wrap ? this.colsVis : 0, list: out };
    return out;
  }
  rowOf(i) { const L = this.lines(); let lo = 0, hi = L.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (L[m].s <= i) lo = m; else hi = m - 1; } return lo; }
  // the index at display column `col` of visual line `row`
  indexAt(row, col) {
    const l = this.lines()[row]; let n = 0, i = l.s;
    while (i < l.e) { const w = this.t[i] === '\t' ? ((n >> 3) + 1 << 3) - n : 1; if (n + w / 2 > col) break; n += w; i++; }
    return i;
  }
  layout(r) {
    const i = { x: r.x + 2, y: r.y + 2, w: r.w - 4, h: r.h - 4 }, hsH = this.wrap ? 0 : 16;
    this.ta = { x: i.x, y: i.y, w: i.w - 16, h: i.h - hsH };
    this.rows = Math.max(1, Math.floor(this.ta.h / this.lh)); this.colsVis = Math.max(1, Math.floor((this.ta.w - 2) / this.cw));
    const L = this.lines();
    this.vs.pos = this.top; this.vs.set(i.x + i.w - 16, i.y, i.h - hsH, L.length, this.rows); this.top = this.vs.pos;
    if (!this.wrap) { this.hs.pos = this.left; this.hs.set(i.x, i.y + i.h - 16, i.w - 16, 1024, this.colsVis); this.left = this.hs.pos; } else this.left = 0;
    this.corner = this.wrap ? null : { x: i.x + i.w - 16, y: i.y + i.h - 16 };
  }
  draw(r, win) {
    win.title = this.title;
    this.layout(r);
    field(r.x, r.y, r.w, r.h);
    const L = this.lines(), [ss, se] = this.sel, act = win.isActive;
    ctx.save(); ctx.beginPath(); ctx.rect(this.ta.x, this.ta.y, this.ta.w, this.ta.h); ctx.clip();
    for (let k = 0; k <= this.rows; k++) {
      const l = L[this.top + k]; if (!l) break;
      const y = this.ta.y + k * this.lh, x0 = this.ta.x + 1 - this.left * this.cw;
      // the line drawn in up to three runs: before, inside and after the selection
      const cuts = [l.s, clamp(ss, l.s, l.e), clamp(se, l.s, l.e), l.e];
      for (let j = 0; j < 3; j++) {
        const a = cuts[j], b = cuts[j + 1]; if (a >= b) continue;
        const x = x0 + this.cols(l.s, a) * this.cw, w = this.cols(l.s, b) * this.cw - (x - x0);
        let shown = ''; for (let i = a, n = this.cols(l.s, a); i < b; i++) { if (this.t[i] === '\t') { const m = ((n >> 3) + 1 << 3) - n; shown += ' '.repeat(m); n += m; } else { shown += this.t[i]; n++; } }
        const inSel = j === 1 && act;
        if (inSel) fill(x, y, w, this.lh, K.sel);
        text(esc(shown), x, y, inSel ? K.hl : K.dk, false, this.f);
      }
    }
    const cr = this.rowOf(this.c);
    if (act && blinkOn && ss === se && cr >= this.top) fill(this.ta.x + 1 + (this.cols(L[cr].s, this.c) - this.left) * this.cw, this.ta.y + (cr - this.top) * this.lh, 1, this.lh, K.dk);
    ctx.restore();
    this.vs.draw(); if (!this.wrap) this.hs.draw();
    if (this.corner) fill(this.corner.x, this.corner.y, 16, 16, K.face);
  }
  show() {
    if (!this.rows) return;
    const L = this.lines(), r = this.rowOf(this.c), col = this.cols(L[r].s, this.c);
    if (r < this.top) this.top = r;
    if (r >= this.top + this.rows) this.top = r - this.rows + 1;
    if (!this.wrap) { if (col < this.left) this.left = Math.max(0, col - 8); if (col > this.left + this.colsVis - 1) this.left = col - this.colsVis + 8; }
    blinkOn = true;
  }
  at(px, py) {
    const L = this.lines(), row = clamp(this.top + Math.floor((py - this.ta.y) / this.lh), 0, L.length - 1);
    return this.indexAt(row, this.left + (px - this.ta.x - 1) / this.cw);
  }
  down(x, y, btn, dbl) {
    if (this.vs.contains(x, y)) return this.vs.down(x, y);
    if (!this.wrap && this.hs.contains(x, y)) return this.hs.down(x, y);
    if (!inR(this.ta, x, y)) return null;
    const i = this.at(x, y);
    if (dbl) {   // a word and the spaces after it
      const wd = ch => ch !== undefined && /[^\s]/.test(ch);
      let s = i, e = i; while (s > 0 && wd(this.t[s - 1])) s--; while (e < this.t.length && wd(this.t[e])) e++; while (this.t[e] === ' ') e++;
      this.a = s; this.c = e; this.typing = false; blinkOn = true; return null;
    }
    this.c = i; if (!mods.shift) this.a = i; this.typing = false; blinkOn = true;
    return { move: (mx, my) => { this.c = this.at(mx, my); this.show(); } };
  }
  cursor(x, y) { return inR(this.ta, x, y) ? 'ibeam' : null; }
  // every change goes through here; a run of typing is one step of undo, as in the EDIT control
  edit(s, e, ins, typing = false) {
    if (!(typing && this.typing)) this.undo = { t: this.t, c: this.c, a: this.a };
    this.typing = typing;
    this.t = this.t.slice(0, s) + ins + this.t.slice(e); this.c = this.a = s + ins.length; this.modified = true; this.show();
  }
  insert(str, typing = false) { const [s, e] = this.sel; this.edit(s, e, str, typing); }
  undoLast() { if (!this.undo) return; const u = this.undo; this.undo = { t: this.t, c: this.c, a: this.a }; Object.assign(this, { t: u.t, c: u.c, a: u.a }); this.typing = false; this.modified = true; this.show(); }
  cut() { if (this.c === this.a) return; textClip = this.selected; this.insert(''); }
  copy() { if (this.c !== this.a) textClip = this.selected; }
  paste() { if (textClip) this.insert(textClip.replace(/\r\n?/g, '\n')); }
  del() { if (this.c !== this.a) this.insert(''); }
  selectAll() { this.a = 0; this.c = this.t.length; this.typing = false; this.show(); }
  findNext(win) {
    const f = this.find; if (!f.what) return findDialog(this, win);
    const hay = f.matchCase ? this.t : this.t.toLowerCase(), needle = f.matchCase ? f.what : f.what.toLowerCase(), [s, e] = this.sel;
    const i = f.down ? hay.indexOf(needle, e) : hay.lastIndexOf(needle, Math.max(0, s - 1));
    if (i < 0 || (!f.down && i >= s)) return msgBox('Notepad', `Cannot find "${f.what}"`, 'info');
    this.a = i; this.c = i + f.what.length; this.typing = false; this.show();
  }
  key(e) {
    const t = this.t, k = e.key, shift = e.shiftKey, ctl = e.ctrlKey || e.metaKey;
    if (e.altKey) return false;
    if (ctl) {
      const kk = k.toLowerCase();
      if (kk === 'z') this.undoLast(); else if (kk === 'x') this.cut(); else if (kk === 'c') this.copy(); else if (kk === 'v') this.paste();
      else if (k === 'Home' || k === 'End' || k === 'ArrowLeft' || k === 'ArrowRight') {
        const wordStep = d => { let i = this.c; if (d < 0) { while (i > 0 && /\s/.test(t[i - 1])) i--; while (i > 0 && !/\s/.test(t[i - 1])) i--; } else { while (i < t.length && !/\s/.test(t[i])) i++; while (i < t.length && /\s/.test(t[i])) i++; } return i; };
        this.c = k === 'Home' ? 0 : k === 'End' ? t.length : wordStep(k === 'ArrowLeft' ? -1 : 1);
        if (!shift) this.a = this.c; this.typing = false;
      } else return false;
      this.show(); return true;
    }
    if (k === 'F5') { this.insert(timeDate()); return true; }
    if (k === 'F3') { this.findNext(); return true; }
    if (k.length === 1) { this.insert(k, true); return true; }
    if (k === 'Enter') { this.insert('\n', true); return true; }
    if (k === 'Tab') { this.insert('\t', true); return true; }
    if (k === 'Backspace') { const [s, e2] = this.sel; if (s !== e2) this.edit(s, e2, ''); else if (s > 0) this.edit(s - 1, s, '', true); return true; }
    if (k === 'Delete') { const [s, e2] = this.sel; if (s !== e2) this.edit(s, e2, ''); else if (s < t.length) this.edit(s, s + 1, ''); return true; }
    const L = this.lines(), r = this.rowOf(this.c), col = this.cols(L[r].s, this.c);
    let c = this.c;
    if (k === 'ArrowLeft') c = !shift && this.a !== this.c ? this.sel[0] : Math.max(0, c - 1);
    else if (k === 'ArrowRight') c = !shift && this.a !== this.c ? this.sel[1] : Math.min(t.length, c + 1);
    else if (k === 'ArrowUp') c = r > 0 ? this.indexAt(r - 1, col) : c;
    else if (k === 'ArrowDown') c = r < L.length - 1 ? this.indexAt(r + 1, col) : c;
    else if (k === 'Home') c = L[r].s;
    else if (k === 'End') c = L[r].e;
    else if (k === 'PageUp') c = this.indexAt(Math.max(0, r - this.rows), col);
    else if (k === 'PageDown') c = this.indexAt(Math.min(L.length - 1, r + this.rows), col);
    else return false;
    this.c = c; if (!shift) this.a = c; this.typing = false; this.show(); return true;
  }
  // ---- file I/O
  load(path) {
    let i; try { i = fs.stat(path); } catch (e) { msgBox('Notepad', `${path}\n${e.message}`, 'warning'); return false; }
    if (i.size > 65535) { msgBox('Notepad', `The file ${dispName(i.name)} is too large for Notepad.\n\nUse another editor to edit the file.`, 'warning'); return false; }
    let t; try { t = fs.readText(i.path); } catch (e) { msgBox('Notepad', `${i.path}\n${e.message}`, 'warning'); return false; }
    this.setText(t); this.path = i.path; addRecent(i.path); dirty(); return true;
  }
  write(path) {
    const ok = fsTry('save', dispName(basename(path)), () => fs.writeFile(path, this.t.replace(/\n/g, '\r\n')));
    if (ok) { this.path = fs.realpath(path); this.modified = false; addRecent(this.path); }
    return ok;
  }
  save(then) { if (this.path) { if (this.write(this.path) && then) then(); } else this.saveAs(then); }
  saveAs(then) {
    fileDialog({ title: 'Save As', save: true, dir: this.path ? dirname(this.path) : 'C:\\My Documents', name: this.path ? basename(this.path) : '*.txt',
      onOk: p => { if (this.write(p) && then) then(); } });
  }
  confirm(then) {
    if (!this.modified) return then();
    msgBox('Notepad', `The text in the ${this.path || 'Untitled'} file has changed.\n\nDo you want to save the changes?`, 'warning', ['&Yes', '&No', 'Cancel'], b => {
      if (b === '&Yes') this.save(then); else if (b === '&No') then();
    });
  }
  canClose(proceed) { if (!this.modified) return true; this.confirm(proceed); return false; }
}
// Search > Find: the text to find, Match case, and a direction; Find Next keeps going from the selection
function findDialog(np) {
  const open = windows.find(w => w.title === 'Find' && w.np === np); if (open) return activate(open);
  let win;
  const what = { type: 'edit', x: 72, y: 12, w: 180, h: 21, value: np.find.what || np.selected.split('\n')[0], caret: 0, focus: true };
  what.caret = what.value.length; what.all = true;
  const mc = { type: 'check', x: 8, y: 62, label: 'Match &case', checked: np.find.matchCase };
  const up = { type: 'radio', group: 'dir', x: 172, y: 58, label: '&Up', checked: !np.find.down }, dn = { type: 'radio', group: 'dir', x: 212, y: 58, label: '&Down', checked: np.find.down };
  win = dialog('Find', 340, 92, [
    { type: 'label', text: 'Fi&nd what:', amp: true, x: 8, y: 16 }, what,
    { type: 'group', x: 164, y: 42, w: 92, h: 40, label: 'Direction' }, up, dn, mc,
    { type: 'button', x: 262, y: 10, w: 72, h: 23, label: '&Find Next', def: true, fn: () => { Object.assign(np.find, { what: what.value, matchCase: mc.checked, down: dn.checked }); if (what.value) np.findNext(); } },
    { type: 'button', x: 262, y: 38, w: 72, h: 23, label: 'Cancel', cancel: true, fn: () => closeWin(win) },
  ], { modal: false, noTask: true });
  win.np = np;
  return win;
}
// with no printer installed, as on a fresh Windows 95, Page Setup and Print offer to install one
function noPrinter(title) {
  msgBox(title, 'Before you can perform printer-related tasks such as page setup or printing a document, you need to install a printer. Do you want to install a printer now?', 'question', ['&Yes', '&No'], b => { if (b === '&Yes') openFolder(Printers); });
}
function notepad(path) {
  const np = new Notepad();
  if (path && !np.load(path)) return null;
  const p = nextPos(440, 300);
  let w;
  const open = () => np.confirm(() => fileDialog({ title: 'Open', dir: np.path ? dirname(np.path) : 'C:\\My Documents', onOk: f => np.load(f) }));
  const hasSel = () => np.c !== np.a;
  w = new Win({
    ...p, w: 440, h: 300, title: np.title, icon: 'notepad', minW: 160, minH: 100, body: np,
    menu: [
      { label: '&File', items: () => [
        { label: '&New', fn: () => np.confirm(() => { np.setText(''); np.path = null; }) },
        { label: '&Open...', fn: open }, { label: '&Save', fn: () => np.save() }, { label: 'Save &As...', fn: () => np.saveAs() },
        { sep: true }, { label: 'Page Se&tup...', fn: () => noPrinter('Page Setup') }, { label: '&Print', fn: () => noPrinter('Notepad') }, { sep: true }, { label: 'E&xit', fn: () => closeWin(w) }] },
      { label: '&Edit', items: () => [
        { label: '&Undo', acc: 'Ctrl+Z', disabled: !np.undo, fn: () => np.undoLast() }, { sep: true },
        { label: 'Cu&t', acc: 'Ctrl+X', disabled: !hasSel(), fn: () => np.cut() }, { label: '&Copy', acc: 'Ctrl+C', disabled: !hasSel(), fn: () => np.copy() },
        { label: '&Paste', acc: 'Ctrl+V', disabled: !textClip, fn: () => np.paste() }, { label: 'De&lete', acc: 'Del', disabled: !hasSel(), fn: () => np.del() }, { sep: true },
        { label: 'Select &All', fn: () => np.selectAll() },
        { label: 'Time/&Date', acc: 'F5', fn: () => np.insert(timeDate()) }, { sep: true },
        { label: '&Word Wrap', check: np.wrap, fn: () => { np.wrap = !np.wrap; np.vl = null; np.left = 0; np.show(); } }] },
      { label: '&Search', items: () => [{ label: '&Find...', fn: () => findDialog(np) }, { label: 'Find &Next', acc: 'F3', fn: () => np.findNext() }] },
      { label: '&Help', items: [{ label: '&Help Topics', disabled: !hasHelp(), fn: () => winHelp('notepad.hlp') }, { sep: true }, { label: '&About Notepad', fn: () => msgBox('About Notepad', 'Microsoft Notepad\nWindows 95', 'info') }] },
    ],
  });
  return openWin(w);
}

// ---------------------------------------------------------------- dialogs
class DialogBody {
  constructor(ctrls, o = {}) {
    this.c = ctrls; this.o = o; this.page = 0;
    this.focus = ctrls.findIndex(c => c.focus);
    if (this.focus < 0) this.focus = ctrls.findIndex(c => c.def);
  }
  abs(c) { return { x: this.r.x + c.x, y: this.r.y + c.y, w: c.w || 0, h: c.h || 0 }; }
  vis(c) { return (c.page === undefined || c.page === this.page) && c.hidden !== true; }
  hitRect(c) {
    const a = this.abs(c);
    if (c.type === 'radio' || c.type === 'check') return { ...a, w: 19 + textW(c.label), h: 14 };
    return a;
  }
  draw(r, win) {
    this.r = r;
    const focusBtn = this.c[this.focus] && this.c[this.focus].type === 'button';
    this.c.forEach((c, i) => {
      if (!this.vis(c)) return;
      const a = this.abs(c), foc = i === this.focus && win.isActive;
      if (c.type === 'label') {
        if (c.ell) text(ellipsis(c.amp ? c.text : esc(c.text), c.w), a.x, a.y);
        else wrap(c.amp ? c.text : esc(c.text), c.w || 9999).forEach((l, j) => text(l, a.x, a.y + j * 13));
      } else if (c.type === 'icon') icon(c.name, a.x, a.y);
      else if (c.type === 'line') { fill(a.x, a.y, c.w, 1, K.sh); fill(a.x, a.y + 1, c.w, 1, K.hl); }
      else if (c.type === 'tabs') {
        const py = a.y + 19;
        fill(a.x, py, a.w, a.h - 19, K.face); edge(a.x, py, a.w, a.h - 19, K.hl, K.dk); edge(a.x + 1, py + 1, a.w - 2, a.h - 21, K.lt, K.sh);
        let tx = a.x + 2; c.hdr = [];
        c.tabs.forEach((t, k) => { const tw = textW(t) + 12; c.hdr.push({ x: tx, y: a.y, w: tw, h: 20 }); tx += tw; });
        const tab = (h, sel) => {
          const x = sel ? h.x - 2 : h.x, y = sel ? a.y : a.y + 2, w = sel ? h.w + 4 : h.w, hh = sel ? 21 : 18;
          fill(x, y + 2, w, hh - 2, K.face);
          fill(x, y + 2, 1, hh - 2, K.hl); fill(x + 1, y + 1, 1, 1, K.hl); fill(x + 2, y, w - 4, 1, K.hl);
          fill(x + w - 2, y + 1, 1, 1, K.dk); fill(x + w - 1, y + 2, 1, hh - 2, K.dk); fill(x + w - 2, y + 2, 1, hh - 2, K.sh);
        };
        c.hdr.forEach((h, k) => { if (k !== this.page) { tab(h, false); text(c.tabs[k], h.x + 6, a.y + 5); } });
        const h = c.hdr[this.page]; tab(h, true); text(c.tabs[this.page], h.x + 6, a.y + 3);
        if (win.isActive && this.focus === i) focusRect(h.x + 3, a.y + 3, h.w - 6, 15);
      } else if (c.type === 'group') {
        edge(a.x, a.y + 6, a.w, a.h - 6, K.sh, K.hl); edge(a.x + 1, a.y + 7, a.w - 2, a.h - 8, K.hl, K.sh);
        fill(a.x + 1, a.y + 7, 1, a.h - 9, K.hl); fill(a.x + 1, a.y + 7, a.w - 3, 1, K.hl);
        if (c.label) { const tw = textW(c.label); fill(a.x + 7, a.y, tw + 4, 13, K.face); if (c.disabled) textEmboss(c.label, a.x + 9, a.y); else text(c.label, a.x + 9, a.y); }
      } else if (c.type === 'button') {
        pushButton(a.x, a.y, a.w, a.h, c.label, { def: c.def && !focusBtn || (foc && c.type === 'button'), pressed: c.pressed, focus: foc, disabled: c.disabled });
      } else if (c.type === 'radio') {
        radio(a.x, a.y + 1, c.checked); text(c.label, a.x + 18, a.y);
        if (foc) focusRect(a.x + 16, a.y - 1, textW(c.label) + 4, 15);
      } else if (c.type === 'check') {
        fill(a.x, a.y, 13, 13, c.disabled ? K.face : K.win); edge(a.x, a.y, 13, 13, K.sh, K.hl); edge(a.x + 1, a.y + 1, 11, 11, K.dk, K.lt);
        if (c.checked) mglyph('check', a.x + 3, a.y + 3, c.disabled ? K.sh : K.dk);
        if (c.disabled) textEmboss(c.label, a.x + 19, a.y); else text(c.label, a.x + 19, a.y);
        if (foc) focusRect(a.x + 17, a.y - 1, textW(c.label) + 4, 15);
      } else if (c.type === 'edit') {
        field(a.x, a.y, a.w, a.h, c.readonly && !c.combo ? K.face : K.win);
        const ty = a.y + ((a.h - 13) >> 1), tx = a.x + 3 + (c.iconName ? 19 : 0);
        if (c.iconName) icon(c.iconName + '16', a.x + 3, a.y + ((a.h - 16) >> 1));
        ctx.save(); ctx.beginPath(); ctx.rect(a.x + 2, a.y + 2, a.w - 4 - (c.combo ? 16 : 0), a.h - 4); ctx.clip();
        // a field whose whole text is selected (as when the focus arrives by Tab or a dialog opens on it) shows it highlighted
        if (c.all && foc && c.value) { fill(tx - 1, ty, textW(esc(c.value)) + 2, 13, K.sel); text(esc(c.value), tx, ty, K.hl); }
        else text(esc(c.value), tx, ty);
        if (foc && !c.readonly && blinkOn && !(c.all && c.value)) fill(tx + textW(esc(c.value.slice(0, c.caret))), ty, 1, 13, K.dk);
        ctx.restore();
        if (c.combo) { const bx = a.x + a.w - 2 - 16; btnUp(bx, a.y + 2, 16, a.h - 4); mglyph('down', bx + 4, a.y + 2 + ((a.h - 8) >> 1)); }
      } else if (c.type === 'custom') c.draw(a, foc, win);
    });
  }
  ctrlAt(x, y) { return this.c.findIndex(c => this.vis(c) && !['label', 'icon', 'line', 'tabs', 'group'].includes(c.type) && inR(this.hitRect(c), x, y)); }
  down(x, y, btn, dbl) {
    for (const [ti, c] of this.c.entries()) {
      if (c.type !== 'tabs' || !c.hdr) continue;
      const k = c.hdr.findIndex(h => inR(h, x, y));
      if (k >= 0) { this.page = k; this.focus = ti; if (c.onChange) c.onChange(k); return null; }
    }
    const i = this.ctrlAt(x, y); if (i < 0) return null;
    const c = this.c[i]; if (c.disabled) return null;
    this.focus = i;
    if (c.type === 'radio') { this.pick(c); if (c.onChange) c.onChange(); return null; }
    if (c.type === 'check') { c.checked = !c.checked; if (c.onChange) c.onChange(); return null; }
    if (c.type === 'custom') return c.down ? c.down(x, y, btn, dbl, this.abs(c)) || null : null;
    if (c.type === 'edit') {
      if (c.onDrop && (c.readonly || x >= this.abs(c).x + c.w - 18)) { c.onDrop(this.abs(c)); return null; }
      const a = this.abs(c), tx = a.x + 3 + (c.iconName ? 19 : 0);
      let k = 0; while (k < c.value.length && tx + textW(esc(c.value.slice(0, k + 1))) <= x) k++;
      c.caret = k; c.all = false; blinkOn = true; return null;
    }
    if (c.type === 'button') {
      c.pressed = true;
      return { move: (mx, my) => { c.pressed = inR(this.abs(c), mx, my); }, up: (mx, my) => { const hit = inR(this.abs(c), mx, my); c.pressed = false; if (hit) this.press(c); } };
    }
    return null;
  }
  cursor(x, y) { const i = this.ctrlAt(x, y); return i >= 0 && this.c[i].type === 'edit' && !this.c[i].readonly ? 'ibeam' : null; }
  pick(c) { this.c.forEach(o => { if (o.type === 'radio' && o.group === c.group) o.checked = o === c; }); }
  press(c) { if (c.fn) c.fn(); else emit('button.noop', { label: amp(c.label || '')[0] }); }
  // the control whose label underlines this letter: a button is pressed, a check box or option button is clicked,
  // a label or group box sends the focus to the next control that takes it (an edit with its text selected)
  mnemonic(ch) {
    ch = ch.toLowerCase();
    const takes = o => this.vis(o) && !o.disabled && ['button', 'edit', 'check', 'radio', 'custom'].includes(o.type) && (o.type !== 'custom' || o.key);
    for (const [i, o] of this.c.entries()) {
      if (!this.vis(o) || o.disabled) continue;
      const t = o.type === 'label' ? (o.amp ? o.text : null) : ['button', 'check', 'radio', 'group'].includes(o.type) ? o.label : null;
      if (!t) continue;
      const [str, u] = amp(t);
      if (u < 0 || str[u].toLowerCase() !== ch) continue;
      if (o.type === 'button') { this.focus = i; this.press(o); return true; }
      if (o.type === 'check') { this.focus = i; o.checked = !o.checked; if (o.onChange) o.onChange(); return true; }
      if (o.type === 'radio') { this.focus = i; this.pick(o); if (o.onChange) o.onChange(); return true; }
      const j = this.c.findIndex((n, k) => k > i && takes(n));
      if (j < 0) return false;
      const n = this.c[j];
      this.focus = j;
      if (n.type === 'edit') n.caret = n.value.length;
      return true;
    }
    return false;
  }
  key(e) {
    const c = this.c[this.focus];
    // Ctrl+Tab and Ctrl+Shift+Tab (or Ctrl+PageDown/PageUp) turn a property sheet's pages
    const sheet = e.ctrlKey && (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp') && this.c.find(o => o.type === 'tabs');
    if (sheet) {
      const back = e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey), n = sheet.tabs.length;
      this.page = (this.page + (back ? n - 1 : 1)) % n; if (sheet.onChange) sheet.onChange(this.page); return true;
    }
    if (e.key === 'Tab') {
      const f = this.c.map((o, i) => i).filter(i => {
        const o = this.c[i];
        return this.vis(o) && !o.disabled && (['button', 'edit', 'check', 'tabs'].includes(o.type) || (o.type === 'radio' && o.checked) || (o.type === 'custom' && o.key));
      });
      if (!f.length) return true;
      const k = f.indexOf(this.focus); this.focus = f[(k + (e.shiftKey ? f.length - 1 : 1)) % f.length];
      const n = this.c[this.focus]; if (n && n.type === 'edit' && !n.readonly) { n.all = true; n.caret = n.value.length; }
      return true;
    }
    if (c && c.type === 'custom' && c.key && c.key(e)) return true;
    // mnemonics: Alt+letter anywhere, the letter alone unless the focus is in a field that takes typing
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && (e.altKey || !(c && c.type === 'edit' && !c.readonly)) && this.mnemonic(e.key)) return true;
    if (e.key === 'Enter') { const b = c && c.type === 'button' ? c : this.c.find(o => o.def); if (b) this.press(b); return true; }
    if (e.key === 'Escape') { const b = this.c.find(o => o.cancel); if (b && b.fn) b.fn(); return true; }
    if (e.key === ' ' && c && c.type === 'button') { this.press(c); return true; }
    if (e.key === ' ' && c && c.type === 'check') { c.checked = !c.checked; return true; }
    if (c && c.type === 'radio' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const g = this.c.filter(o => o.type === 'radio' && o.group === c.group);
      const n = g[(g.indexOf(c) + (e.key === 'ArrowDown' ? 1 : g.length - 1)) % g.length];
      this.pick(n); this.focus = this.c.indexOf(n); return true;
    }
    if (c && c.type === 'edit' && !c.readonly && !e.ctrlKey && !e.metaKey) {
      if (c.all) {   // typing or deleting replaces the selected text; a movement key drops the selection
        c.all = false;
        if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') { c.value = ''; c.caret = 0; if (e.key.length !== 1) { if (c.onChange) c.onChange(); return true; } }
      }
      const v = c.value;
      if (e.key.length === 1) { c.value = v.slice(0, c.caret) + e.key + v.slice(c.caret); c.caret++; }
      else if (e.key === 'Backspace') { if (c.caret > 0) { c.value = v.slice(0, c.caret - 1) + v.slice(c.caret); c.caret--; } }
      else if (e.key === 'Delete') c.value = v.slice(0, c.caret) + v.slice(c.caret + 1);
      else if (e.key === 'ArrowLeft') c.caret = Math.max(0, c.caret - 1);
      else if (e.key === 'ArrowRight') c.caret = Math.min(v.length, c.caret + 1);
      else if (e.key === 'Home') c.caret = 0;
      else if (e.key === 'End') c.caret = v.length;
      else return false;
      if (c.onChange && c.value !== v) c.onChange();
      blinkOn = true; return true;
    }
    if (c && c.type === 'tabs' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      this.page = (this.page + (e.key === 'ArrowRight' ? 1 : c.tabs.length - 1)) % c.tabs.length; if (c.onChange) c.onChange(this.page); return true;
    }
    return false;
  }
}
function dialog(title, cw, ch, ctrls, o = {}) {
  const w = cw + 6, h = ch + 3 + 19 + 3, p = centered(w, h);
  const win = new Win({ ...p, w, h, title, resizable: false, minimizable: false, maximizable: false, body: new DialogBody(ctrls, o), noTask: o.noTask !== false, dim: !!o.dim, icon: o.icon || null });
  if (o.modal !== false) modals.push(win);
  return openWin(win);
}
function msgBox(title, msg, type, buttons = ['OK'], cb, o = {}) {
  const lines = wrap(esc(msg), Math.min(420, Math.floor(W * 0.6))), tw = Math.max(...lines.map(l => textW(l))), th = lines.length * 13;
  const tx = type ? 12 + 32 + 16 : 12, bw = buttons.length * 75 + (buttons.length - 1) * 6;
  const cw = Math.max(tx + tw + 14, bw + 24, 120);
  const by = 12 + Math.max(type ? 32 : 0, th) + 16, ch = by + 23 + 11;
  let win;
  const done = b => { closeWin(win); if (cb) cb(b); };
  const ctrls = [];
  if (type) ctrls.push({ type: 'icon', name: type, x: 12, y: 12 });
  ctrls.push({ type: 'label', text: lines.join('\n'), amp: true, x: tx, y: 12 + Math.max(0, ((type ? 32 : 0) - th) >> 1) });
  buttons.forEach((b, i) => ctrls.push({ type: 'button', label: b, x: ((cw - bw) >> 1) + i * 81, y: by, w: 75, h: 23, def: i === 0, cancel: buttons.length === 1 || i === buttons.length - 1, fn: () => done(b) }));
  win = dialog(title, cw, ch, ctrls, o);
  win.message = { type: type || null, text: msg };
  return win;
}
function aboutWin95() { msgBox('About Windows 95', 'Microsoft Windows 95\n4.00.950 B\nCopyright \u00a9 1981-1996 Microsoft Corp.', 'info'); }

// Win95-style common Open / Save As dialog over the in-memory file system.
function fileDialog(o) {
  let dir = 'C:\\'; try { dir = fs.realpath(o.dir); } catch (_) { /* fall back to C:\ */ }
  const filters = [{ label: 'Text Documents (*.txt)', pat: '*.txt' }, { label: 'All Files (*.*)', pat: '*.*' }];
  let fi = 0, sel = -1, entries = [], win;
  const sb = new ScrollBar(true, () => dirty());
  const edit = { type: 'edit', x: 92, y: 196, w: 214, h: 21, value: o.name || '', caret: (o.name || '').length, focus: true };
  const look = { type: 'edit', x: 66, y: 8, w: 228, h: 22, value: '', combo: true, readonly: true, onDrop: a => lookMenu(a) };
  const typ = { type: 'edit', x: 92, y: 224, w: 214, h: 21, value: filters[0].label, combo: true, readonly: true,
    onDrop: a => openPopup(filters.map((f, i) => ({ label: esc(f.label), fn: () => { fi = i; typ.value = f.label; refresh(); } })), a.x, a.y + a.h) };
  const refresh = () => {
    try {
      const all = fs.readdir(dir).filter(i => !i.hidden);
      const pat = filters[fi].pat, files = fs.readdir(dir, pat).filter(i => !i.isDir && !i.hidden);
      entries = all.filter(i => i.isDir).concat(files).sort(byName);
    } catch (_) { entries = []; }
    look.value = isRoot(dir) ? driveLabel(dir[0]) : dispName(basename(dir), true);
    look.iconName = isRoot(dir) ? driveIcon(dir[0]) : 'folderopen';
    sel = -1; sb.pos = 0;
  };
  const go = d => { try { fs.readdir(d); dir = fs.realpath(d); refresh(); } catch (e) { msgBox(o.title, fsMsg(d, e), 'error'); } };
  const lookMenu = a => {
    const items = [];
    for (const v of fs.volumes()) {
      items.push({ label: esc(driveLabel(v.letter)), icon: driveIcon(v.letter), fn: () => go(v.root) });
      if (dir[0] === v.letter) {
        const parts = dir.slice(3).split('\\').filter(Boolean);
        parts.forEach((p, i) => items.push({ label: esc(' '.repeat(2 * (i + 1)) + dispName(p, true)), icon: 'folder', fn: () => go(v.root + parts.slice(0, i + 1).join('\\')) }));
      }
    }
    openPopup(items, a.x, a.y + a.h);
  };
  const finish = p => { closeWin(win); o.onOk(p); };
  const ok = () => {
    const v = edit.value.trim(); if (!v) return;
    if (/[*?]/.test(v)) { filters.push({ label: v, pat: v }); fi = filters.length - 1; typ.value = v; refresh(); return; }
    let p = /^[a-z]:|^\\/i.test(v) ? v : join(dir, v);
    try { if (fs.exists(p) && fs.stat(p).isDir) { go(p); edit.value = ''; edit.caret = 0; return; } }
    catch (e) { return msgBox(o.title, `${p}\n${e.message}`, 'warning'); }
    if (!extname(p) && fi === 0 && (o.save || !fs.exists(p))) p += '.txt';
    if (!o.save) {
      if (!fs.exists(p)) return msgBox(o.title, `${p}\nFile not found.\nPlease verify the correct file name was given.`, 'warning');
      return finish(fs.realpath(p));
    }
    if (!fs.exists(dirname(p))) return msgBox(o.title, `${p}\nPath does not exist.\nPlease verify the correct path was given.`, 'warning');
    if (fs.exists(p)) return msgBox(o.title, `${p} already exists.\nDo you want to replace it?`, 'warning', ['&Yes', '&No'], b => b === '&Yes' && finish(p));
    finish(p);
  };
  const pickEntry = e => { if (e.isDir) go(e.path); else finish(e.path); };
  const list = {
    type: 'custom', x: 8, y: 38, w: 380, h: 148,
    draw(a, foc, w) {
      field(a.x, a.y, a.w, a.h);
      const inner = { x: a.x + 2, y: a.y + 2, w: a.w - 20, h: a.h - 4 }, rows = Math.floor(inner.h / 17);
      sb.set(inner.x + inner.w, inner.y, inner.h, entries.length, rows);
      ctx.save(); ctx.beginPath(); ctx.rect(inner.x, inner.y, inner.w, inner.h); ctx.clip();
      for (let i = sb.pos; i < Math.min(entries.length, sb.pos + rows + 1); i++) {
        const e = entries[i], y = inner.y + (i - sb.pos) * 17 + 1, label = esc(dispName(e.name, e.isDir)), tw = textW(label);
        icon(iconFor(e) + '16', inner.x + 2, y, i === sel && w.isActive);
        if (i === sel) fill(inner.x + 20, y + 1, tw + 4, 14, w.isActive ? K.sel : K.face);
        text(label, inner.x + 22, y + 2, i === sel && w.isActive ? K.hl : K.dk);
        if (i === sel && foc) focusRect(inner.x + 20, y + 1, tw + 4, 14);
      }
      ctx.restore(); sb.draw();
      this.inner = inner;
    },
    down(x, y, btn, dbl) {
      if (sb.contains(x, y)) return sb.down(x, y);
      const i = sb.pos + Math.floor((y - this.inner.y) / 17);
      if (i < 0 || i >= entries.length) { sel = -1; return null; }
      sel = i; const e = entries[i];
      if (!e.isDir) { edit.value = e.name; edit.caret = e.name.length; }
      if (dbl) pickEntry(e);
      return null;
    },
    key(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        sel = clamp(sel + (e.key === 'ArrowDown' ? 1 : -1), 0, entries.length - 1);
        const en = entries[sel]; if (en && !en.isDir) { edit.value = en.name; edit.caret = en.name.length; }
        const rows = Math.floor(this.inner.h / 17);
        if (sel < sb.pos) sb.pos = sel; else if (sel >= sb.pos + rows) sb.pos = sel - rows + 1;
        return true;
      }
      if (e.key === 'Enter' && entries[sel]) { pickEntry(entries[sel]); return true; }
      if (e.key === 'Backspace') { if (!isRoot(dir)) go(dirname(dir)); return true; }
      return false;
    },
  };
  const up = {
    type: 'custom', x: 300, y: 8, w: 24, h: 22, pressed: false,
    draw(a) { if (this.pressed) btnDown(a.x, a.y, a.w, a.h); else btnUp(a.x, a.y, a.w, a.h); const o2 = this.pressed ? 1 : 0; icon('folder16', a.x + 5 + o2, a.y + 4 + o2); mglyph('up', a.x + 9 + o2, a.y + 3 + o2, K.dk); },
    down() { this.pressed = true; return { move() {}, up: () => { this.pressed = false; if (!isRoot(dir)) go(dirname(dir)); } }; },
  };
  refresh();
  win = dialog(o.title, 396, 254, [
    { type: 'label', text: 'Look &in:', amp: true, x: 8, y: 13 }, look, up, list,
    { type: 'label', text: 'File &name:', amp: true, x: 8, y: 200 }, edit,
    { type: 'button', label: o.save ? '&Save' : '&Open', x: 313, y: 195, w: 75, h: 23, def: true, fn: ok },
    { type: 'label', text: 'Files of &type:', amp: true, x: 8, y: 228 }, typ,
    { type: 'button', label: 'Cancel', x: 313, y: 223, w: 75, h: 23, cancel: true, fn: () => closeWin(win) },
  ]);
  return win;
}

function runDialog() {
  const existing = windows.find(w => w.title === 'Run'); if (existing) return activate(existing);
  let win;
  const edit = { type: 'edit', x: 54, y: 52, w: 276, h: 21, value: '', caret: 0, combo: true, focus: true };
  const go = () => { const v = edit.value.trim(); closeWin(win); runCommand(v); };
  win = dialog('Run', 342, 116, [
    { type: 'icon', name: 'run32', x: 12, y: 12 },
    { type: 'label', text: 'Type the name of a program, folder, or document, and Windows will open it for you.', x: 54, y: 14, w: 276 },
    { type: 'label', text: '&Open:', amp: true, x: 12, y: 56 },
    edit,
    { type: 'button', label: 'OK', x: 99, y: 84, w: 75, h: 23, def: true, fn: go },
    { type: 'button', label: 'Cancel', x: 177, y: 84, w: 75, h: 23, cancel: true, fn: () => closeWin(win) },
    { type: 'button', label: '&Browse...', x: 255, y: 84, w: 75, h: 23, fn: () => fileDialog({ title: 'Browse', dir: WINDIR, onOk: p => { edit.value = p; edit.caret = p.length; } }) },
  ], { modal: false, noTask: false });
}
function runCommand(v) {
  if (!v) return;
  let cmd = v, arg = '';
  const q = /^"([^"]*)"\s*(.*)$/.exec(v);
  if (q) { cmd = q[1]; arg = q[2]; } else if (!fs.exists(v)) { const m = /^(\S+)\s+(.*)$/.exec(v); if (m) { cmd = m[1]; arg = m[2]; } }
  const bases = /^[a-z]:|^\\/i.test(cmd) ? [cmd] : [join(WINDIR, cmd), join(WINDIR, 'COMMAND', cmd), join(fs.cwd, cmd)];
  const exts = extname(cmd) ? [''] : ['', '.exe', '.com', '.bat'];
  for (const b of bases) for (const e of exts) if (fs.exists(b + e)) return shellOpen(fs.realpath(b + e), arg);
  if (/^[a-z]:\\?$/i.test(cmd)) { try { fs.stat(cmd); } catch (e) { return msgBox(cmd.toUpperCase(), fsMsg(cmd.toUpperCase(), e), 'error'); } }
  msgBox(v, `Cannot find the file '${v}' (or one of its components). Make sure the path and filename are correct and that all required libraries are available.`, 'error');
}

// Find: All Files. Name & Location (a name, with * and ? as wildcards or else any name containing it; where to look,
// My Computer for every drive; whether below it), Date Modified (all, or the last days), Advanced (text the file
// holds). The search walks the folders a slice at a time, so the shell keeps running; results come as they are found
function findFiles(lookIn) {
  closeMenus();
  const open = windows.find(w => w.title === 'Find: All Files'); if (open) return activate(open);
  let win, found = [], sel = -1, status = '', run = 0;
  const sb = new ScrollBar(true, () => dirty());
  const named = { type: 'edit', page: 0, x: 84, y: 40, w: 280, h: 21, value: '', caret: 0, combo: true, focus: true };
  const look = { type: 'edit', page: 0, x: 84, y: 68, w: 280, h: 21, value: lookIn || 'C:\\', caret: 0, combo: true };
  const subs = { type: 'check', page: 0, label: 'Include &subfolders', checked: true, x: 18, y: 96 };
  const allDates = { type: 'radio', page: 1, group: 'd', label: '&All files', checked: true, x: 18, y: 40 };
  const lastDays = { type: 'radio', page: 1, group: 'd', label: 'during the pre&vious', checked: false, x: 18, y: 64 };
  const days = { type: 'edit', page: 1, x: 150, y: 62, w: 40, h: 21, value: '1', caret: 1 };
  const containing = { type: 'edit', page: 2, x: 120, y: 40, w: 244, h: 21, value: '', caret: 0 };
  const nameTest = () => {
    const q = named.value.trim().toUpperCase(); if (!q) return () => true;
    if (!/[*?]/.test(q)) return n => n.toUpperCase().includes(q);
    const re = new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return n => re.test(n.toUpperCase());
  };
  const done = n => { status = `${n} file(s) found`; stop.disabled = true; dirty(); };
  const findNow = async () => {
    const me = ++run, test = nameTest(), text = containing.value.toUpperCase(), since = lastDays.checked ? Date.now() - Math.max(0, parseInt(days.value, 10) || 0) * 86400000 : 0;
    const where = look.value.trim(), roots = /^my computer$/i.test(where) ? fs.volumes().filter(v => v.ready).map(v => v.root) : [where];
    found = []; sel = -1; sb.pos = 0; status = 'Searching...'; stop.disabled = false; dirty();
    const holds = i => { if (!text) return true; if (i.isDir || i.size > 4 << 20) return false; try { return W95FS.decode(fs.readFile(i.path)).toUpperCase().includes(text); } catch (_) { return false; } };
    let n = 0;
    const walk = async dir => {
      let items; try { items = fs.readdir(dir); } catch (_) { return; }
      for (const i of items) {
        if (me !== run) return;
        if ((test(i.name) || (i.shortName && test(i.shortName))) && (!since || i.mtime >= since) && holds(i)) { found.push(i); dirty(); }
        if (++n % 200 === 0) { status = `Searching ${dir}`; await new Promise(r => setTimeout(r, 0)); if (me !== run) return; }
        if (i.isDir && subs.checked && !inBin(i.path)) await walk(i.path);
      }
    };
    for (const r of roots) { if (me !== run) return; try { if (!fs.stat(r).isDir) continue; } catch (e) { status = ''; return msgBox('Find', fsMsg(r, e), 'error'); } await walk(r); }
    if (me === run) done(found.length);
  };
  const stop = { type: 'button', x: 388, y: 38, w: 80, h: 23, label: 'St&op', disabled: true, fn: () => { run++; done(found.length); } };
  const openFound = i => (i.isDir ? openPath(i.path) : shellOpen(i.path));
  const cols = [['Name', 130], ['In Folder', 120], ['Size', 50], ['Type', 80], ['Modified', 0]];
  const list = {
    type: 'custom', x: 0, y: 132, w: 480, h: 150,
    draw(a, foc, w) {
      field(a.x, a.y, a.w, a.h);
      const inner = { x: a.x + 2, y: a.y + 2, w: a.w - 20, h: a.h - 4 }, hdr = 18, rows = Math.floor((inner.h - hdr) / 17);
      let cx = 0; const xs = cols.map(([label, cw]) => { const x0 = cx, ww = cw || inner.w - cx; btnUp(inner.x + x0, inner.y, ww, hdr); text(label, inner.x + x0 + 6, inner.y + 3, K.dk); cx += ww; return x0; });
      sb.set(inner.x + inner.w, inner.y, inner.h, found.length, rows);
      ctx.save(); ctx.beginPath(); ctx.rect(inner.x, inner.y + hdr, inner.w, inner.h - hdr); ctx.clip();
      for (let i = sb.pos; i < Math.min(found.length, sb.pos + rows + 1); i++) {
        const f = found[i], y = inner.y + hdr + (i - sb.pos) * 17 + 1, label = esc(dispName(f.name, f.isDir)), tw = textW(label), on = i === sel && w.isActive;
        icon(iconFor(f) + '16', inner.x + 2, y, on);
        if (i === sel) fill(inner.x + 20, y + 1, Math.min(tw + 4, cols[0][1] - 20), 14, w.isActive ? K.sel : K.face);
        ctx.save(); ctx.beginPath(); ctx.rect(inner.x, y, cols[0][1] - 2, 16); ctx.clip(); text(label, inner.x + 22, y + 2, on ? K.hl : K.dk); ctx.restore();
        if (i === sel && foc) focusRect(inner.x + 20, y + 1, Math.min(tw + 4, cols[0][1] - 20), 14);
        const cell = (k, v) => { ctx.save(); ctx.beginPath(); ctx.rect(inner.x + xs[k], y, (cols[k][1] || inner.w - xs[k]) - 2, 16); ctx.clip(); text(esc(v), inner.x + xs[k] + 6, y + 2, K.dk); ctx.restore(); };
        cell(1, dirname(f.path)); cell(2, f.isDir ? '' : Math.max(1, Math.ceil(f.size / 1024)) + 'KB'); cell(3, typeDesc(f)); cell(4, fmtShort(f.mtime));
      }
      ctx.restore(); sb.draw();
      this.inner = { ...inner, y: inner.y + hdr, h: inner.h - hdr };
    },
    down(x, y, btn, dbl) {
      if (sb.contains(x, y)) return sb.down(x, y);
      const i = sb.pos + Math.floor((y - this.inner.y) / 17);
      sel = i >= 0 && i < found.length && y >= this.inner.y ? i : -1;
      if (dbl && sel >= 0) openFound(found[sel]);
      return null;
    },
    key(e) {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && found.length) { sel = clamp(sel + (e.key === 'ArrowDown' ? 1 : -1), 0, found.length - 1); return true; }
      if (e.key === 'Enter' && found[sel]) { openFound(found[sel]); return true; }
      return false;
    },
  };
  win = dialog('Find: All Files', 480, 302, [
    { type: 'tabs', x: 6, y: 6, w: 370, h: 118, tabs: ['Name && Location', 'Date Modified', 'Advanced'] },
    { type: 'label', page: 0, text: '&Named:', amp: true, x: 18, y: 44 }, named,
    { type: 'label', page: 0, text: '&Look in:', amp: true, x: 18, y: 72 }, look, subs,
    { type: 'button', page: 0, x: 284, y: 94, w: 80, h: 23, label: '&Browse...', fn: () => browseFolder({ title: 'Select the folder to search in:', done: p => { if (p) { look.value = p; look.caret = p.length; } } }) },
    allDates, lastDays, days, { type: 'label', page: 1, text: 'day(s)', x: 196, y: 66 },
    { type: 'label', page: 2, text: '&Containing text:', amp: true, x: 18, y: 44 }, containing,
    { type: 'button', x: 388, y: 10, w: 80, h: 23, label: 'F&ind Now', def: true, fn: findNow }, stop,
    { type: 'button', x: 388, y: 66, w: 80, h: 23, label: 'Ne&w Search', fn: () => { run++; found = []; sel = -1; status = ''; named.value = ''; named.caret = 0; containing.value = ''; stop.disabled = true; } },
    list,
    { type: 'custom', x: 0, y: 284, w: 480, h: 18, draw: a => { btnDown(a.x, a.y, a.w, a.h); ctx.save(); ctx.beginPath(); ctx.rect(a.x, a.y, a.w, a.h); ctx.clip(); text(esc(status), a.x + 4, a.y + 3, K.dk); ctx.restore(); } },
  ], { modal: false, noTask: false, icon: 'findfiles' });
  return win;
}
// Find: Computer. The computers the network's browse lists name (each workgroup's, through MPR's enumeration) whose
// names match: a pattern with * or ? as a wildcard, else any name containing what was typed
function findComputer() {
  closeMenus();
  const open = windows.find(w => w.title === 'Find: Computer'); if (open) return activate(open);
  let win, found = [], sel = -1, status = '', run = 0;
  const sb = new ScrollBar(true, () => dirty());
  const edit = { type: 'edit', page: 0, x: 74, y: 40, w: 220, h: 21, value: '', caret: 0, combo: true, focus: true };
  const match = name => {
    const q = edit.value.trim().replace(/^\\+/, '').toUpperCase(); if (!q) return true;
    if (!/[*?]/.test(q)) return name.toUpperCase().includes(q);
    return new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(name.toUpperCase());
  };
  const findNow = async () => {
    const me = ++run; found = []; sel = -1; status = 'Searching...'; stop.disabled = false; dirty();
    const groups = (await netEnum(2, EntireNetwork.res)).filter(r => r.disp === 1);
    for (const g of groups) {
      if (me !== run) return;
      for (const r of await netEnum(2, g)) {
        if (me !== run) return;
        const name = r.remote.replace(/^\\+/, '');
        if (r.disp === 2 && match(name) && !found.some(f => f.remote.toUpperCase() === r.remote.toUpperCase())) { found.push({ ...r, location: netCap(g.remote) }); dirty(); }
      }
    }
    status = `${found.length} computer(s) found`; stop.disabled = true; dirty();
  };
  const stop = { type: 'button', x: 318, y: 38, w: 80, h: 23, label: 'St&op', disabled: true, fn: () => { run++; status = `${found.length} computer(s) found`; stop.disabled = true; } };
  const openFound = r => netItem(r).open();
  const list = {
    type: 'custom', x: 0, y: 112, w: 410, h: 150,
    draw(a, foc, w) {
      field(a.x, a.y, a.w, a.h);
      const inner = { x: a.x + 2, y: a.y + 2, w: a.w - 20, h: a.h - 4 }, hdr = 18, rows = Math.floor((inner.h - hdr) / 17), cols = [[0, 'Name', 130], [130, 'In Folder', 120], [250, 'Comment', inner.w - 250]];
      for (const [cx, label, cw] of cols) { btnUp(inner.x + cx, inner.y, cw, hdr); text(label, inner.x + cx + 6, inner.y + 3, K.dk); }
      sb.set(inner.x + inner.w, inner.y, inner.h, found.length, rows);
      ctx.save(); ctx.beginPath(); ctx.rect(inner.x, inner.y + hdr, inner.w, inner.h - hdr); ctx.clip();
      for (let i = sb.pos; i < Math.min(found.length, sb.pos + rows + 1); i++) {
        const r = found[i], y = inner.y + hdr + (i - sb.pos) * 17 + 1, label = esc(netName(r)), tw = textW(label), on = i === sel && w.isActive;
        icon('netserver16', inner.x + 2, y, on);
        if (i === sel) fill(inner.x + 20, y + 1, tw + 4, 14, w.isActive ? K.sel : K.face);
        text(label, inner.x + 22, y + 2, on ? K.hl : K.dk);
        if (i === sel && foc) focusRect(inner.x + 20, y + 1, tw + 4, 14);
        text(esc(r.location), inner.x + 136, y + 2, K.dk); text(esc(r.comment || ''), inner.x + 256, y + 2, K.dk);
      }
      ctx.restore(); sb.draw();
      this.inner = { ...inner, y: inner.y + hdr, h: inner.h - hdr };
    },
    down(x, y, btn, dbl) {
      if (sb.contains(x, y)) return sb.down(x, y);
      const i = sb.pos + Math.floor((y - this.inner.y) / 17);
      sel = i >= 0 && i < found.length && y >= this.inner.y ? i : -1;
      if (dbl && sel >= 0) openFound(found[sel]);
      return null;
    },
    key(e) {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && found.length) { sel = clamp(sel + (e.key === 'ArrowDown' ? 1 : -1), 0, found.length - 1); return true; }
      if (e.key === 'Enter' && found[sel]) { openFound(found[sel]); return true; }
      return false;
    },
  };
  win = dialog('Find: Computer', 410, 282, [
    { type: 'tabs', x: 6, y: 6, w: 300, h: 98, tabs: ['Computer Name'] },
    { type: 'label', page: 0, text: '&Named:', amp: true, x: 18, y: 44 }, edit,
    { type: 'button', x: 318, y: 10, w: 80, h: 23, label: 'F&ind Now', def: true, fn: findNow }, stop,
    { type: 'button', x: 318, y: 66, w: 80, h: 23, label: 'Ne&w Search', fn: () => { run++; found = []; sel = -1; status = ''; edit.value = ''; edit.caret = 0; stop.disabled = true; } },
    list,
    { type: 'custom', x: 0, y: 264, w: 410, h: 18, draw: a => { btnDown(a.x, a.y, a.w, a.h); text(esc(status), a.x + 4, a.y + 3, K.dk); } },
  ], { modal: false, noTask: false, icon: 'findcomp' });
  return win;
}

function shutDownDialog() {
  closeMenus();
  if (windows.some(w => w.title === 'Shut Down Windows')) return;
  let win;
  const opts = ['&Shut down the computer?', '&Restart the computer?', 'Restart the computer in &MS-DOS mode?', '&Close all programs and log on as a different user?'];
  const radios = opts.map((l, i) => ({ type: 'radio', group: 's', label: l, checked: i === 0, focus: i === 0, x: 60, y: 36 + i * 19 }));
  const cw = Math.max(...opts.map(o => 60 + 18 + textW(o))) + 16;
  const yes = () => {
    const pick = radios.findIndex(r => r.checked);
    closeWin(win);
    if (pick === 3) { [...windows].forEach(w => closeWin(w, true)); return; }
    shutdownSeq(pick !== 0);
  };
  const bx = (cw - (3 * 75 + 12)) >> 1;
  win = dialog('Shut Down Windows', cw, 150, [
    { type: 'icon', name: 'shutdown32', x: 14, y: 12 },
    { type: 'label', text: 'Are you sure you want to:', x: 60, y: 14 },
    ...radios,
    { type: 'button', label: '&Yes', x: bx, y: 118, w: 75, h: 23, def: true, fn: yes },
    { type: 'button', label: '&No', x: bx + 81, y: 118, w: 75, h: 23, cancel: true, fn: () => closeWin(win) },
    { type: 'button', label: '&Help', x: bx + 162, y: 118, w: 75, h: 23, disabled: !hasHelp(), fn: () => winHelp() },
  ], { dim: true });
}
function shutdownSeq(restart) {
  [...windows].forEach(w => closeWin(w, true)); closeMenus();
  shutDownCleanly();
  // the machines stop as Windows does (the system's, the network's, the programs'): a restart boots them afresh
  for (const a of new Set([...nativeApps, sysApp, netApp])) if (a && a.alive) a.exited(0);
  if (restart) { rebooted = true; try { localStorage.setItem(SHUTDOWN, 'running'); } catch (_) { /* no storage */ } }   // (Windows runs again)
  screen = 'logow'; dirty();
  setTimeout(() => {
    if (restart) { screen = 'black'; dirty(); setTimeout(boot, 1200); } else { screen = 'logos'; dirty(); }
  }, 2600);
}
/** Windows itself shut down (Explorer's Shut Down: USER's ExitWindows ending in KERNEL's ExitKernel): a clean
 *  shutdown, the next start's SystemStart heard; a restart (EW_RESTARTWINDOWS, EW_REBOOTSYSTEM) starts it again */
function systemEnded(code) { shutdownSeq(code === 0x42 || code === 0x43); }
// The disk lives in memory, so it survives a restart but not a page reload.
function boot() { screen = 'desktop'; ren = null; desk.selKey = null; active = null; dirty(); systemBootLater(); netBootLater(); }

// ---------------------------------------------------------------- desktop
const SYS_ITEMS = () => [
  { key: 'sys:mc', label: 'My Computer', icon: 'mycomputer', virt: true, open: () => openFolder(MyComputer) },
  { key: 'sys:net', label: 'Network Neighborhood', icon: 'network', virt: true, open: () => { Network.refresh(); openFolder(Network); } },
  { key: 'sys:bin', label: 'Recycle Bin', icon: binItems().length ? 'recyclefull' : 'recycle', virt: true, open: () => openFolder(RecycleBin) },
];
const desk = {
  selKey: null, pos: new Map(), posVer: 0, cells: [], cache: null, lay: null, pending: null, src: null,
  refresh() { this.cache = null; },
  arrange() { this.pos.clear(); this.posVer++; },
  lineUp() { for (const p of this.pos.values()) { p.x = Math.max(0, Math.round((p.x - 21) / 75)) * 75 + 21; p.y = Math.max(0, Math.round((p.y - 6) / 75)) * 75 + 6; } this.posVer++; },
  navStep(k) { return { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[k] || 0; },
  created(path) { if (path) { this.pending = fs.inoOf(path); } },
  items() {
    if (!this.cache || this.cache.v !== fs.version) {
      let files = []; try { files = this.src.list(); } catch (_) { files = []; }
      this.cache = { v: fs.version, list: [...SYS_ITEMS(), ...files] };
    }
    return this.cache.list;
  },
  layout() {
    const items = this.items(), key = `${this.cache.v}:${W}x${H}:${this.posVer}`;
    if (this.lay === key) return;
    const keys = new Set(items.map(i => i.key));
    for (const k of [...this.pos.keys()]) if (!keys.has(k)) this.pos.delete(k);
    const rows = Math.max(1, Math.floor((workH() - 6) / 75));
    for (const it of items) {
      if (this.pos.has(it.key)) continue;
      const used = [...this.pos.values()];
      for (let i = 0; ; i++) {
        const x = Math.floor(i / rows) * 75 + 21, y = (i % rows) * 75 + 6;
        if (!used.some(p => Math.abs(p.x - x) < 37 && Math.abs(p.y - y) < 37)) { this.pos.set(it.key, { x, y }); break; }
      }
    }
    this.cells = items.map(it => { const p = this.pos.get(it.key); return cellFor(it, p.x, p.y, 72); });
    this.lay = key;
    if (this.pending) {
      const c = this.cells.find(x => x.it.key === this.pending); this.pending = null;
      if (c) { this.selKey = c.it.key; startRename(this, c.it); }
    }
  },
};
function drawDesktop() {
  fill(0, 0, W, H, K.desk);
  desk.layout();
  const focused = active === null && !modal();
  for (const c of desk.cells) {
    if (ghost && ghost.key === c.it.key) continue;
    drawIconLabel(c, desk, focused && c.it.key === desk.selKey, true, K.hl);
  }
  if (ghost) {
    const c = desk.cells.find(x => x.it.key === ghost.key);
    if (c) {
      ctx.save(); ctx.globalAlpha = 0.6;
      drawIconLabel({ ...c, ix: c.ix + ghost.dx, iy: c.iy + ghost.dy, lx: c.lx + ghost.dx, ly: c.ly + ghost.dy }, null, true, true, K.hl);
      ctx.restore();
    }
  }
}
// Dropping a desktop icon on the Recycle Bin deletes it; on a folder or drive, moves it there.
function deskDrop(it, x, y) {
  const t = desk.cells.find(c => c.it.key !== it.key && cellHit(c, x, y));
  if (!t) return false;
  if (t.it.key === 'sys:bin') { confirmDelete(it); return true; }
  if (it.info && t.it.path && (t.it.drive || (t.it.info && t.it.info.isDir))) {
    fsTry('move', it.label, () => moveAny(it.path, join(t.it.path, it.info.name))); return true;
  }
  return false;
}
function deskDown(x, y, btn, dbl) {
  active = null;
  desk.layout();
  const c = desk.cells.find(cc => cellHit(cc, x, y));
  desk.selKey = c ? c.it.key : null;
  if (btn === 2) { openPopup(c ? itemMenu(desk, c.it) : bgMenu(desk, true), x, y); return; }
  if (!c) return;
  if (dbl) { c.it.open(); return; }
  const sx = x, sy = y, key = c.it.key;
  cap = {
    move: (mx, my) => { if (ghost || Math.abs(mx - sx) > 2 || Math.abs(my - sy) > 2) ghost = { key, dx: mx - sx, dy: my - sy }; },
    up: (mx, my) => {
      if (!ghost) return;
      const g = ghost; ghost = null;
      if (deskDrop(c.it, mx, my)) return;
      const p = desk.pos.get(key);
      if (p) { p.x = clamp(p.x + g.dx, 0, W - 32); p.y = clamp(p.y + g.dy, 0, workH() - 48); desk.posVer++; }
    },
  };
}

// ---------------------------------------------------------------- taskbar
function clockStr() { const d = new Date(); const h = d.getHours() % 12 || 12; return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`; }
function timeDate() { const d = new Date(); return `${clockStr()} ${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; }
function taskLayout() {
  const y = barTop();
  const start = { x: 2, y: y + 4, w: 54, h: 22 };
  const cw = (tbar.clock ? textW(clockStr()) + 14 : trayIcons.length ? 6 : 0) + trayIcons.length * 18;
  const tray = { x: W - 2 - cw, y: y + 4, w: cw, h: 22 };
  const icons = trayIcons.map((t, i) => ({ t, x: tray.x + 4 + i * 18, y: tray.y + 3, w: 16, h: 16 }));
  const x0 = start.x + start.w + 3, avail = tray.x - 3 - x0, n = tasks.length;
  const bw = n ? Math.min(160, Math.floor((avail - (n - 1) * 3) / n)) : 0;
  const btns = tasks.map((t, i) => ({ t, x: x0 + i * (bw + 3), y: y + 4, w: bw, h: 22 }));
  return { y, start, tray, btns, icons };
}
function drawTaskbar() {
  const L = taskLayout();
  fill(0, L.y, W, TB, K.face); fill(0, L.y, W, 1, K.lt); fill(0, L.y + 1, W, 1, K.hl);
  const s = L.start, open = menuSrc && menuSrc.kind === 'start', o = open ? 1 : 0;
  if (open) btnDown(s.x, s.y, s.w, s.h); else btnUp(s.x, s.y, s.w, s.h);
  ctx.drawImage(IMG.startflag, s.x + 2 + o, s.y + 3 + o);
  text('Start', s.x + 21 + o, s.y + 4 + o, K.dk, true);
  if (open) focusRect(s.x + 3, s.y + 3, s.w - 6, s.h - 6);
  for (const b of L.btns) {
    if (b.w < 8) continue;
    const pressed = b.t === active && !b.t.min, p = pressed ? 1 : 0;
    if (pressed) btnDown(b.x, b.y, b.w, b.h, PAT.track); else btnUp(b.x, b.y, b.w, b.h);
    ctx.save(); ctx.beginPath(); ctx.rect(b.x + 2, b.y + 2, b.w - 4, b.h - 4); ctx.clip();
    if (b.t.icon) icon(b.t.icon + '16', b.x + 4 + p, b.y + 3 + p);
    text(ellipsis(esc(b.t.title), b.w - 28, pressed), b.x + 23 + p, b.y + 4 + p, K.dk, pressed);
    ctx.restore();
  }
  const t = L.tray; if (t.w) edge(t.x, t.y, t.w, t.h, K.sh, K.hl);
  for (const i of L.icons) icon(i.t.icon + '16', i.x, i.y);
  if (tbar.clock) { const cs = clockStr(); text(cs, t.x + t.w - 7 - textW(cs), t.y + 4); }
}
function taskDown(x, y, btn, dbl) {
  const L = taskLayout();
  const ti = L.icons.find(v => inR(v, x, y));
  if (ti) { trayMouse(ti.t, btn === 2 ? 0x204 : dbl ? 0x203 : 0x201); return; }
  if (inR(L.start, x, y)) { if (menuSrc && menuSrc.kind === 'start') closeMenus(); else openStart(); return; }
  const b = L.btns.find(v => inR(v, x, y));
  if (b) {
    if (btn === 2) { activate(b.t); if (!b.t.native) sysMenu(b.t, x, y - 4, true); return; }
    if (b.t === active && !b.t.min) minimize(b.t); else activate(b.t);
    return;
  }
  if (btn === 2 && !inR(L.tray, x, y)) {
    openPopup([
      { label: '&Cascade', fn: cascadeAll }, { label: 'Tile &Horizontally', fn: () => tileAll(false) }, { label: 'Tile &Vertically', fn: () => tileAll(true) },
      { sep: true }, { label: '&Minimize All Windows', fn: () => tasks.forEach(minimize) }, { sep: true }, { label: 'P&roperties', fn: taskbarProperties },
    ], x, y);
    const m = menus[0]; placeMenu(m, x, y - m.h);
  }
}
function restorable() { return tasks.filter(t => !t.min && t.resizable); }
function cascadeAll() {
  restorable().forEach((t, i) => { if (t.max) toggleMax(t); Object.assign(t, { x: i * 22, y: i * 22, w: Math.min(t.w, W - i * 22), h: Math.min(t.h, workH() - i * 22) }); activate(t); });
}
function tileAll(vert) {
  const ts = restorable(), n = ts.length; if (!n) return;
  ts.forEach((t, i) => {
    if (t.max) toggleMax(t);
    if (vert) Object.assign(t, { x: Math.floor(i * W / n), y: 0, w: Math.floor(W / n), h: workH() });
    else Object.assign(t, { x: 0, y: Math.floor(i * workH() / n), w: W, h: Math.floor(workH() / n) });
  });
}
function sysMenu(w, x, y, above) {
  openPopup([
    { label: '&Restore', disabled: !(w.max || w.min), fn: () => { if (w.min) activate(w); else toggleMax(w); } },
    { label: '&Move', disabled: w.max || !w.resizable }, { label: '&Size', disabled: w.max || !w.resizable },
    { label: 'Mi&nimize', disabled: w.min || !w.minimizable, fn: () => minimize(w) },
    { label: 'Ma&ximize', disabled: w.max || !w.maximizable, fn: () => { if (w.min) activate(w); toggleMax(w); } },
    { sep: true }, { label: '&Close', acc: 'Alt+F4', bold: true, fn: () => closeWin(w) },
  ], x, y);
  if (above) { const m = menus[0]; placeMenu(m, x, y - m.h); }
}

// ---------------------------------------------------------------- screen savers
// Saver binaries live on C:\WINDOWS. A run reads the file from the in-memory disk, matches
// its SHA-256 to the recompiled module, and executes it through win32.js.
const SV = window.W95SAVERS || { savers: {}, fonts: {} };
const b64bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function sha256hex(b) { const h = await crypto.subtle.digest('SHA-256', b); return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join(''); }
// the network's ring-0 images (VxDs, NE2000.SYS) and DLLs: decoded and compiled before its process first starts, so
// the start runs them rather than building them on the main thread
const unb64 = async s => { try { return new Uint8Array(await (await fetch('data:application/octet-stream;base64,' + s)).arrayBuffer()); } catch (_) { return b64bytes(s); } };
/** a bundled module's compiled code (d.wasm, base64), decoded and compiled off the main thread, once */
const wasmOf = d => d.module || (d.module = unb64(d.wasm).then(b => WebAssembly.compile(b)));
let sysCompile = null;
function systemCompiled() {
  const S = window.W95SYSTEM; if (!S) return Promise.resolve();
  return sysCompile || (sysCompile = Promise.all([...Object.values(S.ne), ...Object.values(S.dlls), ...Object.values(S.net || {})].map(async m => { m.mod = await wasmOf(m); })));
}
let netCompile = null;
function netCompiled() {
  const S = window.W95SYSTEM; if (!S) return Promise.resolve();
  const job = async (d, from, to) => { if (!d[to] && d[from]) d[to] = await unb64(d[from]); if (!d.mod && d.wasm) d.mod = await WebAssembly.compile(await unb64(d.wasm)); };
  return netCompile || (netCompile = Promise.all([
    ...Object.values(S.vxds || {}).map(d => job(d, 'image', 'imgBytes')),
    ...Object.values(S.drivers || {}).map(d => job(d, 'file', 'bytes')),
    ...Object.values(S.net || {}).map(d => job(d, 'file', 'bytes')),
  ]));
}
const mkc = (w, h) => Object.assign(document.createElement('canvas'), { width: Math.max(1, w), height: Math.max(1, h) });
let fullSaver = null, lastInput = performance.now();
async function startSaverProcess(path, arg) {
  const app = sysApp || await startSystem();
  if (!app || !app.alive || !app.remote) return null;
  const result = await app.spawnProgram(path, arg);
  return result && result.pid ? { app, pid: result.pid, path } : null;
}
function stopSaverProcess(run) {
  if (run && run.pid && run.app && run.app.alive) run.app.cmd('endProcess', [run.pid, 0]);
}
/** A screen saver is a process on the system machine; its normal USER32 windows are composed with the machine's windows. */
function startFullSaver(path) {
  if (fullSaver || !path) return;
  closeMenus();
  const run = fullSaver = { path, pid: 0, app: null };
  startSaverProcess(path, '/s').then(p => {
    if (fullSaver !== run) { stopSaverProcess(p); return; }
    if (p) Object.assign(run, p); else fullSaver = null;
  }).catch(e => { console.error(e); if (fullSaver === run) fullSaver = null; });
}
function saverIni() {
  const g = (f, s, k) => W95Win32.iniGet(fs, f, s, k);
  return { path: g('SYSTEM.INI', 'boot', 'SCRNSAVE.EXE') || '', active: g('WIN.INI', 'windows', 'ScreenSaveActive') === '1',
    timeout: parseInt(g('WIN.INI', 'windows', 'ScreenSaveTimeOut') || '900', 10) || 900 };
}
setInterval(() => {
  if (fullSaver || screen !== 'desktop') return;
  const c = saverIni();
  if (c.active && c.path && performance.now() - lastInput >= c.timeout * 1000) startFullSaver(c.path);
}, 1000);
function listSavers() {
  const out = [];
  for (const dir of [WINDIR, WINDIR + '\\SYSTEM']) {
    let ents = []; try { ents = fs.readdir(dir, '*.scr'); } catch (_) { continue; }
    for (const e of ents) {
      // desk.cpl: long file names are shown as-is; 8.3 names use the saver's IDS_DESCRIPTION string
      let name = null;
      if (is83(e.name.toUpperCase())) try { name = W95Win32.peString(fs.readFile(e.path), 1); } catch (_) { /* unreadable */ }
      out.push({ path: e.path, name: name || e.name.replace(/\.scr$/i, '') });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- Win32 dialogs owned by guest processes
let dlgBase = null;
function dialogBaseUnits() {
  if (!dlgBase) dlgBase = { x: Math.floor((textW('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') / 26 + 1) / 2), y: 13 };
  return dlgBase;
}
function win32Dialog(proc, d) {
  const bu = dialogBaseUnits(), px = v => Math.round(v * bu.x / 4), py = v => Math.round(v * bu.y / 8);
  const body = new Win32DialogBody(proc, d, px, py);
  const cw = px(d.cx), ch = py(d.cy), w = cw + 6, h = ch + 3 + 19 + 3;
  const win = new Win({ ...centered(w, h), w, h, title: d.title, resizable: false, minimizable: false, maximizable: false, body, noTask: true });
  d.ui = win; modals.push(win); openWin(win); dirty();
}
// ---------------------------------------------------------------- Setup's registry entries
// The AddReg sections of the CD's Setup INF files, as Setup writes them: `root, key, name, flags, value` with
// %strings% and %dirid% substituted; flag 1 makes the value binary (hex bytes), 2 leaves an existing value alone.
/** an INF file's sections (lower-case names: their lines), its lines' fields, and its %strings% and %dirids% put in */
function infParse(text) {
  const sec = {}; let cur = null;
  for (const l of text.split(/\r?\n/)) { const m = l.match(/^\s*\[([^\]]+)\]/); if (m) { cur = sec[m[1].trim().toLowerCase()] = sec[m[1].trim().toLowerCase()] || []; continue; } if (cur) cur.push(l); }
  const fields = l => {   // comma-separated, "quoted" with "" for a quote, ; starts a comment outside quotes
    const out = []; let f = '', q = false, quoted = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"') { if (l[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
      if (c === '"') { if (!quoted && !f.trim()) f = ''; q = quoted = true; continue; }   // (the blanks around a quoted field are not its)
      if (c === ';') break;
      if (c === ',') { out.push(quoted ? f : f.trim()); f = ''; quoted = false; continue; }
      if (quoted && /\s/.test(c)) continue;
      f += c;
    }
    out.push(quoted ? f : f.trim()); return out;
  };
  const strings = {};
  for (const l of sec.strings || []) { const m = l.match(/^\s*([^=;\s][^=]*?)\s*=\s*(.*)$/); if (m) strings[m[1].toLowerCase()] = fields(m[2])[0]; }
  const dirs = { 10: WINDIR, 11: WINDIR + '\\SYSTEM', 17: WINDIR + '\\INF', 18: WINDIR + '\\HELP', 20: WINDIR + '\\FONTS', 24: 'C:\\', 25: WINDIR, 30: 'C:\\' };
  const subst = s => s.replace(/%([^%]*)%/g, (m, k) => (k === '' ? '%' : dirs[k] ?? strings[k.toLowerCase()] ?? m));
  return { sec, fields, subst };
}
function infAddReg(text, section, hkr) {
  const { sec, fields, subst } = infParse(text);
  const ROOT = { HKCR: 'hkcr', HKCU: 'hkcu', HKLM: 'hklm', HKU: 'hku', HKR: hkr };   // HKR: the device's own key, for a device INF
  for (const l of sec[section.toLowerCase()] || []) {
    if (!l.trim() || /^\s*;/.test(l)) continue;
    const f = fields(l), root = ROOT[(f[0] || '').toUpperCase()]; if (!root) continue;
    const sub = subst(f[1] || ''), key = sub ? root + '\\' + sub : root, flags = parseInt(f[3] || '0', 16) || 0;
    if (f.length < 3) { W95Win32.regSet(key, null); continue; }
    const name = subst(f[2] || '');
    if (flags & 2 && W95Win32.regGet(key, name) !== undefined) continue;
    if (flags & 1) W95Win32.regSet(key, name, { type: 3, data: Uint8Array.from(f.slice(4).filter(Boolean).map(h => parseInt(h, 16))) });
    else W95Win32.regSet(key, name, { type: 1, data: W95FS.encode(subst(f.slice(4).join(',')) + '\0') });
  }
}
// what Setup puts in the registry for the shell (SHELL.INF), on a registry that has not had it
// an INF's UpdateInis section: `file, section, old line, new line`; a new line key=value is set in that file's section
// (only files `only` matches, when given), the INF's %strings% put in. Lines that only delete an old entry are left
function infUpdateInis(text, section, only) {
  const { sec, fields, subst } = infParse(text);
  for (const l of sec[section.toLowerCase()] || []) {
    const f = fields(l);
    if (f.length < 4 || !f[0] || !f[3] || (only && !only.test(f[0]))) continue;
    const line = subst(f[3]), eq = line.indexOf('='); if (eq <= 0) continue;
    W95Win32.iniSet(fs, f[0].toUpperCase(), f[1], line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
}
// the Start menu as Setup leaves it: SETUPC.INF's UpdateInis lines for SETUP.INI (the folders under Programs in
// [progman.groups], each one's links in its own section) and GRPCONV run once at the next start (-s, by RUNONCE) to
// make them the Start Menu's folders and shell links, with the links of the Accessories the system has (APPLETS.INF's
// <component>.links, each component whose program is here: Calculator). A Start menu whose Windows Explorer link is
// not yet a shell link gets them, and one that lacks a link of an accessory here
function setupStartMenu() {
  const S = window.W95SYSTEM || {}, infs = S.infs || {}, inf = infs['SETUPC.INF']; if (!inf || !(S.programs || {})['GRPCONV.EXE']) return;
  const applets = infs['APPLETS.INF'] ? infParse(infs['APPLETS.INF']) : null;
  // the accessories' sections: each <name>.links whose links are all to programs the system has, with the link's name
  const accessories = [];
  if (applets) for (const [name, lines] of Object.entries(applets.sec)) {
    if (!/\.links$/.test(name) || /remove/.test(name)) continue;
    const links = lines.map(l => applets.fields(l)).filter(f => /^setup\.ini$/i.test(f[0]) && f[1] && !/^progman\.groups$/i.test(f[1]) && f[3])
      .map(f => applets.fields(applets.subst(f[3])));
    if (links.length && links.every(k => (S.programs || {})[(k[1] || '').toUpperCase()])) accessories.push({ name, links });
  }
  let cur = null; try { cur = fs.readFile(PROGRAMS + '\\Windows Explorer.lnk'); } catch (_) { /* none yet */ }
  const missing = accessories.some(a => a.links.some(k => !fs.exists(join(PROGRAMS, 'Accessories', k[0] + '.lnk'))));
  if (cur && cur[0] === 0x4c && cur[1] === 0 && !missing) return;   // ('L': a shell link's header)
  const out = new Map();
  const add = ({ sec, fields, subst }, names) => {
    for (const name of names) for (const l of sec[name] || []) {
      if (!l.trim() || /^\s*;/.test(l)) continue;
      const f = fields(l); if (!/^setup\.ini$/i.test(f[0]) || !f[1] || !f[3]) continue;
      const section = f[1].toLowerCase(), line = subst(f[3]);
      if (!out.has(section)) out.set(section, { name: f[1], lines: [] });
      const lines = out.get(section).lines, eq = section === 'progman.groups' ? line.indexOf('=') : -1;
      const at = eq > 0 ? lines.findIndex(x => x.slice(0, eq + 1).toLowerCase() === line.slice(0, eq + 1).toLowerCase()) : lines.indexOf(line);
      if (at >= 0) lines[at] = line; else lines.push(line);
    }
  };
  add(infParse(inf), ['winbase.inis', 'winother.links']);
  if (applets) add(applets, accessories.map(a => a.name));
  fs.writeFile(join(WINDIR, 'SETUP.INI'), W95FS.encode([...out.values()].map(v => `[${v.name}]\r\n${v.lines.join('\r\n')}\r\n`).join('\r\n')));
  // SETUPC.INF's RunOnce\Setup item: run under RUNONCE's "Windows 95 Setup" screen before the system's message server
  // starts (worker.js startSystemTask), before SystemStart and the shell. (GRPCONV makes the Start menu through the
  // shell's DDE: it looks for the shell for ten seconds and, without it, writes no links, so this item runs again at
  // the next start; with the shell first, SystemStart, which MSGSRV32 plays before it starts the shell, came before
  // the screen)
  const str = v => ({ type: 1, data: W95FS.encode(v + '\0') }), ro = 'hklm\\software\\microsoft\\windows\\currentversion\\runonce';
  W95Win32.regSet(ro + '\\setup', 'Programs on the Start menu', str(join(WINDIR, 'grpconv.exe') + ' -s'));
}
// Setup's registration of the copy (CurrentVersion: RegisteredOwner, RegisteredOrganization, ProductId): MSGSRV32
// checks them as Windows starts and, missing, runs the first-run screens instead. The owner is the name the network
// logon is given; this copy has no organization and an OEM product id
function setupRegistration() {
  const cv = 'hklm\\software\\microsoft\\windows\\currentversion', str = v => ({ type: 1, data: W95FS.encode(v + '\0') });
  const owner = ((window.W95HOST && window.W95HOST.userName) || '').slice(0, 48) || 'Windows 95 User';
  if (W95Win32.regGet(cv, 'RegisteredOwner') === undefined) W95Win32.regSet(cv, 'RegisteredOwner', str(owner));
  if (W95Win32.regGet(cv, 'RegisteredOrganization') === undefined) W95Win32.regSet(cv, 'RegisteredOrganization', str(''));
  if (W95Win32.regGet(cv, 'ProductId') === undefined) W95Win32.regSet(cv, 'ProductId', str('00000-OEM-0000000-00000'));
  // where Setup put the shared Windows files (SHELL32 runs RUNDLL32 from there: Control Panel's applets)
  if (W95Win32.regGet(cv + '\\setup', 'SharedDir') === undefined) W95Win32.regSet(cv + '\\setup', 'SharedDir', str(WINDIR));
}
function setupRegistry() {
  setupRegistration();
  const inf = ((window.W95SYSTEM || {}).infs || {})['SHELL.INF']; if (!inf) return;
  if (W95Win32.regGet('hkcr\\clsid\\{20d04fe0-3aea-1069-a2d8-08002b30309d}\\inprocserver32', '') !== undefined) return;
  infAddReg(inf, 'shell.reg');
}
// Setup's multimedia: MOTOWN.INF's base (event labels and schemes, the MEDIA class, MediaResources), MMOPT.INF's sound
// clips of a Typical install in C:\WINDOWS\MEDIA, SYSTEM.INI's [boot] drivers=mmsystem.dll, and the Windows Sound System
// card WAVE.INF installs: a legacy *PNPB007 device whose software key is MEDIA\0000
// The card's drivers as the media device loader records them once it has started the devnode: an entry under
// MediaResources for each driver its class key lists (SOFTWAREKEY, DeviceID, DevNode, with the driver key's values) and
// Drivers\MIGRATED=1, from which MMSYSTEM loads them. A disk whose entries are missing or lack those values (left by
// an earlier setup, or naming the devnode by another handle) gets them written again
function mediaResources() {
  const R = W95Win32, sw = 'hklm\\system\\currentcontrolset\\services\\class\\media\\0000', drv = sw + '\\drivers';
  const res = 'hklm\\system\\currentcontrolset\\control\\mediaresources';
  if (!R.regKids(drv).length) return;
  // the card's devnode handle as CONFIGMG hands them out: C1000000h plus 100h for each ROOT devnode before it
  let at = 0, idx = -1;
  for (const b of R.regKids('hklm\\enum').filter(x => x.toLowerCase() === 'root')) for (const d of R.regKids(`hklm\\enum\\${b}`)) for (const i of R.regKids(`hklm\\enum\\${b}\\${d}`)) { if (`${b}\\${d}\\${i}`.toUpperCase() === 'ROOT\\*PNPB007\\0000') idx = at; at++; }
  const h = (0xc1000000 + 0x100 * Math.max(idx, 0)) >>> 0;
  const str = v => ({ type: 1, data: W95FS.encode(v + '\0') }), devnode = { type: 3, data: new Uint8Array([h & 0xff, h >> 8 & 0xff, h >> 16 & 0xff, h >>> 24]) };
  const want = [];
  for (const cls of R.regKids(drv)) for (const d of R.regKids(`${drv}\\${cls}`)) want.push([cls, d, `${res}\\${cls}\\${d}<0000>`]);
  const same = v => v && v.data && v.data.length === 4 && v.data.every((b, i) => b === devnode.data[i]);
  const ok = want.every(([, , k]) => R.regGet(k, 'softwarekey') !== undefined && same(R.regGet(k, 'devnode')) && R.regGet(k, 'driver') !== undefined) && same(R.regGet(drv, 'devnode'))
    && /^1/.test(W95FS.decode((R.regGet(drv, 'migrated') || { data: new Uint8Array(0) }).data));
  if (ok) return;
  for (const [cls, d, k] of want) {
    R.regDel(k);
    for (const [n, v] of R.regVals(`${drv}\\${cls}\\${d}`)) R.regSet(k, (v && v.name) || n, v);
    R.regSet(k, 'softwarekey', str('System\\CurrentControlSet\\Services\\Class\\MEDIA\\0000'));
    R.regSet(k, 'deviceid', str('ROOT\\*PNPB007\\0000'));
    R.regSet(k, 'devnode', devnode);
    R.regSet(k, 'active', str('1'));
    if (cls === 'midi') R.regSet(k, 'mapperconfig', { type: 4, data: new Uint8Array([1, 0, 0, 0]) });
  }
  R.regSet(drv, 'devnode', devnode);
  R.regSet(drv, 'migrated', str('1'));
}
// the help files Setup puts in C:\WINDOWS\HELP, each one the disk lacks
function setupHelp() {
  const S = window.W95SYSTEM || {}, dir = join(WINDIR, 'HELP');
  if (!Object.keys(S.help || {}).length) return;
  fs.mkdir(dir, { recursive: true });
  for (const [n, d] of Object.entries(S.help)) { const f = join(dir, n.toLowerCase()); if (!fs.exists(f)) fs.writeFile(f, b64bytes(d)); }
}
// what Setup leaves for installing from the CD (the Add Printer wizard's drivers): the INF files in C:\WINDOWS\INF (the
// printer drivers' lists, and LAYOUT.INF, which says which of the CD's cabinets holds each file), the CD's Windows
// folder as the source Setup's engine copies from, SetupFlags as a local install leaves them (SUF_SBSCOPYOK, files
// may be copied into the Windows folders, which no server shares; the first boot done) and MSPRINT.INF's Printer
// class, whose installer is MSPRINT.DLL
function setupPrinting() {
  const R = W95Win32, infs = (window.W95SYSTEM || {}).infs || {}, dir = join(WINDIR, 'INF');
  if (!infs['MSPRINT.INF']) return;
  fs.mkdir(dir, { recursive: true });
  for (const [n, t] of Object.entries(infs)) { const f = join(dir, n); if (!fs.exists(f)) fs.writeFile(f, Uint8Array.from(t, c => c.charCodeAt(0))); }
  const cv = 'hklm\\software\\microsoft\\windows\\currentversion', str = v => ({ type: 1, data: W95FS.encode(v + '\0') });
  if (R.regGet(cv + '\\setup', 'SourcePath') === undefined) R.regSet(cv + '\\setup', 'SourcePath', str('D:\\WIN95\\'));   // LDID_SRCPATH
  if (R.regGet(cv, 'DevicePath') === undefined) R.regSet(cv, 'DevicePath', str(dir));
  if (R.regGet(cv, 'SetupFlags') === undefined) R.regSet(cv, 'SetupFlags', { type: 3, data: new Uint8Array([0, 1, 0, 0]) });
  const cls = 'hklm\\system\\currentcontrolset\\services\\class\\printer';
  if (R.regGet(cls, 'Installer') === undefined) infAddReg(infs['MSPRINT.INF'], 'ClassAddReg', cls);
  // the spooler's environment, monitors, printers and providers keys, and WIN.INI's spooler lines (MSPRINT.INF
  // [Environment]), which SPOOLSS reads as it starts
  if (R.regGet('hklm\\system\\currentcontrolset\\control\\print\\environments\\windows 4.0', 'Directory') === undefined) {
    infAddReg(infs['MSPRINT.INF'], 'Environment_Reg'); infUpdateInis(infs['MSPRINT.INF'], 'Environment_Ini');
  }
}
// the fonts Setup copies to C:\WINDOWS\FONTS, each one the disk lacks (a disk made without one, Marlett's among them,
// draws USER's caption buttons and scroll arrows as letters)
function setupFonts() {
  const sysFonts = (window.W95SYSTEM || {}).fonts || {}, dir = join(WINDIR, 'FONTS');
  for (const [e, d] of Object.entries(sysFonts)) { const f = join(dir, e); if (!fs.exists(f)) fs.writeFile(f, b64bytes(d)); }
}
// the printer port Setup's detection finds and installs (MSPORTS.INF *PNP0400, LptPort): its ROOT devnode at I/O 378h
// and IRQ 7 (parallel.js) named LPT1, and its software key under the Ports class with VCOMM its device loader, LPT.VXD
// its port driver and LPTENUM.VXD the enumerator of what is plugged into it
function setupPorts() {
  const R = W95Win32, inf = ((window.W95SYSTEM || {}).infs || {})['MSPORTS.INF']; if (!inf) return;
  const hw = 'hklm\\enum\\root\\*pnp0400\\0000', cls = 'hklm\\system\\currentcontrolset\\services\\class\\ports', sw = cls + '\\0000';
  if (R.regGet(hw, 'Driver') !== undefined) return;
  const str = v => ({ type: 1, data: W95FS.encode(v + '\0') });
  infAddReg(inf, 'PortsClass.AddReg', cls);
  infAddReg(inf, 'LptPort.AddReg', sw);
  for (const [k, v] of [['DriverDesc', 'Printer Port'], ['ProviderName', 'Microsoft'], ['InfPath', 'MSPORTS.INF'], ['InfSection', 'LptPort']]) R.regSet(sw, k, str(v));
  for (const [k, v] of [['Class', 'Ports'], ['Driver', 'Ports\\0000'], ['DeviceDesc', 'Printer Port'], ['HardwareID', '*PNP0400'], ['Mfg', '(Standard port types)'], ['PortName', 'LPT1']]) R.regSet(hw, k, str(v));
}
/** Windows Help (the recompiled WINHLP32.EXE) on a help file of C:\WINDOWS\HELP: with its contents file, Help Topics */
const hasHelp = () => !!((window.W95SYSTEM || {}).programs || {})['WINHLP32.EXE'];
function winHelp(file = 'windows.hlp') { closeMenus(); if (hasHelp()) runNative(join(WINDIR, 'WINHLP32.EXE'), join(WINDIR, 'HELP', file)); }
// the display: a start after one whose display driver could not enable finds USER's note of it in SYSTEM.INI
// (*DisplayFallback=1), which sends the next start down the VGA fallback path; this machine's adapter and driver are
// always the same, so the note is cleared before each start
function setupDisplay() {
  if (W95Win32.iniGet(fs, 'SYSTEM.INI', 'boot', '*DisplayFallback') !== null) W95Win32.iniSet(fs, 'SYSTEM.INI', 'boot', '*DisplayFallback', null);
  setupDisplayDevices(); setupFontSize(); setupPatterns(); setupWallpapers();
}
// the wallpapers the Background page lists: SHELL.INF's basebitmaps, each in C:\WINDOWS by the name its addreg line
// renames it to (RenameFiles\Win: bamboo.bmp to "Straw Mat.bmp"), each one the disk lacks
function setupWallpapers() {
  const S = window.W95SYSTEM || {}, inf = (S.infs || {})['SHELL.INF']; if (!inf || !S.bitmaps) return;
  const { sec, fields, subst } = infParse(inf), names = {};
  for (const l of sec['basebitmaps.addreg'] || []) { const f = fields(l); if (f[2] && f[4]) names[f[2].toUpperCase()] = subst(f[4]); }
  for (const [n, d] of Object.entries(S.bitmaps)) { const f = join(WINDIR, names[n] || n.toLowerCase()); if (!fs.exists(f)) fs.writeFile(f, b64bytes(d)); }
}
// the desktop patterns Display Properties' Background page lists: SHELL.INF's patterns.inis, CONTROL.INI's [Patterns]
// ("(None)" and the named 8x8 bitmaps), on a disk that has none
function setupPatterns() {
  const inf = ((window.W95SYSTEM || {}).infs || {})['SHELL.INF']; if (!inf) return;
  if (W95Win32.iniRead(fs, 'CONTROL.INI').get('patterns')) return;
  infUpdateInis(inf, 'patterns.inis');
}
// the display adapter and monitor Setup's detection finds and installs: the Tseng ET4000/W32 (MSDISP.INF *PNP0912,
// TsengW32: TSENG.DRV with its mini-VDD TSENG.VXD) as a ROOT devnode under the Display class, and the monitor the
// adapter enumerates (MONITOR.INF's class install makes Monitor\Default_Monitor\0001) as Super VGA 1280x1024, the
// generic type that takes the adapter's largest mode
function setupDisplayDevices() {
  const R = W95Win32, infs = (window.W95SYSTEM || {}).infs || {}, disp = infs['MSDISP.INF'], mon = infs['MONITOR.INF']; if (!disp || !mon) return;
  const hw = 'hklm\\enum\\root\\*pnp0912\\0000', cls = 'hklm\\system\\currentcontrolset\\services\\class\\';
  if (R.regGet(hw, 'Driver') !== undefined) return;
  const str = v => ({ type: 1, data: W95FS.encode(v + '\0') }), set = (k, o) => { for (const [n, v] of Object.entries(o)) R.regSet(k, n, str(v)); };
  infAddReg(disp, 'ClassAddReg', cls + 'display');
  infAddReg(disp, 'TsengW32.AddReg', cls + 'display\\0000');
  set(cls + 'display\\0000', { DriverDesc: 'Tseng Labs ET4000/W32', ProviderName: 'Microsoft', InfPath: 'MSDISP.INF', InfSection: 'TsengW32' });
  set(hw, { Class: 'Display', Driver: 'Display\\0000', DeviceDesc: 'Tseng Labs ET4000/W32', HardwareID: '*PNP0912', Mfg: 'Tseng Labs' });
  // the configuration's depth as the adapter is installed: High Color (a disk set up before it, at 256 colors, too)
  for (const k of ['hkcc\\display\\settings', 'hklm\\config\\0001\\display\\settings']) R.regSet(k, 'BitsPerPixel', str(String(BOOT_BPP)));
  infAddReg(mon, 'ClassAddReg', cls + 'monitor');
  infAddReg(mon, '1280', cls + 'monitor\\0000');
  set(cls + 'monitor\\0000', { DriverDesc: 'Super VGA 1280x1024', ProviderName: 'Microsoft', InfPath: 'MONITOR.INF', InfSection: '1280.Install' });
  set('hklm\\enum\\monitor\\default_monitor\\0001', { Class: 'Monitor', Driver: 'Monitor\\0000', DeviceDesc: 'Super VGA 1280x1024', HardwareID: 'Monitor\\Default_Monitor', Mfg: '(Standard monitor types)' });
}
// the font sizes Display Properties offers (FONTS.INF's MS_FONTSIZE_AddReg: Small Fonts at 96 dpi, Large at 120),
// and the one the profile has, as the display's class installer records it: Small Fonts' system font files and DPI
function setupFontSize() {
  const R = W95Win32, inf = ((window.W95SYSTEM || {}).infs || {})['FONTS.INF']; if (!inf) return;
  if (R.regGet('hklm\\software\\microsoft\\windows\\currentversion\\fontsize\\96', 'Description') !== undefined) return;
  infAddReg(inf, 'MS_FONTSIZE_AddReg');
  const str = v => ({ type: 1, data: W95FS.encode(v + '\0') });
  const small = { 'fonts.fon': 'vgasys.fon', 'fixedfon.fon': 'vgafix.fon', 'oemfonts.fon': 'vgaoem.fon', DPILogicalX: '96', DPILogicalY: '96', DPIPhysicalX: '96', DPIPhysicalY: '96' };
  for (const k of ['hkcc\\display\\settings', 'hklm\\config\\0001\\display\\settings']) for (const [n, v] of Object.entries(small)) R.regSet(k, n, str(v));
}
function setupSound() {
  const S = window.W95SYSTEM || {}, infs = S.infs || {};
  if (!infs['MOTOWN.INF']) return;
  // the media files, each one the disk lacks (a disk set up before the bundle carried it gets it too)
  const media = join(WINDIR, 'MEDIA'); fs.mkdir(media, { recursive: true });
  const NAMES = { 'MSSOUND.WAV': 'The Microsoft Sound.wav' };   // MOTOWN.INF's RenameFiles\Media
  for (const [n, d] of Object.entries(S.media || {})) { const f = join(media, NAMES[n] || n.toLowerCase()); if (!fs.exists(f)) fs.writeFile(f, b64bytes(d)); }
  // the MCI devices that play MIDI and wave files (MOTOWN.INF's MCISEQ and MCIWAVE) and Media Player (MPlay): their
  // registry and SYSTEM.INI [mci] lines, and WIN.INI's [mci extensions] from the base install
  if (W95Win32.regGet('hklm\\system\\currentcontrolset\\control\\mediaresources\\mci\\sequencer', 'Driver') === undefined) {
    for (const sec of ['sequencer.Reg', 'waveaudio.Reg', 'MPlay.install.reg']) infAddReg(infs['MOTOWN.INF'], sec);
    for (const sec of ['sequencer.inis', 'waveaudio.inis']) infUpdateInis(infs['MOTOWN.INF'], sec);
    infUpdateInis(infs['MOTOWN.INF'], 'mmsys.inis', /^win\.ini$/i);
  }
  // Media Player checks that .avi is still its avifile type (MOTOWN.INF's HKCR,.avi,,,avifile, which OSR2 leaves to
  // ActiveMovie) and otherwise asks on every start to repair its settings
  if (W95Win32.regGet('hkcr\\.avi', '') === undefined) W95Win32.regSet('hkcr\\.avi', '', { type: 1, data: W95FS.encode('avifile\0') });
  // the video device that plays .avi files (MOTOWN.INF's MCIAVI: [mci] avivideo=mciavi.drv) and the Cinepak codec
  // the CD's videos are in (VIDC.CVID: [drivers32] vidc.CVID=iccvid.dll), on a disk that lacks them
  if ((S.ne || {}).MCIAVI && W95Win32.regGet('hklm\\system\\currentcontrolset\\control\\mediaresources\\mci\\avivideo', 'Driver') === undefined) {
    for (const sec of ['avivideo.Reg', 'cvid.Reg']) infAddReg(infs['MOTOWN.INF'], sec);
    for (const sec of ['avivideo.inis', 'cvid.inis']) infUpdateInis(infs['MOTOWN.INF'], sec);
  }
  mediaResources();
  if (W95Win32.regGet('hkcu\\appevents\\eventlabels\\systemstart', '') !== undefined) return;
  infAddReg(infs['MOTOWN.INF'], 'mmsys.add.reg');
  if (infs['MMOPT.INF']) infAddReg(infs['MMOPT.INF'], 'mediaopt.reg');

  const ini = W95Win32.iniGet(fs, 'SYSTEM.INI', 'boot', 'drivers');
  if (!ini || !/(^|[\s,])mmsystem\.dll/i.test(ini)) W95Win32.iniSet(fs, 'SYSTEM.INI', 'boot', 'drivers', ini ? `${ini} mmsystem.dll` : 'mmsystem.dll');
  const wave = infs['WAVE.INF']; if (!wave) return;
  const sw = 'hklm\\system\\currentcontrolset\\services\\class\\media\\0000', hw = 'hklm\\enum\\root\\*pnpb007\\0000';
  for (const sec of ['WAVE.AddReg', 'MIXER.AddReg', 'PNPB007.AddReg', 'WSS.AddReg']) infAddReg(wave, sec, sw);
  const str = v => ({ type: 1, data: W95FS.encode(v + '\0') }), desc = 'MS Windows Sound System Compatible';
  for (const [k, v] of [['DriverDesc', desc], ['ProviderName', 'Microsoft'], ['InfPath', 'WAVE.INF'], ['InfSection', 'PNPB007_Device']]) W95Win32.regSet(sw, k, str(v));
  for (const [k, v] of [['Class', 'MEDIA'], ['Driver', 'MEDIA\\0000'], ['DeviceDesc', desc], ['HardwareID', '*PNPB007'], ['Mfg', 'Microsoft']]) W95Win32.regSet(hw, k, str(v));
  mediaResources();
}

// Setup's network, as the Network control panel installs it (NETDI.DLL): an NE2000-compatible card (NETNOVEL.INF
// *PNP80D6) at I/O 300h and IRQ 5, NetBEUI bound to it (NETTRANS.INF) and Client for Microsoft Networks bound to that
// (NETCLI.INF, with the Microsoft Network provider MPR loads). Each component has its Enum devnode (the card a ROOT
// one, the protocol and client the Network enumerator's) and its software key under Services\Class; Bindings subkeys
// link them upward. The static VxDs NET.INF and NETCLI.INF add (NDIS, VNETBIOS, VNETSUP, VREDIR) and the machine's
// name and workgroup (VNETSUP) complete it
function setupNetwork() {
  const R = W95Win32, infs = (window.W95SYSTEM || {}).infs || {};
  if (!infs['NETNOVEL.INF'] || !infs['NETTRANS.INF'] || !infs['NETCLI.INF'] || !infs['NET.INF']) return;
  const str = v => ({ type: 1, data: W95FS.encode(v + '\0') }), bin = (...b) => ({ type: 3, data: Uint8Array.from(b) });
  // the user name Setup asks for, which the logon offers (Network\Logon username): the host's account
  const user = ((window.W95HOST && window.W95HOST.userName) || '').replace(/[^\w.\-$!#%&'(){}^~@]/g, '').slice(0, 20);
  if (user && R.regGet('hklm\\network\\logon', 'username') === undefined) R.regSet('hklm\\network\\logon', 'username', str(user));
  // the providers MPR calls, in order (NetworkProvider\Order's ProviderOrder): the network device installer composes
  // it from the names the clients' INF sections leave under that key (MSNP32); with none, MPR has no network, and
  // neither do USER (SM_NETWORK) and the shell (Network Neighborhood)
  const order = 'hklm\\system\\currentcontrolset\\control\\networkprovider\\order';
  const providers = () => R.regVals(order).map(([n]) => n).filter(n => n !== 'providerorder').map(n => n.toUpperCase());
  const setOrder = () => { const p = providers(); if (p.length && R.regGet(order, 'ProviderOrder') === undefined) R.regSet(order, 'ProviderOrder', str(p.join(','))); };
  // the primary network logon is Windows Logon: one logon form (Welcome to Windows), whose name and password the
  // network client then logs on with, instead of the client's Enter Network Password before it
  const logon = 'hklm\\network\\logon', primary = W95FS.decode(((R.regGet(logon, 'PrimaryProvider') || {}).data) || new Uint8Array(0)).replace(/\0.*$/, '');
  if (primary === '' || primary === 'Microsoft Network') R.regSet(logon, 'PrimaryProvider', str('Windows Logon'));
  if (R.regGet('hklm\\enum\\root\\net\\0000', 'Driver') !== undefined) { setOrder(); return; }
  const cls = 'hklm\\system\\currentcontrolset\\services\\class\\';
  const set = (k, o) => { for (const [n, v] of Object.entries(o)) R.regSet(k, n, typeof v === 'string' ? str(v) : v); };
  // the card
  infAddReg(infs['NET.INF'], 'ClassAddReg', cls + 'net'); infAddReg(infs['NETTRANS.INF'], 'NetTrans.AddReg', cls + 'nettrans'); infAddReg(infs['NETCLI.INF'], 'NetClientReg', cls + 'netclient');
  infAddReg(infs['NETNOVEL.INF'], 'ne2000.ndi.reg', cls + 'net\\0000');
  infAddReg(infs['NETNOVEL.INF'], 'NE2000.params.reg', cls + 'net\\0000');
  set(cls + 'net\\0000', { DriverDesc: 'NE2000 Compatible', InfPath: 'NETNOVEL.INF', InfSection: '*pnp80d6.ndi', IOBaseAddress: '300', InterruptNumber: '5' });
  set('hklm\\enum\\root\\net\\0000', { Class: 'Net', Driver: 'Net\\0000', DeviceDesc: 'NE2000 Compatible', HardwareID: '*PNP80D6', Mfg: 'Novell/Anthem', ConfigFlags: bin(0, 0, 0, 0) });
  R.regSet('hklm\\enum\\root\\net\\0000\\bindings', 'NETBEUI\\0000', str(''));
  // the protocol
  infAddReg(infs['NETTRANS.INF'], 'NETBEUI.ndi.reg', cls + 'nettrans\\0000');
  infAddReg(infs['NETTRANS.INF'], 'NETBEUI.AddReg', cls + 'nettrans\\0000');
  set(cls + 'nettrans\\0000', { DriverDesc: 'NetBEUI', InfPath: 'NETTRANS.INF', InfSection: 'NETBEUI.ndi' });
  set('hklm\\enum\\network\\netbeui\\0000', { Class: 'NetTrans', Driver: 'NetTrans\\0000', MasterCopy: 'Enum\\Network\\NETBEUI\\0000', DeviceDesc: 'NetBEUI', CompatibleIDs: 'NETBEUI', Mfg: 'Microsoft', ConfigFlags: bin(0x10, 0, 0, 0) });
  R.regSet('hklm\\enum\\network\\netbeui\\0000\\bindings', 'VREDIR\\0000', str(''));
  // the client and its provider
  for (const sec of ['VREDIR.ndi.reg', 'VREDIR.AddReg', 'MSNP32.AddReg']) infAddReg(infs['NETCLI.INF'], sec, cls + 'netclient\\0000');
  set(cls + 'netclient\\0000', { DriverDesc: 'Client for Microsoft Networks', InfPath: 'NETCLI.INF', InfSection: 'VREDIR.ndi' });
  set('hklm\\enum\\network\\vredir\\0000', { Class: 'NetClient', Driver: 'NetClient\\0000', MasterCopy: 'Enum\\Network\\VREDIR\\0000', DeviceDesc: 'Client for Microsoft Networks', CompatibleIDs: 'VREDIR', Mfg: 'Microsoft', ConfigFlags: bin(0x10, 0, 0, 0) });
  // the network's static VxDs and the machine's identity on it
  for (const sec of ['NET_VNETBIOS.add.reg', 'NET_NDIS386.add.reg']) infAddReg(infs['NET.INF'], sec);
  set('hklm\\system\\currentcontrolset\\services\\vxd\\vnetsup', { ComputerName: 'WIN95', Workgroup: 'WORKGROUP', Comment: '' });
  set('hklm\\system\\currentcontrolset\\control\\computername\\computername', { ComputerName: 'WIN95' });
  set('hklm\\network\\logon', { LMLogon: bin(0, 0, 0, 0) });
  setOrder();
  mediaResources();   // the devnodes ahead of the sound card's in Enum's order have changed
}

// ---------------------------------------------------------------- Windows programs on the native USER
// A program the system bundle carries (NOTEPAD.EXE) runs as Windows 95 runs it: its own code on USER32, USER.EXE, GDI
// and the display driver, all recompiled, in a machine of its own whose screen is an ET4000 mode no larger than the
// shell's. Each visible top-level window USER has on that screen is a window of the shell at the same place, drawn
// from the machine's framebuffer and kept in USER's order; the mouse goes to USER while it is over one of them or USER
// holds the capture (menus, dragging), and the keys while one of them is the active window.
const nativeApps = new Set();
// the display mode for the system's machine: the page's viewport at its own pixels (the page is the monitor
// EXPLORER.EXE's screen is shown on); 640x480 at the least, 1024 on a side at most (the display driver's longest scan
// line and its memory count: ne16.js displaySlot). A viewport larger than that gets a 1024-wide or 1024-tall screen, centered
// (the custom mode has the driver's 1024-byte scan lines in the 1 MB its memory count finds, so 960 lines at most: a
// mode of a full megabyte, 1024 by 1024, the driver refuses and falls back from)
const nativeMode = () => [Math.max(640, Math.min(1024, Math.floor(innerWidth / ZOOM))), Math.max(480, Math.min(960, Math.floor(innerHeight / ZOOM)))];
// the mode the system's machine boots in, as Display Properties leaves it for the display driver: Display\Settings
// under the current configuration (Resolution "w,h", BitsPerPixel), read by the display driver as it is enabled; the one
// the page's viewport holds, so no change is needed once the shell is up
function bootMode(w, h) {
  const str = v => ({ type: 1, data: W95FS.encode(v + '\0') }), bpp = bootBpp();
  for (const k of ['hkcc\\display\\settings', 'hklm\\config\\0001\\display\\settings']) { W95Win32.regSet(k, 'Resolution', str(`${w},${h}`)); W95Win32.regSet(k, 'BitsPerPixel', str(String(bpp))); }
  W95Win32.iniSet(fs, 'SYSTEM.INI', 'display', 'BitsPerPixel', String(bpp));   // (the display VxD's configuration, ne16.js displayConfig)
  // the hardware profile CONFIGMG starts in, as it records it at boot (Control\IDConfigDB): the one Setup made,
  // 0001, which Device Manager's Hardware Profiles page lists by its friendly name
  const idc = 'hklm\\system\\currentcontrolset\\control\\idconfigdb';
  if (W95Win32.regGet(idc, 'CurrentConfig') === undefined) W95Win32.regSet(idc, 'CurrentConfig', str('0001'));
  if (W95Win32.regGet(idc, 'FriendlyName0001') === undefined) W95Win32.regSet(idc, 'FriendlyName0001', str('Original Configuration'));
}
// high color: the screen the system's machine boots in (the page scans 8, 16, 24 and 32 bits a pixel out)
const BOOT_BPP = 16, SCAN_BPP = new Set([4, 8, 16, 24, 32]);
/** the bytes of VRAM a screen of a's mode reads: its lines, or the four 64K planes of a 16-color mode */
const scanBytes = a => (a.bpp === 4 ? 0x40000 : a.pitch * a.h);
/** the depth the system's machine boots in: Windows' own setting for the configuration (Display\Settings'
 *  BitsPerPixel, which Display Properties rewrites and Setup sets to High Color as it installs the adapter,
 *  setupDisplayDevices); High Color without one */
function bootBpp() {
  const v = W95Win32.regGet('hkcc\\display\\settings', 'BitsPerPixel'), reg = parseInt(v && v.data ? W95FS.decode(v.data) : v, 10);
  return SCAN_BPP.has(reg) ? reg : BOOT_BPP;
}
/** the size the system's machine boots at: the page's, when its screen and the display driver's off-screen caches fit
 *  the adapter's 4 MB (TSENG.DRV counts the W32's memory through its segment selects); else the largest of the
 *  driver's sizes that fits */
function bootSize() {
  const [w, h] = nativeMode(), bpp = bootBpp(), fits = (x, y) => x * y * (bpp >> 3) + 0x10000 <= 4 << 20;
  if (bpp === 4) return [[800, 600], [640, 480]].find(([x, y]) => x <= w && y <= h) || [640, 480];   // (16 colors: VGA.DRV's 640x480 or SUPERVGA.DRV's 800x600, no other)
  if (fits(w, h)) return [w, h];
  return [[1024, 768], [800, 600], [640, 480]].find(([x, y]) => x <= w && y <= h && fits(x, y)) || [640, 480];
}
/** one pixel of a scanned-out screen, as the canvas's 32-bit ABGR: through the DAC at 8 bits, else the pixel's own
 *  RGB (16: 5-6-5 when the Sierra DAC's command register says so (E0h), else 5-5-5; 24 and 32: B, G, R in memory) */
/** a row of a scanned-out screen (x0..x1 of the line at byte s) into d from o: one tight loop for each depth */
function scanRow(a, v, pal, d, o, s, x0, x1) {
  if (a.bpp === 8) { for (let x = x0; x < x1; x++) d[o + x] = pal[v[s + x]]; return; }
  if (a.bpp === 4) {   // (a pixel's four bits from the four planes, 64K apart, high bit first; through the attribute palette to the DAC)
    const at = a.attr, wide = at[0x10] & 0x80, m = wide ? 0x0f : 0x3f, sel = wide ? (at[0x14] & 0x0f) << 4 : (at[0x14] & 0x0c) << 4;
    for (let x = x0; x < x1; x++) {
      const i = s + (x >> 3), b = 7 - (x & 7);
      d[o + x] = pal[(at[(v[i] >> b & 1) | (v[i + 0x10000] >> b & 1) << 1 | (v[i + 0x20000] >> b & 1) << 2 | (v[i + 0x30000] >> b & 1) << 3] & m) | sel];
    }
    return;
  }
  if (a.bpp === 16 && (a.dacMode & 0xe0) !== 0xe0) {
    for (let x = x0, i = s + 2 * x0; x < x1; x++, i += 2) { const c = v[i] | v[i + 1] << 8, r = c >> 10 & 31, g = c >> 5 & 31, b = c & 31; d[o + x] = 0xff000000 | (b << 3 | b >> 2) << 16 | (g << 3 | g >> 2) << 8 | (r << 3 | r >> 2); }
    return;
  }
  for (let x = x0; x < x1; x++) d[o + x] = scanPx(a, v, pal, s, x);
}
function scanPx(a, v, pal, s, x) {
  switch (a.bpp) {
    case 8: return pal[v[s + x]];
    case 16: {
      const i = s + 2 * x, c = v[i] | v[i + 1] << 8;
      if ((a.dacMode & 0xe0) === 0xe0) { const r = c >> 11, g = c >> 5 & 63, b = c & 31; return (0xff000000 | (b << 3 | b >> 2) << 16 | (g << 2 | g >> 4) << 8 | (r << 3 | r >> 2)) >>> 0; }
      const r = c >> 10 & 31, g = c >> 5 & 31, b = c & 31; return (0xff000000 | (b << 3 | b >> 2) << 16 | (g << 3 | g >> 2) << 8 | (r << 3 | r >> 2)) >>> 0;
    }
    case 24: { const i = s + 3 * x; return (0xff000000 | v[i] << 16 | v[i + 1] << 8 | v[i + 2]) >>> 0; }
    default: { const i = s + 4 * x; return (0xff000000 | v[i] << 16 | v[i + 1] << 8 | v[i + 2]) >>> 0; }
  }
}
// the app's window is the monitor: its content takes the size of the mode the system's machine is in, at the page's
// pixels, so the screen fills it with nothing around (the display driver sets the resolutions of its table and no
// other, so the window follows the mode, not the mode the window). A browser page has no window to size
function fitWindow(w, h) { const s = window.W95HOST && window.W95HOST.screen; if (s) s.fit(w * ZOOM, h * ZOOM); }
// the system's machine follows the page: once its viewport holds another of the adapter's modes (the display driver,
// FRAMEBUF.DRV, sets the resolutions of its own table and no other), the machine is asked for it; a mode it did not
// take is not asked for again until the viewport changes
function syncMode() {
  const a = sysApp; if (!a || !a.alive || !a.setMode) return;
  const [w, h] = bootSize();
  if ((w === a.sw && h === a.sh) || (a.modeRefused || []).some(([x, y]) => x === w && y === h)) return;
  a.setMode(w, h).then(() => { if (a.alive) syncMode(); });
}
async function nativeProgram(bytes) {
  const progs = (window.W95SYSTEM || {}).programs || {}, sha = await sha256hex(bytes);
  for (const [name, d] of Object.entries(progs)) if (d.meta.sha256 === sha) return { name, d };
  return null;
}
// the files the bundle carries for programs replace the placeholders an older disk has for them
function installPrograms() {
  const stub = exeStub(), S = window.W95SYSTEM || {};
  const put = (path, b64) => {
    let cur = null; try { cur = fs.readFile(path); } catch (_) { /* not there */ }
    if (cur && !(cur.length === stub.length && cur.every((b, i) => b === stub[i]))) return;
    fs.writeFile(path, b64bytes(b64));
  };
  const IN_SYSTEM = new Set(['SPOOL32.EXE', 'SYSTRAY.EXE', 'MPREXE.EXE']);   // the programs Setup puts in SYSTEM rather than the Windows folder (COPY.INF: LDID 11; MPR starts MPREXE from there)
  for (const [name, d] of Object.entries(S.programs || {})) if (!d.onCD) put(join(WINDIR, IN_SYSTEM.has(name) ? 'SYSTEM' : '', name), d.file);   // (one the CD runs from the disc: Hover!)
  // the system modules the programs run on, in SYSTEM as Setup puts them (SHELL32 reads its icons from its file)
  for (const [name, d] of Object.entries({ ...S.dlls, ...S.net, ...S.drivers })) if (!d.onCD) put(join(WINDIR, 'SYSTEM', name), d.file);
  for (const d of Object.values(S.ne || {})) if (d.fileName && !d.onDisk) put(join(WINDIR, d.fileName === 'PROGMAN.EXE' ? '' : 'SYSTEM', d.fileName), d.file);   // (a printer driver: as the Add Printer wizard copies it; Program Manager in the Windows folder, COPY.INF)
}
class NativeWin extends Win {
  constructor(app, n) {
    super({ resizable: false, maximizable: false, icon: app.iconOf(n) });
    this.app = app; this.hwnd = n.key || n.hwnd; this.guestHwnd = n.hwnd; this.ownerPid = n.ownerPid || 0; this.win32 = !!n.win32; this.native = true;
    this.noTask = !!n.owner || n.cls === '#32768' || !n.title;
    this.minimizable = !this.noTask;
    this.set(n);
  }
  set(n) {
    Object.assign(this, { x: n.x, y: n.y, w: n.w, h: n.h, title: n.title, min: n.iconic, cls: n.cls, transparent: !!(n.ex & 0x20), preview: !!n.preview, guestParent: n.parent || 0 });
    if (n.pixels) {
      if (!this.surface || this.surface.width !== n.w || this.surface.height !== n.h) { this.surface = mkc(n.w, n.h); this.surfaceCtx = this.surface.getContext('2d'); }
      const image = this.surfaceCtx.createImageData(n.w, n.h); image.data.set(n.pixels); this.surfaceCtx.putImageData(image, 0, 0);
      if (this.preview && windows.some(w => w.title === 'Display Properties')) dirty();
    }
  }
  // a WS_EX_TRANSPARENT window (MPR's MPRTransparentDesktop behind the logon) shows what is under it
  draw() { if (!this.transparent && !this.preview) this.app.blit(this); }
  hit(px, py) { return inR(this, px, py) ? 'native' : null; }
  buttons() { return []; }
  barItems() { return []; }
}
// scan codes (set 1) by KeyboardEvent.code; E0-prefixed keys carry 0x100
const SCAN = (() => {
  const t = { Escape: 1, Minus: 12, Equal: 13, Backspace: 14, Tab: 15, BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
    Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43, Comma: 51, Period: 52, Slash: 53, ShiftRight: 54,
    NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58, NumLock: 69, ScrollLock: 70, NumpadSubtract: 74, NumpadAdd: 78,
    NumpadDecimal: 83, F11: 87, F12: 88, ControlRight: 0x11d, AltRight: 0x138, NumpadEnter: 0x11c, NumpadDivide: 0x135,
    Home: 0x147, ArrowUp: 0x148, PageUp: 0x149, ArrowLeft: 0x14b, ArrowRight: 0x14d, End: 0x14f, ArrowDown: 0x150, PageDown: 0x151,
    Insert: 0x152, Delete: 0x153 };
  '1234567890'.split('').forEach((c, i) => { t['Digit' + c] = 2 + i; });
  ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'].forEach((r, k) => r.split('').forEach((c, i) => { t['Key' + c] = [0x10, 0x1e, 0x2c][k] + i; }));
  for (let i = 1; i <= 10; i++) t['F' + i] = 0x3a + i;
  [[7, 0x47], [8, 0x48], [9, 0x49], [4, 0x4b], [5, 0x4c], [6, 0x4d], [1, 0x4f], [2, 0x50], [3, 0x51], [0, 0x52]].forEach(([n, c]) => { t['Numpad' + n] = c; });
  return t;
})();
class NativeApp {
  constructor(path, arg, o = {}) { this.path = path; this.arg = arg; this.net = !!o.net; this.system = !!o.system; this.quiet = !!o.quiet; this.alive = true; this.wins = new Map(); this.icon = EXE_ICON[basename(path).toUpperCase()] || 'app'; this.lastActive = 0; this.cursorOn = false; }
  async start(bytes, prog) {
    const S = window.W95SYSTEM;
    await systemCompiled();
    // the system's machine has no image of its own: its layout is any program's
    if (!prog) prog = { name: 'MSGSRV32.EXE', d: { meta: Object.values(S.programs)[0].meta, mod: Promise.resolve(null) } };
    if (!prog.d.mod) prog.d.mod = WebAssembly.compile(b64bytes(prog.d.wasm));
    const module = await prog.d.mod;
    const dlls = new Map();
    for (const [n, d] of Object.entries({ ...S.dlls, ...(this.net ? S.net : {}) })) { d.bytes = d.bytes || b64bytes(d.file); dlls.set(n.replace(/\.DLL$/, ''), { file: d.bytes, module: d.mod, meta: d.meta }); }
    // the network's DLLs for a program that imports them (MSPRINT2's MPR): compiled as one is first loaded
    if (!this.net) for (const [n, d] of Object.entries(S.net || {})) dlls.set(n.replace(/\.DLL$/, ''), {
      get file() { return d.bytes || (d.bytes = b64bytes(d.file)); }, meta: d.meta,
      get module() { return d.mod instanceof WebAssembly.Module ? d.mod : (d.modSync || (d.modSync = new WebAssembly.Module(b64bytes(d.wasm)))); } });
    [this.sw, this.sh] = this.system ? bootSize() : nativeMode(); if (this.system) bootMode(this.sw, this.sh);
    const host = {
      fs, width: this.sw, height: this.sh, path: this.path, now: () => performance.now(), net: this.net, vmPages: 2048,   // 128 MiB of address space to reserve
      shared: true,   // (the system's modules take shared memory: the machines in workers share theirs with the page)
      cursor: () => ({ x: mouse.x, y: mouse.y }), surface: (h, w, hh) => mkc(w, hh).getContext('2d'), setCursor: () => {},
      exited: (code, why) => this.exited(code, why, true), boot: p => p.bootUser16(), exec: (cmd, show) => this.exec(cmd, show),
      // the display in and out of message mode (a blue screen), and the machine's reset (the keyboard controller's)
      msgMode: on => { msgApp = on ? this : msgApp === this ? null : msgApp; dirty(); }, reset: () => machineReset(),
      // KERNEL32's unhandled-exception filter: its fault dialog for this program (which then ends)
      faultDialog: f => faultDialog(this.progName(), f),
    };
    const exe = /\s/.test(this.path) ? `"${this.path}"` : this.path;
    try {
      this.proc = new W95Win32.Process(bytes, module, { ...prog.d.meta, name: prog.name.replace(/\.EXE$/, '') }, host, this.arg ? `${exe} ${this.arg}` : exe, dlls);
      this.proc.soundQuiet = this.quiet;   // (sound.js: the card's output off for the one sound)
      if (this.system && !this.proc.trapped && !this.proc.startTask16('MSGSRV32.EXE')) throw new Error('MSGSRV32.EXE did not start');
    }
    catch (e) { console.error(e); this.exited(-1, e.message); return false; }
    if (this.proc.trapped) { this.exited(-1, this.proc.trapped); return false; }
    { const a = this.proc.scanout(); if (a.bpp) [this.sw, this.sh] = [a.w, a.h]; }   // the mode the display driver set
    this.cv = mkc(this.sw, this.sh); this.cx = this.cv.getContext('2d'); this.img = this.cx.createImageData(this.sw, this.sh);
    this.ov = mkc(this.sw, this.sh); this.ox = this.ov.getContext('2d'); this.oimg = this.ox.createImageData(this.sw, this.sh); this.o32 = new Uint32Array(this.oimg.data.buffer);
    this.d32 = new Uint32Array(this.img.data.buffer); this.pal = new Uint32Array(256);
    if (!this.system) try {
      // its windows stay above the taskbar (the system's machine is the screen: its work area is its shell's to set)
      const p = this.proc, r = p.wbufLin || (p.nativeWindows(), p.wbufLin);
      p.w16(r, 0); p.w16(r + 2, 0); p.w16(r + 4, Math.min(this.sw, W)); p.w16(r + 6, Math.min(this.sh, workH()));
      p.user16(483, [['w', 47], ['w', 0], ['l', p.wbufSel << 16], ['w', 0]]);   // SPI_SETWORKAREA
    } catch (e) { console.error(e); }
    nativeApps.add(this);
    this.step(); return true;
  }
  step() {
    clearTimeout(this.timer); this.timer = 0;
    if (!this.alive) return;
    const p = this.proc, t0 = performance.now();
    // ring-0 work that stopped (blocked, or a blue screen waiting for its key) goes on, and nothing else runs meanwhile
    if (p.r0Runs && p.r0Runs.length) {
      try { p.r0Step(); } catch (e) { console.error(e); this.exited(-1, e.message); return; }
      if (msgApp === this) dirty();
      if (!(p.r0Runs && p.r0Runs.length) && this.afterR0) { const go = this.afterR0; this.afterR0 = null; go(); }
      if (this.alive) this.timer = setTimeout(() => this.step(), 16);
      return;
    }
    if (this.stopped) return;   // (its fault dialog is up: it ends when that closes)
    if (!p.win16Held && p.k32CloseRequest && p.k32CloseRequest()) closeProgram(this);   // REBOOT's APC: Close Program
    this.keysFed = 0; this.feedKeys();
    // while a thread holds the Win16Lock it gave up the processor in (or hung in), only it runs: USER's timers, the
    // system thread, appy time and the other threads wait for it; the VMM's time-outs still come (ring 0)
    try {
      for (let n = 0; this.alive && n < 4; n++) {
        p.stats.slices++; const live = p.slice();
        if (!p.win16Held) { p.timers16(); p.threads16(); p.systemPump(); p.appy16(); }
        else { p.threads16(); if (p.vxdRunTimeOuts) p.vxdRunTimeOuts(); }
        if (p.sound16) p.sound16(); if (p.lanPoll) p.lanPoll();
        if (!live || p.preempted || p.win16Held) break;   // its time ran out: the page gets its turn
      }
    } catch (e) {
      if (e instanceof W95Win32.FaultError) { p.depth = 0; p.faulted(e.fault); }   // (in a call the host made)
      else if (!(e instanceof W95Win32.HangError)) { console.error(e); this.exited(-1, e.message); return; }
      else { p.hung('host', e); p.depth = 0; }   // a call the host made into it never came back: the system is frozen behind it
    }
    // a processor exception nothing handled: at ring 0 VWIN32's blue screen, then the program ends; else KERNEL32's
    // fault dialog for it, and it ends when the dialog closes
    if (p.fault && !this.faultTaken) {
      this.faultTaken = true;
      if (p.fault.ring === 0) { fatalException(this, p.fault); if (this.alive) this.timer = setTimeout(() => this.step(), 16); return; }
      this.stopped = true; faultDialog(this.progName(), p.fault, () => this.exited(-1)); return;
    }
    p.stats.guestMs += performance.now() - t0;
    // a program the system started that performed an illegal operation: it alone is shut down
    for (const f of (p.pcFaults || []).splice(0)) {
      f.pc.fault = true; emit('program.exit', { path: f.pc.path, code: -1, why: f.why });
      if (f.fault) faultDialog(basename(f.pc.path).replace(/\.[^.]*$/, '').toUpperCase(), f.fault);
      else msgBox(basename(f.pc.path), `This program has performed an illegal operation and will be shut down.\n\n${f.why}`, 'error', ['OK'], null, { noTask: false, modal: false });
    }
    if (p.trapped && !p.failed) p.fail(p.trapped);
    if (p.exitCode !== null || p.trapped) { this.exited(p.exitCode, p.trapped); return; }
    if (!p.win16Held) { this.sync(); this.clipHandoff(); }   // its windows as USER has them (not while USER is held)
    else dirty();   // (its screen, as it is drawn meanwhile)
    this.timer = setTimeout(() => this.step(), this.keyq && this.keyq.length ? 0 : 16);
  }
  /** the program's module name, as KERNEL32's messages name it */
  progName() { return basename(this.path).replace(/\.[^.]*$/, '').toUpperCase(); }
  /** ring-0 runs stopped mid-way (a blue screen up): the system takes nothing else until they are done */
  ring0() { return !!(this.proc && this.proc.r0Runs && this.proc.r0Runs.length); }
  // the keyboard as VKD sees it first: its hot keys (Ctrl+Alt+Del) and, in message mode, every key. True when it took it
  vkd(e, up) {
    const p = this.proc; if (!p || !p.vkdKey || !this.alive) return false;
    let sc = SCAN[e.code] || 0;
    if (e.code === 'Backspace' && e.ctrlKey && e.altKey) sc = 0x153;   // a Mac's Delete key: Ctrl+Alt+Del
    if (!sc) return false;
    try { return p.vkdKey(sc & 0xff, sc > 0xff, up, { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey }); } catch (err) { console.error(err); return false; }
  }
  /** a window's icon: its program's (in the system's machine, the program of the process whose task made it) */
  iconOf(n) {
    const pc = n && n.task && this.proc && [...(this.proc.procs || new Map()).values()].find(c => c.tdb === n.task);
    return pc ? EXE_ICON[basename(pc.path).toUpperCase()] || 'app' : this.icon;
  }
  // WinExec and CreateProcess from the program: a program the system runs starts in this one's address space, on its
  // window system (P.spawn). An instance handle (above 31) on success, else WinExec's error: 2 not found, 11 not a
  // program this system runs, 8 its image's place already taken here (a second instance of the same program)
  exec(cmd, show) {
    const m = /^\s*(?:"([^"]+)"|(\S+))\s*(.*)$/.exec(cmd || ''); if (!m) return 2;
    let path = m[1] || m[2]; const arg = m[3];
    if (!extname(path)) path += '.exe';
    const file = (/^[a-z]:|^\\/i.test(path) ? [path] : [join(WINDIR, path), join(WINDIR, 'SYSTEM', path), join(fs.cwd, path)]).find(f => fs.exists(f));
    if (!file) return 2;
    // a Windows (16-bit) program of the system's: a task of this machine's, as KERNEL's WinExec starts one
    const ne = Object.values((window.W95SYSTEM || {}).ne || {}).find(d => d.fileName === basename(file).toUpperCase() && /\.EXE$/.test(d.fileName));
    if (ne) return this.proc.winExec16(ne.fileName, arg || '', show === undefined ? 1 : show);
    return this.spawnProgram(file, arg);
  }
  /** a program the system bundle carries, started in this machine: its process, or WinExec's error (11 not one this
   *  system runs, 8 its image's place already taken here: a second instance of the same program) */
  spawnProgram(file, arg) {
    const S = window.W95SYSTEM || {}, p = this.proc;
    const name = basename(file).toUpperCase(), d = (S.programs || {})[name]; if (!d) return 11;
    if (p.pc0 && p.pc0.exe && p.pc0.exe.base === d.meta.base) return 8;   // (the machine's own program: one instance)
    const live = [...(p.procs || new Map()).values()].some(x => x.exe.base === d.meta.base);   // (then the instances share its image: P.spawn)
    if (!live) p.modules = p.modules.filter(x => x.base !== d.meta.base);   // an ended process's image: loaded afresh
    let pc;
    try {
      const mod = d.modSync || (d.modSync = new WebAssembly.Module(b64bytes(d.wasm)));
      pc = p.spawn(fs.readFile(file), mod, { ...d.meta, name: name.replace(/\.EXE$/, '') }, fs.realpath(file), arg ? `${fs.realpath(file)} ${arg}` : fs.realpath(file));
    } catch (e) { console.error(e); return 8; }
    pc.onExit = code => { if (!pc.fault) emit('program.exit', { path: pc.path, code }); };
    this.kick();
    return pc;
  }
  // one clipboard across programs: each process's USER keeps its own, so the text moves through the shell's when the
  // keyboard moves: the program losing it leaves its CF_TEXT as the shell's text, the one gaining it is given that
  clipHandoff() {
    const mine = !!(active && active.native && active.app === this);
    if (mine && clipOwner !== this) {
      if (clipOwner && clipOwner.alive) clipOwner.clipOut();
      clipOwner = this; this.clipIn();
    } else if (!mine && clipOwner === this && !(active && active.native)) { this.clipOut(); clipOwner = null; }
  }
  clipOut() {
    const p = this.proc; if (!p || p.depth) return;
    const code = p.exitCode; p.exitCode = null;   // called as the program exits too: its USER still holds the data
    try {
      if (!p.user16(137, [['w', 0]]).ax) return;                                    // OpenClipboard
      const h = p.user16(142, [['w', 1]]).ax, b = h && p.gblock(h);            // GetClipboardData(CF_TEXT)
      if (b) { const t = p.readA(b.lin, b.size).replace(/\r\n/g, '\n'); textClip = this.clipText = t; }
      p.user16(138);                                                                 // CloseClipboard
    } catch (e) { console.error(e); } finally { p.exitCode = code; }
  }
  clipIn() {
    const p = this.proc; if (!p || p.depth || textClip === this.clipText) return;
    try {
      if (!p.user16(137, [['w', 0]]).ax) return;
      p.user16(139);                                                                 // EmptyClipboard
      if (textClip) {
        const bytes = W95FS.encode(textClip.replace(/\r?\n/g, '\r\n')), h = p.globalAlloc16(0x2002, bytes.length + 1);
        p.u8.set(bytes, p.gblock(h).lin); p.u8[p.gblock(h).lin + bytes.length] = 0;
        p.user16(141, [['w', 1], ['w', h]]);                                         // SetClipboardData(CF_TEXT)
      }
      p.user16(138);
      this.clipText = textClip;
    } catch (e) { console.error(e); }
  }
  kick() { if (this.alive && this.timer) { clearTimeout(this.timer); this.timer = setTimeout(() => this.step(), 0); } }
  // the shell's windows for USER's: added, moved, retitled, closed, in USER's order, and USER's active window active
  sync() {
    let nw; try { nw = this.proc.nativeWindows(); } catch (e) { console.error(e); this.exited(-1, e.message); return; }
    const seen = new Set();
    for (const n of nw.list) {
      let w = this.wins.get(n.hwnd);
      if (!w) { w = new NativeWin(this, n); this.wins.set(n.hwnd, w); windows.push(w); if (!w.noTask) tasks.push(w); }
      else w.set(n);
      seen.add(n.hwnd);
    }
    for (const [h, w] of this.wins) if (!seen.has(h)) { this.wins.delete(h); closeWin(w, true); }
    const order = nw.list.map(n => this.wins.get(n.hwnd)).reverse(), slots = [];
    windows.forEach((w, i) => { if (w.app === this) slots.push(i); });
    slots.forEach((i, k) => { windows[i] = order[k]; });
    this.capture = nw.capture;
    if (nw.active !== this.lastActive) {
      this.lastActive = nw.active;
      const w = this.wins.get(nw.active); if (w && !w.min) { this.syncing = true; activate(w); this.syncing = false; }
    }
    this.paint(); dirty();
  }
  // the framebuffer under this program's windows, through the DAC, into the canvas they are drawn from
  paint() {
    // a program with nothing on the screen (no window of its own, no capture: the network's MPREXE) shows nothing: its
    // overlay is cleared once and the screen is not read
    if (!this.wins.size && !this.capture) { if (!this.blank) { this.o32.fill(0); this.ox.putImageData(this.oimg, 0, 0); this.blank = true; } return; }
    this.blank = false;
    const a = this.proc.scanout(); if (!SCAN_BPP.has(a.bpp)) return;
    const pal = this.pal, dac = a.dac, v = a.vram, pitch = a.pitch || a.w, d = this.d32, sw = this.sw, sh = this.sh;
    for (let i = 0; i < 256; i++) { const r = dac[3 * i], g = dac[3 * i + 1], b = dac[3 * i + 2]; pal[i] = 0xff000000 | ((b << 2 | b >> 4) << 16) | ((g << 2 | g >> 4) << 8) | (r << 2 | r >> 4); }
    for (const w of this.wins.values()) {
      if (w.min || w.transparent) continue;
      const x0 = Math.max(0, w.x), y0 = Math.max(0, w.y), x1 = Math.min(sw, a.w, w.x + w.w), y1 = Math.min(sh, a.h, w.y + w.h);
      if (x1 <= x0 || y1 <= y0) continue;
      for (let y = y0; y < y1; y++) scanRow(a, v, pal, d, y * sw, y * pitch, x0, x1);
      this.cx.putImageData(this.img, 0, 0, x0, y0, x1 - x0, y1 - y0);
    }
    // the rest of its screen: what USER draws on its desktop (its cursor, a window's drag frame) over the desktop
    // color, which is the shell's desktop showing through
    // (GetSysColor(COLOR_BACKGROUND), at the DAC's 6 bits a component as the palette above has it)
    const six = c => (c >> 2) << 2 | (c >> 2) >> 4;
    let bg = 0; try { const c = this.proc.user16(180, [['w', 1]]); bg = 0xff000000 | six(c.dx & 0xff) << 16 | six(c.ax >> 8 & 0xff) << 8 | six(c.ax & 0xff); bg >>>= 0; } catch (e) { console.error(e); }
    const o = this.o32, wins = [...this.wins.values()].filter(w => !w.min && !w.transparent);   // (a WS_EX_TRANSPARENT window draws nothing: what is under it shows)
    for (let y = 0; y < sh; y++) {
      const s = y * pitch, r = y * sw, ins = wins.filter(w => y >= w.y && y < w.y + w.h);
      for (let x = 0; x < sw; x++) {
        const c = y < a.h && x < a.w ? (a.bpp === 8 ? pal[v[s + x]] : scanPx(a, v, pal, s, x)) : bg;
        o[r + x] = c === bg || ins.some(w => x >= w.x && x < w.x + w.w) ? 0 : c;
      }
    }
    this.ox.putImageData(this.oimg, 0, 0);
  }
  /** the screen as the display adapter scans it out now: its mode, VRAM and DAC */
  screenNow() { const a = this.proc.scanout(); return { w: a.w, h: a.h, pitch: a.pitch || a.w, bpp: a.bpp, dacMode: a.hicolor, attr: a.attr, vram: a.vram, dac: a.dac }; }
  /** the whole screen into the page's canvas, through the DAC (the page as the machine's monitor) */
  scanToCanvas() {
    const a = this.screenNow(); fill(0, 0, W, H, '#000');
    if (!a || !SCAN_BPP.has(a.bpp) || !this.d32) return;
    const pal = this.pal, dac = a.dac, v = a.vram, d = this.d32, sw = this.sw, w = Math.min(sw, a.w), h = Math.min(this.sh, a.h);
    for (let i = 0; i < 256; i++) { const r = dac[3 * i], g = dac[3 * i + 1], b = dac[3 * i + 2]; pal[i] = 0xff000000 | ((b << 2 | b >> 4) << 16) | ((g << 2 | g >> 4) << 8) | (r << 2 | r >> 4); }
    for (let y = 0; y < h; y++) scanRow(a, v, pal, d, y * sw, y * a.pitch, 0, w);
    this.cx.putImageData(this.img, 0, 0, 0, 0, w, h); ctx.drawImage(this.cv, 0, 0, w, h, 0, 0, w, h);
  }
  blit(w) {
    if (w.win32) { if (w.surface) ctx.drawImage(w.surface, w.x, w.y, w.w, w.h); return; }
    const x0 = Math.max(0, w.x), y0 = Math.max(0, w.y), x1 = Math.min(this.sw, w.x + w.w), y1 = Math.min(this.sh, w.y + w.h);
    if (x1 > x0 && y1 > y0) ctx.drawImage(this.cv, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  }
  // the mouse: absolute moves and button changes into USER's mouse_event, as the mouse driver reports them
  pointer(kind, x, y, btn = 0) {
    // (the mouse driver reports to USER at interrupt time, a thread holding the Win16Lock or not; not while ring 0 has
    // the machine in message mode)
    if (!this.alive || !this.proc || this.proc.depth || this.ring0()) return;
    const ax = Math.round(clamp(x, 0, this.sw - 1) * 65535 / (this.sw - 1)), ay = Math.round(clamp(y, 0, this.sh - 1) * 65535 / (this.sh - 1));
    const f = kind === 'down' ? (btn === 2 ? 8 : 2) : kind === 'up' ? (btn === 2 ? 16 : 4) : 1;
    try {
      // the move first, as the mouse reports it before the button, so USER sees the button where the pointer is
      // behind keys still waiting to go in (a click after typing reaches the program after what was typed)
      const ev = [];
      if (f !== 1 && (ax !== this.ax || ay !== this.ay)) ev.push({ mouse: [0x8001, ax, ay] });
      ev.push({ mouse: [0x8001 | f, ax, ay] }); this.ax = ax; this.ay = ay;
      if (this.keyq && this.keyq.length) this.keyq.push(...ev); else for (const m of ev) this.proc.mouseEvent16(...m.mouse);
    } catch (e) { console.error(e); }
    this.feedKeys();
    this.kick();
  }
  key(e, up) {
    if (!this.alive) return;
    const vk = e.keyCode || 0, sc = SCAN[e.code] || 0; if (vk === 91 || vk === 93 || vk === 224) return;   // the Mac command keys stay with the host
    // the modifiers as the event reports them: a Shift, Ctrl or Alt pressed or released while the page had no focus
    // (or one the browser reports only as a flag) reaches USER before the key it changes
    this.mods = this.mods || {};
    for (const [m, on, code] of [[16, e.shiftKey, 'ShiftLeft'], [17, e.ctrlKey, 'ControlLeft'], [18, e.altKey, 'AltLeft']]) {
      if (m === vk || on === undefined || !!this.mods[m] === !!on) continue;
      this.mods[m] = on; (this.keyq = this.keyq || []).push([m, SCAN[code] || 0, !on]);
    }
    if (vk === 16 || vk === 17 || vk === 18) this.mods[vk] = !up;
    if (vk) (this.keyq = this.keyq || []).push([vk, sc, up]);
    // USER's system queue holds a limited number of events: a burst (fast or synthetic typing) goes in a few at a
    // time between slices, so the program takes each batch off before the next arrives, as a keyboard buffer would
    this.feedKeys();
    this.kick();
  }
  feedKeys() {
    if (!this.keyq || !this.keyq.length || this.proc.depth || this.ring0()) return;   // (the keyboard driver's, at interrupt time too)
    try { if (this.proc.user16(335).ax) return; } catch (e) { console.error(e); }   // GetInputState: USER has input not yet taken
    for (; this.keyq.length && (this.keysFed || 0) < 16; this.keysFed = (this.keysFed || 0) + 1) {
      const k = this.keyq.shift();
      if (k.mouse) { try { this.proc.mouseEvent16(...k.mouse); } catch (err) { console.error(err); } continue; }
      const [vk, sc, up] = k;
      try { this.proc.keyEvent16(vk, sc & 0xff, up, sc > 0xff); } catch (err) { console.error(err); }
    }
  }
  // Ctrl or Alt with a character the event names without its key (synthetic events): that key, pressed and released
  // with the modifiers held, which are then let go
  chord(e) {
    const c = e.key.toUpperCase(), k = { keyCode: c.charCodeAt(0), code: (/\d/.test(c) ? 'Digit' : 'Key') + c, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey };
    this.key(k, false); this.key(k, true);
    this.key({ keyCode: 0, ctrlKey: false, altKey: false, shiftKey: false }, true);
  }
  // text that arrives as characters (paste, IME, synthetic typing): each as the keys of a US keyboard that type it
  typeText(str) {
    const SYM = { ' ': [32, 0], '\n': [13, 0], '\t': [9, 0], ',': [188, 0], '.': [190, 0], '/': [191, 0], ';': [186, 0], "'": [222, 0], '[': [219, 0], ']': [221, 0],
      '\\': [220, 0], '-': [189, 0], '=': [187, 0], '`': [192, 0], '<': [188, 1], '>': [190, 1], '?': [191, 1], ':': [186, 1], '"': [222, 1], '{': [219, 1],
      '}': [221, 1], '|': [220, 1], '_': [189, 1], '+': [187, 1], '~': [192, 1], ')': [48, 1], '!': [49, 1], '@': [50, 1], '#': [51, 1], '$': [52, 1],
      '%': [53, 1], '^': [54, 1], '&': [55, 1], '*': [56, 1], '(': [57, 1] };
    const code = { 13: 'Enter', 32: 'Space', 9: 'Tab', 188: 'Comma', 190: 'Period', 191: 'Slash', 186: 'Semicolon', 222: 'Quote', 219: 'BracketLeft',
      221: 'BracketRight', 220: 'Backslash', 189: 'Minus', 187: 'Equal', 192: 'Backquote' };
    for (const ch of str) {
      let vk, shift;
      if (/[a-z]/.test(ch)) [vk, shift] = [ch.toUpperCase().charCodeAt(0), 0];
      else if (/[A-Z]/.test(ch)) [vk, shift] = [ch.charCodeAt(0), 1];
      else if (/[0-9]/.test(ch)) [vk, shift] = [ch.charCodeAt(0), 0];
      else if (SYM[ch]) [vk, shift] = SYM[ch];
      else continue;
      const c = code[vk] || (vk >= 65 && vk <= 90 ? 'Key' + String.fromCharCode(vk) : vk >= 48 && vk <= 57 ? 'Digit' + String.fromCharCode(vk) : '');
      // (each key with the Shift state it is pressed under, as a keyboard's events carry it: the machine follows the
      // modifiers a key reports)
      const sh = !!shift;
      if (sh) this.key({ keyCode: 16, code: 'ShiftLeft', shiftKey: true }, false);
      this.key({ keyCode: vk, code: c, shiftKey: sh }, false); this.key({ keyCode: vk, code: c, shiftKey: sh }, true);
      if (sh) this.key({ keyCode: 16, code: 'ShiftLeft', shiftKey: false }, true);
    }
  }
  focus(w) {
    // as the task that owns it (a window of a process this program started is that process's): restored, or made
    // active and brought to the top
    try {
      this.proc.asWindowTask(w.hwnd, () => {
        if (w.min) this.proc.user16(42, [['w', w.hwnd], ['w', 9]]);                                     // ShowWindow SW_RESTORE
        else { this.proc.user16(59, [['w', w.hwnd]]); this.proc.user16(45, [['w', w.hwnd]]); }          // SetActiveWindow, BringWindowToTop
      });
    } catch (e) { console.error(e); }
    this.kick();
  }
  minimize(w) { try { this.proc.user16(42, [['w', w.hwnd], ['w', 6]]); } catch (e) { console.error(e); } this.kick(); }   // SW_MINIMIZE
  close(w) { try { this.proc.user16(110, [['w', w.hwnd], ['w', 0x10], ['w', 0], ['l', 0]]); } catch (e) { console.error(e); } this.kick(); }   // PostMessage WM_CLOSE
  exited(code, why, own) {
    if (!this.alive) return;
    if (clipOwner === this) { if (!why && this.proc && !this.proc.trapped) this.clipOut(); clipOwner = null; }   // what it copied outlives it
    this.alive = false; clearTimeout(this.timer); nativeApps.delete(this);
    if (this.proc && this.proc.soundClose) this.proc.soundClose();
    for (const w of this.wins.values()) closeWin(w, true);
    this.wins.clear();
    emit('program.exit', { path: this.path, code, ...(why ? { why } : {}) });
    if (why) msgBox(basename(this.path), `This program has performed an illegal operation and will be shut down.\n\n${why}`, 'error', ['OK'], null, { noTask: false, modal: false });
    dirty();
    if (own && this.system && !why) systemEnded(code);
  }
}
// ---------------------------------------------------------------- a machine in a worker (worker.js)
// The program's machine runs in a worker of its own, so nothing it does holds the page: it draws into its memory,
// which the page shares and reads the screen from; the page sends it the keys and the mouse through its input ring
// (bridge.js) and asks it for what is done to its windows; it calls the page's file system synchronously (the page
// answers here). The page draws USER's windows from what the machine reports after each of its steps.
const machineWorkers = new Set();
/** a channel from machine `a` to the network's machine, for the network's files it opens (worker.js netCall): the
 *  network's machine answers on `a`'s block, which `a` waits on */
function netLink(a) {
  const n = netApp && netApp.alive && netApp.remote ? netApp : null; if (!n || a === n || a.net) return;
  const ch = new MessageChannel(), sab = new SharedArrayBuffer(16 + W95Bridge.RPC_BYTES);
  n.worker.postMessage({ t: 'netport', port: ch.port2, sab }, [ch.port2]);
  a.worker.postMessage({ t: 'netlink', port: ch.port1, sab }, [ch.port1]);
  a.worker.postMessage({ t: 'netmounts', list: netMounts });
}
let netMounts = [];   // the drives the network has connected: { letter, unc }
W95Win32.regWatch(o => { for (const a of machineWorkers) a.worker.postMessage({ t: 'regop', o }); });
class RemoteApp extends NativeApp {
  constructor(path, arg, o = {}) { super(path, arg, o); this.remote = true; this.calls = new Map(); this.nextCall = 1; this.stats = { slices: 0, guestMs: 0 }; this.held = null; }
  // what the shell's older code reads of a machine (its counters; a program that has not exited)
  get proc() { return { stats: this.stats, exitCode: this.alive ? null : 0, trapped: null, depth: 0, win16Held: this.held, r0Runs: this.r0 ? [1] : [], txt: this.txt }; }
  start(bytes, prog) {
    [this.sw, this.sh] = this.system ? bootSize() : nativeMode(); if (this.system) bootMode(this.sw, this.sh);
    this.ring = W95Bridge.newRing(); this.rpcSab = new SharedArrayBuffer(16 + W95Bridge.RPC_BYTES);
    if (this.net || this.system) this.lanRing = W95Bridge.newFrames();   // (the frames for its network card: the network's machine, and the system's, which runs the network stack)
    this.worker = new Worker('worker.js'); machineWorkers.add(this);
    this.worker.onmessage = e => this.message(e.data);
    this.worker.onerror = e => { console.error('[worker]', e.message); this.exited(-1, e.message); };
    this.worker.postMessage({ t: 'start', rpc: this.rpcSab, registry: W95Win32.regDump(), o: {
      path: this.path, arg: this.arg, net: this.net, system: this.system, quiet: this.quiet, sw: this.sw, sh: this.sh, shellW: W, workH: workH(), ring: this.ring, lan: this.lanRing || null,
      bytes: bytes || null, prog: prog ? { name: prog.name, meta: prog.d.meta } : null,
      trace: new URLSearchParams(location.search).get('trace'),   // (?trace=MSGSRV32: the imports that thread calls, read back with cmd 'trace')
      exp: Object.fromEntries(new URLSearchParams(location.search).getAll('exp').map(x => x.split('=')).map(([k, v]) => [k, v === 'false' ? false : v === 'true' ? true : v])) } });   // (?exp=NAME=false: a switch in the machine, for an experiment)
    return new Promise(ok => { this.started = ok; });
  }
  /** the machine's display mode changed to w by h (the page's viewport holds another mode): asked of the machine once
   *  no thread holds USER; the page's canvases for its screen follow the mode it is in after the change */
  async setMode(w, h) {
    if (this.modeBusy) return this.modeBusy;
    return (this.modeBusy = new Promise(done => {
      this.modeDone = r => { this.modeDone = null; if (r) this.modeTaken(w, h, r); done(); };
      // the machine answers at once when no thread holds USER; otherwise it makes the change as soon as none does and
      // tells (its 'mode' message)
      this.cmd('mode', [w, h]).then(r => { if (r && this.modeDone) this.modeDone(r); });
    }).finally(() => { this.modeBusy = null; }));
  }
  /** the machine's answer to a mode asked for: the mode it is in now; one it did not take is not asked for again at
   *  this viewport size */
  modeTaken(w, h, r) {
    if (r.sw !== w || r.sh !== h) (this.modeRefused = this.modeRefused || []).push([w, h]);
    if (r.sw !== this.sw || r.sh !== this.sh) this.screenSized(r.sw, r.sh);
  }
  screenSized(sw, sh) {
    [this.sw, this.sh] = [sw, sh];
    this.cv = mkc(sw, sh); this.cx = this.cv.getContext('2d'); this.img = this.cx.createImageData(sw, sh);
    this.ov = mkc(sw, sh); this.ox = this.ov.getContext('2d'); this.oimg = this.ox.createImageData(sw, sh); this.o32 = new Uint32Array(this.oimg.data.buffer);
    this.d32 = new Uint32Array(this.img.data.buffer); this.blank = false;
    if (this.system) fitWindow(sw, sh);
    resize();
  }
  /** a request to the machine; resolves to its answer */
  cmd(name, args = []) {
    if (!this.alive) return Promise.resolve(null);
    const id = this.nextCall++;
    return new Promise(ok => { this.calls.set(id, ok); this.worker.postMessage({ t: 'cmd', id, name, args }); });
  }
  message(m) {
    switch (m.t) {
      case 'rpc': this.serve(m); return;
      case 'started':
        this.mem = m.mem; [this.sw, this.sh] = [m.sw, m.sh];
        this.cv = mkc(this.sw, this.sh); this.cx = this.cv.getContext('2d'); this.img = this.cx.createImageData(this.sw, this.sh);
        this.ov = mkc(this.sw, this.sh); this.ox = this.ov.getContext('2d'); this.oimg = this.ox.createImageData(this.sw, this.sh); this.o32 = new Uint32Array(this.oimg.data.buffer);
        this.d32 = new Uint32Array(this.img.data.buffer); this.pal = new Uint32Array(256);
        if (this.system) fitWindow(this.sw, this.sh);
        nativeApps.add(this);
        // a machine with a network card (the network's, and the system's, which has the network stack as Windows does): a station on the page's segment
        if (this.lanRing) { this.lanStation = { rx: frame => { if (this.alive) W95Bridge.framePut(this.lanRing, frame); } }; this.lanDetach = window.W95LAN && W95LAN.attach(this.lanStation); }
        if (this.net) { for (const a of machineWorkers) if (a !== this) netLink(a); }
        else netLink(this);
        if (this.started) this.started(true); return;
      case 'lan': if (window.W95LAN && this.lanStation) W95LAN.send(this.lanStation, m.frame); return;
      case 'frame': this.frame(m); return;
      case 'held': this.held = m.held; this.stats = m.stats; return;
      // the screen's mode, DAC and the cursor sprite, as often as the machine runs, its window list or not (USER held)
      case 'scan': this.scr = m; this.followMode(m); dirty(); return;
      case 'mode': if (this.modeDone) this.modeDone(m.r); return;   // (a mode asked for while a thread held USER, made now)
      case 'text': this.txt = m.txt; if (msgApp === this) dirty(); return;
      case 'msgMode': msgApp = m.on ? this : msgApp === this ? null : msgApp; this.r0 = m.on; dirty(); return;
      case 'reset': machineReset(); return;
      case 'audio': if (window.W95Sound) W95Sound.play(this, m.rate, m.l, m.r); return;
      case 'regop': W95Win32.regApply(m.o); return;
      case 'closeProgram': closeProgram(this); return;
      case 'fault': faultDialog(this.progName(), m.f, () => this.exited(-1)); return;
      case 'faultDialog': faultDialog(this.progName(), m.f); return;
      case 'pcFault':
        emit('program.exit', { path: m.path, code: -1, why: m.why });
        if (m.f) faultDialog(basename(m.path).replace(/\.[^.]*$/, '').toUpperCase(), m.f);
        else msgBox(basename(m.path), `This program has performed an illegal operation and will be shut down.\n\n${m.why}`, 'error', ['OK'], null, { noTask: false, modal: false });
        return;
      case 'emit':
        if (m.ev === 'program.exit' && fullSaver && String(fullSaver.path).toUpperCase() === String(m.data.path).toUpperCase()) { fullSaver = null; lastInput = performance.now(); }
        emit(m.ev, m.data); return;
      case 'shell': { const f = window.W95SHELL[m.fn]; if (typeof f === 'function') try { f(...m.args); } catch (e) { console.error(e); } return; }
      case 'reply': { const ok = this.calls.get(m.id); this.calls.delete(m.id); if (m.error) console.error('[machine]', m.error); if (ok) ok(m.value); return; }
      case 'exited': this.exited(m.code, m.why, true); if (this.started) this.started(false); return;
    }
  }
  /** the machine's synchronous call into the page (bridge.js): the file system, and what only the page has */
  serve(m) {
    let v;
    try {
      if (m.target === 'fs') {
        if (m.method === 'getCwd') v = fs.cwd;
        else if (m.method === 'setCwd') { fs.cwd = m.args[0]; v = null; }
        else if (m.method === 'vols') v = [...fs.vols.values()].map(x => ({ letter: x.letter, kind: x.kind, label: x.label, remote: !!x.remote, unc: x.unc || '' }));
        else if (typeof fs[m.method] !== 'function') throw new Error(`the file system has no ${m.method}`);
        else v = fs[m.method](...m.args);
      } else if (m.target === 'host') {
        if (m.method === 'fatalText') v = fatalText(m.args[0]);
        else if (m.method === 'runApart') { runNative(m.args[0], m.args[1] || '', { apart: true }); v = true; }   // (it starts as the page goes on)
      }
    } catch (e) { v = e instanceof Error ? e : new Error(String(e)); }
    W95Bridge.answer(this.rpcSab, v === undefined ? null : v);
  }
  // USER's windows as the machine reported them: the shell's windows for them, its screen, its cursor
  /** the page's canvases are the size of the mode the machine is in (a mode changed from inside it too: Display
   *  Properties) */
  followMode(m) { const s = m && m.scan; if (s && s.bpp && (s.w !== this.sw || s.h !== this.sh)) this.screenSized(s.w, s.h); }
  frame(m) {
    if (this.system && bootLogo.on && m.list.length) bootLogoEnd();   // (Windows has a window up: the start-up screen goes)
    this.snap = this.scr = m; this.stats = m.stats; this.held = m.held; this.capture = m.capture; this.cursorOn = m.cursorOn; this.followMode(m);    const seen = new Set();
    for (const n of m.list) {
      const key = n.key || n.hwnd;
      let w = this.wins.get(key);
      if (!w) { w = new NativeWin(this, n); this.wins.set(key, w); windows.push(w); if (!w.noTask) tasks.push(w); }
      else w.set(n);
      seen.add(key);
    }
    for (const [h, w] of this.wins) if (!seen.has(h)) { this.wins.delete(h); closeWin(w, true); }
    const order = m.list.map(n => this.wins.get(n.key || n.hwnd)).reverse(), slots = [];
    windows.forEach((w, i) => { if (w.app === this) slots.push(i); });
    slots.forEach((i, k) => { windows[i] = order[k]; });
    if (m.active !== this.lastActive) {
      this.lastActive = m.active;
      const w = this.wins.get(m.active); if (w && !w.min) { this.syncing = true; activate(w); this.syncing = false; }
    }
    this.clipHandoff();
    this.paint(); dirty();
  }
  iconOf(n) { return n && n.prog ? EXE_ICON[n.prog] || 'app' : this.icon; }
  // (the screen as the machine last reported its mode and DAC, VRAM read where it is in the shared memory)
  screenNow() {
    const m = this.scr || this.snap; if (!m || !m.scan || !this.mem) return null; const a = m.scan;
    return { ...a, vram: new Uint8Array(this.mem, a.vram, Math.max(0, Math.min(scanBytes(a), this.mem.byteLength - a.vram))), dac: m.dac };
  }
  // the framebuffer under this program's windows, through the DAC, from the machine's memory
  paint() {
    const m = this.snap; if (!m || !this.mem) return;
    if (!this.wins.size && !this.capture) { if (!this.blank) { this.o32.fill(0); this.ox.putImageData(this.oimg, 0, 0); this.blank = true; } return; }
    this.blank = false;
    const a = m.scan; if (!SCAN_BPP.has(a.bpp)) return;
    const v = new Uint8Array(this.mem, a.vram, Math.min(scanBytes(a), this.mem.byteLength - a.vram));
    const pal = this.pal, dac = m.dac, pitch = a.pitch, d = this.d32, sw = this.sw, sh = this.sh;
    for (let i = 0; i < 256; i++) { const r = dac[3 * i], g = dac[3 * i + 1], b = dac[3 * i + 2]; pal[i] = 0xff000000 | ((b << 2 | b >> 4) << 16) | ((g << 2 | g >> 4) << 8) | (r << 2 | r >> 4); }
    for (const w of this.wins.values()) {
      if (w.min || w.transparent) continue;
      const x0 = Math.max(0, w.x), y0 = Math.max(0, w.y), x1 = Math.min(sw, a.w, w.x + w.w), y1 = Math.min(sh, a.h, w.y + w.h);
      if (x1 <= x0 || y1 <= y0) continue;
      for (let y = y0; y < y1; y++) scanRow(a, v, pal, d, y * sw, y * pitch, x0, x1);
      this.cx.putImageData(this.img, 0, 0, x0, y0, x1 - x0, y1 - y0);
    }
    const six = c => (c >> 2) << 2 | (c >> 2) >> 4, c = m.bg;
    const bg = (0xff000000 | six(c >> 16 & 0xff) << 16 | six(c >> 8 & 0xff) << 8 | six(c & 0xff)) >>> 0;
    const o = this.o32, wins = [...this.wins.values()].filter(w => !w.min && !w.transparent);
    for (let y = 0; y < sh; y++) {
      const s = y * pitch, r = y * sw, ins = wins.filter(w => y >= w.y && y < w.y + w.h);
      for (let x = 0; x < sw; x++) {
        const cc = y < a.h && x < a.w ? (a.bpp === 8 ? pal[v[s + x]] : scanPx(a, v, pal, s, x)) : bg;
        o[r + x] = cc === bg || ins.some(w => x >= w.x && x < w.x + w.w) ? 0 : cc;
      }
    }
    this.ox.putImageData(this.oimg, 0, 0);
  }
  /** the W32 sprite (USER's cursor) as the machine reported it, its image in the shared memory */
  sprite() { const m = this.scr || this.snap, s = m && m.sprite; return s && this.mem ? { ...s, bits: new Uint8Array(this.mem, s.at, 64 * s.row) } : null; }
  // the mouse and the keys: into the machine's input ring, which it takes as interrupts
  pointer(kind, x, y, btn = 0) {
    if (!this.alive || !this.ring) return;
    const f = kind === 'down' ? (btn === 2 ? 8 : 2) : kind === 'up' ? (btn === 2 ? 16 : 4) : 1;
    W95Bridge.ringPut(this.ring, W95Bridge.MOUSE, f, Math.round(x), Math.round(y));
    this.kick();
  }
  key(e, up) { this.ringKey(e, up, true); }
  ringKey(e, up, toUser) {
    if (!this.alive || !this.ring) return;
    const vk = e.keyCode || 0; if (vk === 91 || vk === 93 || vk === 224) return;   // the Mac command keys stay with the host
    let sc = SCAN[e.code] || 0;
    if (e.code === 'Backspace' && e.ctrlKey && e.altKey) sc = 0x153;   // a Mac's Delete key: Ctrl+Alt+Del
    const a = (sc & 0x1ff) | (up ? 0x200 : 0) | (toUser ? 0x400 : 0), b = (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0);
    W95Bridge.ringPut(this.ring, W95Bridge.KEY, a, b, vk);
    this.kick();
  }
  // VKD's first look at a key the program does not have the focus for: Ctrl+Alt+Del, and every key in message mode
  vkd(e, up) {
    if (!this.alive) return false;
    const cad = e.ctrlKey && e.altKey && (e.code === 'Delete' || e.code === 'Backspace' || e.code === 'NumpadDecimal');
    if (msgApp !== this && !cad) return false;
    this.ringKey(e, up, false); return true;
  }
  feedKeys() {}
  ring0() { return !!this.r0; }
  kick() { if (this.worker) this.worker.postMessage({ t: 'kick' }); }
  focus(w) { if (!w.win32) this.cmd('focus', [w.hwnd, !!w.min]); }
  minimize(w) { if (!w.win32) this.cmd('minimize', [w.hwnd]); }
  close(w) { this.cmd(w.win32 ? 'closeWin32' : 'close', w.win32 ? [w.guestHwnd, w.ownerPid] : [w.hwnd]); }
  // one clipboard across machines: USER's CF_TEXT leaves with the keyboard, the shell's text arrives with it
  clipHandoff() {
    const mine = !!(active && active.native && active.app === this);
    if (mine && clipOwner !== this) {
      if (clipOwner && clipOwner.alive && clipOwner.clipOut) clipOwner.clipOut();
      clipOwner = this; if (textClip !== this.clipText) { this.cmd('clipIn', [textClip]); this.clipText = textClip; }
    } else if (!mine && clipOwner === this && !(active && active.native)) { this.clipOut(); clipOwner = null; }
  }
  clipOut() { this.cmd('clipOut').then(t => { if (t !== null && t !== undefined) textClip = this.clipText = t; }); }
  clipIn() {}
  spawnProgram(file, arg) { return this.cmd('spawn', [file, arg]); }
  exited(code, why, own) {
    if (!this.alive) return;
    this.alive = false; nativeApps.delete(this); machineWorkers.delete(this);
    if (this.lanDetach) this.lanDetach();
    if (this.net) for (const a of machineWorkers) a.worker.postMessage({ t: 'netlink', port: null });
    if (clipOwner === this) clipOwner = null;
    if (window.W95Sound) W95Sound.close(this);
    for (const w of this.wins.values()) closeWin(w, true);
    this.wins.clear();
    if (msgApp === this) msgApp = null;
    for (const ok of this.calls.values()) ok(null); this.calls.clear();
    setTimeout(() => this.worker.terminate(), 0);
    emit('program.exit', { path: this.path, code, ...(why ? { why } : {}) });
    if (why) msgBox(basename(this.path), `This program has performed an illegal operation and will be shut down.\n\n${why}`, 'error', ['OK'], null, { noTask: false, modal: false });
    dirty();
    if (own && this.system && !why) systemEnded(code);
  }
}
// the native program whose window is under the point, or that holds USER's capture
function nativeAt(x, y) {
  for (const a of nativeApps) if (a.capture) return a;
  const w = winAt(x, y); return w ? (w.native ? w.app : null) : monApp();
}
async function runNative(path, arg, o = {}) {
  let bytes; try { bytes = fs.readFile(path); } catch (e) { return false; }
  const prog = await nativeProgram(bytes); if (!prog) return false;
  // in the system's machine, as Windows 95 runs every program on its one USER and its one set of drivers; a second
  // instance of a program (whose image's place there is taken) gets a machine of its own
  if (!o.net && !o.apart) {
    const sys = await startSystem();
    if (sys) {
      let r = sys.spawnProgram(path, arg); if (r && r.then) r = await r;
      if (r && (r.ok || (typeof r === 'object' && !('err' in r)))) return true;
      const err = r && typeof r === 'object' ? r.err : r; if (err !== 8) return false;
    }
  }
  const app = o.net || !window.SharedArrayBuffer ? new NativeApp(path, arg, o) : new RemoteApp(path, arg, o);   // (a machine in a worker: the network's stays on the page, which its drives call into)
  return app.start(bytes, prog);
}
// ---------------------------------------------------------------- the system
// Windows 95's system: one machine (one USER, one MMSYSTEM, one sound card) whose first task is MSGSRV32.EXE, started
// as the desktop comes up. USER's first-task start-up loads the installable drivers for it (MMSYSTEM, the card's), so
// sound starts once, with the system, and MSGSRV32 plays SystemStart. The programs the shell runs start in it
let sysApp = null, sysStarting = null, firstRun = false, rebooted = false;   // firstRun: Setup built C: as this page started (makeDisk); rebooted: Restart in it
// SystemStart is heard when Windows starts after it was shut down (Shut Down, Restart), and on its first run (Setup has
// just built C:): a page reloaded or a window closed with Windows running is no shutdown, and the start after it is
// quiet. The shutdown record is this browser's (a start with none plays)
const SHUTDOWN = 'w95.shutdown';
const cleanStart = (() => { let v = null; try { v = localStorage.getItem(SHUTDOWN); localStorage.setItem(SHUTDOWN, 'running'); } catch (_) { /* no storage: every start plays */ } return v !== 'running'; })();
function shutDownCleanly() { try { localStorage.setItem(SHUTDOWN, 'clean'); } catch (_) { /* no storage */ } }
function startSystem() {
  if (window.W95SYSTEMVM === false) return Promise.resolve(null);
  if (sysApp && sysApp.alive) return Promise.resolve(sysApp);
  return sysStarting || (sysStarting = (async () => {
    const S = window.W95SYSTEM || {}; if (!(S.ne || {}).MSGSRV32 || !Object.keys(S.programs || {}).length) return null;
    // MSGSRV32's start-up plays SystemStart and starts the shell SYSTEM.INI names; after a start that was no shutdown
    // its SystemStart is not heard (quiet)
    const quiet = !cleanStart && !firstRun && !rebooted;
    const a = new (window.SharedArrayBuffer ? RemoteApp : NativeApp)(join(WINDIR, 'SYSTEM', 'MSGSRV32.EXE'), '', { system: true, quiet });
    if (!(await a.start(null, null))) { bootLogoEnd(); return null; }
    sysApp = a; if (!a.remote) bootLogoEnd();
    return a;
  })().finally(() => { sysStarting = null; }));
}
// The start-up screen while the system's machine boots, as IO.SYS shows it until Windows' display driver takes the
// screen: the CD's LOGO.SYS (320x400, 8 bits, shown at 4:3), its bottom band (palette entries 236-255) rotating. It
// stays until the machine has a window on screen (Setup's, the logon's, the shell's)
const bootLogo = { on: false, img: null, pal: null, px: null, timer: 0 };
function bootLogoStart() {
  const s = (window.W95SYSTEM || {}).logo; if (!s || window.W95SYSTEMVM === false) return;
  if (!bootLogo.px) {
    const b = b64bytes(s), dv = new DataView(b.buffer), off = dv.getUint32(10, true), w = dv.getInt32(18, true), h = dv.getInt32(22, true);
    bootLogo.pal = Array.from({ length: 256 }, (_, i) => [b[54 + 4 * i + 2], b[54 + 4 * i + 1], b[54 + 4 * i]]);
    bootLogo.px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) bootLogo.px.set(b.subarray(off + (h - 1 - y) * w, off + (h - y) * w), y * w);   // (bottom-up rows)
    bootLogo.w = w; bootLogo.h = h; bootLogo.cv = mkc(w, h); bootLogo.img = bootLogo.cv.getContext('2d').createImageData(w, h);
  }
  bootLogo.on = true; bootLogo.t0 = performance.now();
  clearInterval(bootLogo.timer); bootLogo.timer = setInterval(dirty, 60);
}
function bootLogoEnd() { if (!bootLogo.on) return; bootLogo.on = false; clearInterval(bootLogo.timer); dirty(); }
function drawBootLogo() {
  const L = bootLogo, d = L.img.data, step = Math.floor((performance.now() - L.t0) / 60) % 20;
  const pal = L.pal.map((c, i) => (i >= 236 ? L.pal[236 + (i - 236 + step) % 20] : c));
  for (let i = 0; i < L.px.length; i++) { const c = pal[L.px[i]]; d[4 * i] = c[0]; d[4 * i + 1] = c[1]; d[4 * i + 2] = c[2]; d[4 * i + 3] = 255; }
  L.cv.getContext('2d').putImageData(L.img, 0, 0);
  fill(0, 0, W, H, '#000');
  const s = Math.min(W / 4, H / 3), dw = Math.round(s * 4), dh = Math.round(s * 3);
  ctx.imageSmoothingEnabled = false; ctx.drawImage(L.cv, (W - dw) >> 1, (H - dh) >> 1, dw, dh);
}
/** at boot: once the desktop is drawn and the page has loaded */
function systemBootLater() {
  bootLogoStart();
  const go = () => setTimeout(() => startSystem(), 50);
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
}
// the network's process, which Windows 95 starts as it boots: MPREXE.EXE, with the network's VxDs at ring 0 under it
// and the provider router's DLLs in it. As Windows 95 boots, the network logon follows (MPR's own Enter Network
// Password dialog), then the connections to remember are made again; each drive MPR has connected is a drive of fs.js
// whose files the redirector reaches (netfs.js)
let netApp = null;
const le32 = v => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
/** a network drive's (or share's) files as the shell sees them while the network's machine runs in its worker: the
 *  page cannot wait on the machine, so what the shell lists comes from the folders the machine has listed for it,
 *  asked for as the shell first looks and shown when they arrive (fs.js's version: the views refresh). A change the
 *  shell makes goes to the machine and shows when it is done. The files' contents are the programs' to read (each
 *  machine reaches the network's machine itself); the shell's own reads of them are refused */
function netCache(app, key) {
  const lists = new Map(), stats = new Map(), asked = new Map(); let space = { total: 0, free: 0 }, spaceAt = 0;
  const call = (op, args) => (app.alive ? app.cmd('netfs', [key, op, args]) : Promise.resolve(null)).catch(e => { console.warn('[net]', key, op, e && e.message); return null; });   // (a machine gone, or an error there: no answer)
  const refresh = () => { fs.version++; dirty(); };
  // (by the path in capitals, as the file system's names compare)
  const list = rel => {
    const k = rel.toUpperCase(), t = asked.get(k); if (t && performance.now() - t < 2000) return;
    asked.set(k, performance.now());
    call('list', [rel]).then(r => {
      if (!Array.isArray(r)) { if (!lists.has(k)) { lists.set(k, []); refresh(); } return; }   // (a folder that cannot be listed holds nothing)
      const pre = k ? k + '\\' : '';   // (what the folder no longer holds goes)
      for (const p of [...stats.keys()]) if (p.startsWith(pre) && !p.slice(pre.length).includes('\\')) stats.delete(p);
      lists.set(k, r); for (const e of r) stats.set(((rel ? rel + '\\' : '') + e.name).toUpperCase(), e); refresh();
    });
  };
  const later = (op, args, then) => call(op, args).then(() => { if (then) then(); refresh(); });
  const parent = rel => rel.split('\\').slice(0, -1).join('\\');
  return {
    // a path whose folder has not been listed yet is taken as a folder until the listing says what it is (a path the
    // shell opens before it has looked in its parent: a share's subfolder named in a UNC path or typed in Run)
    stat: rel => {
      if (!rel) return { dir: true, size: 0, attrs: 0x10, ctime: 0, mtime: 0, atime: 0, name: '' };
      const e = stats.get(rel.toUpperCase()); if (e) return e;
      list(parent(rel));
      return lists.has(parent(rel).toUpperCase()) ? null : { dir: true, size: 0, attrs: 0x10, ctime: 0, mtime: 0, atime: 0, name: rel.split('\\').pop() };
    },
    list: rel => { list(rel); return lists.get(rel.toUpperCase()) || []; },
    open: (rel) => { throw new W95FS.FSError(5, rel); },
    read: () => new Uint8Array(0), write: () => { throw new W95FS.FSError(5, key); }, truncate: () => {}, size: () => 0, close: () => {},
    mkdir: rel => later('mkdir', [rel], () => list(parent(rel))), rmdir: rel => later('rmdir', [rel], () => list(parent(rel))),
    unlink: rel => later('unlink', [rel], () => { stats.delete(rel.toUpperCase()); asked.delete(parent(rel).toUpperCase()); list(parent(rel)); }),
    rename: (a, b) => later('rename', [a, b], () => { stats.delete(a.toUpperCase()); asked.delete(parent(a).toUpperCase()); asked.delete(parent(b).toUpperCase()); list(parent(a)); list(parent(b)); }),
    setAttrs: (rel, a) => later('setAttrs', [rel, a]), setTime: (rel, ms) => later('setTime', [rel, ms]),
    space: () => { if (performance.now() - spaceAt > 5000) { spaceAt = performance.now(); call('space', []).then(r => { if (r) { space = r; refresh(); } }); } return space; },
  };
}
/** MPR's export `name` called on a thread of the network's process (its dialogs run there as the process's own),
 *  with dword arguments; resolves to what it returns */
function netCall(name, args = []) {
  if (netApp && netApp.remote) return netApp.alive ? netApp.cmd('netCall', [name, args]) : Promise.resolve(null);
  const p = netApp && netApp.alive ? netApp.proc : null, mpr = p && p.byName.get('MPR'), fn = mpr && mpr.exports.get(name);
  if (!fn) return Promise.resolve(null);
  const a = p.alloc(96), res = a + 88, ptr = a + 92, code = [];
  for (let i = args.length - 1; i >= 0; i--) code.push(0x68, ...le32(args[i]));   // push imm32
  code.push(0xff, 0x15, ...le32(ptr), 0xa3, ...le32(res), 0xc2, 0x04, 0x00);       // call [ptr]; mov [res], eax; ret 4
  p.w32(ptr, fn); p.u8.set(code, a);
  return new Promise(ok => { const t = p.newThread(a, 0, 0x10000, true, false); t.onDone = () => ok(p.r32(res)); netApp.kick(); });
}
/** a string in the network's process's memory */
const netStr = s => { if (netApp.remote) return s; const p = netApp.proc, a = p.alloc(s.length + 1); p.writeA(a, s); return a; };   // (a string itself for the network's machine in its worker)
/** fs.js's drives as MPR has them connected: one for each drive letter with a connection (WNetGetConnectionA), none for
 *  one without */
function syncNetDrives() {
  if (netApp && netApp.remote) {   // (from the network's machine in its worker: the shell's drives, and each machine's)
    if (!netApp.alive) return Promise.resolve();
    return netApp.cmd('netConnections').then(list => {
      list = list || [];
      for (let c = 65; c <= 90; c++) {
        const L = String.fromCharCode(c), v = fs.vols.get(L); if (v && (!v.remote || v.host)) continue;   // (a host share's drive is the page's, not MPR's)
        const x = list.find(y => y.letter === L), unc = x && x.unc;
        if (v && (!unc || v.unc.toUpperCase() !== unc.toUpperCase())) fs.unmount(L);
        if (unc && (!v || v.unc.toUpperCase() !== unc.toUpperCase())) fs.mount(L, { remote: netCache(netApp, L), unc, label: unc.split('\\').pop() || '' });
      }
      netMounts = list; for (const a of machineWorkers) if (!a.net) a.worker.postMessage({ t: 'netmounts', list });
    }).catch(e => console.warn('[net] connections', e && e.message));   // (the network's machine gone: the drives stay as they were)
  }
  const p = netApp && netApp.alive ? netApp.proc : null, fn = p && p.byName.get('MPR') && p.byName.get('MPR').exports.get('WNetGetConnectionA');
  const loc = p && p.alloc(8), buf = p && p.alloc(264), pn = p && p.alloc(4);
  for (let c = 65; c <= 90; c++) {
    const L = String.fromCharCode(c), v = fs.vols.get(L); if (v && (!v.remote || v.host)) continue;
    let unc = null;
    if (fn) { p.writeA(loc, L + ':'); p.w32(pn, 260); try { if (p.call(fn, [loc, buf, pn]) === 0) unc = p.readA(buf); } catch (e) { console.error(e); } }
    if (v && (!unc || v.unc.toUpperCase() !== unc.toUpperCase())) fs.unmount(L);
    if (unc && (!v || v.unc.toUpperCase() !== unc.toUpperCase())) fs.mount(L, { remote: W95NetFS.backend(netApp, L), unc, label: unc.split('\\').pop() || '' });
  }
  if (p) p.free(loc), p.free(buf), p.free(pn);
}
// MPR's Map Network Drive and Disconnect Network Drive dialogs (WNetConnectionDialog, WNetDisconnectDialog), for disks
async function mapNetDrive() { if (await netBoot()) { await netCall('WNetConnectionDialog', [0, 1]); await syncNetDrives(); } }
async function disconnectNetDrive() { if (await netBoot()) { await netCall('WNetDisconnectDialog', [0, 1]); await syncNetDrives(); } }
// a UNC path's share (\\server\share), reached through the redirector as a drive's is: none if it does not answer
fs.uncBackend = unc => {
  const hostShares = getHostShares();
  if (hostShares) {   // a share of the host's: its folder, directly (fs.js), not the redirector
    const m = /^\\\\([^\\]+)\\([^\\]+)/.exec(unc);
    if (m && m[1].toUpperCase() === hostName()) { try { return (hostShares.list() || []).some(s => s.name.toUpperCase() === m[2].toUpperCase()) ? hostBackend(m[2]) : null; } catch (e) { return null; } }
  }
  if (!netApp || !netApp.alive) { netBoot(); return null; }   // not yet: the network starts for the next time
  if (netApp.remote) return netCache(netApp, unc);
  const b = W95NetFS.backend(netApp, unc); try { b.space(); return b; } catch (_) { return null; }   // its root answers
};
// the network as the shell first needs it (Network Neighborhood, Map Network Drive, or connections to restore as it
// boots): the process started, the logon (MPR's Enter Network Password), the remembered connections made again. Once
// for each start of the network's process
let netBooting = null, netUp = null;
function netBoot() {
  if (!((window.W95SYSTEM || {}).net || {})['MPR.DLL']) return null;
  if (netUp && netUp === netApp && netApp.alive) return Promise.resolve(netApp);
  return netBooting || (netBooting = (async () => {
    const a = await startNetwork(); if (!a) return null;
    await netCall('WNetLogonA', [0, 0]);
    await netCall('WNetRestoreConnectionA', [0, 0]);
    await syncNetDrives(); netUp = a; return a;
  })().finally(() => { netBooting = null; }));
}
// ---------------------------------------------------------------- the host's folders as network drives
// The folders the host shares (the app's shares.js, the dev server's /__share) are drives of their own in fs.js, as
// network drives on the host computer (\\COMPUTER\SHARE): each operation goes to the host synchronously, through
// the page's file system, not the redirector. The network stack (MPR, the redirector, the card) still runs for
// Network Neighborhood and for the connections it makes itself
const HOST_ERR = { ENOENT: 2, ENOTDIR: 3, EACCES: 5, EPERM: 5, EEXIST: 80, ENOTEMPTY: 145, EISDIR: 5 };
// The host's file names Windows cannot spell (a name with " * : < > ? | or a control character: the home folder's
// "music" with its quotes) are shown under a legal alias, each such character an underscore (~2, ~3 on a clash within
// the folder), and the alias is turned back into the name on every operation, as an SMB server mangles such names;
// a folder's aliases are learned as it is listed, which Explorer and the redirector do before they open anything in it
function legalShares(H) {
  const BAD = /[\\/:*?"<>|\x00-\x1f]/g, known = new Map();   // share\folder -> Map(alias upper -> name)
  const folderKey = (share, path) => share.toUpperCase() + '|' + path.replace(/^[\\]+|[\\]+$/g, '').toUpperCase();
  const alias = (names, name) => {
    if (!BAD.test(name)) { BAD.lastIndex = 0; return name; }
    BAD.lastIndex = 0; const base = name.replace(BAD, '_'); let a = base;
    for (let n = 2; names.has(a.toUpperCase()); n++) a = `${base}~${n}`;
    return a;
  };
  const real = (share, path) => {   // a path of aliases to the host's path
    const parts = String(path || '').split('\\'), out = [];
    for (let i = 0; i < parts.length; i++) {   // (folders are keyed by the path of aliases, as the caller spells it)
      const dir = known.get(folderKey(share, parts.slice(0, i).join('\\'))), r = dir && dir.get(parts[i].toUpperCase());
      out.push(r !== undefined ? r : parts[i]);
    }
    return out.join('\\');
  };
  return {
    list: () => H.list(),
    op: (share, op, ...args) => {
      if (op === 'space') return H.op(share, op, ...args);
      const a = args.slice(); if (typeof a[0] === 'string') a[0] = real(share, a[0]); if (op === 'rename' && typeof a[1] === 'string') a[1] = real(share, a[1]);
      const r = H.op(share, op, ...a);
      if (op === 'list' && r && Array.isArray(r.ok)) {
        const dir = new Map(), names = new Set(r.ok.map(e => e.name.toUpperCase()));
        for (const e of r.ok) { const al = alias(names, e.name); if (al !== e.name) { names.add(al.toUpperCase()); dir.set(al.toUpperCase(), e.name); e.name = al; } }
        known.set(folderKey(share, args[0] || ''), dir);
      }
      return r;
    },
  };
}
let hostSharesWrap = null;
function getHostShares() {
  const base = window.W95HOST && window.W95HOST.shares;
  if (!base) return null;
  if (base.legal) return base;
  if (hostSharesWrap && hostSharesWrap.base === base) return hostSharesWrap.wrap;
  const wrap = Object.assign(legalShares(base), { legal: true });
  hostSharesWrap = { base, wrap };
  return wrap;
}
window.W95LegalShares = legalShares;   // (for the tests)
function hostBackend(name) {
  const H = getHostShares(), handles = new Map(); let nextH = 1;
  if (!H) return null;
  const op = (o, path, ...args) => { const r = H.op(name, o, ...args); if (!r || r.err) throw new W95FS.FSError(HOST_ERR[r && r.err] || 31, path); return r.ok; };
  const ent = (e, n) => e && ({ name: n !== undefined ? n : e.name, dir: !!e.dir, size: e.dir ? 0 : e.size || 0, attrs: (e.dir ? 0x10 : 0x20) | (e.readonly ? 1 : 0) | (e.hidden ? 2 : 0),
    ctime: e.ctime || 0, mtime: e.mtime || 0, atime: e.atime || 0 });
  const rel = h => { const r = handles.get(h); if (r === undefined) throw new W95FS.FSError(6, name); return r; };
  return {
    stat: r => { if (!r) return { dir: true, size: 0, attrs: 0x10, ctime: 0, mtime: 0, atime: 0, name: '' }; return ent(op('stat', r, r), r.split('\\').pop()) || null; },
    list: r => op('list', r, r).map(e => ent(e)),
    open: (r, f) => {
      const there = !!op('stat', r, r);
      if (!there) { if (!f.create) throw new W95FS.FSError(2, r); op('create', r, r, false); }
      else if (f.trunc) op('truncate', r, r, 0);
      const h = nextH++; handles.set(h, r); return h;
    },
    read: (h, pos, n) => { const out = new Uint8Array(n); let got = 0; while (got < n) { const b = op('read', rel(h), rel(h), pos + got, n - got); if (!b || !b.length) break; out.set(b, got); got += b.length; } return out.subarray(0, got); },
    write: (h, pos, b) => op('write', rel(h), rel(h), pos, b),
    truncate: (h, n) => op('truncate', rel(h), rel(h), n),
    size: h => { const e = op('stat', rel(h), rel(h)); return e ? e.size || 0 : 0; },
    close: h => { handles.delete(h); },
    mkdir: r => op('mkdir', r, r), rmdir: r => op('rmdir', r, r), unlink: r => op('unlink', r, r), rename: (a, b) => op('rename', a, a, b),
    setAttrs: () => {}, setTime: (r, ms) => op('times', r, r, ms),
    space: () => op('space', name) || { total: 0, free: 0 },
  };
}
const hostName = () => ((window.W95HOST && window.W95HOST.computerName) || 'HOST').toUpperCase().replace(/[^A-Z0-9!@#$%^&()\-_'{}.~]/g, '').slice(0, 15) || 'HOST';
/** the host's shares mounted as network drives, from E: on (the first letters free after the disks and the CD) */
function mountHostShares() {
  const H = getHostShares(); if (!H) return;
  let list = []; try { list = H.list() || []; } catch (e) { console.error(e); return; }
  const host = hostName();
  let c = 69;   // E:
  for (const s of list) {
    while (c <= 90 && fs.vols.has(String.fromCharCode(c))) c++;
    if (c > 90) break;
    const L = String.fromCharCode(c), unc = `\\\\${host}\\${s.name.toUpperCase()}`;
    const v = fs.mount(L, { remote: hostBackend(s.name), unc, label: s.name.toUpperCase() }); v.host = true;
  }
}
/** connections MPR remembers (HKCU\Network\Persistent): the network's machine starts as the shell boots to make them
 *  again; otherwise it starts when the shell first needs it (the system's own MPR and MPREXE run regardless) */
const netRemembered = () => W95Win32.regKids('hkcu\\network\\persistent').some(k => W95Win32.regGet('hkcu\\network\\persistent\\' + k, 'RemotePath') !== undefined);
/** at boot, with connections to restore: once the desktop is drawn and the page has loaded */
function netBootLater() {
  const go = () => setTimeout(() => { if (netRemembered()) netBoot(); }, 100);   // after the desktop's first frames
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
}
let netStarting = null;   // one start at a time: callers while it starts wait for it
function startNetwork() {
  if (netApp && netApp.alive) return Promise.resolve(netApp);
  return netStarting || (netStarting = (async () => {
    if (!((window.W95SYSTEM || {}).net || {})['MPR.DLL']) return null;
    const path = join(WINDIR, 'SYSTEM', 'MPREXE.EXE');
    let bytes; try { bytes = fs.readFile(path); } catch (e) { return null; }
    const prog = await nativeProgram(bytes); if (!prog) return null;
    // on the page, as before 5d295d0: the shell reads and writes a network drive synchronously through the redirector
    // (a worker can only answer it later, so its files could only be listed); programs in the other machines reach the
    // drive through the page's file system
    await netCompiled();
    netApp = new NativeApp(path, '', { net: true }); fs.uncs.clear();
    const t = performance.now(), ok = await netApp.start(bytes, prog); netApp.startMs = performance.now() - t;
    return ok ? netApp : null;
  })().finally(() => { netStarting = null; }));
}

class Win32DialogBody {
  constructor(proc, d, px, py) {
    this.p = proc; this.d = d;
    for (const c of d.ctls) c.r = { x: px(c.x), y: py(c.y), w: px(c.cx), h: py(c.cy) };
    for (const c of d.ctls) {
      if (c.cls === 'msctls_updown32' && c.buddy && c.style & 4) {
        const b = c.buddy.r; b.w -= 14; c.r = { x: b.x + b.w - 2, y: b.y, w: 16, h: b.h };
      }
    }
    this.focus = d.ctls.findIndex(c => c.style & 0x10000 && c.enabled && c.visible);
  }
  guard(fn) { try { fn(); } catch (e) { console.error(e); } dirty(); }
  abs(c) { return { x: this.r.x + c.r.x, y: this.r.y + c.r.y, w: c.r.w, h: c.r.h }; }
  kind(c) {
    const t = c.style & 0xf;
    if (c.cls === 'button') return t === 7 ? 'group' : [2, 3, 5, 6].includes(t) ? 'check' : [4, 9].includes(t) ? 'radio' : 'push';
    if (c.cls === 'static') return 'static';
    if (c.cls === 'edit') return 'edit';
    if (c.cls === 'combobox') return 'combo';
    if (c.cls === 'listbox') return 'list';
    if (c.cls === 'msctls_trackbar32') return 'slider';
    if (c.cls === 'msctls_updown32') return 'updown';
    return 'other';
  }
  label(c) { return c.cls === 'static' && c.style & 0x80 ? esc(c.text) : c.text; }
  draw(r, win) {
    this.r = r;
    const focused = this.d.ctls[this.focus];
    this.d.ctls.forEach((c, i) => {
      if (!c.visible) return;
      const a = this.abs(c), k = this.kind(c), foc = i === this.focus && win.isActive, dis = !c.enabled || c.dlg && c.dlg.enabled === false;
      if (k === 'push') {
        const def = (c.style & 0xf) === 1 && !(focused && this.kind(focused) === 'push' && focused !== c) || (foc);
        pushButton(a.x, a.y, a.w, a.h, c.text, { def, pressed: c.pressed, focus: foc, disabled: dis });
      } else if (k === 'check' || k === 'radio') {
        const ty = a.y + ((a.h - 13) >> 1);
        if (k === 'check') {
          fill(a.x, ty, 13, 13, dis ? K.face : K.win); edge(a.x, ty, 13, 13, K.sh, K.hl); edge(a.x + 1, ty + 1, 11, 11, K.dk, K.lt);
          if (c.check) mglyph('check', a.x + 3, ty + 3, dis ? K.sh : K.dk);
        } else radio(a.x, ty, c.check);
        const lx = a.x + (k === 'check' ? 19 : 18);
        if (dis) textEmboss(c.text, lx, ty); else text(c.text, lx, ty);
        if (foc) focusRect(lx - 2, ty - 1, textW(c.text) + 4, 15);
      } else if (k === 'group') {
        edge(a.x, a.y + 6, a.w, a.h - 6, K.sh, K.hl); fill(a.x + 1, a.y + 7, 1, a.h - 9, K.hl); fill(a.x + 1, a.y + 7, a.w - 3, 1, K.hl);
        if (c.text) { const tw = textW(c.text); fill(a.x + 7, a.y, tw + 4, 13, K.face); if (dis) textEmboss(c.text, a.x + 9, a.y); else text(c.text, a.x + 9, a.y); }
      } else if (k === 'static') {
        const t = c.style & 0x1f;
        if (t === 0x10) { fill(a.x, a.y, a.w, 1, K.sh); fill(a.x, a.y + 1, a.w, 1, K.hl); }
        else if (t === 0x12 || t === 8) { edge(a.x, a.y, a.w, a.h, K.sh, K.hl); }
        else if (t === 7 || t === 4) edge(a.x, a.y, a.w, a.h, K.dk, K.dk);
        else if (t === 3) icon('app32', a.x, a.y);
        else if (t <= 2 || t === 0xb || t === 0xc) {
          const lines = t === 0xb || t === 0xc ? [this.label(c)] : wrap(this.label(c), a.w);
          lines.forEach((l, j) => {
            const lw = textW(l), lx = t === 1 ? a.x + ((a.w - lw) >> 1) : t === 2 ? a.x + a.w - lw : a.x;
            if (dis) textEmboss(l, lx, a.y + 13 * j); else text(l, lx, a.y + 13 * j);
          });
        }
      } else if (k === 'edit') {
        field(a.x, a.y, a.w, a.h, dis ? K.face : K.win);
        const ty = a.y + ((a.h - 13) >> 1);
        ctx.save(); ctx.beginPath(); ctx.rect(a.x + 2, a.y + 2, a.w - 4, a.h - 4); ctx.clip();
        text(esc(c.text), a.x + 3, ty, dis ? K.sh : K.dk);
        if (foc && blinkOn) fill(a.x + 3 + textW(esc(c.text)), ty, 1, 13, K.dk);
        ctx.restore();
      } else if (k === 'combo') {
        const h = Math.min(a.h, 21);
        field(a.x, a.y, a.w, h, dis ? K.face : K.win);
        const bx = a.x + a.w - 18; btnUp(bx, a.y + 2, 16, h - 4); mglyph('down', bx + 4, a.y + 2 + ((h - 8) >> 1), dis ? K.sh : K.dk);
        const tw = textW(esc(c.text));
        if (foc) { fill(a.x + 3, a.y + 3, Math.min(tw + 2, a.w - 22), h - 6, K.sel); text(esc(c.text), a.x + 4, a.y + ((h - 13) >> 1), K.hl); }
        else text(esc(c.text), a.x + 4, a.y + ((h - 13) >> 1), dis ? K.sh : K.dk);
      } else if (k === 'list') {
        field(a.x, a.y, a.w, a.h);
        ctx.save(); ctx.beginPath(); ctx.rect(a.x + 2, a.y + 2, a.w - 4, a.h - 4); ctx.clip();
        c.items.forEach((s, j) => {
          const y = a.y + 2 + 13 * j; if (j === c.sel) fill(a.x + 2, y, a.w - 4, 13, K.sel);
          text(esc(s), a.x + 4, y, j === c.sel ? K.hl : K.dk);
        });
        ctx.restore();
      } else if (k === 'slider') this.slider(c, a, foc, dis);
      else if (k === 'updown') {
        const hh = a.h >> 1;
        for (const [j, up] of [[0, true], [1, false]]) {
          const y = a.y + j * hh, h = j ? a.h - hh : hh, pr = c.pressed === (up ? 1 : -1);
          if (pr) btnDown(a.x, y, a.w, h); else btnUp(a.x, y, a.w, h);
          const cx = a.x + (a.w >> 1) + (pr ? 1 : 0), cy = y + (h >> 1) + (pr ? 1 : 0), col = dis ? K.sh : K.dk;
          for (let s = 0; s < 3; s++) fill(cx - s, up ? cy - 1 + s : cy + 1 - s, 2 * s + 1, 1, col);
        }
      }
    });
  }
  sliderGeom(c, a) {
    const lo = Math.min(c.min, c.max), hi = Math.max(c.min, c.max), span = Math.max(1, hi - lo);
    const x0 = a.x + 8, x1 = a.x + a.w - 9;
    return { lo, hi, x0, x1, tx: x0 + Math.round((clamp(c.pos, lo, hi) - lo) * (x1 - x0) / span) };
  }
  slider(c, a, foc, dis) {
    const g = this.sliderGeom(c, a), cy = a.y + 4;
    edge(g.x0 - 3, cy + 6, g.x1 - g.x0 + 6, 4, K.sh, K.hl); edge(g.x0 - 2, cy + 7, g.x1 - g.x0 + 4, 2, K.dk, K.lt);
    const tx = g.tx - 5;
    btnUp(tx, cy, 11, 18);
    if (c.style & 1 || true) for (let v = g.lo; v <= g.hi; v += Math.max(1, Math.ceil((g.hi - g.lo) / 10))) {
      const x = g.x0 + Math.round((v - g.lo) * (g.x1 - g.x0) / Math.max(1, g.hi - g.lo)); fill(x, cy + 21, 1, 3, K.dk);
    }
    fill(g.x1, cy + 21, 1, 3, K.dk);
    if (foc) focusRect(a.x, a.y, a.w, a.h);
  }
  ctlAt(x, y) {
    return this.d.ctls.findIndex(c => {
      if (!c.visible || this.kind(c) === 'group' || (this.kind(c) === 'static' && !(c.style & 0x100))) return false;
      return inR(this.abs(c), x, y);
    });
  }
  down(x, y, btn, dbl) {
    const i = this.ctlAt(x, y); if (i < 0) return null;
    const c = this.d.ctls[i], k = this.kind(c), a = this.abs(c), d = this.d;
    if (!c.enabled) return null;
    if (k !== 'updown') this.focus = i;
    if (k === 'push') {
      c.pressed = true;
      return { move: (mx, my) => { c.pressed = inR(this.abs(c), mx, my); }, up: (mx, my) => { c.pressed = false; if (inR(this.abs(c), mx, my)) this.guard(() => d.click(c)); } };
    }
    if (k === 'check' || k === 'radio') { this.guard(() => d.click(c)); return null; }
    if (k === 'combo') {
      openPopup(c.items.map((s, j) => ({ label: esc(s), check: j === c.sel, fn: () => this.guard(() => { c.sel = j; c.text = s; d.selected(c); }) })), a.x, a.y + Math.min(a.h, 21));
      return null;
    }
    if (k === 'list') {
      const j = Math.floor((y - a.y - 2) / 13);
      if (j >= 0 && j < c.items.length) { c.sel = j; this.guard(() => { d.selected(c); if (dbl) d.command(c, 2); }); }
      return null;
    }
    if (k === 'updown') {
      const up = y < a.y + (a.h >> 1);
      c.pressed = up ? 1 : -1; this.guard(() => d.spun(c, up ? 1 : -1));
      return { up: () => { c.pressed = 0; dirty(); } };
    }
    if (k === 'slider') {
      const set = mx => {
        const g = this.sliderGeom(c, this.abs(c));
        c.pos = Math.round(g.lo + clamp(mx - g.x0, 0, g.x1 - g.x0) * (g.hi - g.lo) / Math.max(1, g.x1 - g.x0));
        this.guard(() => d.scrolled(c, 5));
      };
      set(x);
      return { move: mx => set(mx), up: () => this.guard(() => { d.scrolled(c, 4); d.scrolled(c, 8); }) };
    }
    return null;
  }
  cursor(x, y) { const i = this.ctlAt(x, y); return i >= 0 && this.kind(this.d.ctls[i]) === 'edit' ? 'ibeam' : null; }
  // IsDialogMessage's mnemonics: a button with the underlined letter is clicked; a static text or group box
  // (without SS_NOPREFIX) moves the focus to the next control in the tab order that is not one of those
  mnemonic(ch) {
    const d = this.d; ch = ch.toLowerCase();
    for (const [i, c] of d.ctls.entries()) {
      if (!c.visible || !c.enabled || !c.text) continue;
      const k = this.kind(c);
      if (k === 'static' && c.style & 0x80) continue;
      if (!['push', 'check', 'radio', 'static', 'group'].includes(k)) continue;
      const [str, u] = amp(c.text);
      if (u < 0 || str[u].toLowerCase() !== ch) continue;
      if (k === 'push' || k === 'check' || k === 'radio') { this.focus = i; this.guard(() => d.click(c)); return true; }
      const j = d.ctls.findIndex((n, m) => m > i && n.visible && n.enabled && !['static', 'group'].includes(this.kind(n)));
      if (j < 0) return false;
      this.focus = j; return true;
    }
    return false;
  }
  key(e) {
    const d = this.d, c = d.ctls[this.focus], k = c && this.kind(c);
    if (e.key === 'Tab') {
      const f = d.ctls.map((o, i) => i).filter(i => { const o = d.ctls[i]; return o.visible && o.enabled && o.style & 0x10000; });
      if (f.length) { const j = f.indexOf(this.focus); this.focus = f[(j + (e.shiftKey ? f.length - 1 : 1)) % f.length]; }
      return true;
    }
    if (e.key === 'Escape') { this.guard(() => d.command(d.ctl(2) || { id: 2, hwnd: 0 })); return true; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && (e.altKey || k !== 'edit') && this.mnemonic(e.key)) return true;
    if (e.key === 'Enter' && k !== 'push') {
      const def = d.ctls.find(o => o.cls === 'button' && (o.style & 0xf) === 1) || d.ctl(1) || { id: 1, hwnd: 0 };
      this.guard(() => d.command(def)); return true;
    }
    if ((e.key === 'Enter' || e.key === ' ') && (k === 'push' || k === 'check' || k === 'radio')) { this.guard(() => d.click(c)); return true; }
    if (k === 'slider' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const lo = Math.min(c.min, c.max), hi = Math.max(c.min, c.max);
      c.pos = clamp(c.pos + (e.key === 'ArrowRight' ? 1 : -1), lo, hi); this.guard(() => { d.scrolled(c, e.key === 'ArrowRight' ? 1 : 0); d.scrolled(c, 8); }); return true;
    }
    if (k === 'edit' && !e.ctrlKey && !e.metaKey) {
      if (e.key.length === 1) c.text += e.key; else if (e.key === 'Backspace') c.text = c.text.slice(0, -1); else return false;
      this.guard(() => d.edited(c)); return true;
    }
    return false;
  }
  canClose() { this.guard(() => this.d.command(this.d.ctl(2) || { id: 2, hwnd: 0 })); return false; }
}

// ---------------------------------------------------------------- Display Properties
function displayProperties() {
  const open = windows.find(w => w.title === 'Display Properties'); if (open) return activate(open);
  const savers = [{ path: '', name: '(None)' }, ...listSavers()];
  const ini = saverIni();
  let cur = Math.max(0, savers.findIndex(s => s.path && ini.path && s.path.toUpperCase() === ini.path.toUpperCase()));
  if (!ini.active) cur = 0;
  let previewRun = null, previewWindowKey = '', previewWindowHwnd = 0, previewGeneration = 0, win;
  const restartPreview = async () => {
    const generation = ++previewGeneration, old = previewRun;
    previewRun = null; previewWindowKey = ''; previewWindowHwnd = 0; stopSaverProcess(old);
    const s = savers[cur]; settingsBtn.disabled = previewBtn.disabled = !s.path; dirty();
    if (!s.path) return;
    const app = sysApp || await startSystem();
    if (generation !== previewGeneration || !app || !app.alive || !app.remote) return;
    const result = await app.spawnProgram(s.path, '/p 0x7ff0');
    if (generation !== previewGeneration) { if (result && result.pid) app.cmd('endProcess', [result.pid, 0]); return; }
    if (result && result.pid) {
      previewRun = { app, pid: result.pid, path: s.path }; previewWindowKey = result.previewKey || ''; previewWindowHwnd = result.previewHwnd || 0;
      dirty();
    }
  };
  const combo = { type: 'edit', page: 1, x: 22, y: 256, w: 170, h: 21, value: savers[cur].name, combo: true, readonly: true,
    onDrop: a => openPopup(savers.map((s, i) => ({ label: esc(s.name), check: i === cur, fn: () => { cur = i; combo.value = s.name; restartPreview(); } })), a.x, a.y + a.h) };
  const wait = { type: 'edit', page: 1, x: 262, y: 292, w: 34, h: 21, value: String(Math.max(1, Math.round(ini.timeout / 60))), caret: 0 };
  wait.caret = wait.value.length;
  const spin = { type: 'custom', page: 1, x: 296, y: 292, w: 16, h: 21, pressed: 0,
    draw(a) {
      for (const [j, up] of [[0, true], [1, false]]) {
        const y = a.y + j * 10, h = j ? 11 : 10, pr = this.pressed === (up ? 1 : -1);
        if (pr) btnDown(a.x, y, a.w, h); else btnUp(a.x, y, a.w, h);
        const cx = a.x + 8 + (pr ? 1 : 0), cy = y + (h >> 1) + (pr ? 1 : 0);
        for (let s = 0; s < 3; s++) fill(cx - s, up ? cy - 1 + s : cy + 1 - s, 2 * s + 1, 1, K.dk);
      }
    },
    down(x, y, btn, dbl, a) {
      const up = y < a.y + 10; this.pressed = up ? 1 : -1;
      wait.value = String(clamp((parseInt(wait.value, 10) || 1) + (up ? 1 : -1), 1, 60));
      return { up: () => { this.pressed = 0; dirty(); } };
    } };
  const settingsBtn = { type: 'button', page: 1, x: 202, y: 255, w: 75, h: 23, label: 'Se&ttings...', fn: () => { const s = savers[cur]; if (s.path) startSaverProcess(s.path, '/c:0'); } };
  const previewBtn = { type: 'button', page: 1, x: 284, y: 255, w: 75, h: 23, label: 'Pre&view', fn: () => { const s = savers[cur]; if (s.path) startFullSaver(s.path); } };
  const monitor = { type: 'custom', x: 104, y: 40, w: 184, h: 170,
    draw(a) {
      icon('monitor', a.x, a.y);
      if (body.page === 1) {
        const guestWindow = sysApp && previewWindowHwnd && [...sysApp.wins.values()].find(w => w.preview && w.guestParent === previewWindowHwnd);
        if (guestWindow && guestWindow.surface) { fill(a.x + 16, a.y + 17, 152, 104, K.desk); ctx.drawImage(guestWindow.surface, a.x + 16, a.y + 17, 152, 104); }
        else fill(a.x + 16, a.y + 17, 152, 104, K.desk);
      }
    } };
  const info = (page, y, k, v) => [{ type: 'label', page, x: 22, y, text: k }, { type: 'label', page, x: 150, y, text: v }];
  const apply = () => {
    const s = savers[cur], m = clamp(parseInt(wait.value, 10) || 1, 1, 60);
    return fsTry('save', 'display settings', () => {
      W95Win32.iniSet(fs, 'SYSTEM.INI', 'boot', 'SCRNSAVE.EXE', s.path);
      W95Win32.iniSet(fs, 'WIN.INI', 'windows', 'ScreenSaveActive', s.path ? '1' : '0');
      W95Win32.iniSet(fs, 'WIN.INI', 'windows', 'ScreenSaveTimeOut', String(m * 60));
    });
  };
  win = dialog('Display Properties', 392, 420, [
    { type: 'tabs', x: 6, y: 6, w: 380, h: 376, tabs: ['Background', 'Screen Saver', 'Appearance', 'Settings'] },
    monitor,
    { type: 'group', page: 0, x: 16, y: 222, w: 172, h: 140, label: '&Pattern' }, { type: 'edit', page: 0, x: 26, y: 242, w: 152, h: 21, value: '(None)', readonly: true },
    { type: 'group', page: 0, x: 200, y: 222, w: 172, h: 140, label: '&Wallpaper' }, { type: 'edit', page: 0, x: 210, y: 242, w: 152, h: 21, value: '(None)', readonly: true },
    { type: 'group', page: 1, x: 12, y: 236, w: 362, h: 92, label: '&Screen Saver' }, combo, settingsBtn, previewBtn,
    { type: 'check', page: 1, x: 22, y: 296, label: 'Password protected', disabled: true },
    { type: 'label', page: 1, x: 230, y: 296, text: '&Wait:', amp: true }, wait, spin, { type: 'label', page: 1, x: 318, y: 296, text: 'minutes' },
    { type: 'group', page: 2, x: 16, y: 222, w: 356, h: 60, label: 'Sc&heme' }, { type: 'edit', page: 2, x: 26, y: 244, w: 200, h: 21, value: 'Windows Standard', readonly: true },
    { type: 'group', page: 3, x: 16, y: 222, w: 356, h: 100, label: '' },
    ...info(3, 236, 'Color palette:', 'True Color (24 bit)'), ...info(3, 256, 'Desktop area:', `${W} by ${H} pixels`), ...info(3, 276, 'Font size:', 'Small Fonts'),
    { type: 'button', x: 152, y: 390, w: 75, h: 23, label: 'OK', def: true, fn: () => { if (apply()) closeWin(win); } },
    { type: 'button', x: 232, y: 390, w: 75, h: 23, label: 'Cancel', cancel: true, fn: () => closeWin(win) },
    { type: 'button', x: 312, y: 390, w: 75, h: 23, label: '&Apply', fn: apply },
  ], { modal: false, noTask: false });
  const body = win.body; body.page = 1;
  body.onClose = () => {
    ++previewGeneration; stopSaverProcess(previewRun); previewRun = null; previewWindowKey = ''; previewWindowHwnd = 0;
  };
  win.icon = 'cpl_display';
  restartPreview();
  return win;
}

const APPLETS = [
  ['access', 'Accessibility Options'], ['hardware', 'Add New Hardware'], ['appwiz', 'Add/Remove Programs'], ['datetime', 'Date/Time'],
  ['display', 'Display'], ['fonts', 'Fonts'], ['joystick', 'Joystick'], ['keyboard', 'Keyboard'], ['modems', 'Modems'], ['mouse', 'Mouse'],
  ['multimedia', 'Multimedia'], ['network', 'Network'], ['passwords', 'Passwords'], ['cplprinters', 'Printers'], ['regional', 'Regional Settings'],
  ['sounds', 'Sounds'], ['system', 'System'],
];
// the strings of a PE image's string tables (RT_STRING), read from the file
function peStrings(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u16 = o => dv.getUint16(o, true), u32 = o => dv.getUint32(o, true);
  const pe = u32(0x3c); if (u32(pe) !== 0x4550) return [];
  const opt = pe + 24, nsec = u16(pe + 6), secs = opt + u16(pe + 20), rva = u32(opt + 112), out = [];
  if (!rva) return out;
  const off = r => { for (let i = 0; i < nsec; i++) { const h = secs + 40 * i, va = u32(h + 12), sz = Math.max(u32(h + 8), u32(h + 16)); if (r >= va && r < va + sz) return r - va + u32(h + 20); } return -1; };
  const root = off(rva); if (root < 0) return out;
  const kids = d => { const n = u16(d + 12) + u16(d + 14), e = []; for (let i = 0; i < n; i++) e.push([u32(d + 16 + 8 * i), u32(d + 20 + 8 * i)]); return e; };
  for (const [type, t] of kids(root)) {
    if (type !== 6 || !(t & 0x80000000)) continue;
    for (const [, nm] of kids(root + (t & 0x7fffffff))) for (const [, lg] of kids(root + (nm & 0x7fffffff))) {
      const leaf = root + (lg & 0x7fffffff); let o = off(u32(leaf)); const end = o + u32(leaf + 4);
      while (o >= 0 && o + 2 <= end) { const n = u16(o); o += 2; let str = ''; for (let i = 0; i < n; i++) str += String.fromCharCode(u16(o + 2 * i)); o += 2 * n; if (str) out.push(str); }
    }
  }
  return out;
}
// an applet the shell has no page for runs as Windows 95's Control Panel runs it: the .CPL in the system directory
// whose strings name it, through RUNDLL32 on SHELL32's Control_RunDLL
function openApplet(k, name) {
  if (k === 'display') return displayProperties();
  if (k === 'fonts') return openPath(WINDIR + '\\FONTS');
  if (k === 'cplprinters') return openFolder(Printers);
  const sys = join(WINDIR, 'SYSTEM');
  let cpl = null;
  try {
    for (const f of fs.readdir(sys)) {
      if (f.isDir || !/\.cpl$/i.test(f.name)) continue;
      try { if (peStrings(fs.readFile(join(sys, f.name))).some(t => t.replace(/&/g, '').toLowerCase() === name.toLowerCase())) { cpl = f.name; break; } } catch (e) { console.error(e); }
    }
  } catch (e) { console.error(e); }
  if (cpl) return runNative(join(WINDIR, 'RUNDLL32.EXE'), `shell32.dll,Control_RunDLL ${cpl}`)
    .then(ok => { if (!ok) msgBox(name, `The ${name} applet is not implemented in this shell.`, 'info'); });
  msgBox(name, `The ${name} applet is not implemented in this shell.`, 'info');
}
ControlPanel.list = () => APPLETS.map(([k, n]) => ({ key: 'cpl:' + k, label: n, icon: 'cpl_' + k, virt: true, open: () => openApplet(k, n) }));

// ---------------------------------------------------------------- start menu
// Programs and Documents are read from the Start Menu and Recent folders on C:.
function menuFromDir(dir) {
  let list; try { list = fs.readdir(dir).filter(i => !i.hidden).sort(byName); } catch (_) { return []; }
  return list.map(i => i.isDir
    ? { label: esc(dispName(i.name, true)), icon: 'programs', sub: () => menuFromDir(i.path) }
    : { label: esc(dispName(i.name)), icon: iconFor(i), fn: () => shellOpen(i.path) });
}
const START = [
  { label: '&Programs', icon: 'programs', sub: () => menuFromDir(PROGRAMS) },
  { label: '&Documents', icon: 'documents', sub: () => menuFromDir(RECENT) },
  { label: '&Settings', icon: 'settings', sub: [
    { label: '&Control Panel', icon: 'controlpanel', fn: () => openFolder(ControlPanel) },
    { label: '&Printers', icon: 'printers', fn: () => openFolder(Printers) },
    { label: '&Taskbar...', icon: 'taskbar', fn: taskbarProperties },
  ] },
  { label: '&Find', icon: 'find', sub: [
    { label: '&Files or Folders...', icon: 'findfiles', fn: () => findFiles() },
    { label: '&Computer...', icon: 'findcomp', disabled: !((window.W95SYSTEM || {}).net || {})['MPR.DLL'], fn: findComputer },
  ] },
  { label: '&Help', icon: 'help', disabled: !hasHelp(), fn: () => winHelp() },
  { label: '&Run...', icon: 'run', fn: runDialog },
  { sep: true },
  { label: 'Sh&ut Down...', icon: 'shutdown', fn: shutDownDialog },
];

// ---------------------------------------------------------------- render
function render() {
  rafPending = false;
  const txt = msgApp && (msgApp.remote ? msgApp.txt : msgApp.proc && msgApp.proc.txt);
  if (txt) { drawTextScreen(txt); return; }
  if (bootLogo.on && screen === 'desktop') { drawBootLogo(); return; }
  if (screen !== 'desktop') {
    fill(0, 0, W, H, '#000');
    const im = screen === 'logow' ? IMG.logow : screen === 'logos' ? IMG.logos : null;
    if (im) {
      const s = Math.min(W / 4, H / 3), dw = Math.round(s * 4), dh = Math.round(s * 3);
      ctx.imageSmoothingEnabled = false; ctx.drawImage(im, (W - dw) >> 1, (H - dh) >> 1, dw, dh);
    }
    if (screen === 'logow') drawCursor('wait');
    return;
  }
  // the system's machine's screen, whole, once it runs (the scanout as the CRTC sends it to the monitor); before, the
  // page's own desktop and taskbar
  const sa = monApp();
  if (!!sa !== monitor) resize();
  if (sa) sa.scanToCanvas(); else drawDesktop();
  // a screen saver running full screen on the machine is topmost: the shell's own windows, menus and tips stay under it
  if (sa && sa.snap && sa.snap.list.some(n => /^WindowsScreenSaverClass$/i.test(n.cls || '') && !n.preview)) { const na = pointerApp(mouse.x, mouse.y); if (na) drawSprite(na); return; }
  const m = modal();
  if (!sa && !tbar.ontop) drawTaskbar();
  for (const w of windows) if (!(sa && w.app === sa && !w.win32) && !w.min && !(m && m.dim && w === m)) w.draw();
  if (!sa && tbar.ontop) drawTaskbar();
  if (m && m.dim) { ctx.fillStyle = PAT.dim; ctx.fillRect(0, 0, W, H); m.draw(); }
  for (const mm of menus) drawMenu(mm);
  if (drag) xorFrame(drag.r, drag.t);
  if (tip) {
    const tw = textW(tip.text) + 6, tx = clamp(tip.x, 0, W - tw), ty = tip.y;
    fill(tx, ty, tw, 17, K.tip); edge(tx, ty, tw, 17, K.dk, K.dk); text(tip.text, tx + 3, ty + 2);
  }
  const cur = cursorAt(mouse.x, mouse.y);
  for (const a of nativeApps) if (a.ov && a.alive && a !== sa) ctx.drawImage(a.ov, 0, 0);
  if (cur === 'none') { const na = pointerApp(mouse.x, mouse.y); if (na) drawSprite(na); }
  else drawCursor(cur);
}
// the display adapter's hardware cursor: the sprite the program's display driver loaded and placed, overlaid on the
// whole screen as the CRTC overlays it on scanout (2 bits a pixel: bit 1 keeps the screen, bit 0 inverts it), a
// column of it to each pixel clock (cpp of them to a screen pixel at high color)
function drawSprite(app) {
  let sp; try { sp = app.remote ? app.sprite() : app.proc && app.proc.sprite(); } catch (e) { return; }
  if (!sp) return;
  const cpp = sp.cpp || 1, x = sp.x, y = sp.y, w = Math.min(Math.floor((64 - sp.px) / cpp), W - x), h = Math.min(64 - sp.py, H - y);
  if (w <= 0 || h <= 0 || x < 0 || y < 0) return;
  const im = ctx.getImageData(x, y, w, h), d = im.data;
  for (let j = 0; j < h; j++) {
    const row = (sp.py + j) * sp.row;
    for (let i = 0; i < w; i++) {
      const p = sp.px + i * cpp, v = sp.bits[row + (p >> 2)] >> ((p & 3) * 2) & 3, o = (j * w + i) * 4;
      if (v === 2) continue;
      const and = v & 2 ? 0xff : 0, xor = v & 1 ? 0xff : 0;
      d[o] = (d[o] & and) ^ xor; d[o + 1] = (d[o + 1] & and) ^ xor; d[o + 2] = (d[o + 2] & and) ^ xor;
    }
  }
  ctx.putImageData(im, x, y);
}
// ---------------------------------------------------------------- the display in text mode (message mode's blue screens)
// 80x25 characters in 9x16 cells, as the VGA shows its text mode, in the 8x16 code page 437 font from the CD's EGA.CPI
// (column 9 repeats column 8 for the line-drawing characters C0h-DFh); the 16 text colors; the cursor blinking
const TEXT_RGB = [0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa, 0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55, 0xffffff];
let msgApp = null, textFont = null, textCv = null;
function cpiFont(b, cp = 437, h = 16) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = v.getUint32(0x13, true) + 2;
  for (let n = v.getUint16(e - 2, true); n-- > 0; e = v.getUint32(e + 2, true)) {
    if (v.getUint16(e + 16, true) !== cp) continue;
    const info = v.getUint32(e + 24, true); let f = info + 6;
    for (let k = v.getUint16(info + 2, true); k-- > 0; f += 6 + v.getUint16(f + 4, true) * b[f]) if (b[f] === h && b[f + 1] === 8) return b.subarray(f + 6, f + 6 + 256 * h);
  }
  return null;
}
function drawTextScreen(t) {
  if (!textFont) { const d = window.W95SYSTEM && W95SYSTEM.dos && W95SYSTEM.dos['EGA.CPI']; if (d) textFont = cpiFont(b64bytes(d)); }
  if (!textCv) textCv = mkc(720, 400);
  const tx = textCv.getContext('2d'), im = tx.createImageData(720, 400), px = new Uint32Array(im.data.buffer);
  const rgb = c => 0xff000000 | (c & 0xff) << 16 | (c & 0xff00) | (c >>> 16 & 0xff);
  const blink = (performance.now() >> 9) & 1;
  for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) {
    const o = r * t.cols + c, ch = t.ch[o], at = t.at[o], fg = rgb(TEXT_RGB[at & 15]), bg = rgb(TEXT_RGB[at >> 4 & 15]);
    const cur = blink && t.cur[0] === r && t.cur[1] === c;
    for (let y = 0; y < 16; y++) {
      let bits = textFont ? textFont[ch * 16 + y] : 0;
      if (cur && y >= 14) bits = 0xff;
      const nine = ch >= 0xc0 && ch <= 0xdf ? bits & 1 : 0, row = (r * 16 + y) * 720 + c * 9;
      for (let x = 0; x < 8; x++) px[row + x] = bits & (0x80 >> x) ? fg : bg;
      px[row + 8] = nine ? fg : bg;
    }
  }
  tx.putImageData(im, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.drawImage(textCv, 0, 0, W, H); ctx.imageSmoothingEnabled = false;
  if (msgApp) setTimeout(dirty, 250);   // the cursor's blink
}
// KERNEL32's Close Program (its dialog 2, in dialog units, and its strings), which REBOOT's APC puts up on Ctrl+Alt+Del:
// every task, the ones whose system does not answer marked; End Task ends the selected one, Shut Down opens Shut Down
// Windows. KERNEL32 tells REBOOT the dialog is coming (2), up (3: Ctrl+Alt+Del again restarts) and gone (0)
function closeProgram(app) {
  const p = app.proc, state = n => { try { if (app.remote) app.cmd('closeState', [n]); else p.k32CloseState(n); } catch (e) { console.error(e); } };
  state(2);
  if (windows.some(w => w.title === 'Close Program')) { state(3); return; }
  const bu = dialogBaseUnits(), px = v => Math.round(v * bu.x / 4), py = v => Math.round(v * bu.y / 8);
  // [Not responding]: USER's own test (USER32's IsHungThread: the thread's queue has not been read for its hung-app
  // time) on the thread that owns the window
  // (a machine in a worker answers for its windows when asked: its answers arrive as the dialog is up)
  const hungRemote = new Map();
  for (const m of new Set(windows.filter(w => w.native && w.app && w.app.remote).map(w => w.app))) {
    const ws = [...m.wins.values()]; m.cmd('hung', [ws.map(w => w.hwnd)]).then(f => { if (f) ws.forEach((w, i) => hungRemote.set(w, f[i])); dirty(); });
  }
  const hung = w => {
    if (w.native && w.app && w.app.remote) return !!hungRemote.get(w);
    const q = w.native && w.app && w.app.proc, u = q && q.byName && q.byName.get('USER32'), x = u && u.exports;
    const tid = x && x.get('GetWindowThreadProcessId'), hung = x && x.get('IsHungThread');
    if (!tid || !hung || q.depth || (q.r0Runs && q.r0Runs.length)) return false;
    try { return !!q.call(hung, [q.call(tid, [w.hwnd, 0])]); } catch (e) { console.error(e); return false; }
  };
  const tasks = () => windows.filter(w => !w.noTask && w.title && w.title !== 'Close Program');
  let sel = 0, win;
  const done = () => { closeWin(win); state(0); };
  const endTask = () => {
    const w = tasks()[sel]; if (!w) return;
    done();
    if (w.native && w.app) w.app.exited(-1); else closeWin(w, true);
  };
  const list = {
    type: 'custom', x: px(7), y: py(7), w: px(196), h: py(92), focus: true,
    draw: a => {
      btnDown(a.x, a.y, a.w, a.h, '#fff');
      tasks().forEach((w, i) => {
        const y = a.y + 2 + i * 13; if (y + 13 > a.y + a.h - 2) return;
        if (i === sel) fill(a.x + 2, y, a.w - 4, 13, K.sel);
        text(esc(w.title + (hung(w) ? ' [Not responding]' : '')), a.x + 4, y, i === sel ? '#fff' : K.dk);
      });
    },
    down: (x, y, btn, dbl, a) => { const i = Math.floor((y - a.y - 2) / 13); if (i >= 0 && i < tasks().length) sel = i; if (dbl) endTask(); },
    key: e => { const n = tasks().length; if (e.key === 'ArrowDown') { sel = Math.min(n - 1, sel + 1); return true; } if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); return true; } return false; },
  };
  win = dialog('Close Program', px(210), py(157), [
    list,
    { type: 'label', text: wrap('WARNING: Pressing CTRL+ALT+DEL again will restart your computer. You will lose unsaved information in all programs that are running.', px(189)).join('\n'), x: px(7), y: py(101) },
    { type: 'button', label: '&End Task', x: px(7), y: py(136), w: px(62), h: py(14), def: true, fn: endTask },
    { type: 'button', label: '&Shut Down', x: px(73), y: py(136), w: px(62), h: py(14), fn: () => { done(); shutDownDialog(); } },
    { type: 'button', label: 'Cancel', x: px(141), y: py(136), w: px(62), h: py(14), cancel: true, fn: done },
  ], { noTask: true });
  state(3);
}
// ---------------------------------------------------------------- processor exceptions: the system's answers
// KERNEL32.DLL's and VWIN32.VXD's own text (system.js res)
let k32Bytes = null;
const k32 = () => k32Bytes || (k32Bytes = window.W95SYSTEM && W95SYSTEM.res && W95SYSTEM.res['KERNEL32.DLL'] ? b64bytes(W95SYSTEM.res['KERNEL32.DLL']) : null);
const k32Str = id => (k32() && W95Win32.peString(k32(), id)) || '';
/** FormatMessage's inserts: %n, and %n!printf format! (d, x, with a width and a precision) */
const fmtMsg = (fmt, args) => fmt.replace(/%(\d)(?:!([^!]*)!)?/g, (m, k, f) => {
  const v = args[+k - 1]; if (v === undefined) return '';
  if (!f || f === 's') return String(v);
  const t = /x$/i.test(f) ? (v >>> 0).toString(16).toUpperCase() : String(v | 0), w = /\.?(\d+)/.exec(f);
  return w ? t.padStart(+w[1], '0') : t;
});
// the message for each exception (KERNEL32's strings 106-113; 107 any other)
const FAULT_MSG = { 0: 108, 6: 109, 0xb: 110, 0xc: 111, 0xd: 112, 0xe: 113 };
/** the details KERNEL32 writes for a fault: what, where, the registers, the bytes at CS:EIP and the stack */
function faultDetails(prog, f) {
  const r = f.regs, sg = f.segs;
  let t = fmtMsg(k32Str(FAULT_MSG[f.n] || 107), [prog, f.module, f.cs, f.offset, f.n]);
  t += fmtMsg(k32Str(114), [r.eax, f.cs, f.offset, f.flags]) + fmtMsg(k32Str(115), [r.ebx, sg.ss, r.esp, r.ebp]);
  t += fmtMsg(k32Str(116), [r.ecx, sg.ds, r.esi, sg.fsel]) + fmtMsg(k32Str(117), [r.edx, sg.es, r.edi, sg.gsel]);
  t += k32Str(118) + f.bytes.map(b => fmtMsg(k32Str(120), [b])).join('');
  t += k32Str(119); f.stack.forEach((d, i) => { t += fmtMsg(k32Str(122), [d]) + (i % 8 === 7 ? '\n' : ''); });
  return t;
}
/** KERNEL32's fault dialog (its dialog 1, in dialog units): the program's name as the title, "This program has
 *  performed an illegal operation and will be shut down", Close, and Details>> opening the details below it */
function faultDialog(prog, f, done) {
  const bu = dialogBaseUnits(), px = v => Math.round(v * bu.x / 4), py = v => Math.round(v * bu.y / 8);
  const details = faultDetails(prog, f).replace(/\r/g, '');
  const open = more => {
    let win;
    const close = () => { closeWin(win); if (done) done(); };
    const ctrls = [
      { type: 'icon', name: 'error', x: px(7), y: py(7) },
      { type: 'label', text: wrap(k32Str(104), px(154)).join('\n'), x: px(35), y: py(7) },
      { type: 'button', label: '&Close', x: px(208), y: py(7), w: px(50), h: py(14), def: true, cancel: true, fn: close },
      { type: 'button', label: more ? '&Details<<' : '&Details>>', x: px(208), y: py(41), w: px(50), h: py(14), fn: () => { closeWin(win); open(!more); } },
    ];
    if (more) ctrls.push({ type: 'custom', x: px(7), y: py(63), w: px(251), h: py(82), draw: a => {
      field(a.x, a.y, a.w, a.h); let y = a.y + 3;
      for (const l of details.split('\n')) { if (y + 13 > a.y + a.h) break; text(esc(l), a.x + 3, y); y += 13; }
    } });
    win = dialog(prog, px(265), py(more ? 152 : 61), ctrls, { noTask: false, modal: false });   // (the faulting program's own: the others go on taking input)
  };
  open(false);
}
let vwin32Bytes = null;
/** VWIN32's fatal-exception message (with its VxD form when the fault is in one), from VWIN32.VXD itself */
function vwin32Text(inVxd) {
  const b = vwin32Bytes || (vwin32Bytes = W95SYSTEM.res && W95SYSTEM.res['VWIN32.VXD'] ? b64bytes(W95SYSTEM.res['VWIN32.VXD']) : null); if (!b) return null;
  const out = []; const key = [...'A fatal exception'].map(c => c.charCodeAt(0));
  for (let i = 0; i < b.length - key.length; i++) {
    if (key.every((c, k) => b[i + k] === c)) { let j = i; while (b[j]) j++; out.push(String.fromCharCode(...b.subarray(i, j))); i = j; }
  }
  return out.find(t => /in VXD/.test(t) === inVxd) || null;
}
/** a processor exception at ring 0: VWIN32's blue screen, shown by SHELL.VXD (SHELL_SYSMODAL_Message, MB_NOWINDOW);
 *  when a key closes it the current application is terminated */
/** VWIN32's fatal-exception message for fault `f`, its inserts as VMM's message formatter takes them (%<insert><width>x,
 *  %<insert>s) */
function fatalText(f) {
  const fmt = vwin32Text(!!f.vxd); if (!fmt) return null;
  const vals = [f.n, f.cs, f.eip, f.vxd ? `${f.vxd}(01) + ${(f.offset >>> 0).toString(16).toUpperCase().padStart(8, '0')}` : ''];
  return fmt.replace(/%(\d)(\d?)([xs])/g, (m, k, w, c) => c === 's' ? String(vals[+k - 1]) : (vals[+k - 1] >>> 0).toString(16).toUpperCase().padStart(+w || 0, '0'));
}
function fatalException(app, f) {
  const p = app.proc, msg = fatalText(f), at = p.vxdService && p.vxdService(0x17, 3);
  if (!msg || !at) { app.exited(-1); return; }
  const a = p.alloc(msg.length + 1); p.writeA(a, msg);
  app.afterR0 = () => app.exited(-1);   // the current application terminated
  try { if (p.r0Start(at, { ebx: p.sysVM(), eax: 0x40001000, ecx: a, edi: 0, esi: 0, edx: 0 }) !== null) app.exited(-1); }
  catch (e) { console.error(e); app.exited(-1); }
}
// the machine's reset (the keyboard controller's reset line): every program stops where it is, the screen goes dark
// and Windows starts again; the disk keeps what was written to it
function machineReset() {
  msgApp = null;
  for (const a of [...nativeApps]) a.exited(-1);
  [...windows].forEach(w => closeWin(w, true)); closeMenus();
  screen = 'black'; dirty(); setTimeout(boot, 1200);
}
function drawCursor(name) {
  if (name === 'none') return;
  const c = CUR[name] || CUR.arrow; if (!c || mouse.x < 0) return;
  ctx.drawImage(c.i, mouse.x - c.hx, mouse.y - c.hy);
}
const SIZE_CUR = { n: 'sizens', s: 'sizens', e: 'sizewe', w: 'sizewe', nw: 'sizenwse', se: 'sizenwse', ne: 'sizenesw', sw: 'sizenesw' };
/** the machine the mouse goes to at a point: the one dragging (the shell's capture for it), else the one whose window is
 *  there when no shell menu or dialog has the mouse (as pointermove routes it) */
const pointerApp = (x, y) => (cap ? cap.native || null : !menus.length && !modal() ? nativeAt(x, y) : null);
function cursorAt(x, y) {
  if (drag) return drag.cursor;
  if (pointerApp(x, y)) return 'none';   // one pointer: where a machine has the mouse, the cursor is its USER's, as its display adapter has it
  if (menus.length && menuAt(x, y) >= 0) return 'arrow';
  if (onTaskbar(x, y)) return 'arrow';
  const w = winAt(x, y);
  if (!w || (modal() && w !== modal())) return 'arrow';
  const part = w.hit(x, y);
  if (SIZE_CUR[part]) return SIZE_CUR[part];
  if (part === 'client' && w.body && w.body.cursor) return w.body.cursor(x, y) || 'arrow';
  return 'arrow';
}

// ---------------------------------------------------------------- input
// the taskbar takes a point when it is on top, or when no window covers it there
const onTaskbar = (x, y) => !monApp() && y >= barTop() && (tbar.ontop || !winAt(x, y));
// (the system's machine's windows are its screen, under the page's own: a point on none of the page's is the machine's)
function winAt(x, y) { const sa = monApp(); for (let i = windows.length - 1; i >= 0; i--) if ((windows[i].app !== sa || windows[i].win32) && !windows[i].min && inR(windows[i], x, y)) return windows[i]; return null; }
/** the system's machine while it runs: the page is then its monitor, its whole screen what the page shows (the desktop,
 *  the taskbar and every window on it are the shell's SYSTEM.INI names, EXPLORER.EXE, as the machine draws them) */
let monitor = false;   // (the page shows the machine's screen: resize)
const monApp = () => (sysApp && sysApp.alive && sysApp.cv ? sysApp : null);
function pos(e) { const r = cv.getBoundingClientRect(); return [Math.floor((e.clientX - r.left) * W / r.width), Math.floor((e.clientY - r.top) * H / r.height)]; }

function menuDown(x, y) {
  const d = menuAt(x, y);
  if (d >= 0) {
    const m = menus[d], i = rowAt(m, x, y);
    if (i >= 0 && m.items[i].sub && !m.items[i].disabled) { m.hover = i; if (!(menus[d + 1] && menus[d + 1].parent === i)) openSub(d, i); }
    return true;
  }
  const src = menuSrc;
  if (src.kind === 'start' && inR(taskLayout().start, x, y)) { closeMenus(); return true; }
  if (src.kind === 'bar') {
    const it = src.win.barItems().findIndex(b => inR(b, x, y));
    if (it === src.idx) { closeMenus(); return true; }
    if (it >= 0) { openBar(src.win, it); return true; }
  }
  closeMenus();
  return true;
}

function winDown(w, x, y, btn, dbl) {
  activate(w);
  const part = w.hit(x, y);
  if (['close', 'max', 'restore', 'min'].includes(part)) {
    const b = w.buttons().find(v => v.id === part); if (b.disabled) return;
    w.pressBtn = part;
    cap = {
      move: (mx, my) => { w.pressBtn = inR(b, mx, my) ? part : null; },
      up: (mx, my) => {
        w.pressBtn = null; if (!inR(b, mx, my)) return;
        if (part === 'close') closeWin(w); else if (part === 'min') minimize(w); else toggleMax(w);
      },
    };
    return;
  }
  if (part === 'sysicon') { if (dbl) closeWin(w); else sysMenu(w, w.capR.x, w.capR.y + w.capR.h); return; }
  if (part === 'caption') {
    if (btn === 2) { sysMenu(w, x, y); return; }
    if (dbl) { toggleMax(w); return; }
    if (w.max) return;
    const ox = x - w.x, oy = y - w.y;
    drag = { r: { x: w.x, y: w.y, w: w.w, h: w.h }, t: w.b, cursor: 'arrow' };
    cap = {
      move: (mx, my) => { drag.r.x = mx - ox; drag.r.y = clamp(my - oy, -w.b, workH() - 8); },
      up: () => { w.x = drag.r.x; w.y = drag.r.y; drag = null; },
    };
    return;
  }
  if (SIZE_CUR[part]) {
    const r0 = { x: w.x, y: w.y, w: w.w, h: w.h }, sx = x, sy = y;
    drag = { r: { ...r0 }, t: w.b, cursor: SIZE_CUR[part] };
    cap = {
      move: (mx, my) => {
        const dx = mx - sx, dy = my - sy, r = { ...r0 };
        if (part.includes('e')) r.w = Math.max(w.minW, r0.w + dx);
        if (part.includes('s')) r.h = Math.max(w.minH, r0.h + dy);
        if (part.includes('w')) { r.w = Math.max(w.minW, r0.w - dx); r.x = r0.x + r0.w - r.w; }
        if (part.includes('n')) { r.h = Math.max(w.minH, r0.h - dy); r.y = r0.y + r0.h - r.h; }
        drag.r = r;
      },
      up: () => { Object.assign(w, drag.r); drag = null; },
    };
    return;
  }
  if (part === 'bar') { const i = w.barItems().findIndex(b => inR(b, x, y)); if (i >= 0) openBar(w, i); return; }
  if (part === 'client' && w.body && w.body.down) {
    const c = w.body.down(x, y, btn, dbl, w);
    if (c) cap = c;
  }
}

cv.addEventListener('pointerdown', e => {
  e.preventDefault(); kbd.focus(); lastInput = performance.now(); mods.shift = e.shiftKey;
  const [x, y] = pos(e); mouse = { x, y };
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
  const btn = e.button === 2 ? 2 : 0, now = performance.now();
  const dbl = btn === 0 && now - lastDown.t < 500 && Math.abs(x - lastDown.x) <= 4 && Math.abs(y - lastDown.y) <= 4;
  lastDown = dbl ? { t: 0, x, y } : { t: btn === 0 ? now : 0, x, y };
  hideTip();
  if (screen === 'logos') { screen = 'black'; dirty(); setTimeout(boot, 1200); return; }
  if (screen !== 'desktop') return;
  if (menus.length && menuDown(x, y)) { dirty(); return; }
  if (ren && !(ren.box && inR(ren.box, x, y))) commitRename();
  if (ren) { dirty(); return; }
  const m = modal();
  const na = !m ? nativeAt(x, y) : null;
  if (na && (na.capture || !onTaskbar(x, y))) {
    const nw = winAt(x, y); if (nw && nw.native && active !== nw) { na.syncing = true; activate(nw); na.syncing = false; }
    na.pointer('down', x, y, btn);
    cap = { native: na, move: (mx, my) => na.pointer('move', mx, my), up: (ux, uy) => na.pointer('up', ux, uy, btn) };
    dirty(); return;
  }
  if (onTaskbar(x, y)) { if (!m) taskDown(x, y, btn, dbl); dirty(); return; }
  const w = winAt(x, y);
  if (m && w !== m) { activate(m); dirty(); return; }
  if (w) winDown(w, x, y, btn, dbl); else deskDown(x, y, btn, dbl);
  dirty();
});
cv.addEventListener('pointermove', e => {
  const [x, y] = pos(e); if (x !== mouse.x || y !== mouse.y) lastInput = performance.now(); mouse = { x, y };
  if (tbar.autohide && !cap) { if (y >= H - 2 || (tbar.shown > 0 && y >= barTop())) slideTaskbar(true); else if (!(menuSrc && menuSrc.kind === 'start')) slideTaskbar(false); }
  const na = !cap && !menus.length && !modal() ? nativeAt(x, y) : null;
  if (cap && cap.move) cap.move(x, y);
  else if (na) na.pointer('move', x, y);
  else if (menus.length) {
    const d = menuAt(x, y);
    if (d >= 0) { const i = rowAt(menus[d], x, y); setHover(d, i); }
    else {
      const last = menus[menus.length - 1]; if (last.hover >= 0) { last.hover = -1; clearTimeout(menuTimer); }
      if (menuSrc && menuSrc.kind === 'bar') {
        const i = menuSrc.win.barItems().findIndex(b => inR(b, x, y));
        if (i >= 0 && i !== menuSrc.idx) openBar(menuSrc.win, i);
      }
    }
  }
  const TL = taskLayout(), t = TL.tray, hov = !monApp() && TL.icons.find(v => inR(v, x, y));
  if (hov && screen === 'desktop' && !menus.length) {
    trayMouse(hov.t, 0x200);
    if (hov.t.tip && (!tip || tip.text !== hov.t.tip)) { hideTip(); tip = { text: hov.t.tip, x: mouse.x, y: barTop() - 20 }; }
  } else if (!monApp() && inR(t, x, y) && screen === 'desktop' && !menus.length) {
    if (!tip && !tipTimer) tipTimer = setTimeout(() => {
      const d = new Date();
      tip = { text: d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), x: mouse.x, y: barTop() - 20 };
      dirty();
    }, 600);
  } else hideTip();
  dirty();
});
function hideTip() { clearTimeout(tipTimer); tipTimer = 0; if (tip) { tip = null; dirty(); } }
cv.addEventListener('pointerup', e => {
  const [x, y] = pos(e);
  if (cap) { const c = cap; cap = null; if (c.up) c.up(x, y); dirty(); return; }
  if (screen === 'desktop' && !menus.length && onTaskbar(x, y)) {
    const ti = taskLayout().icons.find(v => inR(v, x, y)); if (ti) trayMouse(ti.t, e.button === 2 ? 0x205 : 0x202);
  }
  if (menus.length) {
    const d = menuAt(x, y);
    if (d >= 0) { const i = rowAt(menus[d], x, y); if (i >= 0) activateItem(menus[d].items[i]); }
  }
  dirty();
});
cv.addEventListener('pointerleave', () => { mouse = { x: -100, y: -100 }; hideTip(); dirty(); });
cv.addEventListener('contextmenu', e => e.preventDefault());

// Printable characters arrive through the textarea's input event (covers paste and IME);
// keydown handles everything else.
kbd.addEventListener('input', () => {
  const s = kbd.value; kbd.value = '';
  { const a = nativeFocus(); if (a) { lastInput = performance.now(); a.typeText(s.replace(/\r/g, '')); return; } }
  for (const ch of s.replace(/\r/g, '')) handleKey({ key: ch === '\n' ? 'Enter' : ch, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
});
// the keys go to USER while one of a native program's windows is active and the shell has nothing open over it
// (or, the system's machine being the screen, while no window of the page's own is active)
const nativeFocus = () => (!menus.length && !ren && !modal() && screen === 'desktop' ? (fullSaver && fullSaver.app && fullSaver.app.alive ? fullSaver.app : active && active.native && active.app.alive ? active.app : !(active && windows.includes(active)) ? monApp() : null) : null);
// the keyboard reaches VKD before anything: the system in message mode (a blue screen) takes every key, and a hot key
// goes to the native system with the focus, else to one that is frozen, else to any
const vkdApp = () => msgApp || nativeFocus() || [...nativeApps].find(a => a.alive && a.proc && a.proc.win16Held) || [...nativeApps].find(a => a.alive && !a.net);
window.addEventListener('keyup', e => { const v = vkdApp(); if (v && v.vkd(e, true)) { e.preventDefault(); return; } const a = nativeFocus(); if (a) { e.preventDefault(); if (e.keyCode) a.key(e, true); } });
window.addEventListener('keydown', e => {
  { const v = vkdApp(); if (v && v.vkd(e, false)) { e.preventDefault(); return; } }
  { const a = nativeFocus(); if (a) { lastInput = performance.now(); e.preventDefault(); if (!e.keyCode && e.key.length === 1 && (e.ctrlKey || e.altKey) && /^[a-z0-9]$/i.test(e.key)) a.chord(e); else if (!e.keyCode && e.key.length === 1) a.typeText(e.key); else a.key(e, false); return; } }
  // Option changes the character a Mac key types; Alt+letter means the letter on the key
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^(Key[A-Z]|Digit\d)$/.test(e.code)) {
    e.preventDefault();
    return handleKey({ key: e.code.slice(-1).toLowerCase(), altKey: true, shiftKey: e.shiftKey, ctrlKey: false, metaKey: false, preventDefault() {} });
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return;
  if (e.isComposing) return;
  handleKey(e);
});
function handleKey(e) {
  lastInput = performance.now();
  if (screen !== 'desktop') return;
  let handled = false;
  if (menus.length) {
    const d = menus.length - 1, m = menus[d];
    const sel = i => !m.items[i].sep;
    if (e.key === 'Escape') { if (d > 0) { menus.pop(); } else closeMenus(); handled = true; }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = m.items.length, s = e.key === 'ArrowDown' ? 1 : n - 1; let i = m.hover;
      do { i = (i + s + (i < 0 && s !== 1 ? 1 : 0)) % n; } while (!sel(i));
      m.hover = i; handled = true;
    } else if (e.key === 'ArrowRight') { const it = m.items[m.hover]; if (it && it.sub) { openSub(d, m.hover); menus[d + 1].hover = 0; } handled = true; }
    else if (e.key === 'ArrowLeft') { if (d > 0) menus.pop(); handled = true; }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      // a menu item's underlined letter chooses it (the first of several with the same letter is highlighted)
      const hits = m.items.map((it, i) => i).filter(i => !m.items[i].sep && !m.items[i].disabled && mnemonicOf(m.items[i].label) === e.key.toLowerCase());
      if (hits.length === 1) { const it = m.items[hits[0]]; m.hover = hits[0]; if (it.sub) { openSub(d, hits[0]); menus[d + 1].hover = 0; } else activateItem(it); }
      else if (hits.length) m.hover = hits.find(i => i > m.hover) ?? hits[0];
      handled = true;
    }
    else if (e.key === 'Enter') {
      const it = m.items[m.hover];
      if (it && it.sub) { openSub(d, m.hover); menus[d + 1].hover = 0; } else activateItem(it);
      handled = true;
    }
  } else if (ren) handled = renameKey(e);
  else {
    const target = modal() || active;
    // Alt+letter opens the window's menu bar menu with that underlined letter
    if (target && !modal() && e.altKey && e.key.length === 1 && target.menu) {
      const i = target.menu.findIndex(mm => mnemonicOf(mm.label) === e.key.toLowerCase());
      if (i >= 0) { openBar(target, i); menus[0].hover = 0; handled = true; }
    }
    if (!handled && target && target.body && target.body.key) handled = target.body.key(e);
    if (!handled && target && e.key === 'F4' && e.altKey) { closeWin(target); handled = true; }
    if (!handled && !target) handled = viewKey(desk, e);
  }
  if (!handled && !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) {
    const mods = ['ctrl', 'alt', 'shift'].filter(m => e[m + 'Key']);
    emit('key.unhandled', { key: [...mods, e.key].join('+'), target: menus.length ? 'menu' : (modal() || active || {}).title || 'desktop' });
  }
  if (handled || ['Tab', 'Backspace', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
  dirty();
}

// ---------------------------------------------------------------- boot
let modeTimer = 0, viewSize = '';
function resize() {
  if (`${innerWidth}x${innerHeight}` !== viewSize) { viewSize = `${innerWidth}x${innerHeight}`; if (sysApp) sysApp.modeRefused = null; }   // (a new size: the modes refused at the last one may be taken now)
  // once EXPLORER.EXE is the shell the page is its monitor: the machine's whole screen at its own pixels (ZOOM),
  // centered, black around it, in the largest of its modes the page holds (syncMode); before, the shell's own screen
  // fills the page
  clearTimeout(modeTimer); modeTimer = setTimeout(syncMode, 300);   // (once the page's size has settled: a mode change for each size dragged through is none)
  const mon = monitor = !!monApp();
  if (mon) {
    W = sysApp.sw; H = sysApp.sh;
    const cw = W * ZOOM, ch = H * ZOOM;
    cv.width = W; cv.height = H; cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
    cv.style.marginLeft = Math.max(0, (innerWidth - cw) >> 1) + 'px'; cv.style.marginTop = Math.max(0, (innerHeight - ch) >> 1) + 'px';
  } else {
    W = Math.max(320, Math.floor(innerWidth / ZOOM)); H = Math.max(240, Math.floor(innerHeight / ZOOM));
    cv.width = W; cv.height = H; cv.style.width = W * ZOOM + 'px'; cv.style.height = H * ZOOM + 'px'; cv.style.marginLeft = cv.style.marginTop = '0';
  }
  ctx.imageSmoothingEnabled = false;
  for (const w of windows) if (w.max) Object.assign(w, maxRect(w.b));
  closeMenus(); dirty();
}
window.addEventListener('resize', resize);
setInterval(() => { blinkOn = !blinkOn; dirty(); }, 530);

bootDisk();
mountHostShares();
systemBootLater();
netBootLater();
loadTaskbar();
desk.src = new FsSource(DESKTOP_DIR);
fs.on(() => dirty());
Promise.all(ready).then(() => { resize(); kbd.focus(); dirty(); });
// ---------------------------------------------------------------- events
// What happened in the shell, for scripts: win95.on(type, fn) in the page, and over the DevTools protocol to a
// client that registered the binding __w95event (Runtime.addBinding), as JSON { type, ...data }.
// Window, menu and screen saver events come from comparing the shell's state after each change; file system
// events come straight from the file system.
const listeners = new Map();
function emit(type, data = {}) {
  const ev = { type, ...data, t: Date.now() };
  for (const k of [type, type.split('.')[0], '*']) for (const fn of listeners.get(k) || []) { try { fn(ev); } catch (e) { console.error(e); } }
  if (typeof window.__w95event === 'function') { try { window.__w95event(JSON.stringify(ev)); } catch (_) { /* client gone */ } }
}
function snapshot() {
  return {
    wins: new Map(windows.map(w => [w, { title: w.title, min: !!w.min, max: !!w.max }])),
    active, menus: menus.map(m => m.items.map(i => i.sep ? '-' : amp(i.label || '')[0])),
    saver: fullSaver && { path: fullSaver.path }, screen,
  };
}
function observe() {
  observing = false;
  const now = snapshot(), was = seen; seen = now;
  if (!was) return;
  for (const [w, s] of now.wins) {
    const o = was.wins.get(w);
    if (!o) { emit('window.open', winInfo(w)); continue; }
    if (o.title !== s.title) emit('window.title', { ...winInfo(w), was: o.title });
    if (o.min !== s.min) emit(s.min ? 'window.minimize' : 'window.restore', winInfo(w));
    if (o.max !== s.max) emit(s.max ? 'window.maximize' : 'window.restore', winInfo(w));
  }
  for (const [w, o] of was.wins) if (!now.wins.has(w)) emit('window.close', { title: o.title });
  if (now.active !== was.active && now.active) emit('window.activate', winInfo(now.active));
  if (JSON.stringify(now.menus) !== JSON.stringify(was.menus)) emit(now.menus.length ? 'menu.open' : 'menu.close', { menus: now.menus });
  if (!was.saver && now.saver) emit('saver.start', now.saver);
  if (was.saver && !now.saver) emit('saver.stop', was.saver);
  if (now.screen !== was.screen) emit('screen', { screen: now.screen });
}
fs.on(e => emit('fs.' + e.op, { path: e.path, ...(e.path2 ? { path2: e.path2 } : {}) }));

// ---------------------------------------------------------------- scripting
// Drives the shell through the same input paths a person uses: pointer events on the screen canvas in screen
// pixels, keys through the shell's key handler. Documented in SCRIPTING.md.
function pointer(type, x, y, button = 0) {
  const el = cv, r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent(type, { clientX: r.left + (x + 0.5) * r.width / W, clientY: r.top + (y + 0.5) * r.height / H,
    button, buttons: type === 'pointerup' ? 0 : 1 << (button === 2 ? 1 : 0), pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true }));
}
const winInfo = w => ({ title: w.title, x: w.x, y: w.y, w: w.w, h: w.h, active: w === active, minimized: !!w.min, maximized: !!w.max, modal: modals.includes(w), ...(w.message ? { message: w.message } : {}) });
const findWin = t => { const m = t instanceof RegExp ? w => t.test(w.title) : w => w.title === t; for (let i = windows.length - 1; i >= 0; i--) if (m(windows[i])) return windows[i]; return null; };
const KEY_NAMES = { enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', space: ' ' };
const NATIVE_VK = { enter: [13, 'Enter'], escape: [27, 'Escape'], esc: [27, 'Escape'], tab: [9, 'Tab'], backspace: [8, 'Backspace'],
  delete: [46, 'Delete'], del: [46, 'Delete'], insert: [45, 'Insert'], home: [36, 'Home'], end: [35, 'End'], pageup: [33, 'PageUp'],
  pagedown: [34, 'PageDown'], up: [38, 'ArrowUp'], down: [40, 'ArrowDown'], left: [37, 'ArrowLeft'], right: [39, 'ArrowRight'],
  arrowup: [38, 'ArrowUp'], arrowdown: [40, 'ArrowDown'], arrowleft: [37, 'ArrowLeft'], arrowright: [39, 'ArrowRight'], space: [32, 'Space'] };
function pressKey(spec) {
  const parts = spec.split('+'), name = parts.pop(), mods = new Set(parts.map(m => m.toLowerCase()));
  const na = nativeFocus();
  if (na) {   // a native program has the keyboard: the key as a PC keyboard sends it, with its modifiers held around it
    const n = name.toLowerCase(), f = /^f(\d+)$/.exec(n);
    const [vk, code] = NATIVE_VK[n] || (f ? [111 + +f[1], 'F' + f[1]] : [name.toUpperCase().charCodeAt(0), (/\d/.test(name) ? 'Digit' : 'Key') + name.toUpperCase()]);
    const e = { keyCode: vk, code, shiftKey: mods.has('shift'), ctrlKey: mods.has('ctrl'), altKey: mods.has('alt') };
    na.key(e, false); na.key(e, true); na.key({ keyCode: 0, shiftKey: false, ctrlKey: false, altKey: false }, true);
    return;
  }
  const key = KEY_NAMES[name.toLowerCase()] || (/^f\d+$/i.test(name) ? name.toUpperCase() : name);
  handleKey({ key, shiftKey: mods.has('shift'), ctrlKey: mods.has('ctrl'), altKey: mods.has('alt'), metaKey: mods.has('meta'), preventDefault() {} });
}
// What is on screen, as Active Accessibility describes a window tree: each element's role, name, rectangle in screen
// pixels, state and value, front-most last. Geometry is current as of a fresh redraw.
const ROLE_W32 = { push: 'pushbutton', check: 'checkbutton', radio: 'radiobutton', group: 'grouping', static: 'text', edit: 'text-edit',
  combo: 'combobox', list: 'list', slider: 'slider', updown: 'spinbutton' };
function elements() {
  render();
  const out = [], add = (role, name, r, o = {}) => out.push({ role, name: name ?? '', x: r.x, y: r.y, w: r.w, h: r.h, ...o });
  const label = s => amp(s || '')[0];
  const cell = (c, o) => add('listitem', c.it.label, c.small ? { x: c.ix, y: c.iy, w: c.lx - c.ix + c.lw + 2, h: 16 }
    : { x: Math.min(c.ix, c.lx), y: c.iy, w: Math.max(32, c.lw), h: c.ly + c.lines.length * 13 - c.iy }, o);
  for (const c of desk.cells) cell(c, { window: 'Desktop', selected: desk.selKey === c.it.key });
  for (const w of windows) {
    if (w.min) continue;
    const win = { window: w.title };
    add('window', w.title, w, { active: w.isActive, modal: modals.includes(w), maximized: !!w.max });
    add('titlebar', w.title, w.capR, win);
    for (const b of w.buttons()) add('pushbutton', { close: 'Close', max: 'Maximize', restore: 'Restore', min: 'Minimize' }[b.id], b, { ...win, disabled: !!b.disabled });
    if (w.native && w.app.alive && w.app.proc && !w.app.proc.depth) {   // the controls USER keeps for a native window
      let kids = []; try { kids = w.app.proc.nativeChildren(w.hwnd); } catch (e) { console.error(e); }
      for (const c of kids) {
        const bs = c.style & 0x0f, k = c.cls.toLowerCase();
        const role = k === 'button' ? (bs === 7 ? 'grouping' : [2, 3, 5, 6].includes(bs) ? 'checkbutton' : [4, 9].includes(bs) ? 'radiobutton' : 'pushbutton')
          : k === 'edit' ? 'text-edit' : k === 'static' ? 'text' : k === 'combobox' ? 'combobox' : k === 'listbox' ? 'list'
          : k === 'scrollbar' ? 'scrollbar' : /listview/i.test(k) ? 'list' : /toolbar/i.test(k) ? 'toolbar' : 'client';
        add(role, label(c.text), c, { ...win, cls: c.cls, id: c.id, hwnd: c.hwnd, disabled: !c.enabled, focused: c.focused,
          ...(c.checked !== undefined ? { checked: !!c.checked } : {}), ...(role === 'text-edit' || role === 'combobox' ? { value: c.text } : {}) });
      }
    }
    for (const b of w.barItems()) add('menuitem', label(b.m.label), b, { ...win, menubar: true, open: w.barOpen === w.barItems().indexOf(b) });
    const body = w.body;
    if (body instanceof FolderView) {
      for (const t of body.tbButtons()) add('pushbutton', t.b[2], t, { ...win, toolbar: true, disabled: !body.tbEnabled(t.b[3]), checked: t.b[3] === body.mode });
      if (body.mode === 'details') { let hx = body.head.x; for (const c of DETAIL_COLS) { add('columnheader', c.label, { x: hx, y: body.head.y, w: c.w, h: body.head.h }, win); hx += c.w; } }
      for (const c of body.cells) if (c.iy + 16 > body.inner.y && c.iy < body.inner.y + body.inner.h && c.ix + 16 > body.inner.x && c.ix < body.inner.x + body.inner.w) cell(c, { ...win, selected: body.selKey === c.it.key, view: body.mode });
    }
    if (body instanceof Notepad && body.ta) add('document', w.title, body.ta, { ...win, value: body.t.replace(/\n/g, '\r\n'), modified: body.modified, selection: body.sel, wrap: body.wrap });
    if (body instanceof DialogBody && body.r) {
      for (const c of body.c) {
        if (!body.vis(c)) continue;
        const r = body.hitRect(c), dis = !!c.disabled, foc = body.c[body.focus] === c;
        if (c.type === 'button') add('pushbutton', label(c.label), r, { ...win, disabled: dis, focused: foc, default: !!c.def });
        else if (c.type === 'check') add('checkbutton', label(c.label), r, { ...win, disabled: dis, focused: foc, checked: !!c.checked });
        else if (c.type === 'radio') add('radiobutton', label(c.label), r, { ...win, disabled: dis, focused: foc, checked: !!c.checked });
        else if (c.type === 'edit') add(c.onDrop ? 'combobox' : 'text-edit', '', r, { ...win, disabled: dis, focused: foc, readonly: !!c.readonly, value: c.value });
        else if (c.type === 'label') add('text', label(c.text), r, win);
        else if (c.type === 'group') add('grouping', label(c.label), r, win);
        else if (c.type === 'tabs' && c.hdr) c.hdr.forEach((h, k) => add('pagetab', c.tabs[k], h, { ...win, selected: k === body.page }));
        else if (c.type === 'custom' && c.list) {
          add('outline', '', r, { ...win, focused: foc });
          c.list.forEach((row, i) => {
            const y = c.inner.y + (i - c.top) * 17 + 1; if (y < c.inner.y || y + 16 > c.inner.y + c.inner.h) return;
            add('outlineitem', row.label, { x: c.inner.x + 2 + row.depth * 19, y, w: 20 + textW(esc(row.label)) + 4, h: 16 }, { ...win, path: row.path, selected: !!(row.path && c.sel && row.path.toUpperCase() === c.sel.toUpperCase()), expanded: c.open.has(row.path) });
          });
        }
        else if (c.type === 'custom' && c.key) add('list', '', r, { ...win, focused: foc });
      }
    }
    if (body instanceof Win32DialogBody && body.r) {
      for (const [i, c] of body.d.ctls.entries()) {
        if (!c.visible) continue;
        const k = body.kind(c), o = { ...win, disabled: !c.enabled, focused: body.focus === i };
        if (k === 'check' || k === 'radio') o.checked = !!c.check;
        if (k === 'edit' || k === 'combo') o.value = c.text;
        if (k === 'combo' || k === 'list') { o.items = [...c.items]; o.selected = c.sel; }
        if (k === 'slider') { o.value = c.pos; o.min = Math.min(c.min, c.max); o.max = Math.max(c.min, c.max); }
        add(ROLE_W32[k] || k, ['edit', 'combo', 'list', 'slider', 'updown'].includes(k) ? '' : label(c.text), body.abs(c), o);
      }
    }
  }
  const L = taskLayout();
  add('pushbutton', 'Start', L.start, { window: 'Taskbar', pressed: !!(menuSrc && menuSrc.kind === 'start') });
  for (const b of L.btns) add('pushbutton', b.t.title, b, { window: 'Taskbar', pressed: b.t === active && !b.t.min });
  for (const i of L.icons) add('icon', i.t.tip, i, { window: 'Taskbar' });
  if (tbar.clock) add('clock', clockStr(), L.tray, { window: 'Taskbar' });
  menus.forEach((m, d) => m.items.forEach((it, i) => {
    const r = m.rows[i]; if (it.sep) return;
    add('menuitem', label(it.label), { x: m.x + 3, y: m.y + r.y, w: m.w - 6, h: r.h }, { window: 'Menu', depth: d, disabled: !!it.disabled, submenu: !!it.sub, hot: m.hover === i, checked: !!it.check });
  }));
  // covered: a click at its centre would land on something drawn over it (a later window, the taskbar, a menu)
  const bar = { x: 0, y: L.y, w: W, h: TB }, above = [];
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i], cx = e.x + (e.w >> 1), cy = e.y + (e.h >> 1);
    if (e.window === 'Menu') { above.push(e); continue; }
    e.covered = above.some(a => inR(a, cx, cy)) || (e.window !== 'Taskbar' && inR(bar, cx, cy));
    if (e.role === 'window') above.push(e);
  }
  return out;
}
// the front-most element matching every given field: strings match exactly, RegExps test
function findEl(q) {
  if (typeof q === 'string' || q instanceof RegExp) q = { name: q };
  const ok = e => Object.entries(q).every(([k, v]) => v instanceof RegExp ? v.test(String(e[k] ?? '')) : e[k] === v);
  const all = elements(); for (let i = all.length - 1; i >= 0; i--) if (ok(all[i])) return all[i];
  return null;
}
// an element, a query for one, or plain coordinates, as the point a click lands on
function target(a, b) {
  if (typeof a === 'number') return [a, b];
  const e = a && typeof a === 'object' && !(a instanceof RegExp) && 'x' in a && 'w' in a ? a : findEl(a);
  if (!e) throw new Error('no element matches ' + JSON.stringify(a, (k, v) => v instanceof RegExp ? String(v) : v));
  return [e.x + (e.w >> 1), e.y + (e.h >> 1)];
}

const script = {
  move(x, y) { [x, y] = target(x, y); pointer('pointermove', x, y); },
  down(x, y, o = {}) { if (typeof x !== 'number') { o = y || {}; [x, y] = target(x); } pointer('pointerdown', x, y, o.button === 'right' ? 2 : 0); },
  up(x, y, o = {}) { if (typeof x !== 'number') { o = y || {}; [x, y] = target(x); } pointer('pointerup', x, y, o.button === 'right' ? 2 : 0); },
  click(x, y, o = {}) {
    if (typeof x !== 'number') { o = y || {}; [x, y] = target(x); }
    const b = o.button === 'right' ? 2 : 0;
    for (let i = 0; i < (o.double ? 2 : 1); i++) { pointer('pointermove', x, y); pointer('pointerdown', x, y, b); pointer('pointerup', x, y, b); }
  },
  dblclick(x, y) { if (typeof x !== 'number') [x, y] = target(x); script.click(x, y, { double: true }); },
  drag(x1, y1, x2, y2, steps = 8) {
    if (typeof x1 !== 'number') { steps = x2 ?? 8; [x2, y2] = target(y1); [x1, y1] = target(x1); }
    pointer('pointermove', x1, y1); pointer('pointerdown', x1, y1);
    for (let i = 1; i <= steps; i++) pointer('pointermove', Math.round(x1 + (x2 - x1) * i / steps), Math.round(y1 + (y2 - y1) * i / steps));
    pointer('pointerup', x2, y2);
  },
  type(text) { const na = nativeFocus(); if (na) { na.typeText(String(text).replace(/\r/g, '')); return; } for (const ch of String(text).replace(/\r/g, '')) handleKey({ key: ch === '\n' ? 'Enter' : ch, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} }); },
  key(...specs) { for (const k of specs) pressKey(k); },
  elements(q) { const all = elements(); if (!q) return all; if (typeof q === 'string' || q instanceof RegExp) q = { name: q };
    return all.filter(e => Object.entries(q).every(([k, v]) => v instanceof RegExp ? v.test(String(e[k] ?? '')) : e[k] === v)); },
  find: q => findEl(q),
  windows() { return windows.map(winInfo); },
  window(title) { const w = findWin(title); return w ? winInfo(w) : null; },
  activate(title) { const w = findWin(title); if (!w) return false; if (w.min) w.min = false; activate(w); dirty(); return true; },
  close(title) { const w = findWin(title); if (!w) return false; closeWin(w); dirty(); return true; },
  menus() { return menus.map(m => m.items.map(i => i.sep ? '-' : amp(i.label || '')[0])); },
  run(cmd) { runCommand(cmd); dirty(); },
  open(path) { openPath(path); dirty(); },
  saver(path) { startFullSaver(path); },
  stopSaver() { if (!fullSaver || !fullSaver.pid) return false; stopSaverProcess(fullSaver); fullSaver = null; return true; },
  screen() { return { width: W, height: H, taskbar: barTop() }; },
  screenshot() { render(); return cv.toDataURL('image/png'); },
  saverStats() { return null; },
  on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
  // resolves with the next event of this type that passes the test, or rejects after the timeout
  next(type, test = () => true, ms = 10000) {
    return new Promise((ok, no) => {
      const off = script.on(type, e => { if (test(e)) { off(); clearTimeout(t); ok(e); } });
      const t = setTimeout(() => { off(); no(new Error(`no ${type} within ${ms} ms`)); }, ms);
    });
  },
};

window.win95 = { ...script, get nativeApps() { return [...nativeApps]; }, startSystem, get sysApp() { return sysApp; }, startNetwork, netBoot, netCall, syncNetDrives, mapNetDrive, disconnectNetDrive, get netApp() { return netApp; }, fs, render, displayProperties, startFullSaver, get fullSaver() { return fullSaver; }, properties, driveProps, openFolder, openPath, shellOpen, notepad, msgBox, runDialog, findComputer, findFiles, winHelp, shutDownDialog, MyComputer, get state() { return { menus: menus.length, menuSrc, modals: modals.length, cap: !!cap, drag: !!drag, screen, active: active && active.title }; } };
})();
