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
function mountDrives() {
  fs.mount('A', { kind: 'removable', ready: false, total: 1457664, cluster: 512 });
  fs.mount('C', { kind: 'fixed', total: 536870912, cluster: 8192 });
  fs.mount('D', { kind: 'cdrom', label: window.W95CD.label, readonly: true, cluster: 2048, fsname: 'CDFS' });
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const conv = e => (e[2] ? [e[0], e[1], e[2].map(conv)] : e[4] ? [e[0], e[1], null, e[3], b64(e[4])] : e);
  fs.load('D', window.W95CD.tree.map(conv));
}
// Setup's first boot: C: as a fresh install leaves it
function makeDisk(mounted) {
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
  txt(WINDIR + '\\SYSTEM.INI', '[boot]\nshell=Explorer.exe\nSCRNSAVE.EXE=\nsystem.drv=system.drv\ndisplay.drv=pnpdrvr.drv\n\n[386Enh]\nmouse=*vmouse, msmouse.vxd\n\n[boot.description]\ndisplay.drv=Standard Display Adapter (VGA)\n');
  for (const e of ['NOTEPAD.EXE', 'EXPLORER.EXE', 'REGEDIT.EXE', 'CALC.EXE', 'WRITE.EXE', 'TASKMAN.EXE', 'PROGMAN.EXE', 'WINFILE.EXE', 'SOL.EXE'])
    fs.writeFile(join(WINDIR, e), exeStub());
  for (const e of ['USER.EXE', 'GDI.EXE', 'KRNL386.EXE', 'USER32.DLL', 'GDI32.DLL', 'KERNEL32.DLL', 'SHELL32.DLL', 'COMCTL32.DLL', 'VMM32.VXD'])
    fs.writeFile(join(WINDIR, 'SYSTEM', e), exeStub());
  for (const e of ['FORMAT.COM', 'XCOPY.EXE', 'EDIT.COM', 'MEM.EXE', 'DELTREE.EXE']) fs.writeFile(join(WINDIR, 'COMMAND', e), exeStub());
  // the fonts a VGA install puts in C:\WINDOWS\FONTS, from the CD when the native system modules are present
  for (const e of ['SSERIFE.FON', 'VGAFIX.FON', 'VGASYS.FON', 'MARLETT.TTF', 'ARIAL.TTF', 'TIMES.TTF', 'COUR.TTF']) if (!sysFonts[e]) fs.writeFile(join(WINDIR, 'FONTS', e), exeStub());
  for (const [e, d] of Object.entries(sysFonts)) fs.writeFile(join(WINDIR, 'FONTS', e), b64(d));
  fs.writeFile('C:\\Program Files\\Accessories\\WORDPAD.EXE', exeStub());
  fs.writeFile(PROGRAMS + '\\Accessories\\Notepad.lnk', lnk(WINDIR + '\\NOTEPAD.EXE'));
  installPrograms();
  // the CD's screen savers, byte for byte, under the long names APPLETS.INF gives them in LDID_SYS
  const LONG = { 'BEZIER.SCR': 'Curves and Colors.scr', 'SSMARQUE.SCR': 'Scrolling Marquee.scr', 'SSMYST.SCR': 'Mystify Your Mind.scr',
    'SCRNSAVE.SCR': 'Blank Screen.scr', 'SSFLYWIN.SCR': 'Flying Windows.scr', 'SSSTARS.SCR': 'Flying Through Space.scr' };
  for (const [name, s] of Object.entries((window.W95SAVERS || {}).savers || {}))
    fs.writeFile(join(WINDIR, 'SYSTEM', LONG[name] || name), Uint8Array.from(atob(s.scr), c => c.charCodeAt(0)));
  for (const [name, d] of Object.entries((window.W95SAVERS || {}).dlls || {}))
    fs.writeFile(join(WINDIR, 'SYSTEM', name), Uint8Array.from(atob(d.file), c => c.charCodeAt(0)));
  fs.writeFile(PROGRAMS + '\\Windows Explorer.lnk', lnk(WINDIR + '\\EXPLORER.EXE'));
  fs.chdir('C:\\');
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
  installPrograms();
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
};
const EXE_ICON = { 'NOTEPAD.EXE': 'notepad', 'EXPLORER.EXE': 'explorer' };
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
function readLnk(p) { try { const m = /^Target=(.*)$/m.exec(fs.readText(p)); return m ? m[1].trim() : null; } catch (_) { return null; } }
function driveIcon(l) { const v = fs.vols.get(l); return v.kind === 'removable' ? 'floppy' : v.kind === 'cdrom' ? 'cdrom' : 'hdd'; }
function driveLabel(l) {
  const v = fs.vols.get(l);
  if (v.kind === 'removable') return `3\u00bd Floppy (${l}:)`;
  return (v.label ? v.label[0] + v.label.slice(1).toLowerCase() + ' ' : '') + `(${l}:)`;
}
function iconFor(i, depth = 0) {
  if (i.isDir) return isRoot(i.path) ? driveIcon(i.drive) : 'folder';
  const e = extname(i.name);
  if (e === 'lnk') { const t = readLnk(i.path); try { return t && depth < 4 ? iconFor(fs.stat(t), depth + 1) : 'app'; } catch (_) { return 'app'; } }
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
  get title() { const p = this.path; return isRoot(p) ? driveLabel(p[0]) : dispName(basename(p), true); }
  get icon() { return isRoot(this.path) ? driveIcon(this.path[0]) : 'folder'; }
  get readonly() { return fs.vols.get(this.path[0]).readonly; }
  list() {
    const all = fs.readdir(this.path).sort(byName);
    this.hidden = all.filter(i => i.hidden).length;
    return all.filter(i => !i.hidden).map(fsItem);
  }
}
const virt = (id, title, icon, list) => ({ id, title, icon, list, readonly: true, path: null, gone: false });
const ControlPanel = virt('cp', 'Control Panel', 'controlpanel', () => []);
const Printers = virt('printers', 'Printers', 'printers', () => []);
const MyComputer = virt('mycomputer', 'My Computer', 'mycomputer', () => [
  ...fs.volumes().map(v => ({ key: 'drv:' + v.letter, label: driveLabel(v.letter), icon: driveIcon(v.letter), drive: v.letter, path: v.root, open: () => openPath(v.root) })),
  { key: 'v:cp', label: 'Control Panel', icon: 'controlpanel', virt: true, open: () => openFolder(ControlPanel) },
  { key: 'v:pr', label: 'Printers', icon: 'printers', virt: true, open: () => openFolder(Printers) },
]);
const Network = virt('net', 'Network Neighborhood', 'network', () => [
  { key: 'v:en', label: 'Entire Network', icon: 'globe', virt: true, open: () => msgBox('Entire Network', 'Unable to browse the network.\n\nThe network is not accessible.', 'error') },
]);
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
  msgBox(dispName(basename(path)), `${path} is not a valid Windows application.`, 'error');
}
// Notepad: the CD's NOTEPAD.EXE on the native USER when the system bundle has it, the shell's own otherwise
function runNotepad(file, exe = join(WINDIR, 'NOTEPAD.EXE')) {
  runNative(exe, file ? (/\s/.test(file) ? `"${file}"` : file) : '').then(ok => { if (!ok) notepad(file); });
}
const resolveArg = a => { a = a.trim().replace(/^"(.*)"$/, '$1'); return /^[a-z]:|^\\/i.test(a) ? a : join(fs.cwd, a); };
function openLnk(path) {
  const t = readLnk(path);
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
function binItems() {
  let raw = ''; try { raw = fs.readText(BIN_INFO); } catch (_) { return []; }
  return raw.split('\r\n').filter(Boolean).map(l => {
    const [file, orig, t] = l.split('\t'), path = join(BIN, file);
    return fs.exists(path) ? { file, orig, t: +t, path, info: fs.stat(path) } : null;
  }).filter(Boolean);
}
const binWrite = list => fs.writeFile(BIN_INFO, list.map(e => `${e.file}\t${e.orig}\t${e.t}\r\n`).join(''));
function recycle(path) {
  const items = binItems(), i = fs.stat(path), orig = i.path;
  const n = items.reduce((m, e) => Math.max(m, +((/^DC(\d+)/i.exec(e.file) || [0, 0])[1])), 0) + 1;
  const ext = i.isDir ? '' : extname(i.name), file = `DC${n}${ext ? '.' + ext.toUpperCase() : ''}`;
  fs.rename(orig, join(BIN, file));
  binWrite([...items, { file, orig, t: Date.now() }]);
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
  const base = isRoot(target) ? driveLabel(target[0]) : dispName(basename(target), fs.stat(target).isDir);
  let p; for (let k = 1; ; k++) { p = join(dir, `Shortcut${k > 1 ? ` (${k})` : ''} to ${base.replace(/[\\/:*?"<>|]/g, '')}.lnk`); if (!fs.exists(p)) break; }
  return fsTry('create', 'shortcut', () => fs.writeFile(p, lnk(target))) ? p : null;
}
function createShortcut(view, it) {
  const target = it.path; if (!target) return;
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
  out.push({ label: 'Create &Shortcut', disabled: !(real || it.drive), fn: () => createShortcut(view, it) });
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
  if (it.drive) { const v = fs.vols.get(it.drive); return { fixed: 'Local Disk', removable: '3½ Inch Floppy Disk', cdrom: 'CD-ROM Disc' }[v.kind]; }
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
      { label: '&Help', items: [{ label: '&Help Topics', disabled: true }, { sep: true }, { label: '&About Windows 95', fn: aboutWin95 }] },
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
  const kind = { fixed: 'Local Disk', removable: '3\u00bd Inch Floppy Disk', cdrom: 'CD-ROM Disk' }[v.kind];
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
      { label: '&Help', items: [{ label: '&Help Topics', disabled: true }, { sep: true }, { label: '&About Notepad', fn: () => msgBox('About Notepad', 'Microsoft Notepad\nWindows 95', 'info') }] },
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
function msgBox(title, msg, type, buttons = ['OK'], cb) {
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
  win = dialog(title, cw, ch, ctrls);
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
    { type: 'button', label: '&Help', x: bx + 162, y: 118, w: 75, h: 23, disabled: true },
  ], { dim: true });
}
function shutdownSeq(restart) {
  [...windows].forEach(w => closeWin(w, true)); closeMenus();
  screen = 'logow'; dirty();
  setTimeout(() => {
    if (restart) { screen = 'black'; dirty(); setTimeout(boot, 1200); } else { screen = 'logos'; dirty(); }
  }, 2600);
}
// The disk lives in memory, so it survives a restart but not a page reload.
function boot() { screen = 'desktop'; ren = null; desk.selKey = null; active = null; dirty(); }

// ---------------------------------------------------------------- desktop
const SYS_ITEMS = () => [
  { key: 'sys:mc', label: 'My Computer', icon: 'mycomputer', virt: true, open: () => openFolder(MyComputer) },
  { key: 'sys:net', label: 'Network Neighborhood', icon: 'network', virt: true, open: () => openFolder(Network) },
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
const fontsReady = Promise.all(Object.entries(SV.fonts).map(([fam, data]) => {
  const f = new FontFace(fam, b64bytes(data)); document.fonts.add(f); return f.load().catch(() => null);
}));
async function sha256hex(b) { const h = await crypto.subtle.digest('SHA-256', b); return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join(''); }
// GDI.EXE, GDI32.DLL and the display driver run natively in a saver process when it needs them (outline fonts);
// their modules are compiled once, off the main thread's synchronous path
let sysCompile = null;
function systemCompiled() {
  const S = window.W95SYSTEM; if (!S) return Promise.resolve();
  return sysCompile || (sysCompile = Promise.all([...Object.values(S.ne), ...Object.values(S.dlls)].map(async m => { m.mod = await WebAssembly.compile(b64bytes(m.wasm)); })));
}
function compiledSaver(sha) {
  for (const [name, s] of Object.entries(SV.savers)) {
    if (s.meta.sha256 !== sha) continue;
    if (!s.module) s.module = WebAssembly.compile(b64bytes(s.wasm));
    return { name, s };
  }
  return null;
}
const mkc = (w, h) => Object.assign(document.createElement('canvas'), { width: Math.max(1, w), height: Math.max(1, h) });
const PREVIEW_HWND = 0x7ff0;
let fullSaver = null, lastInput = performance.now();

class SaverRun {
  constructor(path, mode, o = {}) { this.path = path; this.mode = mode; this.o = o; this.alive = true; this.canvas = null; this.mx = mouse.x; this.my = mouse.y; }
  async start() {
    let bytes;
    try { bytes = fs.readFile(this.path); } catch (e) { msgBox('Display Properties', fsMsg(this.path, e), 'error'); return false; }
    const hit = compiledSaver(await sha256hex(bytes));
    if (!hit) { msgBox('Display Properties', `${basename(this.path)} has no recompiled code module.`, 'error'); this.alive = false; return false; }
    const module = await hit.s.module; await fontsReady; await systemCompiled();
    // Microsoft DLLs on C:\WINDOWS\SYSTEM that have recompiled modules run natively in the process
    const dlls = new Map();
    for (const [name, d] of Object.entries(SV.dlls || {})) {
      let file; try { file = fs.readFile(join(WINDIR, 'SYSTEM', name)); } catch (_) { continue; }
      if (await sha256hex(file) !== d.meta.sha256) continue;
      if (!d.module) d.module = WebAssembly.compile(b64bytes(d.wasm));
      dlls.set(name.replace(/\.DLL$/, ''), { file, module: await d.module, meta: d.meta });
    }
    if (!this.alive) return false;
    if (this.mode === 's') this.overlay();
    if (this.mode === 'p') this.canvas = mkc(this.o.w, this.o.h);
    const host = {
      fs, width: W, height: H, path: this.path, now: () => performance.now(),
      cursor: () => (this.mode === 's' ? { x: this.mx, y: this.my } : { x: mouse.x, y: mouse.y }),
      previewParent: this.mode === 'p' ? PREVIEW_HWND : 0, previewW: this.o.w, previewH: this.o.h,
      surface: (hwnd, w, h) => this.surface(w, h),
      exited: (code, why) => this.exited(code, why),
      setCursor: () => {},
      dialog: (proc, d) => win32Dialog(proc, d),
      closeDialog: d => { if (d.ui) closeWin(d.ui, true); dirty(); },
    };
    const exe = /\s/.test(this.path) ? `"${this.path}"` : this.path;
    const cmd = this.mode === 's' ? `${exe} /s` : this.mode === 'p' ? `${exe} /p ${PREVIEW_HWND}` : `${exe} /c:0`;
    try { this.proc = new W95Win32.Process(bytes, module, { ...hit.s.meta, name: hit.name }, host, cmd, dlls); }
    catch (e) { console.error(e); this.exited(-1, e.message); return false; }
    this.loop(); return true;
  }
  surface(w, h) {
    if (this.mode === 'p') return this.canvas.getContext('2d');
    if (this.mode === 's') return this.ctx2d;
    return mkc(w, h).getContext('2d');
  }
  loop() {
    const step = () => {
      if (!this.alive) return;
      const p = this.proc;
      const t0 = performance.now();
      try { for (let n = 0; this.alive && p.ready() && n < 4; n++) { p.stats.slices++; if (!p.slice()) break; } }
      catch (e) { console.error(e); this.exited(-1, e.message); return; }
      // a guest that faulted or exited without reporting it must not leave its window up
      p.stats.guestMs += performance.now() - t0;
      if (p.trapped && !p.failed) p.fail(p.trapped);
      if (p.exitCode !== null || p.trapped) { this.exited(p.exitCode, p.trapped); return; }
      if (this.mode === 'p') dirty();
      // guest time is driven by its own timers and message loop
      const p2 = this.proc, now = performance.now();
      const next = p2 && p2.waiting ? Math.min(...p2.timers.map(t => t.due), now + 50) : now;
      setTimeout(step, Math.max(0, next - now));
    };
    setTimeout(step, 0);
  }
  overlay() {
    const c = this.el = mkc(W, H);
    c.style.cssText = `position:fixed;left:0;top:0;width:${W * ZOOM}px;height:${H * ZOOM}px;image-rendering:pixelated;cursor:none;z-index:10;background:#000`;
    document.body.appendChild(c);
    this.ctx2d = c.getContext('2d', { alpha: false });
    const pos = e => { const r = c.getBoundingClientRect(); return [Math.floor((e.clientX - r.left) * W / r.width), Math.floor((e.clientY - r.top) * H / r.height)]; };
    const WM = W95Win32.WM;
    c.addEventListener('pointermove', e => { [this.mx, this.my] = pos(e); this.proc && this.proc.dispatchInput(WM.MOUSEMOVE, 0, (this.my << 16) | this.mx); });
    c.addEventListener('pointerdown', e => { e.preventDefault(); [this.mx, this.my] = pos(e); this.proc && this.proc.dispatchInput(e.button === 2 ? WM.RBUTTONDOWN : WM.LBUTTONDOWN, 0, (this.my << 16) | this.mx); });
    c.addEventListener('contextmenu', e => e.preventDefault());
  }
  key(e) { if (this.proc) this.proc.dispatchInput(W95Win32.WM.KEYDOWN, e.keyCode || 0, 0); }
  stop() { this.alive = false; if (this.proc) trayDrop(this.proc); if (this.el) this.el.remove(); if (fullSaver === this) fullSaver = null; }
  exited(code, why) {
    if (!this.alive) return;
    this.stop(); lastInput = performance.now(); dirty();
    emit('program.exit', { path: this.path, mode: this.mode, code: code ?? null, ...(why ? { why } : {}) });
    if (why) msgBox(basename(this.path), `${basename(this.path)} stopped: ${why}`, 'error');
  }
}
function startFullSaver(path) {
  if (fullSaver || !path) return;
  closeMenus();
  fullSaver = new SaverRun(path, 's');
  fullSaver.start();
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
// ---------------------------------------------------------------- Windows programs on the native USER
// A program the system bundle carries (NOTEPAD.EXE) runs as Windows 95 runs it: its own code on USER32, USER.EXE, GDI
// and the display driver, all recompiled, in a machine of its own whose screen is an ET4000 mode no larger than the
// shell's. Each visible top-level window USER has on that screen is a window of the shell at the same place, drawn
// from the machine's framebuffer and kept in USER's order; the mouse goes to USER while it is over one of them or USER
// holds the capture (menus, dragging), and the keys while one of them is the active window.
const nativeApps = new Set();
const NATIVE_MODES = [[1024, 768], [800, 600], [640, 480]];
async function nativeProgram(bytes) {
  const progs = (window.W95SYSTEM || {}).programs || {}, sha = await sha256hex(bytes);
  for (const [name, d] of Object.entries(progs)) if (d.meta.sha256 === sha) return { name, d };
  return null;
}
// the files the bundle carries for programs replace the placeholders an older disk has for them
function installPrograms() {
  const stub = exeStub();
  for (const [name, d] of Object.entries((window.W95SYSTEM || {}).programs || {})) {
    const path = join(WINDIR, name); let cur = null; try { cur = fs.readFile(path); } catch (_) { /* not there */ }
    if (cur && !(cur.length === stub.length && cur.every((b, i) => b === stub[i]))) continue;
    fs.writeFile(path, b64bytes(d.file));
  }
}
class NativeWin extends Win {
  constructor(app, n) {
    super({ resizable: false, maximizable: false, icon: app.icon });
    this.app = app; this.hwnd = n.hwnd; this.native = true;
    this.noTask = !!n.owner || n.cls === '#32768' || !n.title;
    this.minimizable = !this.noTask;
    this.set(n);
  }
  set(n) { Object.assign(this, { x: n.x, y: n.y, w: n.w, h: n.h, title: n.title, min: n.iconic, cls: n.cls }); }
  draw() { this.app.blit(this); }
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
  constructor(path, arg) { this.path = path; this.arg = arg; this.alive = true; this.wins = new Map(); this.icon = EXE_ICON[basename(path).toUpperCase()] || 'app'; this.lastActive = 0; this.cursorOn = false; }
  async start(bytes, prog) {
    const S = window.W95SYSTEM;
    await systemCompiled();
    if (!prog.d.mod) prog.d.mod = WebAssembly.compile(b64bytes(prog.d.wasm));
    const module = await prog.d.mod;
    const dlls = new Map();
    for (const [n, d] of Object.entries(S.dlls)) { d.bytes = d.bytes || b64bytes(d.file); dlls.set(n.replace(/\.DLL$/, ''), { file: d.bytes, module: d.mod, meta: d.meta }); }
    [this.sw, this.sh] = NATIVE_MODES.find(([w, h]) => w <= W && h <= H) || NATIVE_MODES[NATIVE_MODES.length - 1];
    const host = {
      fs, width: this.sw, height: this.sh, path: this.path, now: () => performance.now(),
      cursor: () => ({ x: mouse.x, y: mouse.y }), surface: (h, w, hh) => mkc(w, hh).getContext('2d'), setCursor: () => {},
      exited: (code, why) => this.exited(code, why), boot: p => p.bootUser16(),
    };
    const exe = /\s/.test(this.path) ? `"${this.path}"` : this.path;
    try { this.proc = new W95Win32.Process(bytes, module, { ...prog.d.meta, name: prog.name.replace(/\.EXE$/, '') }, host, this.arg ? `${exe} ${this.arg}` : exe, dlls); }
    catch (e) { console.error(e); this.exited(-1, e.message); return false; }
    if (this.proc.trapped) { this.exited(-1, this.proc.trapped); return false; }
    { const a = this.proc.scanout(); if (a.bpp) [this.sw, this.sh] = [a.w, a.h]; }   // the mode the display driver set
    this.cv = mkc(this.sw, this.sh); this.cx = this.cv.getContext('2d'); this.img = this.cx.createImageData(this.sw, this.sh);
    this.d32 = new Uint32Array(this.img.data.buffer); this.pal = new Uint32Array(256);
    try {
      // the cursor USER draws shows only while the mouse is over this program's windows; its windows stay above the taskbar
      this.proc.user16(71, [['w', 0]]);
      const p = this.proc, r = p.wbufLin || (p.nativeWindows(), p.wbufLin);
      p.w16(r, 0); p.w16(r + 2, 0); p.w16(r + 4, this.sw); p.w16(r + 6, Math.min(this.sh, workH()));
      p.user16(483, [['w', 47], ['w', 0], ['l', p.wbufSel << 16], ['w', 0]]);   // SPI_SETWORKAREA
    } catch (e) { console.error(e); }
    nativeApps.add(this);
    this.step(); return true;
  }
  step() {
    clearTimeout(this.timer); this.timer = 0;
    if (!this.alive) return;
    const p = this.proc, t0 = performance.now();
    try { for (let n = 0; this.alive && n < 4; n++) { p.stats.slices++; const live = p.slice(); p.timers16(); p.threads16(); if (!live) break; } }
    catch (e) { console.error(e); this.exited(-1, e.message); return; }
    p.stats.guestMs += performance.now() - t0;
    if (p.trapped && !p.failed) p.fail(p.trapped);
    if (p.exitCode !== null || p.trapped) { this.exited(p.exitCode, p.trapped); return; }
    this.sync();
    this.timer = setTimeout(() => this.step(), 16);
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
    const a = this.proc.scanout(); if (a.bpp !== 8) return;
    const pal = this.pal, dac = a.dac, v = a.vram, pitch = a.pitch || a.w, d = this.d32, sw = this.sw, sh = this.sh;
    for (let i = 0; i < 256; i++) { const r = dac[3 * i], g = dac[3 * i + 1], b = dac[3 * i + 2]; pal[i] = 0xff000000 | ((b << 2 | b >> 4) << 16) | ((g << 2 | g >> 4) << 8) | (r << 2 | r >> 4); }
    for (const w of this.wins.values()) {
      if (w.min) continue;
      const x0 = Math.max(0, w.x), y0 = Math.max(0, w.y), x1 = Math.min(sw, a.w, w.x + w.w), y1 = Math.min(sh, a.h, w.y + w.h);
      if (x1 <= x0 || y1 <= y0) continue;
      for (let y = y0; y < y1; y++) { const s = y * pitch, o = y * sw; for (let x = x0; x < x1; x++) d[o + x] = pal[v[s + x]]; }
      this.cx.putImageData(this.img, 0, 0, x0, y0, x1 - x0, y1 - y0);
    }
  }
  blit(w) {
    const x0 = Math.max(0, w.x), y0 = Math.max(0, w.y), x1 = Math.min(this.sw, w.x + w.w), y1 = Math.min(this.sh, w.y + w.h);
    if (x1 > x0 && y1 > y0) ctx.drawImage(this.cv, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  }
  // the mouse: absolute moves and button changes into USER's mouse_event, as the mouse driver reports them
  pointer(kind, x, y, btn = 0) {
    if (!this.alive || !this.proc || this.proc.depth) return;
    const ax = Math.round(clamp(x, 0, this.sw - 1) * 65535 / (this.sw - 1)), ay = Math.round(clamp(y, 0, this.sh - 1) * 65535 / (this.sh - 1));
    const f = kind === 'down' ? (btn === 2 ? 8 : 2) : kind === 'up' ? (btn === 2 ? 16 : 4) : 1;
    try {
      this.showCursor(true);
      // the move first, as the mouse reports it before the button, so USER sees the button where the pointer is
      if (f !== 1 && (ax !== this.ax || ay !== this.ay)) this.proc.mouseEvent16(0x8001, ax, ay);
      this.proc.mouseEvent16(0x8001 | f, ax, ay); this.ax = ax; this.ay = ay;
    } catch (e) { console.error(e); }
    this.kick();
  }
  showCursor(on) {
    if (on === this.cursorOn || !this.alive) return;
    this.cursorOn = on; try { this.proc.user16(71, [['w', on ? 1 : 0]]); } catch (e) { console.error(e); }
    this.kick();
  }
  key(e, up) {
    if (!this.alive || this.proc.depth) return;
    const vk = e.keyCode || 0, sc = SCAN[e.code] || 0; if (!vk || vk === 91 || vk === 93 || vk === 224) return;   // the Mac command keys stay with the host
    try { this.proc.keyEvent16(vk, sc & 0xff, up, sc > 0xff); } catch (err) { console.error(err); }
    this.kick();
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
      if (shift) this.key({ keyCode: 16, code: 'ShiftLeft' }, false);
      this.key({ keyCode: vk, code: c }, false); this.key({ keyCode: vk, code: c }, true);
      if (shift) this.key({ keyCode: 16, code: 'ShiftLeft' }, true);
    }
  }
  focus(w) {
    try { if (w.min) this.proc.user16(42, [['w', w.hwnd], ['w', 9]]); else this.proc.user16(59, [['w', w.hwnd]]); } catch (e) { console.error(e); }   // ShowWindow SW_RESTORE, SetActiveWindow
    this.kick();
  }
  minimize(w) { try { this.proc.user16(42, [['w', w.hwnd], ['w', 6]]); } catch (e) { console.error(e); } this.kick(); }   // SW_MINIMIZE
  close(w) { try { this.proc.user16(110, [['w', w.hwnd], ['w', 0x10], ['w', 0], ['l', 0]]); } catch (e) { console.error(e); } this.kick(); }   // PostMessage WM_CLOSE
  exited(code, why) {
    if (!this.alive) return;
    this.alive = false; clearTimeout(this.timer); nativeApps.delete(this);
    for (const w of this.wins.values()) closeWin(w, true);
    this.wins.clear();
    emit('program.exit', { path: this.path, code, ...(why ? { why } : {}) });
    if (why) msgBox(basename(this.path), `This program has performed an illegal operation and will be shut down.\n\n${why}`, 'error');
    dirty();
  }
}
// the native program whose window is under the point, or that holds USER's capture
function nativeAt(x, y) {
  for (const a of nativeApps) if (a.capture) return a;
  const w = winAt(x, y); return w && w.native ? w.app : null;
}
async function runNative(path, arg) {
  let bytes; try { bytes = fs.readFile(path); } catch (e) { return false; }
  const prog = await nativeProgram(bytes); if (!prog) return false;
  const app = new NativeApp(path, arg);
  return app.start(bytes, prog);
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
  let preview = null, win;
  const restartPreview = () => {
    if (preview) preview.stop(); preview = null;
    const s = savers[cur];
    if (s.path) { preview = new SaverRun(s.path, 'p', { w: 152, h: 104 }); preview.start(); }
    settingsBtn.disabled = previewBtn.disabled = !s.path; dirty();
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
  const settingsBtn = { type: 'button', page: 1, x: 202, y: 255, w: 75, h: 23, label: 'Se&ttings...', fn: () => { const s = savers[cur]; if (s.path) new SaverRun(s.path, 'c').start(); } };
  const previewBtn = { type: 'button', page: 1, x: 284, y: 255, w: 75, h: 23, label: 'Pre&view', fn: () => { const s = savers[cur]; if (s.path) startFullSaver(s.path); } };
  const monitor = { type: 'custom', x: 104, y: 40, w: 184, h: 170,
    draw(a) {
      icon('monitor', a.x, a.y);
      if (body.page === 1) {
        if (preview && preview.canvas) ctx.drawImage(preview.canvas, a.x + 16, a.y + 17);
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
  body.onClose = () => { if (preview) preview.stop(); preview = null; };
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
function openApplet(k, name) {
  if (k === 'display') return displayProperties();
  if (k === 'fonts') return openPath(WINDIR + '\\FONTS');
  if (k === 'cplprinters') return openFolder(Printers);
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
    { label: '&Files or Folders...', icon: 'findfiles', disabled: true },
    { label: '&Computer...', icon: 'findcomp', disabled: true },
  ] },
  { label: '&Help', icon: 'help', disabled: true },
  { label: '&Run...', icon: 'run', fn: runDialog },
  { sep: true },
  { label: 'Sh&ut Down...', icon: 'shutdown', fn: shutDownDialog },
];

// ---------------------------------------------------------------- render
function render() {
  rafPending = false;
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
  drawDesktop();
  const m = modal();
  if (!tbar.ontop) drawTaskbar();
  for (const w of windows) if (!w.min && !(m && m.dim && w === m)) w.draw();
  if (tbar.ontop) drawTaskbar();
  if (m && m.dim) { ctx.fillStyle = PAT.dim; ctx.fillRect(0, 0, W, H); m.draw(); }
  for (const mm of menus) drawMenu(mm);
  if (drag) xorFrame(drag.r, drag.t);
  if (tip) {
    const tw = textW(tip.text) + 6, tx = clamp(tip.x, 0, W - tw), ty = tip.y;
    fill(tx, ty, tw, 17, K.tip); edge(tx, ty, tw, 17, K.dk, K.dk); text(tip.text, tx + 3, ty + 2);
  }
  drawCursor(cursorAt(mouse.x, mouse.y));
}
function drawCursor(name) {
  if (name === 'none') return;
  const c = CUR[name] || CUR.arrow; if (!c || mouse.x < 0) return;
  ctx.drawImage(c.i, mouse.x - c.hx, mouse.y - c.hy);
}
const SIZE_CUR = { n: 'sizens', s: 'sizens', e: 'sizewe', w: 'sizewe', nw: 'sizenwse', se: 'sizenwse', ne: 'sizenesw', sw: 'sizenesw' };
function cursorAt(x, y) {
  if (drag) return drag.cursor;
  for (const a of nativeApps) if (a.cursorOn) return 'none';   // USER draws its own
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
const onTaskbar = (x, y) => y >= barTop() && (tbar.ontop || !winAt(x, y));
function winAt(x, y) { for (let i = windows.length - 1; i >= 0; i--) if (!windows[i].min && inR(windows[i], x, y)) return windows[i]; return null; }
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
  for (const a of nativeApps) if (a !== na && !(cap && cap.native === a)) a.showCursor(false);
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
  const TL = taskLayout(), t = TL.tray, hov = TL.icons.find(v => inR(v, x, y));
  if (hov && screen === 'desktop' && !menus.length) {
    trayMouse(hov.t, 0x200);
    if (hov.t.tip && (!tip || tip.text !== hov.t.tip)) { hideTip(); tip = { text: hov.t.tip, x: mouse.x, y: barTop() - 20 }; }
  } else if (inR(t, x, y) && screen === 'desktop' && !menus.length) {
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
const nativeFocus = () => (!menus.length && !ren && !modal() && !fullSaver && screen === 'desktop' && active && active.native && active.app.alive ? active.app : null);
window.addEventListener('keyup', e => { const a = nativeFocus(); if (a) { e.preventDefault(); a.key(e, true); } });
window.addEventListener('keydown', e => {
  { const a = nativeFocus(); if (a) { lastInput = performance.now(); e.preventDefault(); if (!e.keyCode && e.key.length === 1) a.typeText(e.key); else a.key(e, false); return; } }
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
  if (fullSaver) { fullSaver.key(e); if (e.preventDefault) e.preventDefault(); return; }
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
function resize() {
  W = Math.max(320, Math.floor(innerWidth / ZOOM)); H = Math.max(240, Math.floor(innerHeight / ZOOM));
  cv.width = W; cv.height = H; cv.style.width = W * ZOOM + 'px'; cv.style.height = H * ZOOM + 'px';
  ctx.imageSmoothingEnabled = false;
  for (const w of windows) if (w.max) Object.assign(w, maxRect(w.b));
  closeMenus(); dirty();
}
window.addEventListener('resize', resize);
setInterval(() => { blinkOn = !blinkOn; dirty(); }, 530);

bootDisk();
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
  const el = fullSaver && fullSaver.el ? fullSaver.el : cv, r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent(type, { clientX: r.left + (x + 0.5) * r.width / W, clientY: r.top + (y + 0.5) * r.height / H,
    button, buttons: type === 'pointerup' ? 0 : 1 << (button === 2 ? 1 : 0), pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true }));
}
const winInfo = w => ({ title: w.title, x: w.x, y: w.y, w: w.w, h: w.h, active: w === active, minimized: !!w.min, maximized: !!w.max, modal: modals.includes(w), ...(w.message ? { message: w.message } : {}) });
const findWin = t => { const m = t instanceof RegExp ? w => t.test(w.title) : w => w.title === t; for (let i = windows.length - 1; i >= 0; i--) if (m(windows[i])) return windows[i]; return null; };
const KEY_NAMES = { enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', space: ' ' };
function pressKey(spec) {
  const parts = spec.split('+'), name = parts.pop(), mods = new Set(parts.map(m => m.toLowerCase()));
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
  const e = a && 'x' in a && 'w' in a ? a : findEl(a);
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
  type(text) { for (const ch of String(text).replace(/\r/g, '')) handleKey({ key: ch === '\n' ? 'Enter' : ch, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} }); },
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
  stopSaver() { if (!fullSaver) return false; fullSaver.exited(0); return true; },
  screen() { return { width: W, height: H, taskbar: barTop() }; },
  screenshot() { render(); return cv.toDataURL('image/png'); },
  // the running full-screen saver's counters since it started (timers, presents, slices, guestMs, ms)
  saverStats() { const f = fullSaver; return f && f.proc ? { ...f.proc.stats, ms: performance.now() - f.proc.t0 } : null; },
  on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
  // resolves with the next event of this type that passes the test, or rejects after the timeout
  next(type, test = () => true, ms = 10000) {
    return new Promise((ok, no) => {
      const off = script.on(type, e => { if (test(e)) { off(); clearTimeout(t); ok(e); } });
      const t = setTimeout(() => { off(); no(new Error(`no ${type} within ${ms} ms`)); }, ms);
    });
  },
};

window.win95 = { ...script, get nativeApps() { return [...nativeApps]; }, fs, render, SaverRun, displayProperties, startFullSaver, get fullSaver() { return fullSaver; }, properties, driveProps, openFolder, openPath, shellOpen, notepad, msgBox, runDialog, shutDownDialog, MyComputer, get state() { return { menus: menus.length, menuSrc, modals: modals.length, cap: !!cap, drag: !!drag, screen, active: active && active.title }; } };
})();
