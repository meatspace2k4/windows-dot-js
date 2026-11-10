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
const WINDIR = 'C:\\WINDOWS', BIN = 'C:\\RECYCLED', BIN_INFO = 'C:\\RECYCLED\\INFO';
// (the person's own, under Profiles, once they have logged on in a shared session: setupProfile)
let DESKTOP_DIR = 'C:\\WINDOWS\\Desktop', RECENT = 'C:\\WINDOWS\\Recent', PROGRAMS = 'C:\\WINDOWS\\Start Menu\\Programs', START_MENU = 'C:\\WINDOWS\\Start Menu';

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
// the disc in the CD drive (D:): an ISO 9660 image, read a sector range at a time. The app's host reads the image the
// person chose (File > Insert CD Image); a plain browser reads one of the server's images (/__cd lists them, each
// answering byte ranges; cdrom.iso alone where the server has no list). A disc's tree is read from the disc as it is
// put in, except the Windows 95 CD's, which cdrom.js has
const CD_KEY = 'w95.cd';
function cdImages() {
  const host = window.W95HOST && window.W95HOST.cd;
  if (host) return [{ name: (host.image && host.image()) || 'CD', url: null }];
  try {
    const x = new XMLHttpRequest(); x.open('GET', '__cd', false); x.send();
    if (x.status === 200) { const l = JSON.parse(x.responseText); if (Array.isArray(l) && l.length) return l; }
  } catch (_) { /* no list */ }
  return [{ name: 'cdrom.iso', url: 'cdrom.iso' }];
}
// an image as a disc: { read(sector, bytes) }, null where it does not answer
function cdDisc(img) {
  const host = window.W95HOST && window.W95HOST.cd;
  if (host) return { read: (sector, len) => { if (!len) return new Uint8Array(0); const b = host.read(sector, len); return b ? new Uint8Array(b) : null; } };
  return { read(sector, len) {
    if (!len) return new Uint8Array(0);
    const x = new XMLHttpRequest(); x.open('GET', img.url, false);
    x.setRequestHeader('Range', `bytes=${sector * 2048}-${sector * 2048 + len - 1}`); x.overrideMimeType('text/plain; charset=x-user-defined');
    x.send(); if (x.status !== 206 || x.responseText.length !== len) return null;
    const t = x.responseText, b = new Uint8Array(len); for (let i = 0; i < len; i++) b[i] = t.charCodeAt(i) & 0xff; return b;
  } };
}
// what is on a disc, as CDFS reads it: the label, the serial (the volume descriptor's bytes summed in four lanes, as
// Windows makes a CD's), the size in sectors, and the tree as fs.load takes it, from the Joliet descriptor (UCS-2
// names) when the disc has one, else the primary's; each file by the first sector of its extent. `known` is a tree
// read before (cdrom.js's), taken when its label and size are the disc's. null for no ISO 9660 disc
function cdRead(disc, known) {
  const pvd = disc.read(16, 2048), str = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
  if (!pvd || pvd.length !== 2048 || str(pvd, 1, 5) !== 'CD001') return null;
  let desc = pvd, joliet = false;
  for (let n = 17; n < 32; n++) {
    const d = disc.read(n, 2048); if (!d || d[0] === 255) break;
    if (d[0] === 2 && ['%/@', '%/C', '%/E'].includes(str(d, 88, 3))) { desc = d; joliet = true; break; }
  }
  const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const lane = [0, 0, 0, 0]; for (let i = 0; i < 2048; i++) lane[i & 3] = (lane[i & 3] + desc[i]) & 0xff;
  const out = { label: str(pvd, 40, 32).trim(), serial: (lane[0] | lane[1] << 8 | lane[2] << 16 | lane[3] << 24) >>> 0, sectors: dv(pvd).getUint32(80, true) };
  if (known && known.label === out.label && known.sectors === out.sectors) return { ...out, tree: known.tree };
  const when = (r, o) => Date.UTC(1900 + r[o], r[o + 1] - 1, r[o + 2], r[o + 3], r[o + 4], r[o + 5]) - dv(r).getInt8(o + 6) * 15 * 60000;
  const name = raw => {
    let s = ''; if (joliet) for (let i = 0; i + 1 < raw.length; i += 2) s += String.fromCharCode(raw[i] << 8 | raw[i + 1]); else s = str(raw, 0, raw.length);
    return s.split(';')[0].replace(/\.$/, '');
  };
  const seen = new Set();
  const walk = (lba, size) => {
    const kids = []; if (seen.has(lba)) return kids; seen.add(lba);
    const data = disc.read(lba, Math.ceil(size / 2048) * 2048); if (!data) return kids;
    for (let o = 0; o < size;) {
      const n = data[o]; if (!n) { o = (Math.floor(o / 2048) + 1) * 2048; continue; }
      const r = data.subarray(o, o + n); o += n;
      const ext = dv(r).getUint32(2, true), ln = dv(r).getUint32(10, true), raw = r.subarray(33, 33 + r[32]);
      if (raw.length === 1 && raw[0] < 2) continue;
      kids.push(r[25] & 2 ? [name(raw), when(r, 18), walk(ext, ln)] : [name(raw), when(r, 18), null, ln, null, ext]);
    }
    return kids.sort((a, b) => (a[0].toUpperCase() < b[0].toUpperCase() ? -1 : 1));
  };
  const root = desc.subarray(156, 190);
  return { ...out, tree: walk(dv(root).getUint32(2, true), dv(root).getUint32(10, true)) };
}
// puts the image named in the drive, the disc there taken out first, or takes the disc out (null); the drive's disc
// is kept for the next start (localStorage, or ?cd= names it), as a disc stays in its drive. AutoRun follows a disc
// put in, as Explorer runs it
const cdChoice = () => { try { return new URLSearchParams(location.search).get('cd') || localStorage.getItem(CD_KEY); } catch (_) { return null; } };
function cdInsert(name, o = {}) {
  const imgs = cdImages(), img = name == null ? null : imgs.find(i => i.name === name);
  if (img === undefined) throw new Error(`no CD image ${name}: ${imgs.map(i => i.name).join(', ')}`);
  if (!o.boot) try { if (img) localStorage.setItem(CD_KEY, img.name); else localStorage.removeItem(CD_KEY); } catch (_) { /* no storage */ }
  if (!img) { fs.change('D', null); return null; }
  const disc = cdDisc(img), b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const conv = e => (e[2] ? [e[0], e[1], e[2].map(conv)] : e[4] ? [e[0], e[1], null, e[3], b64(e[4])] : e);
  const W = window.W95CD, d = cdRead(disc, W && { label: W.label, sectors: W.sectors, get tree() { return W.tree.map(conv); } });
  if (!d) { fs.change('D', null); return null; }
  fs.change('D', { label: d.label, serial: d.serial, total: d.sectors * 2048, sectors: d.sectors, disc, tree: d.tree });
  if (!o.boot) setTimeout(() => autoRun('D'), 0);
  return { name: img.name, label: d.label, sectors: d.sectors };
}
// AutoRun, as Explorer does it when a disc comes: the root's AUTORUN.INF, its [autorun] open= command run with the
// disc's root the current folder, unless NoDriveTypeAutoRun (HKCU ...\Policies\Explorer: a bit per drive type, 95h
// when unset, which leaves a CD's on) turns it off for the drive's type
function autoRunCmd(letter) {
  let t; try { t = fs.readText(letter + ':\\AUTORUN.INF'); } catch (_) { return null; }
  let sec = '', open = null;
  for (const l of t.split(/\r?\n/)) {
    const m = /^\s*\[(.*)\]/.exec(l); if (m) { sec = m[1].trim().toLowerCase(); continue; }
    const k = /^\s*open\s*=\s*(.*?)\s*$/i.exec(l); if (sec === 'autorun' && k) open = k[1];
  }
  return open;
}
function autoRun(letter) {
  const v = fs.vols.get(letter); if (!v || !v.ready) return;
  const nd = W95Win32.regGet('hkcu\\software\\microsoft\\windows\\currentversion\\policies\\explorer', 'NoDriveTypeAutoRun');
  const mask = nd && nd.data && nd.data.length ? nd.data[0] : 0x95, type = { removable: 2, fixed: 3, remote: 4, cdrom: 5 }[v.kind] || 1;
  if (mask & (1 << type)) return;
  const open = autoRunCmd(letter); if (!open) return;
  const was = fs.cwd; fs.chdir(letter + ':\\');
  try { runCommand(/^[a-z]:|^\\/i.test(open) ? open : letter + ':\\' + open); } finally { try { fs.chdir(was); } catch (_) { /* gone */ } }
}
function mountDrives() {
  fs.mount('A', { kind: 'removable', ready: true, total: 1457664, cluster: 512 });
  fs.mount('C', { kind: 'fixed', total: 536870912, cluster: 8192 });
  fs.mount('D', { kind: 'cdrom', readonly: true, cluster: 2048, fsname: 'CDFS' });
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const conv = e => (e[2] ? [e[0], e[1], e[2].map(conv)] : e[4] ? [e[0], e[1], null, e[3], b64(e[4])] : e);
  fs.load('A', window.W95FLOPPY.tree.map(conv));
  { const c = cdChoice(), first = cdImages()[0].name; let r = null; try { r = cdInsert(c || first, { boot: true }); } catch (_) { /* gone from the server */ } if (!r && c && c !== first) cdInsert(first, { boot: true }); }
  const host = window.W95HOST && window.W95HOST.cd; if (host && host.on) host.on(name => cdInsert(name || null));   // (the app's File > Insert CD Image)
  // the second CD drive, E:, with the audio disc in it (cdaudio.js): its tracks the files CDFS shows (Track01.cda ...),
  // its table of contents the drive's (MSCDEX, ne16.js cdRequest)
  const A = window.W95CDAudio, toc = A.toc;
  const t0 = Date.UTC(1996, 0, 1), v = fs.mount('E', { kind: 'cdrom', label: 'Audio CD', readonly: true, cluster: 2048, fsname: 'CDFS' });
  v.audio = { tracks: toc.tracks.map(t => ({ number: t.number, lba: t.lba, sectors: t.sectors })), leadout: toc.leadout, serial: A.serial() };
  fs.load('E', toc.tracks.map(t => [`Track${String(t.number).padStart(2, '0')}.cda`, t0, null, 44, A.cda(t)]));
}
// C:\CONFIG.SYS as Setup leaves it: DOS in the HMA and its file handles; the machine's extended memory is its own
// (the XMS v86.js's BIOS gives, as V86MMGR gives a VM's), so it loads no HIMEM.SYS. A disk made with the line that
// named one (never put on the disk: "missing or corrupted", line 1) has it as this
const CONFIG_SYS = 'DOS=HIGH,UMB\nFILES=60\n', CONFIG_SYS_OLD = 'DEVICE=C:\\WINDOWS\\HIMEM.SYS\r\nDOS=HIGH,UMB\r\nFILES=60\r\n';
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
  txt('C:\\CONFIG.SYS', CONFIG_SYS);
  txt(WINDIR + '\\WIN.INI', '[windows]\nload=\nrun=\nNullPort=None\nScreenSaveActive=0\nScreenSaveTimeOut=900\n\n[Desktop]\nWallpaper=(None)\nTileWallpaper=0\nWallpaperStyle=0\n\n[intl]\nsCountry=United States\n\n[fonts]\n' + WIN_INI_FONTS.filter(([, f]) => sysFonts[f]).map(([n, f]) => `${n}=${f}\n`).join(''));
  txt(WINDIR + '\\SYSTEM.INI', '[boot]\nshell=Explorer.exe\nSCRNSAVE.EXE=\nsystem.drv=system.drv\ndisplay.drv=pnpdrvr.drv\nsound.drv=mmsound.drv\ndrivers=mmsystem.dll\n\n[386Enh]\nmouse=*vmouse, msmouse.vxd\n\n[boot.description]\ndisplay.drv=Standard Display Adapter (VGA)\n');
  for (const e of ['NOTEPAD.EXE', 'EXPLORER.EXE', 'REGEDIT.EXE', 'CALC.EXE', 'WRITE.EXE', 'TASKMAN.EXE', 'PROGMAN.EXE', 'WINFILE.EXE', 'SOL.EXE'])
    fs.writeFile(join(WINDIR, e), exeStub());
  for (const e of ['USER.EXE', 'GDI.EXE', 'KRNL386.EXE', 'USER32.DLL', 'GDI32.DLL', 'KERNEL32.DLL', 'SHELL32.DLL', 'COMCTL32.DLL', 'VMM32.VXD'])
    fs.writeFile(join(WINDIR, 'SYSTEM', e), exeStub());
  for (const e of ['FORMAT.COM', 'XCOPY.EXE', 'EDIT.COM', 'MEM.EXE', 'DELTREE.EXE']) fs.writeFile(join(WINDIR, 'COMMAND', e), exeStub());
  // the fonts a VGA install puts in C:\WINDOWS\FONTS, from the CD when the native system modules are present
  for (const e of ['SSERIFE.FON', 'VGAFIX.FON', 'VGASYS.FON', 'MARLETT.TTF', 'ARIAL.TTF', 'TIMES.TTF', 'COUR.TTF']) if (!sysFonts[e]) fs.writeFile(join(WINDIR, 'FONTS', e), exeStub());
  for (const [e, d] of Object.entries(sysFonts)) fs.writeFile(join(WINDIR, 'FONTS', e), b64(d));
  fs.writeFile('C:\\Program Files\\Accessories\\WORDPAD.EXE', exeStub());
  installPrograms(); setupFonts(); setupRegistry(); setupDisplay(); setupSavers(); setupSound(); setupHelp(); setupNetwork(); setupPorts(); setupPrinting(); setupVxds(); setupStartMenu();
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
  // (a disk of Windows 3.1 is its own: nothing of Windows 95's Setup; MS-DOS 6.22 on it as SYS leaves it (MS-DOS 7's
  // IO.SYS halts as Windows 3.1 starts), and an AUTOEXEC.BAT with the disk's own WIN.BAT's commands, which start Windows)
  if (diskSystem() === 'win31') { sys622Disk(); win31Autoexec(); fs.chdir('C:\\'); return; }
  installPrograms(); setupFonts(); setupRegistry(); setupDisplay(); setupSavers(); setupSound(); setupHelp(); setupNetwork(); setupPorts(); setupPrinting(); setupVxds(); setupWebView();
  if (host.shared) setupProfile(host.userName);
  setupStartMenu();   // (after the profile: its links go in the Programs folder the user's Shell Folders name)
  fs.chdir('C:\\');
  // a shared session's (shared.js): the changes other people's machines made while this one started apply from here
  if (host.shared && window.W95Shared) {
    const S = window.W95Shared; S.ready(fs);
    S.watch(peopleChanged);   // (who is here: their icons in the notification area, a notice as one comes or goes)
  }
}

// a person's own folders in a session shared with others, as Windows 95 keeps them with user profiles on:
// C:\WINDOWS\Profiles\<user>, made from the machine's Desktop and Start Menu the first time they log on
// (Recent empty), listed under ProfileList, and theirs in HKCU's Shell Folders, which the shell finds its folders by
// (HKCU being theirs: shared.js). A profile HKCU was copied from names its owner's folders, so the names are set again
function setupProfile(user) {
  const R = W95Win32, str = v => ({ type: 1, data: W95FS.encode(v + '\0') });
  const home = profileHome(user); if (!home) return;
  const name = basename(home);
  DESKTOP_DIR = join(home, 'Desktop'); RECENT = join(home, 'Recent'); START_MENU = join(home, 'Start Menu'); PROGRAMS = join(START_MENU, 'Programs');
  const folders = { Desktop: DESKTOP_DIR, Recent: RECENT, NetHood: join(home, 'NetHood'), 'Start Menu': START_MENU, Programs: PROGRAMS, Startup: join(PROGRAMS, 'StartUp') };
  const ex = 'hkcu\\software\\microsoft\\windows\\currentversion\\explorer\\';
  const put = (k, n, v) => { const was = R.regGet(k, n); if (!was || W95FS.decode(was.data).replace(/\0.*$/, '') !== v) R.regSet(k, n, str(v)); };
  for (const [n, p] of Object.entries(folders)) { put(ex + 'shell folders', n, p); put(ex + 'user shell folders', n, p); }
  put('hklm\\software\\microsoft\\windows\\currentversion\\profilelist\\' + name.toLowerCase(), 'ProfileImagePath', home);
}
/** a person's profile folder, made the first time (the host's machine makes everyone's in the session, its C: being
 *  the session's); its path, or null for no name */
function profileHome(user) {
  const name = String(user || '').replace(/[^\w.\-$!#%&'(){}^~@ ]/g, '').trim().slice(0, 20); if (!name) return null;
  const home = join(WINDIR, 'Profiles', name);
  fs.mkdir(home, { recursive: true });
  for (const [d, from] of [['Desktop', join(WINDIR, 'Desktop')], ['Start Menu', join(WINDIR, 'Start Menu')], ['Recent', null], ['NetHood', null]])
    if (!fs.exists(join(home, d))) { if (from && fs.exists(from)) fs.copy(from, join(home, d)); else fs.mkdir(join(home, d)); }
  if (!fs.exists(join(home, 'Start Menu', 'Programs', 'StartUp'))) fs.mkdir(join(home, 'Start Menu', 'Programs', 'StartUp'), { recursive: true });
  return home;
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
  // (their default verb is play: MOTOWN.INF's HKCR,midfile\shell,,,play and its command mplayer.exe /play /close %1)
  mid: { desc: 'MIDI Sequence', icon: 'windoc', open: p => runExe(join(WINDIR, 'MPLAYER.EXE'), '/play /close ' + (/\s/.test(p) ? `"${p}"` : p)) },
  rmi: { desc: 'MIDI Sequence', icon: 'windoc', open: p => runExe(join(WINDIR, 'MPLAYER.EXE'), '/play /close ' + (/\s/.test(p) ? `"${p}"` : p)) },
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
  if (sys) await sys.cmd('printerWindow', [join(WINDIR, 'RUNDLL32.EXE'), name]);
}
function addPrinter() { closeMenus(); runNative(join(WINDIR, 'RUNDLL32.EXE'), 'shell32.dll,SHHelpShortcuts_RunDLL AddPrinter'); }
const MyComputer = virt('mycomputer', 'My Computer', 'mycomputer', () => [
  ...fs.volumes().map(v => ({ key: 'drv:' + v.letter, label: driveLabel(v.letter), icon: driveIcon(v.letter), drive: v.letter, path: v.root,
    open: () => (v.letter === 'D' && v.ready && autoRunCmd('D') ? autoRun('D') : openPath(v.root)) })),   // (AutoPlay, the default verb of a disc with AutoRun)
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
  const a = await netBoot(); if (!a || !a.alive) return [];
  return (await a.cmd('netEnum', [scope, res])) || [];
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
  // (Windows' own Explorer the shell: the folder is its to open, as ShellExecute opens one. The page's folder window
  // here was a Windows 95 window over Windows 98's desktop, in none of its colors)
  const mon = monApp(); if (mon) return mon.cmd('shellOpen', [path]);
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
  // an MS-DOS program (COMMAND.COM: the MS-DOS Prompt) runs in an MS-DOS machine
  if (window.W95V86 && window.W95DOS) {
    let b = null; try { b = fs.readFile(path); } catch (_) { /* below */ }
    if (n === 'COMMAND.COM' || (b && exeKind(b) === 'dos')) return dosBox(n === 'COMMAND.COM' ? 'C:\\COMMAND.COM' : path, arg);
    // a Win32 console program: in an MS-DOS window that is its console (COMMAND.COM /C runs it there; the window goes
    // when it ends), as Windows 95 gives one a console
    if (b && exeKind(b) === 'pe') { const at = b[0x3c] | b[0x3d] << 8 | b[0x3e] << 16; if ((b[at + 92] | b[at + 93] << 8) === 3) { let sp = path; try { sp = fs.stat(path).shortPath; } catch (_) { /* as given */ } return dosBox('C:\\COMMAND.COM', `/C ${sp}${arg ? ` ${arg}` : ''}`); } }
  }
  if (n === 'EXPLORER.EXE') { const mon = monApp(); return arg ? openPath(resolveArg(arg)) : mon ? mon.cmd('shellOpenSpecial', [0x11]) : openFolder(MyComputer); }   // (0x11: CSIDL_DRIVES, My Computer)
  // any other program the system bundle carries runs natively
  runNative(path, arg || '').then(ok => { if (!ok) msgBox(dispName(basename(path)), `${path} is not a valid Windows application.`, 'error'); });
}
// The MS-DOS Prompt: a virtual-8086 machine (v86.js) that boots the CD's MS-DOS (IO.SYS, COMMAND.COM: msdos.js) from a
// disk of its own and runs the program in it; its 80 x 25 text screen drawn in the window in the CD's EGA.CPI 8 x 14
// font, the keys typed into it going to its keyboard. The machine runs in slices on the page's timer; the window
// closes when its program ends
const DOS_KEYS = { Enter: 0x1c0d, Backspace: 0x0e08, Escape: 0x011b, Tab: 0x0f09, ArrowUp: 0x4800, ArrowDown: 0x5000, ArrowLeft: 0x4b00, ArrowRight: 0x4d00,
  Home: 0x4700, End: 0x4f00, PageUp: 0x4900, PageDown: 0x5100, Insert: 0x5200, Delete: 0x5300, F1: 0x3b00, F2: 0x3c00, F3: 0x3d00, F4: 0x3e00, F5: 0x3f00,
  F6: 0x4000, F7: 0x4100, F8: 0x4200, F9: 0x4300, F10: 0x4400 };
const DOS_SCAN = '1234567890-=..qwertyuiop[]..asdfghjkl;\'`.\\zxcvbnm,./';   // (the scan codes of the main keys, from 02h)
let dosFont = null;
const dosMachines = new Set();   // (the MS-DOS machines running: win95.dos)
const consoles = new Map();      // (a console's id -> the MS-DOS machine that is the console: a console program's output goes there)
// a Windows program an MS-DOS machine runs: started in the system's machine, a console program with that machine as
// its console (its output: conOut; the lines typed: conIn; its end: conExit)
function dosWinExec(m) {
  return async (path, tail, id) => {
    if (id) consoles.set(id, m);
    const sys = await startSystem(); if (!sys) { if (id) { consoles.delete(id); m.conDone(); } return; }
    let r = sys.spawnProgram(path, tail, id ? { console: id } : undefined); if (r && r.then) r = await r;
    if (id && !(r && (r.ok || (typeof r === 'object' && !('err' in r))))) { consoles.delete(id); m.conWrite(`Cannot run ${path}\r\n`); m.conDone(); }
  };
}
const dosConIn = (id, text) => { if (sysApp && sysApp.worker) sysApp.worker.postMessage({ t: 'conIn', id, text }); };
// a machine booted to run `program` with `args` as Windows' VM (its drives Windows' own: v86.js takeDrives), or, with
// o.pc, the PC itself. Its disk is the boot volume SYS.COM leaves (the CD's boot sector, IO.SYS and MSDOS.SYS first). A
// VM's is made as Windows makes a VM from the MS-DOS it started from: the CD's MS-DOS, no CONFIG.SYS, and an MSDOS.SYS
// that starts no Windows of its own (the box's program runs where WIN.COM would). The PC's holds what IO.SYS reads
// before its shell runs, from C: as it is now: IO.SYS, MSDOS.SYS, CONFIG.SYS and each driver it names, AUTOEXEC.BAT
// (whether there is one), IFSHLP.SYS, the registry's files, COMMAND.COM and WIN.COM; from the shell's start on, C: is
// the disk's own (takeDrives). Not HIMEM.SYS, which IO.SYS loads when it finds one: the machine's extended memory is
// its BIOS's XMS (v86.js), which HIMEM.SYS would find already there
function dosMachine(program, args, o = {}) {
  const V = window.W95V86, D = window.W95DOS, bytes = s => b64bytes(s);
  if (program) try { program = fs.stat(program).shortPath; } catch (_) { /* (DOS's own name for it: its 8.3 path) */ }
  let files;
  if (o.pc) {
    const fromC = p => { try { return fs.readFile('C:\\' + p); } catch (_) { return null; } };
    // (a C: with no MS-DOS on it has none on its boot volume: its boot sector finds no IO.SYS, "Non-system disk")
    files = ['IO.SYS', 'MSDOS.SYS'].filter(n => fromC(n)).map(n => ({ name: n, data: fromC(n), attr: 7 }));
    const add = p => { const d = fromC(p); if (d && !files.some(f => (f.path || f.name).toUpperCase() === p.toUpperCase())) files.push({ path: p, data: d }); };
    add('COMMAND.COM'); add('CONFIG.SYS'); add('AUTOEXEC.BAT'); add('WINDOWS\\IFSHLP.SYS'); add('WINDOWS\\SYSTEM.DAT'); add('WINDOWS\\USER.DAT'); add('WINDOWS\\WIN.COM');
    // (the drivers IO.SYS loads by itself, as MSDOS.SYS's [Options] and its own list have them: DBLBUFF.SYS for
    // DoubleBuffer, which Windows 98 Setup sets, and SETVER.EXE; left off, Windows 98's IO.SYS said DBLBUFF.SYS was missing)
    const opts = W95FS.decode(fromC('MSDOS.SYS') || new Uint8Array(0));
    if (/^\s*DoubleBuffer\s*=\s*[12]/im.test(opts)) add('WINDOWS\\DBLBUFF.SYS');
    add('WINDOWS\\SETVER.EXE');
    // (the drivers CONFIG.SYS loads, by their paths on C:)
    for (const l of W95FS.decode(fromC('CONFIG.SYS') || new Uint8Array(0)).split(/\r?\n/)) {
      const r = /^\s*(?:DEVICE|DEVICEHIGH|INSTALL|INSTALLHIGH)\s*=\s*(?:\/\S+\s+)*C:\\(\S+)/i.exec(l); if (r) add(r[1]);
    }
  } else {
    const msdos = '[Paths]\r\nWinDir=C:\\WINDOWS\r\nWinBootDir=C:\\WINDOWS\r\nHostWinBootDrv=C\r\n[Options]\r\nBootGUI=0\r\nLogo=0\r\n' + Array(20).fill(';' + 'x'.repeat(68)).join('\r\n') + '\r\n';
    files = [{ name: 'IO.SYS', data: bytes(D.files['IO.SYS']), attr: 7 }, { name: 'MSDOS.SYS', data: W95FS.encode(msdos), attr: 7 },
      ...Object.keys(D.files).filter(p => p !== 'IO.SYS').map(p => ({ path: p, data: bytes(D.files[p]) }))];
  }
  // (the boot sector the IO.SYS's own SYS writes: MS-DOS 7's loads an MZ IO.SYS, an older one MS-DOS 6's)
  const io = files.find(f => f.name === 'IO.SYS'), old = io && !(io.data[0] === 0x4d && io.data[1] === 0x5a) && window.W95DOS622;
  const m = V.machine({ disk: V.fat16(bytes(old ? old.boot : D.boot), files, 16), program, args, fs, conIn: dosConIn, ...o });
  m.o.winExec = dosWinExec(m);
  if (sharedNow()) m.wallSkew = sharedNow().clockSkew();   // (the session's wall clock for its real-time clock: v86Port)
  m.v86Clock(); m.v86Boot();
  return m;
}
// a command run as COMMAND.COM /C runs it, in a machine of its own with no window: what it writes to the console (from
// the box's start: the boot's lines are not its) and how it ended. Claude's Bash tool (ccd.js) runs commands here
function dosRun(command, timeout = 120000, cwd = null) {
  return new Promise(done => {
    const m = dosMachine('C:\\COMMAND.COM', `/C ${command}`, { capture: true, cwd }), t0 = performance.now();
    dosMachines.add(m);
    const end = r => { clearInterval(timer); dosMachines.delete(m); done({ output: (m.out || '').replace(/\r\n?/g, '\n'), ...r }); };
    const timer = setInterval(() => {
      const s0 = performance.now();
      while (performance.now() - s0 < 10) {
        const st = m.v86Run(4000, s0 + 10);
        if (st === 'idle') { m.halted = false; break; }
        if (st === 'exit') { end({ exited: true }); return; }
        if (st === 'trap') { end({ error: m.trapped || 'the machine stopped' }); return; }
      }
      if (performance.now() - t0 > timeout) end({ timedOut: true });
    }, 4);
  });
}
function dosBox(program, args) {
  if (!dosFont) { const d = window.W95SYSTEM && W95SYSTEM.dos && W95SYSTEM.dos['EGA.CPI']; if (d) dosFont = cpiFont(b64bytes(d), 437, 14); }
  const m = dosMachine(program, args);
  const cv = mkc(640, 350), tx = cv.getContext('2d'), im = tx.createImageData(640, 350), px = new Uint32Array(im.data.buffer);
  const rgb = c => 0xff000000 | (c & 0xff) << 16 | (c & 0xff00) | (c >>> 16 & 0xff);
  let win = null, timer = 0, failed = null;
  const paint = () => {
    const blink = (performance.now() >> 9) & 1, cur = [m.m8(0x451), m.m8(0x450)];
    for (let r = 0; r < 25; r++) for (let c = 0; c < 80; c++) {
      const a = 0xb8000 + (r * 80 + c) * 2, ch = m.m8(a), at = m.m8(a + 1), fg = rgb(TEXT_RGB[at & 15]), bg = rgb(TEXT_RGB[at >> 4 & 15]);
      const isCur = blink && cur[0] === r && cur[1] === c;
      for (let y = 0; y < 14; y++) {
        let bits = dosFont ? dosFont[ch * 14 + y] : 0; if (isCur && y >= 12) bits = 0xff;
        const row = (r * 14 + y) * 640 + c * 8;
        for (let x = 0; x < 8; x++) px[row + x] = bits & (0x80 >> x) ? fg : bg;
      }
    }
    tx.putImageData(im, 0, 0);
  };
  const body = {
    draw(cr) { paint(); ctx.drawImage(cv, 0, 0, Math.min(640, cr.w), Math.min(350, cr.h), cr.x, cr.y, Math.min(640, cr.w), Math.min(350, cr.h)); },
    down() { return true; },
    key(e) {
      if (e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key)) { m.keys.push(((DOS_SCAN.indexOf(e.key.toLowerCase()) + 2) << 8) | (e.key.toUpperCase().charCodeAt(0) - 64)); m.halted = false; return true; }
      const k = DOS_KEYS[e.key] || (e.key.length === 1 ? ((Math.max(0, DOS_SCAN.indexOf(e.key.toLowerCase())) + 2) << 8) | (e.key.charCodeAt(0) & 0xff) : 0);
      if (!k) return false;
      if (m.conKey(k)) { dirty(); return true; }   // (a console program has the box: its line input)
      m.keys.push(k); m.halted = false; return true;
    },
    onClose() { clearInterval(timer); dosMachines.delete(m); },
    machine: m,
  };
  dosMachines.add(m);
  win = openWin(new Win({ title: 'MS-DOS Prompt', icon: 'app', x: 60, y: 40, w: 640 + 6, h: 350 + 6 + 19, resizable: false, maximizable: false, body }));
  // the machine's time: slices of the page's, a few milliseconds each, while it has work (an idle machine waits)
  timer = setInterval(() => {
    if (failed) return;
    const t0 = performance.now();
    while (performance.now() - t0 < 8) {
      const st = m.v86Run(4000, t0 + 8);
      if (st === 'idle') { m.halted = false; break; }
      if (st === 'exit') { closeWin(win, true); return; }
      if (st === 'trap') { failed = m.trapped || 'the machine stopped'; console.error('[dos]', failed); msgBox('MS-DOS Prompt', `This program has performed an illegal operation and will be shut down.\n\n${failed}`, 'error'); break; }
    }
    dirty();
  }, 15);
  emit('dos.start', { program, args: args || '' });
  return win;
}
// ---------------------------------------------------------------- the PC
// The machine the page is: at power-on (and each restart) its BIOS boots C:'s MS-DOS, which runs CONFIG.SYS and
// AUTOEXEC.BAT and then, as MSDOS.SYS's BootGUI has it, WIN.COM, which loads VMM32.VXD; Windows starts where the VMM's
// loader enters protected mode (pcWindows) and has the screen until it ends, when the loader returns to WIN.COM with
// ExitWindows' code (pcEnd) and WIN.COM does what it asks: Restart in MS-DOS mode runs DOSSTART.BAT and COMMAND.COM
// (EXIT starts Windows again), a restart resets the PC. Its text screen is the display, whole; the page's keys are its
// keyboard; Ctrl+Alt+Del restarts it
let pc = null, pcSpeed = 1;   // (pcSpeed: the PC's clock run ahead of the wall, as braid.speed runs the system's: its loading screen too)
// the PC's diskette drive A: as its BIOS reads it by sector: a 1.44 MB disk image put in (pc.floppy), the change line
// set as one goes in, what is written to it kept in the image; the BIOS boots it when it is in at a start
const pcFloppy = { image: null, name: null, changed: false };
/** the registry's files in the Windows folder, SYSTEM.DAT and USER.DAT, as Windows writes them when it flushes the
 *  registry (as it shuts down): what IO.SYS reads as the PC next starts */
// (Windows writes its registry back into the files it loaded it from; a file put in their place since, as Windows 98
// Setup puts its new SYSTEM.DAT and USER.DAT there before its restart, is not those files: the flush leaves it, and
// the next start loads the registry from it (loadHives), as the VMM does. Each file as Windows last had it: its stamp,
// kept in the registry under a root of the host's own no file holds (hkhost), so it goes with the registry's store, a
// reload of the page and a moment travelled to)
const HIVES = [['SYSTEM.DAT', 'system'], ['USER.DAT', 'user']];
const hiveStamps = { get: f => { const v = W95Win32.regGet('hkhost\\hives', f.toLowerCase()); return typeof v === 'string' ? v : undefined; }, set: (f, v) => W95Win32.regSet('hkhost\\hives', f.toLowerCase(), v) };
const hiveStamp = p => { try { const s = fs.stat(p), b = fs.readFile(p); let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193); return `${s.size}:${h >>> 0}`; } catch (_) { return null; } };
function flushRegistry() {
  if (diskSystem() !== 'win95') return;   // (Windows 3.1's registry is its REG.DAT, which its SHELL writes)
  for (const [file, which] of HIVES) {
    const p = join(WINDIR, file), was = hiveStamps.get(file);
    if (was && hiveStamp(p) !== was) { console.info(`[registry] ${file} was put there after Windows loaded its registry: left as it is`); continue; }
    try { if (fs.exists(p)) fs.setAttrs(p, 0); fs.writeFile(p, W95Win32.regHive(which)); fs.setAttrs(p, ATTR.HIDDEN | ATTR.SYSTEM | ATTR.READONLY); hiveStamps.set(file, hiveStamp(p)); } catch (e) { console.error('[registry]', file, e); }
  }
}
/** Windows starting from the PC's boot loads its registry from SYSTEM.DAT and USER.DAT, as the VMM does: those the
 *  host wrote itself (their stamps the same) are the registry as it is already; one another wrote (Setup's) is read
 *  (win32.js regReadHive) and the registry made what it holds, the roots no file keeps (HKEY_DYN_DATA) kept */
function loadHives() {
  if (diskSystem() !== 'win95') return;
  const W = W95Win32, read = new Map();
  for (const [file, which] of HIVES) {
    const p = join(WINDIR, file), st = hiveStamp(p); if (!st) continue;
    let held = null; try { held = W.regReadHive(fs.readFile(p), which); } catch (e) { console.error('[registry]', file, e); }
    // (the file as the host last wrote or read it is the registry as it is already, unless the registry has lost what
    // it holds: a store or moment from before it was read left the registry without Setup's keys, its stamp saying
    // read, and Explorer found none of the shell's classes)
    // (the file as the host last wrote or read it: the registry as it is now stands. Keys the file holds and the
    // registry does not are keys Windows has deleted since: read again for them, the file put back RunOnce\Setup's
    // items at every start that followed a restart with no flush, and Windows 98 set itself up again each time)
    if (st === hiveStamps.get(file)) continue;
    if (held && held.length) read.set(which, held);
    hiveStamps.set(file, st);
  }
  if (!read.size) return;
  const roots = { system: ['hklm', 'hkcr', 'hkcc'], user: ['hku', 'hkcu'] }, from = [...read.keys()].flatMap(w => roots[w]);
  const keep = W.regDump().filter(([path]) => !from.includes(path.split('\\')[0]));
  W.regLoad([...keep, ...[...read.values()].flat()], true);
  console.info(`[registry] loaded from ${[...read.keys()].map(w => w === 'system' ? 'SYSTEM.DAT' : 'USER.DAT').join(' and ')}`);
}
function pcBoot() {
  if (pc) clearInterval(pc.timer);
  // (a power cycle ends every program: the last run's dialogs go with it)
  [...windows].forEach(w => closeWin(w, true)); closeMenus();
  if (!window.W95V86 || !window.W95DOS) { pc = null; screen = 'black'; dirty(); return; }
  if (!fs.exists(join(WINDIR, 'SYSTEM.DAT'))) flushRegistry();   // (a disk made before Windows wrote its registry's files)
  if (diskSystem() === 'win95') strayCopies();
  const m = dosMachine(null, null, { pc: true, floppy: pcFloppy, windows: path => pcWindows(path), reset: () => setTimeout(pcBoot, 0) });
  pc = { m, timer: 0, failed: null }; m.speed = pcSpeed;
  // (the VGA BIOS's 8x8 characters, which it draws in a graphics mode: EGA.CPI's, code page 437)
  { const d = window.W95SYSTEM && W95SYSTEM.dos && W95SYSTEM.dos['EGA.CPI']; if (d && !m.font8) m.font8 = cpiFont(b64bytes(d), 437, 8); }
  if (!dosFont) { const d = window.W95SYSTEM && W95SYSTEM.dos && W95SYSTEM.dos['EGA.CPI']; if (d) dosFont = cpiFont(b64bytes(d), 437, 14); }
  screen = 'dos'; dirty();
  const me = pc;
  me.timer = setInterval(() => {
    if (me.failed || pc !== me) return;
    const t0 = performance.now();
    while (performance.now() - t0 < 10) {
      const st = m.v86Run(4000, t0 + 10);   // (the page's own time back by the tick's end: its viewport and input, while WININIT works)
      if (st === 'idle') { if (!m.winWait) m.halted = false; break; }
      if (st === 'trap') { me.failed = m.trapped || 'the machine stopped'; console.error('[pc]', me.failed); break; }
    }
    if (screen === 'dos' && m.dirty) { m.dirty = false; dirty(); }
  }, 4);
  emit('pc.boot', {});
}
/** the VMM WIN.COM loaded entering protected mode: the Windows it is starts, the screen its */
function pcWindows(path) {
  // (Windows 3.1's WIN386.EXE: its personality is not in the bundle yet, so nothing starts; the PC waits at its entry)
  if (/WIN386\.EXE$/i.test(path)) { pc.failed = `${path}: no Windows 3.1 system in this build`; emit('pc.windows', { path, failed: pc.failed }); return; }
  screen = 'desktop'; ren = null; desk.selKey = null; active = null; dirty();
  emit('pc.windows', { path });
  loadHives();   // (the registry the VMM reads: Setup's new one after its restart)
  systemBootLater(); netBootLater();
}
/** Windows has ended with ExitWindows' `code`: the VMM's loader returns to WIN.COM with it, and the PC's screen is its
 *  own again (a shutdown's: the page's It's now safe screen while WIN.COM waits) */
function pcEnd(code) {
  if (!pc || !pc.m.winWait) { pcBoot(); return; }
  // (Restart in MS-DOS mode is Windows' Exit To Dos.pif: COMMAND.COM, which WIN.COM runs after DOSSTART.BAT)
  pc.m.winDone(code, code === 0x44 ? { path: join(WINDIR, 'COMMAND.COM'), tail: '' } : null); screen = code === 0 ? 'logos' : 'dos'; dirty();
}
// the PC's text screen as the display shows it (80x25, from B800h; the cursor where the BIOS keeps it)
function pcText() {
  const m = pc.m, ch = new Uint8Array(2000), at = new Uint8Array(2000);
  for (let i = 0; i < 2000; i++) { ch[i] = m.m8(0xb8000 + i * 2); at[i] = m.m8(0xb8001 + i * 2); }
  return { rows: 25, cols: 80, ch, at, cur: [m.m8(0x451), m.m8(0x450)] };
}
// a key on the PC's keyboard: its scan code and character as the BIOS's keyboard interrupt gets them, the shift state
// in the BIOS's data area (40:17h)
function pcKey(e) {
  const m = pc.m;
  m.s8(0x417, (m.m8(0x417) & ~0x0f) | (e.shiftKey ? 2 : 0) | (e.ctrlKey ? 4 : 0) | (e.altKey ? 8 : 0));
  let k = 0;
  if (e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key)) k = ((DOS_SCAN.indexOf(e.key.toLowerCase()) + 2) << 8) | (e.key.toUpperCase().charCodeAt(0) - 64);
  else k = DOS_KEYS[e.key] || (e.key.length === 1 ? ((Math.max(0, DOS_SCAN.indexOf(e.key.toLowerCase())) + 2) << 8) | (e.key.charCodeAt(0) & 0xff) : 0);
  if (!k) return false;
  m.keys.push(k); m.halted = false; return true;
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
async function pasteInto(dir) {
  if (!clip || !dir) return;
  await Promise.all([netReady(clip.path), netReady(dir, false)]);   // (a network file or folder: as the system's machine has it)
  if (!clip) return;
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
  // (a CD drive with an AutoRun disc: AutoPlay first, as Explorer's default; Eject takes its disc out. A drive with no
  // disc offers the images the host has, the host's own act of putting one in)
  const cd = it.drive === 'D' ? fs.vols.get('D') : null, play = cd && cd.ready && autoRunCmd('D');
  const out = play ? [{ label: 'Auto&Play', bold: true, fn: () => autoRun('D') }, { label: '&Open', fn: () => it.open() }] : [{ label: '&Open', bold: true, fn: () => it.open() }];
  if ((it.info && it.info.isDir) || it.drive || it.key === 'sys:mc') out.push({ label: '&Explore', fn: () => it.open() });
  if (cd && cd.ready) out.push({ label: 'E&ject', fn: () => cdInsert(null) });
  if (cd && !cd.ready) out.push({ label: '&Insert Disc', sub: cdImages().map(i => ({ label: i.name, fn: () => cdInsert(i.name) })) });
  out.push({ sep: true });
  if (real) out.push({ label: 'Cu&t', disabled: ro, fn: () => cutCopy(it, 'cut') }, { label: '&Copy', fn: () => cutCopy(it, 'copy') }, { sep: true });
  if (it.key === 'sys:bin') out.push({ label: 'Empty Recycle &Bin', disabled: !binItems().length, fn: emptyBin }, { sep: true });
  const net = !!((window.W95SYSTEM || {}).net || {})['MPR.DLL'];
  if (net && (it.key === 'sys:mc' || it.key === 'sys:net')) out.push({ label: 'Ma&p Network Drive...', fn: mapNetDrive }, { label: 'Dis&connect Network Drive...', fn: disconnectNetDrive }, { sep: true });
  if (net && it.drive && fs.vols.get(it.drive).remote) out.push({ label: 'Dis&connect', fn: () => netCall('WNetCancelConnection2A', [it.drive + ':', 1, 0]).then(syncNetDrives) }, { sep: true });
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
  load(path, read) {
    if (!read && netPath(path)) { netReady(path).then(() => this.load(path, true)); return true; }   // (a network file: read from the system's machine first)
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
        const shown = c.password ? '*'.repeat(c.value.length) : c.value;   // (a password field shows a star for each character)
        if (c.all && foc && c.value) { fill(tx - 1, ty, textW(esc(shown)) + 2, 13, K.sel); text(esc(shown), tx, ty, K.hl); }
        else text(esc(shown), tx, ty);
        if (foc && !c.readonly && blinkOn && !(c.all && c.value)) fill(tx + textW(esc(shown.slice(0, c.caret))), ty, 1, 13, K.dk);
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
// Export Session and Import Session (Start > Programs > Accessories > System Tools): the machine's C: and registry as a
// .w95session file, to continue on another computer, the page or the Electron app (session-file.js). The app chooses
// the file itself; here the browser's download and file picker do (the picker opens from the dialog's button, a click)
function sessionCommand(op) {
  const s = window.W95HOST && window.W95HOST.session, kb = n => (n < 1 << 20 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);
  if (!s) return msgBox(op === 'export' ? 'Export Session' : 'Import Session', 'This page keeps nothing between visits (the browser gives it no storage), so there is no session to export or replace.', 'info');
  if (s.host) return op === 'export' ? s.export() : s.import();
  if (op === 'save' || op === 'open' || op === 'join') return sessionKeep(op, s);
  if (op === 'export') {
    return s.export().then(r => msgBox('Export Session', `The session was saved as ${r.file} (${kb(r.size)}) in your downloads.\n\nOpen it on the other computer with Start > Programs > Accessories > System Tools > Import Session, or in the Windows 95 app with File > Import Session.`, 'info'),
      e => msgBox('Export Session', `The session was not exported: ${e.message}`, 'error'));
  }
  let w;
  const pick = () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.w95session,.db';
    input.onchange = async () => {
      const f = input.files && input.files[0]; if (!f) return;
      closeWin(w);
      const bytes = new Uint8Array(await f.arrayBuffer()), why = await s.check(bytes).catch(e => e.message);
      if (why) return msgBox('Import Session', `${f.name} cannot be imported: ${why}.`, 'error');
      msgBox('Import Session', `Replace this computer's Windows 95 with ${f.name}?\n\nC:, the registry and the Claude program's sessions are replaced by those in it, and Windows 95 starts again from them. What is here now is downloaded first, as a session file.`, 'warning', ['Yes', 'No'],
        b => { if (b === 'Yes') s.import(bytes).catch(e => msgBox('Import Session', `The session was not imported: ${e.message}`, 'error')); });
    };
    input.click();
  };
  w = dialog('Import Session', 300, 96, [
    { type: 'label', text: 'Choose a .w95session file exported from this page or from the Windows 95 app.', x: 12, y: 12, w: 276 },
    { type: 'button', label: '&Choose File...', x: 104, y: 62, w: 98, h: 23, def: true, fn: pick },
    { type: 'button', label: 'Cancel', x: 208, y: 62, w: 80, h: 23, cancel: true, fn: () => closeWin(w) },
  ], { modal: true });
  return w;
}
// Save, Open and Join Session. The sessions this computer keeps are side by side (host-web.js), one of them the one
// Windows starts from: Save keeps the session running now (a joined one too, which otherwise runs from memory and the
// server) as another, and starts from it from then on; Open starts Windows from one kept here; Join runs another
// person's session, by its id, from memory, leaving what this computer keeps as it is
function sessionKeep(op, s) {
  const S = window.W95Shared, joined = !!(window.W95HOST && window.W95HOST.shared && S);
  let w;
  if (op === 'save') {
    if (!s.save) return msgBox('Save Session', 'This page cannot keep sessions.', 'info');
    const name = { type: 'edit', x: 70, y: 40, w: 220, h: 21, value: joined ? `${S.logon.session}` : `Saved ${new Date().toLocaleString()}`, caret: 0, focus: true };
    const ok = () => {
      const n = name.value.trim() || 'Session'; closeWin(w);
      s.save(n, fs.storeImage('C'), W95Win32.regDump()).then(() => {
        if (joined) return msgBox('Save Session', `"${n}" has been saved on this computer.\n\nWindows will start from it next time. To use a different saved session, click Start, point to Programs, Accessories, and System Tools, and then click Open Session.`, 'info');
        location.reload();   // (this page's machine writes on to the one it is kept as)
      }, e => msgBox('Save Session', `The session was not saved: ${e.message}`, 'error'));
    };
    w = dialog('Save Session', 300, 104, [
      { type: 'label', text: 'Save this session on this computer as:', x: 12, y: 14 },
      { type: 'label', text: '&Name:', x: 12, y: 44 }, name,
      { type: 'button', label: 'OK', x: 128, y: 74, w: 75, h: 23, def: true, fn: ok },
      { type: 'button', label: 'Cancel', x: 213, y: 74, w: 75, h: 23, cancel: true, fn: () => closeWin(w) },
    ], { modal: true });
    return w;
  }
  if (op === 'open') {
    const kept = s.list ? s.list() : [];
    if (!kept.length) return msgBox('Open Session', 'This computer keeps no sessions.', 'info');
    const radios = kept.slice(-10).map((e, i) => ({ type: 'radio', group: 'k', label: `${e.name}${e.at ? '  (' + new Date(e.at).toLocaleString() + ')' : ''}${e.current ? '  - now' : ''}`, checked: e.current, x: 16, y: 34 + i * 19, db: e.db }));
    if (!radios.some(r => r.checked)) radios[0].checked = true;
    const h = 34 + radios.length * 19 + 40;
    const ok = () => { const r = radios.find(x => x.checked); closeWin(w); if (S) S.goLocal(); if (s.open(r.db)) { const u = new URL(location.href); u.searchParams.delete('session'); u.searchParams.delete('user'); location.href = u.toString(); } };
    w = dialog('Open Session', 360, h, [
      { type: 'label', text: 'Choose a saved session to start Windows from:', x: 12, y: 12 }, ...radios,
      { type: 'button', label: 'OK', x: 188, y: h - 34, w: 75, h: 23, def: true, fn: ok },
      { type: 'button', label: 'Cancel', x: 273, y: h - 34, w: 75, h: 23, cancel: true, fn: () => closeWin(w) },
    ], { modal: true });
    return w;
  }
  // join: a session on the server, by its id (the one a person running it gives)
  if (!S) return msgBox('Join Session', 'This page has no server to join sessions on.', 'info');
  const id = { type: 'edit', x: 80, y: 40, w: 208, h: 21, value: '', caret: 0, focus: true };
  const ok = () => { const v = id.value.trim(); if (!v) return; closeWin(w); S.logOff((S.logon && S.logon.user) || 'Guest', v); };
  w = dialog('Join Session', 300, 104, [
    { type: 'label', text: 'Type the name of the session you want to join:', x: 12, y: 14 },
    { type: 'label', text: '&Session:', x: 12, y: 44 }, id,
    { type: 'button', label: 'OK', x: 128, y: 74, w: 75, h: 23, def: true, fn: ok },
    { type: 'button', label: 'Cancel', x: 213, y: 74, w: 75, h: 23, cancel: true, fn: () => closeWin(w) },
  ], { modal: true });
  return w;
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
  if (/^braid$/i.test(v.trim()) && braid) return braid.window();   // (ring α's window: the line as a slider, braid-page.js)
  let cmd = v, arg = '';
  const q = /^"([^"]*)"\s*(.*)$/.exec(v);
  if (q) { cmd = q[1]; arg = q[2]; } else if (!fs.exists(v)) { const m = /^(\S+)\s+(.*)$/.exec(v); if (m) { cmd = m[1]; arg = m[2]; } }
  // (where Windows looks for a program named without its folder: the current folder, the Windows folder, SYSTEM, then
  // the PATH AUTOEXEC.BAT sets, C:\WINDOWS\COMMAND among it, and the root)
  const bases = /^[a-z]:|^\\/i.test(cmd) ? [cmd] : [join(fs.cwd, cmd), join(WINDIR, cmd), join(WINDIR, 'SYSTEM', cmd), join(WINDIR, 'COMMAND', cmd), join('C:\\', cmd)];
  const exts = extname(cmd) ? [''] : ['', '.exe', '.com', '.bat'];
  for (const b of bases) for (const e of exts) if (fs.exists(b + e)) return shellOpen(fs.realpath(b + e), arg);
  // (then the program's own entry under App Paths, as ShellExecute looks a name up there last: MSPAINT, WORDPAD)
  if (!/[\\/:]/.test(cmd)) {
    const ap = W95Win32.regGet(`hklm\\software\\microsoft\\windows\\currentversion\\app paths\\${extname(cmd) ? cmd : cmd + '.exe'}`, '');
    const at = ap && ap.data && W95FS.decode(ap.data).replace(/\0.*$/, '').replace(/^"(.*)"$/, '$1');
    if (at && fs.exists(at)) return shellOpen(fs.realpath(at), arg);
  }
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
    if (pick === 3) { [...windows].forEach(w => closeWin(w, true)); if (window.W95HOST && window.W95HOST.shared) logOnDialog(); return; }
    shutdownSeq([0, 0x43, 0x44][pick]);   // (ExitWindows' codes: shut down, EW_REBOOTSYSTEM, EW_EXITANDEXECAPP)
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
/** Welcome to Windows, as Windows Logon asks after a log off (the page's own shell's Shut Down): the name typed goes
 *  to that person's own session, Guest to the shared one (shared.js) */
function logOnDialog() {
  let win;
  const user = { type: 'edit', x: 120, y: 52, w: 180, h: 21, value: '', caret: 0, focus: true };
  const pass = { type: 'edit', x: 120, y: 80, w: 180, h: 21, value: '', caret: 0, password: true };
  const ok = () => { closeWin(win); window.W95Shared.logOff(user.value.trim() || 'Guest'); };
  win = dialog('Welcome to Windows', 400, 150, [
    { type: 'icon', name: 'passwords', x: 14, y: 12 },
    { type: 'label', text: 'Type a user name and password to log on to Windows.', x: 60, y: 14 },
    { type: 'label', text: '&User name:', x: 60, y: 55 }, user,
    { type: 'label', text: '&Password:', x: 60, y: 83 }, pass,
    { type: 'button', label: 'OK', x: 312, y: 50, w: 75, h: 23, def: true, fn: ok },
    { type: 'button', label: 'Cancel', x: 312, y: 78, w: 75, h: 23, cancel: true, fn: () => { closeWin(win); window.W95Shared.logOff('Guest'); } },
  ], { dim: true });
}
function shutdownSeq(code) {
  [...windows].forEach(w => closeWin(w, true)); closeMenus();
  // the machines stop as Windows does (the system's, the programs'), the registry written to its files; then the VMM
  // returns to MS-DOS with the code, which WIN.COM acts on (pcEnd)
  for (const a of new Set([...nativeApps, sysApp])) if (a && a.alive) a.exited(0);
  flushRegistry();
  // (the machine gone, the page is no longer its monitor: the shutdown screen and the PC's after it fill the page, not
  // the machine's last mode's size)
  screen = 'logow'; resize(); dirty();
  setTimeout(() => pcEnd(code), 2600);
}
/** Windows itself shut down (Explorer's Shut Down: USER's ExitWindows ending in KERNEL's ExitKernel): a clean
 *  shutdown, the next start's SystemStart heard; ExitWindows' code goes back to WIN.COM (EW_RESTARTWINDOWS 42h,
 *  EW_REBOOTSYSTEM 43h, EW_EXITANDEXECAPP 44h, 0 a shutdown) */
function systemEnded(code) {
  emit('pc.windowsEnded', { code });
  shutdownSeq([0x42, 0x43, 0x44].includes(code) ? code : 0);
}
// The disk lives in memory, so it survives a restart but not a page reload.
function boot() { pcBoot(); }

// ---------------------------------------------------------------- desktop
const SYS_ITEMS = () => [
  { key: 'sys:mc', label: 'My Computer', icon: 'mycomputer', virt: true, open: () => openFolder(MyComputer) },
  { key: 'sys:net', label: 'Network Neighborhood', icon: 'network', virt: true, open: () => { Network.refresh(); openFolder(Network); } },
  { key: 'sys:bin', label: 'Recycle Bin', icon: binItems().length ? 'recyclefull' : 'recycle', virt: true, open: () => openFolder(RecycleBin) },
  { key: 'sys:claude', label: 'Claude', icon: 'app', virt: true, open: () => window.win95.ccd && window.win95.ccd.open() },
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
    netReady(t.it.path, false).then(() => fsTry('move', it.label, () => moveAny(it.path, join(t.it.path, it.info.name)))); return true;
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
const mkc = (w, h) => Object.assign(document.createElement('canvas'), { width: Math.max(1, w), height: Math.max(1, h) });
let fullSaver = null, lastInput = performance.now();
async function startSaverProcess(path, arg) {
  const app = sysApp || await startSystem();
  if (!app || !app.alive) return null;
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
let saverHeld = false;   // (a Claude session keeping the machine awake: win95.ccd's request_keep_awake)
setInterval(() => {
  if (fullSaver || screen !== 'desktop' || saverHeld) return;
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
  // (the root, 24 and 30, followed by the INF's own \: one, as Setup joins them)
  const subst = s => s.replace(/%([^%]*)%(\\?)/g, (m, k, bs) => (k === '' ? '%' + bs : k === '24' || k === '30' ? 'C:\\' : (dirs[k] ?? strings[k.toLowerCase()] ?? `%${k}%`) + bs));
  return { sec, fields, subst };
}
function infAddReg(text, section, hkr, keep = () => true) {
  const { sec, fields, subst } = infParse(text);
  const ROOT = { HKCR: 'hkcr', HKCU: 'hkcu', HKLM: 'hklm', HKU: 'hku', HKR: hkr };   // HKR: the device's own key, for a device INF
  for (const l of sec[section.toLowerCase()] || []) {
    if (!l.trim() || /^\s*;/.test(l)) continue;
    const f = fields(l), root = ROOT[(f[0] || '').toUpperCase()]; if (!root) continue;
    const sub = subst(f[1] || ''), key = sub ? root + '\\' + sub : root, flags = parseInt(f[3] || '0', 16) || 0;
    if (f.length < 3) { W95Win32.regSet(key, null); continue; }
    const name = subst(f[2] || '');
    if ((flags & 2 && W95Win32.regGet(key, name) !== undefined) || !keep(key, name)) continue;
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
  // the accessories' sections: each <name>.links whose links are all to programs the system has (its own, or an optional
  // component's Setup installed: the Games, msdos.js), with each link's name and its folder (its group's, from the
  // section's progman.groups lines: Accessories, Accessories\Games). A line naming no program removes an old link
  // (and the links of each Typical component installed from its own INF, its UpdateInis sections: WordPad's in
  // WORDPAD.INF, Phone Dialer's Dialer.Inis. A link's program is the system's, or a file on the disk: by its path, or
  // in the Windows folder)
  const accessories = [], DOS0 = window.W95DOS;
  const has = f => !!((S.programs || {})[f] || (DOS0 && DOS0.windows && DOS0.windows[f])) || (/\\/.test(f) ? fs.exists(f) : !!f && fs.exists(join(WINDIR, f)));
  // (a section another component of APPLETS.INF makes its links with only when that component is set up: one a Typical
  // install chooses, InstallType bit 2, or one installed, the Games; not the Windows 3.1 user interface's, Program
  // Manager in StartUp)
  const owner = {};
  if (applets) for (const [comp, lines] of Object.entries(applets.sec)) {
    const kv = Object.fromEntries(lines.map(l => l.split(';')[0]).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim().toLowerCase(), l.slice(l.indexOf('=') + 1).trim()]));
    for (const s of (kv.updateinis || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)) owner[s] = { comp, type: parseInt(kv.installtype, 10) };
  }
  // (and Win95UI: the Windows 95 user interface, Setup's own choice)
  const chosen = o => !o || o.type & 2 || o.comp === 'win95ui' || (v => v && W95FS.decode(v.data).startsWith('1'))(W95Win32.regGet(`hklm\\software\\microsoft\\windows\\currentversion\\setup\\optionalcomponents\\${o.comp}`, 'Installed'));
  const sources = applets ? Object.keys(applets.sec).filter(n => /\.links$/.test(n) && !/remove/.test(n) && chosen(owner[n])).map(name => ({ inf: applets, name })) : [];
  for (const c of (DOS0 && DOS0.components) || []) {
    const text = DOS0.infs[c.inf]; if (!text) continue;
    const p = infParse(text), body = (p.sec[c.name.toLowerCase()] || []).map(l => l.split(';')[0]).find(l => /^\s*updateinis\s*=/i.test(l));
    for (const name of body ? body.slice(body.indexOf('=') + 1).split(',').map(x => x.trim().toLowerCase()).filter(Boolean) : []) if (!sources.some(s => s.name === name)) sources.push({ inf: p, name });
  }
  for (const { inf: src, name } of sources) {
    const fields = (src.sec[name] || []).map(l => src.fields(l)).filter(f => /^setup\.ini$/i.test(f[0]) && f[1]), groups = {};
    for (const f of fields) if (/^progman\.groups$/i.test(f[1]) && f[3]) { const [g, d] = src.subst(f[3]).split('='); if (d) groups[g.toLowerCase()] = d; }
    const all = fields.filter(f => !/^progman\.groups$/i.test(f[1]) && f[3]).map(f => ({ k: src.fields(src.subst(f[3])), group: f[1].toLowerCase() }))
      .map(l => Object.assign(l.k, { folder: groups[l.group] || 'Accessories' }));
    // (a line naming no program deletes that link: Win95UI's, Program Manager's in StartUp; one there yet is work to do)
    const links = all.filter(k => k[1]), gone = all.filter(k => !k[1] && k[0]);
    // (a link's command: its program's path, which may have spaces in it, else its first word)
    const prog = c => (has(c.toUpperCase()) ? c : c.split(/\s/)[0]).toUpperCase();
    if (links.every(k => has(prog(k[1] || '')))) accessories.push({ inf: src, name, links, gone });
  }
  // (the Programs folder GRPCONV writes its links in: the one the user's Shell Folders name, a profile's where the user
  // has one; Setup's item was armed at every start while the links were in a profile's and this looked in the default)
  const sf = W95Win32.regGet('hkcu\\software\\microsoft\\windows\\currentversion\\explorer\\shell folders', 'Programs');
  const progs = (sf && W95FS.decode(sf.data).replace(/\0.*$/, '')) || PROGRAMS;
  let cur = null; try { cur = fs.readFile(progs + '\\Windows Explorer.lnk'); } catch (_) { /* none yet */ }
  const claude = !!(S.programs || {})['CLAUDE.EXE'];   // (the Claude program: a folder of its own under Programs, claude-exe.js)
  // (Export and Import Session: RUNDLL32 running SESSION.DLL's entries, session-dll.js, in System Tools)
  const session = !!(S.programs || {})['RUNDLL32.EXE'], tools = join(progs, 'Accessories', 'System Tools');
  const dbwin = !!(S.programs || {})['DBWIN.EXE'];   // (the Debug Monitor, dbwin.js, in System Tools)
  // (an optional component Setup installs: its INF's links, Clipboard Viewer's in Accessories)
  const DOS = window.W95DOS, clip = DOS && DOS.infs && DOS.infs['CLIP.INF'] && fs.exists(join(WINDIR, 'CLIPBRD.EXE')) ? infParse(DOS.infs['CLIP.INF']) : null;
  // (the Multimedia accessories, in Accessories\Multimedia (group12): MOTOWN.INF's Media Player, Sound Recorder and
  // Volume Control and MMOPT.INF's CD Player, each whose program the system has)
  const media = [['MOTOWN.INF', 'MPlay.links', 'MPLAYER.EXE', 'Media Player'], ['MOTOWN.INF', 'Rec.links', 'SNDREC32.EXE', 'Sound Recorder'],
    ['MOTOWN.INF', 'Vol.links', 'SNDVOL32.EXE', 'Volume Control'], ['MMOPT.INF', 'CDPlayer.inis', 'CDPLAYER.EXE', 'CD Player']].filter(([inf, , file]) => infs[inf] && (S.programs || {})[file]);
  const missing = accessories.some(a => a.links.some(k => !fs.exists(join(progs, k.folder, k[0] + '.lnk'))) || a.gone.some(k => fs.exists(join(progs, k.folder, k[0] + '.lnk')))) || (claude && !fs.exists(join(progs, 'Claude', 'Claude.lnk')))
    || media.some(m => !fs.exists(join(progs, 'Accessories', 'Multimedia', m[3] + '.lnk')))
    || (session && !fs.exists(join(tools, 'Join Session.lnk'))) || (dbwin && !fs.exists(join(tools, 'Debug Monitor.lnk'))) || ((S.programs || {})['W95DBG.EXE'] && !fs.exists(join(tools, 'Debugger.lnk'))) || (clip &&!fs.exists(join(progs, 'Accessories', 'Clipboard Viewer.lnk')));
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
  for (const a of accessories) add(a.inf, [a.name]);
  if (clip) add(clip, ['clipbrd.links']);
  for (const [inf, sec] of media) add(infParse(infs[inf]), [sec.toLowerCase()]);   // (infParse keys its sections in lower case)
  if (claude) { out.set('progman.groups', out.get('progman.groups') || { name: 'progman.groups', lines: [] }); out.get('progman.groups').lines.push('group90=Claude'); out.set('group90', { name: 'group90', lines: ['"Claude", CLAUDE.EXE'] }); }
  if (session) {
    const groups = out.get('progman.groups') || out.set('progman.groups', { name: 'progman.groups', lines: [] }).get('progman.groups');
    if (!groups.lines.some(l => /^group11=/i.test(l))) groups.lines.push(`group11=${tools.slice(progs.length + 1)}`);
    const g = out.get('group11') || out.set('group11', { name: 'group11', lines: [] }).get('group11');
    g.lines.push('"Export Session", "RUNDLL32.EXE SESSION.DLL,Export"', '"Import Session", "RUNDLL32.EXE SESSION.DLL,Import"',
      '"Save Session", "RUNDLL32.EXE SESSION.DLL,Save"', '"Open Session", "RUNDLL32.EXE SESSION.DLL,Open"', '"Join Session", "RUNDLL32.EXE SESSION.DLL,Join"');
  }
  if (dbwin) {
    const groups = out.get('progman.groups') || out.set('progman.groups', { name: 'progman.groups', lines: [] }).get('progman.groups');
    if (!groups.lines.some(l => /^group11=/i.test(l))) groups.lines.push(`group11=${tools.slice(progs.length + 1)}`);
    const g = out.get('group11') || out.set('group11', { name: 'group11', lines: [] }).get('group11');
    g.lines.push('"Debug Monitor", DBWIN.EXE');
    if ((S.programs || {})['W95DBG.EXE']) g.lines.push('"Debugger", W95DBG.EXE');   // (the Debugger, debugger.js)
  }
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
// Setup's national language support (LOCALE.INF): [NLSAPI]'s nls.reg, the code pages and the locales Windows has
// (Nls\Codepage, Nls\Locale), and its default locale's option, L0409 (Nls\Locale's own value 00000409, the user's
// International locale, the ANSI and OEM code pages), on a registry that has not had them. Without them Windows 98
// Setup read no system locale (SETUPX: Nls\Locale's value, its last four digits Internet Explorer's ChannelLocale) and
// wrote ChannelLocale 0000. (nls.reg's RunOnce item runs ADDREG.EXE, which turns WIN.INI's [intl] into the user's
// International settings: kept only where the disk has the program)
function setupLocale() {
  const inf = ((window.W95SYSTEM || {}).infs || {})['LOCALE.INF']; if (!inf) return;
  if (W95Win32.regGet('hklm\\system\\currentcontrolset\\control\\nls\\locale', '') !== undefined) return;
  const { sec, fields, subst } = infParse(inf), addreg = fs.exists(join(WINDIR, 'SYSTEM', 'ADDREG.EXE'));
  infAddReg(inf, 'nls.reg', undefined, (key, name) => addreg || !(/\\runonce$/i.test(key) && name.toUpperCase() === 'NLSREG'));
  const option = (sec[subst('%Default_Locale%').toLowerCase()] || []).map(l => l.split(';')[0]).find(l => /^\s*addreg\s*=/i.test(l));
  for (const s of option ? fields(option.slice(option.indexOf('=') + 1)) : []) if (s) infAddReg(inf, s);
}
function setupRegistry() {
  setupRegistration();
  setupLocale();
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
// the VxDs the machine's devices name (SYSTEM.INI [386Enh], the registry's StaticVxD), where Setup copies them and
// VMM32's loader reads them as WIN.COM starts Windows: one named *NAME (a VxD VMM32.VXD may hold) in SYSTEM\VMM32, the
// others in SYSTEM (tools/build_dos.py VXDS); each the disk lacks
function setupVxds() {
  const DOS = window.W95DOS; if (!DOS || !DOS.vxds) return;
  const named = new Set();
  let ini = ''; try { ini = fs.readText(join(WINDIR, 'SYSTEM.INI')); } catch (_) { /* none */ }
  const sec = (/\[386Enh\]([\s\S]*?)(?:\r?\n\[|$)/i.exec(ini) || [])[1] || '';
  for (const l of sec.split(/\r?\n/)) { const r = /^\s*[^=;]+=\s*(.*)$/.exec(l); if (r) for (const v of r[1].split(',')) named.add(v.trim().toUpperCase()); }
  for (const [, vals] of W95Win32.regDump()) for (const [n, v] of vals) {
    if (n !== 'staticvxd') continue;
    for (const x of (typeof v === 'string' ? v : W95FS.decode(v.data || new Uint8Array(0)).replace(/\0/g, '')).split(',')) named.add(x.trim().toUpperCase());
  }
  for (const [n, d] of Object.entries(DOS.vxds)) {
    const dir = named.has('*' + n.replace(/\.VXD$/, '')) ? join(WINDIR, 'SYSTEM', 'VMM32') : named.has(n) ? join(WINDIR, 'SYSTEM') : null;
    if (!dir || fs.exists(join(dir, n))) continue;
    fs.mkdir(dir, { recursive: true }); fs.writeFile(join(dir, n), b64bytes(d));
  }
}
function setupPrinting() {
  const R = W95Win32, infs = (window.W95SYSTEM || {}).infs || {}, dir = join(WINDIR, 'INF');
  if (!infs['MSPRINT.INF']) return;
  fs.mkdir(dir, { recursive: true });
  for (const [n, t] of Object.entries(infs)) { const f = join(dir, n); if (!fs.exists(f)) fs.writeFile(f, Uint8Array.from(t, c => c.charCodeAt(0))); }
  const cv = 'hklm\\software\\microsoft\\windows\\currentversion', str = v => ({ type: 1, data: W95FS.encode(v + '\0') });
  if (R.regGet(cv + '\\setup', 'SourcePath') === undefined) R.regSet(cv + '\\setup', 'SourcePath', str('D:\\WIN95\\'));   // LDID_SRCPATH
  if (R.regGet(cv, 'DevicePath') === undefined) R.regSet(cv, 'DevicePath', str(dir));
  if (R.regGet(cv, 'MediaPath') === undefined) R.regSet(cv, 'MediaPath', str(join(WINDIR, 'MEDIA')));   // (the Sounds page lists the .WAV files there)
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
  setupDisplayDevices(); setupDisplayModes(); setupFontSize(); setupPatterns(); setupWallpapers();
}
// The folder templates of Windows 98's Web view (C:\WINDOWS\WEB\*.HTT, which WEBVW.DLL writes as it registers), in
// the color scheme's colors: their left panel is "white" with a white watermark (wvleft.bmp) whatever the scheme, its
// text the scheme's window text, so a dark scheme's panel was white with pale text. The panel takes the scheme's
// Window color instead. And My Computer's pie chart control, which paints white until a drive is selected and its
// script hides it at the first selection: hidden from the start, as it was invisible on the white panel. Each
// template as WEBVW wrote it is changed once; one the user has changed otherwise is left as it is.
function setupWebView() {
  const dir = join(WINDIR, 'WEB'); let list; try { list = fs.readdir(dir); } catch (_) { return; }
  for (const e of list) {
    if (!/\.htt$/i.test(e.name)) continue;
    const p = join(dir, e.name); let t; try { t = fs.readText(p); } catch (_) { continue; }
    let u = t.replace(/background: white URL\(file:\/\/%TEMPLATEDIR%\\wvleft\.bmp\) no-repeat/g, 'background: window');
    if (/id="?PieChart"?/i.test(u) && !/PieChart\.style\.display = "none";\s*Info\.innerHTML = L_Prompt_Text;\s*}\s*<\/script>/.test(u))
      u = u.replace(/(FixSize\(\);\s*)(Info\.innerHTML = L_Prompt_Text;\s*}\s*<\/script>)/, '$1PieChart.style.display = "none";\r\n\t\t\t\t$2');
    if (u !== t) { try { const a = fs.stat(p).attrs || 0; fs.setAttrs(p, 0); fs.writeFile(p, W95FS.encode(u)); fs.setAttrs(p, a); } catch (err) { console.error('[webview]', e.name, err); } }
  }
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
// deletes five MODES keys an earlier build of this page added to the display's software key (16-bit 1152x864 and
// 1280x1024; 24-bit 1024x768, 1152x864 and 1280x1024), which TSENG.DRV's INF does not list
function setupDisplayModes() {
  const R = W95Win32, sw = 'hklm\\system\\currentcontrolset\\services\\class\\display\\0000\\modes\\';
  for (const m of ['16\\1152,864', '16\\1280,1024', '24\\1024,768', '24\\1152,864', '24\\1280,1024']) R.regDel(sw + m);
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
  // Windows 3.x's sound functions (the module SOUND: Minesweeper's beeps), the driver SETUPC.INF names in SYSTEM.INI's
  // [boot], which KERNEL loads as it loads the others there; on every disk, as Setup writes it whatever the system has
  // (a disk made before the line was written gets it too)
  if (!W95Win32.iniGet(fs, 'SYSTEM.INI', 'boot', 'sound.drv')) W95Win32.iniSet(fs, 'SYSTEM.INI', 'boot', 'sound.drv', 'mmsound.drv');
  if (!infs['MOTOWN.INF']) return;
  // the media files, each one the disk lacks (a disk set up before the bundle carried it gets it too)
  const media = join(WINDIR, 'MEDIA'); fs.mkdir(media, { recursive: true });
  const NAMES = { 'MSSOUND.WAV': 'The Microsoft Sound.wav' };   // MOTOWN.INF's RenameFiles\Media
  for (const [n, d] of Object.entries(S.media || {})) { const f = join(media, NAMES[n] || n.toLowerCase()); if (!fs.exists(f)) fs.writeFile(f, b64bytes(d)); }
  // the MCI devices that play MIDI and wave files (MOTOWN.INF's MCISEQ and MCIWAVE) and Media Player (MPlay): their
  // registry and SYSTEM.INI [mci] lines, and WIN.INI's [mci extensions] from the base install
  if (W95Win32.regGet('hklm\\system\\currentcontrolset\\control\\mediaresources\\mci\\sequencer', 'Driver') === undefined) {
    for (const sec of ['sequencer.Reg', 'waveaudio.Reg', 'MPlay.install.reg']) infAddReg(infs['MOTOWN.INF'], sec);
    infUpdateInis(infs['MOTOWN.INF'], 'mmsys.inis', /^win\.ini$/i);
  }
  // (the [mci] lines on a disk that lacks them, whatever the registry holds: the registry and the disk are kept apart,
  // and a disk made new under a registry that had the devices got none, so Media Player found no MCI devices)
  if (!W95Win32.iniGet(fs, 'SYSTEM.INI', 'mci', 'sequencer')) for (const sec of ['sequencer.inis', 'waveaudio.inis']) infUpdateInis(infs['MOTOWN.INF'], sec);
  // the CD audio device (MOTOWN.INF's MCICDA: [mci] cdaudio=mcicda.drv), and the Multimedia accessories of a Typical
  // install: Sound Recorder (Rec: .wav files are SoundRec's), Volume Control (Vol) and CD Player (MMOPT.INF's
  // CDPlayer: .cda files), each the system has and the disk has not had set up
  if ((S.ne || {}).MCICDA) {
    if (W95Win32.regGet('hklm\\system\\currentcontrolset\\control\\mediaresources\\mci\\cdaudio', 'Driver') === undefined) infAddReg(infs['MOTOWN.INF'], 'cdaudio.Reg');
    if (!W95Win32.iniGet(fs, 'SYSTEM.INI', 'mci', 'cdaudio')) infUpdateInis(infs['MOTOWN.INF'], 'cdaudio.inis');
  }
  // the audio disc in E: catalogued in CD Player's disc database (CDPLAYER.INI, the disc's ID its section), as its
  // owner's Edit Play List leaves it: the artist, the title and each track's, the play list in disc order
  const CDA = window.W95CDAudio, cdToc = CDA.toc, cdId = CDA.discId();
  if (cdId && !W95Win32.iniGet(fs, 'CDPLAYER.INI', cdId, 'title')) {
    const set = (k, v) => W95Win32.iniSet(fs, 'CDPLAYER.INI', cdId, k, v), n = cdToc.tracks.length;
    set('EntryType', '1'); set('artist', cdToc.performer || ''); set('title', cdToc.album || ''); set('numtracks', String(n));
    cdToc.tracks.forEach((t, i) => set(String(i), t.title));
    set('order', cdToc.tracks.map((t, i) => i).join(' ')); set('numplay', String(n));
  }
  const oc = 'hklm\\software\\microsoft\\windows\\currentversion\\setup\\optionalcomponents';
  for (const [file, inf, sec, name] of [['SNDREC32.EXE', 'MOTOWN.INF', 'Rec.install.reg', 'Rec'], ['SNDVOL32.EXE', 'MOTOWN.INF', 'Vol.install.reg', 'Vol'], ['CDPLAYER.EXE', 'MMOPT.INF', 'CDPlayer.reg', 'CDPlayer']]) {
    if (!(S.programs || {})[file] || !infs[inf]) continue;
    const v = W95Win32.regGet(`${oc}\\${name.toLowerCase()}`, 'Installed');
    if (!v || W95FS.decode(v.data).replace(/\0.*$/, '') !== '1') infAddReg(infs[inf], sec);
  }
  // Media Player checks that .avi is still its avifile type (MOTOWN.INF's HKCR,.avi,,,avifile, which OSR2 leaves to
  // ActiveMovie) and otherwise asks on every start to repair its settings
  if (W95Win32.regGet('hkcr\\.avi', '') === undefined) W95Win32.regSet('hkcr\\.avi', '', { type: 1, data: W95FS.encode('avifile\0') });
  // the video device that plays .avi files (MOTOWN.INF's MCIAVI: [mci] avivideo=mciavi.drv) and the Cinepak codec
  // the CD's videos are in (VIDC.CVID: [drivers32] vidc.CVID=iccvid.dll), on a disk that lacks them
  if ((S.ne || {}).MCIAVI && W95Win32.regGet('hklm\\system\\currentcontrolset\\control\\mediaresources\\mci\\avivideo', 'Driver') === undefined)
    for (const sec of ['avivideo.Reg', 'cvid.Reg']) infAddReg(infs['MOTOWN.INF'], sec);
  if ((S.ne || {}).MCIAVI && !W95Win32.iniGet(fs, 'SYSTEM.INI', 'mci', 'avivideo')) for (const sec of ['avivideo.inis', 'cvid.inis']) infUpdateInis(infs['MOTOWN.INF'], sec);
  // and the other codecs Setup installs with it (VIDC.MSVC, VIDC.MSRLE, VIDC.IV32: Video 1, RLE, Indeo 3.2), each on a
  // disk whose [drivers32] lacks it
  for (const [key, file, sec] of [['vidc.MSVC', 'MSVIDC32.DLL', 'msvc'], ['VIDC.MRLE', 'MSRLE32.DLL', 'msrle'], ['VIDC.IV32', 'IR32_32.DLL', 'iv32']]) {
    if (!(S.dlls || {})[file] || W95Win32.iniGet(fs, 'SYSTEM.INI', 'drivers32', key)) continue;
    infAddReg(infs['MOTOWN.INF'], `${sec}.Reg`); infUpdateInis(infs['MOTOWN.INF'], `${sec}.inis`);
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
  // the user name Setup asks for, which the logon offers (Network\Logon username): the host's account, or, on a page
  // that has none (a browser's), a name of its own, as the copy's registered owner has one (setupRegistration): with
  // none, the logon offered an empty name, OK refused it, and Cancel left the network client logged off
  const user = ((window.W95HOST && window.W95HOST.userName) || 'User').replace(/[^\w.\-$!#%&'(){}^~@]/g, '').slice(0, 20) || 'User';
  // (in a session shared with others, the person here logs on as themselves each time: their logon's name, which
  // Windows Logon then logs on with, asking nothing; shared.js)
  const was = R.regGet('hklm\\network\\logon', 'username');
  if (user && (was === undefined || (window.W95HOST && window.W95HOST.shared && W95FS.decode(was.data).replace(/\0.*$/, '') !== user))) R.regSet('hklm\\network\\logon', 'username', str(user));
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
// mode of a full megabyte, 1024 by 1024, the driver refuses and falls back from). The width stops at 1016: Windows 98
// Setup sizes its billboard's text by the screen's width (W98SETUP 3:2b91, 14 pt at 1024 and wider, 8 pt below), and
// its 14 pt Arial drew every step heavy; an odd width (1023) drew the screen skewed
const nativeMode = () => [Math.max(640, Math.min(1016, Math.floor(innerWidth / ZOOM))), Math.max(480, Math.min(960, Math.floor(innerHeight / ZOOM)))];
const sharedNow = () => (window.W95HOST && window.W95HOST.shared && window.W95Shared) || null;
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
/** the Windows C: has: 'win31' for a Windows 3.1 installation (WIN386.EXE, no VMM32.VXD), else Windows 95 */
const diskSystem = () => (fs.exists(join(WINDIR, 'SYSTEM', 'WIN386.EXE')) && !fs.exists(join(WINDIR, 'SYSTEM', 'VMM32.VXD')) ? 'win31' : 'win95');
/** MS-DOS on C:, as SYS leaves it (and Windows 95's Setup, which runs it): IO.SYS (the CD's WINBOOT.SYS, which the boot
 *  sector loads), COMMAND.COM in the root, and MSDOS.SYS, its settings, padded past 1024 bytes as IO.SYS requires (the
 *  lines Setup writes for programs that check its size): Windows 95's starting it (BootGUI=1), a disk of an older
 *  Windows booting to the prompt, its own WIN starting that */
function sysDisk(gui) {
  const DOS = window.W95DOS; if (!DOS) return;
  const stub = exeStub(), HSR = ATTR.HIDDEN | ATTR.SYSTEM | ATTR.READONLY, unlock = p => { try { fs.setAttrs(p, 0); } catch (_) { /* not there */ } };
  const put = (path, b64) => { let cur = null; try { cur = fs.readFile(path); } catch (_) { /* not there */ } if (!cur || (cur.length === stub.length && cur.every((b, i) => b === stub[i]))) fs.writeFile(path, b64bytes(b64)); };
  unlock('C:\\IO.SYS'); put('C:\\IO.SYS', DOS.files['IO.SYS']); fs.setAttrs('C:\\IO.SYS', HSR);
  put('C:\\COMMAND.COM', DOS.files['COMMAND.COM']);
  let t = ''; try { t = fs.readText('C:\\MSDOS.SYS'); } catch (_) { /* written below */ }
  if (t.length < 1024) {
    const own = t.replace(/\r?\n/g, '\r\n').replace(/(\r\n)*$/, '') || `[Paths]\r\nWinDir=C:\\WINDOWS\r\nWinBootDir=C:\\WINDOWS\r\nHostWinBootDrv=C\r\n\r\n[Options]\r\nBootGUI=${gui ? 1 : 0}\r\nLogo=${gui ? 1 : 0}`;
    const pad = [';', ';The following lines are required for compatibility with other programs.', ';Do not remove them (MSDOS.SYS needs to be >1024 bytes).'];
    for (let i = 0; i < 18; i++) pad.push(';' + 'x'.repeat(68) + String.fromCharCode(97 + i));
    unlock('C:\\MSDOS.SYS'); fs.writeFile('C:\\MSDOS.SYS', W95FS.encode(`${own}\r\n${pad.join('\r\n')}\r\n`)); fs.setAttrs('C:\\MSDOS.SYS', HSR);
  }
}
/** MS-DOS 6.22 on C:, as its SYS.COM leaves it (W95DOS622, from its Setup Disk 1): IO.SYS and MSDOS.SYS (its kernel, not
 *  a settings file), hidden, system and read-only, and COMMAND.COM in the root; in place of an MS-DOS 7 a disk has (its
 *  IO.SYS an MZ program), and of none */
function sys622Disk() {
  const D = window.W95DOS622; if (!D) return;
  let io = null; try { io = fs.readFile('C:\\IO.SYS'); } catch (_) { /* none */ }
  if (io && !(io[0] === 0x4d && io[1] === 0x5a)) return;   // (an MS-DOS of its own already)
  const HSR = ATTR.HIDDEN | ATTR.SYSTEM | ATTR.READONLY;
  for (const n of ['IO.SYS', 'MSDOS.SYS']) { const p = 'C:\\' + n; try { fs.setAttrs(p, 0); } catch (_) { /* not there */ } fs.writeFile(p, b64bytes(D.files[n])); fs.setAttrs(p, HSR); }
  fs.writeFile('C:\\COMMAND.COM', b64bytes(D.files['COMMAND.COM']));
}
/** a Windows 3.1 disk's AUTOEXEC.BAT, when it has none: the commands of its WIN.BAT (its PATH and settings, then
 *  WIN.COM) if it keeps one in the root, its lines ended CR LF as COMMAND.COM reads them (one kept by DOSBox ends them
 *  with LF alone, one line to MS-DOS), else WIN.COM from its Windows folder */
function win31Autoexec() {
  if (fs.exists('C:\\AUTOEXEC.BAT')) return;
  let cmds = null; try { cmds = fs.readText('C:\\WIN.BAT').split(/\r?\n/).filter(l => l.trim()).join('\r\n'); } catch (_) { /* none */ }
  fs.writeFile('C:\\AUTOEXEC.BAT', W95FS.encode(`@ECHO OFF\r\n${cmds || join(WINDIR, 'WIN.COM')}\r\n`));
}
/** a copy this page put in the Windows folder before of a program Setup puts in SYSTEM (`names`), the bundle's own bytes:
 *  removed. Windows 98's MSGSRV32 runs "runonce.exe -m", found in the Windows folder before SYSTEM, and Windows 95's
 *  RUNONCE ran on Windows 98 (its "Windows 95 Setup" over Setup's first-start items). At the page's start and at each
 *  boot of the PC (Setup's restart, a moment's disk travelled to) */
function strayCopies(names = ['SPOOL32.EXE', 'SYSTRAY.EXE', 'MPREXE.EXE', 'RUNONCE.EXE']) {
  const S = window.W95SYSTEM || {};
  for (const name of names) {
    const d = (S.programs || {})[name], stray = join(WINDIR, name); if (!d) continue;
    let cur = null; try { cur = fs.readFile(stray); } catch (_) { /* none */ }
    const want = cur && b64bytes(d.file);
    if (cur && cur.length === want.length && cur.every((b, i) => b === want[i])) { fs.setAttrs(stray, 0); fs.unlink(stray); }
  }
}
function installPrograms() {
  const stub = exeStub(), S = window.W95SYSTEM || {};
  const OURS = new Set(['CLAUDE.EXE', 'SESSTRAY.EXE', 'DBWIN.EXE', 'W95DBG.EXE']);   // (a program of this project's: its file is the one its translation is of, kept current)
  const put = (path, b64) => {
    let cur = null; try { cur = fs.readFile(path); } catch (_) { /* not there */ }
    const want = OURS.has(basename(path).toUpperCase()) ? b64bytes(b64) : null;
    if (cur && !(cur.length === stub.length && cur.every((b, i) => b === stub[i])) && !(want && !(cur.length === want.length && cur.every((b, i) => b === want[i])))) return;
    fs.writeFile(path, want || b64bytes(b64));
  };
  // the programs Setup puts in SYSTEM rather than the Windows folder (COPY.INF: LDID 11; MPR starts MPREXE from there;
  // SETUPC.INF's [winother.files], RUNONCE.EXE)
  const IN_SYSTEM = new Set(['SPOOL32.EXE', 'SYSTRAY.EXE', 'MPREXE.EXE', 'RUNONCE.EXE']);
  for (const [name, d] of Object.entries(S.programs || {})) if (!d.onCD) put(join(WINDIR, IN_SYSTEM.has(name) ? 'SYSTEM' : '', name), d.file);   // (one the CD runs from the disc: Hover!)
  strayCopies(IN_SYSTEM);
  // the system modules the programs run on, in SYSTEM as Setup puts them (SHELL32 reads its icons from its file)
  for (const [name, d] of Object.entries({ ...S.dlls, ...S.net, ...S.drivers })) if (!d.onCD) put(join(WINDIR, 'SYSTEM', name), d.file);
  for (const d of Object.values(S.ne || {})) if (d.fileName && !d.onDisk) put(join(WINDIR, d.fileName === 'PROGMAN.EXE' ? '' : 'SYSTEM', d.fileName), d.file);   // (a printer driver: as the Add Printer wizard copies it; Program Manager in the Windows folder, COPY.INF)
  // MS-DOS's command interpreter, where Setup puts it: the root's (IO.SYS starts it) and the Windows folder's
  const DOS = window.W95DOS; if (DOS) for (const p of ['C:\\COMMAND.COM', join(WINDIR, 'COMMAND.COM')]) put(p, DOS.files['COMMAND.COM']);
  sysDisk(true);
  try { if (fs.readText('C:\\CONFIG.SYS') === CONFIG_SYS_OLD && !fs.exists(join(WINDIR, 'HIMEM.SYS'))) fs.writeFile('C:\\CONFIG.SYS', CONFIG_SYS.replace(/\n/g, '\r\n')); } catch (_) { /* none */ }
  // and WIN.COM, which IO.SYS's shell runs to start Windows (Setup builds it from WIN.CNF)
  if (DOS && DOS.files['WINDOWS\\WIN.COM']) put(join(WINDIR, 'WIN.COM'), DOS.files['WINDOWS\\WIN.COM']);
  // and IFSHLP.SYS, the file system helper IO.SYS loads from the Windows folder as it starts
  if (DOS && DOS.files['WINDOWS\\IFSHLP.SYS']) put(join(WINDIR, 'IFSHLP.SYS'), DOS.files['WINDOWS\\IFSHLP.SYS']);
  // the MS-DOS programs, in C:\WINDOWS\COMMAND (LDID_COMMAND)
  if (DOS && DOS.command) { fs.mkdir(join(WINDIR, 'COMMAND'), { recursive: true }); for (const [n, d] of Object.entries(DOS.command)) put(join(WINDIR, 'COMMAND', n), d); }
  // the Windows 3.x runtime libraries, in SYSTEM (WIN87EM, NDDEAPI, OLE, WINSOCK: tools/build_dos.py)
  if (DOS && DOS.system) for (const [n, d] of Object.entries(DOS.system)) put(join(WINDIR, 'SYSTEM', n), d);
  // the display's grabber, which WinOldAp imports as GRABBER and KERNEL finds by SYSTEM.INI's [boot] 386grabber, as the
  // display's INF (MSDISP.INF) leaves it; a disk set up before it was written gets it too
  if (DOS && DOS.system && DOS.system['VGAFULL.3GR'] && !W95Win32.iniGet(fs, 'SYSTEM.INI', 'boot', '386grabber')) W95Win32.iniSet(fs, 'SYSTEM.INI', 'boot', '386grabber', 'vgafull.3gr');
  // and the font WinOldAp draws an MS-DOS window's text in, code page 437's (LOCALE.INF: [386Enh] woafont)
  if (DOS && DOS.system && DOS.system['WINOA386.MOD'] && !W95Win32.iniGet(fs, 'SYSTEM.INI', '386Enh', 'woafont')) W95Win32.iniSet(fs, 'SYSTEM.INI', '386Enh', 'woafont', 'dosapp.fon');
  // Setup's optional components (Clipboard Viewer, CLIP.INF): their programs in the Windows folder, their help in HELP,
  // and the OptionalComponents value Add/Remove Programs reads to show one installed
  if (DOS && DOS.windows) for (const [n, d] of Object.entries(DOS.windows)) put(join(WINDIR, n), d);
  if (DOS && DOS.help) { fs.mkdir(join(WINDIR, 'HELP'), { recursive: true }); for (const [n, d] of Object.entries(DOS.help)) put(join(WINDIR, 'HELP', n), d); }
  // the INFs Setup leaves in the INF folder that the system bundle does not carry (APPS.INF, which PIFMGR reads)
  if (DOS && DOS.infs) { fs.mkdir(join(WINDIR, 'INF'), { recursive: true }); for (const [n, t] of Object.entries(DOS.infs)) { const f = join(WINDIR, 'INF', n); if (!fs.exists(f)) fs.writeFile(f, Uint8Array.from(t, c => c.charCodeAt(0))); } }
  if (DOS && DOS.infs && DOS.infs['CLIP.INF']) W95Win32.regSet('hklm\\software\\microsoft\\windows\\currentversion\\setup\\optionalcomponents\\clipbrd', 'Installed', { type: 1, data: W95FS.encode('1\0') });
  if (DOS && DOS.windows && DOS.windows['SOL.EXE']) W95Win32.regSet('hklm\\software\\microsoft\\windows\\currentversion\\setup\\optionalcomponents\\games', 'Installed', { type: 1, data: W95FS.encode('1\0') });   // (APPLETS.INF wingames.install.reg)
  // the components a Typical install sets up (Paint, WordPad, HyperTerminal, Phone Dialer, Disk Defragmenter, the
  // document templates, Accessibility): their files where their INF's CopyFiles put them (tools/build_dos.py), then,
  // once, as Setup installs one, its INF's AddReg and its UpdateInis lines for WIN.INI (its links: setupStartMenu)
  // the DLLs those programs need that the system bundle does not carry (their imports' closure: MFC, TAPI), where Setup
  // puts each (tools/build_dos.py); a file the bundle wrote is kept
  for (const [path, d] of (DOS && DOS.deps) || []) { fs.mkdir(dirname(path), { recursive: true }); put(path, d); }
  for (const c of (DOS && DOS.components) || []) {
    const inf = DOS.infs[c.inf]; if (!inf) continue;
    let fresh = false;
    for (const [path, d] of c.files) { if (!fs.exists(path)) fresh = true; fs.mkdir(dirname(path), { recursive: true }); put(path, d); }
    if (!fresh) continue;
    const body = Object.fromEntries((infParse(inf).sec[c.name.toLowerCase()] || []).map(l => l.split(';')[0]).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim().toLowerCase(), l.slice(l.indexOf('=') + 1).trim()]));
    for (const s of (body.addreg || '').split(',').map(x => x.trim()).filter(Boolean)) infAddReg(inf, s);
    for (const s of (body.updateinis || '').split(',').map(x => x.trim()).filter(Boolean)) infUpdateInis(inf, s, /^win\.ini$/i);
  }
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
    Object.assign(this, { x: n.x, y: n.y, w: n.w, h: n.h, title: n.title, min: n.iconic, cls: n.cls, nativeModal: !!n.modal, transparent: !!(n.ex & 0x20), preview: !!n.preview, guestParent: n.parent || 0 });
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
  constructor(path, arg, o = {}) { this.path = path; this.arg = arg; this.system = !!o.system; this.quiet = !!o.quiet; this.alive = true; this.wins = new Map(); this.icon = EXE_ICON[basename(path).toUpperCase()] || 'app'; this.lastActive = 0; this.cursorOn = false; }
  /** the program's module name, as KERNEL32's messages name it */
  progName() { return basename(this.path).replace(/\.[^.]*$/, '').toUpperCase(); }
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
}
// ---------------------------------------------------------------- a machine in a worker (worker.js)
// The program's machine runs in a worker of its own, so nothing it does holds the page: it draws into its memory,
// which the page shares and reads the screen from; the page sends it the keys and the mouse through its input ring
// (bridge.js) and asks it for what is done to its windows; it calls the page's file system synchronously (the page
// answers here). The page draws USER's windows from what the machine reports after each of its steps.
const machineWorkers = new Set();
/** a channel from machine `a` to the system's machine `n`, which has the network stack, for the network's files `a`
 *  opens (worker.js netCall): `n` answers on `a`'s block, which `a` waits on */
function netLink(a, n = sysApp) {
  if (!n || !n.alive || a === n) return;
  const ch = new MessageChannel(), sab = new SharedArrayBuffer(16 + W95Bridge.RPC_BYTES);
  n.worker.postMessage({ t: 'netport', port: ch.port2, sab }, [ch.port2]);
  a.worker.postMessage({ t: 'netlink', port: ch.port1, sab }, [ch.port1]);
  a.worker.postMessage({ t: 'netmounts', list: netMounts });
}
let netMounts = [];   // the drives the network has connected: { letter, unc }
W95Win32.regWatch(o => { for (const a of machineWorkers) a.worker.postMessage({ t: 'regop', o }); });
class RemoteApp extends NativeApp {
  constructor(path, arg, o = {}) { super(path, arg, o); this.calls = new Map(); this.nextCall = 1; this.stats = { slices: 0, guestMs: 0 }; this.held = null; }
  // what the shell's older code reads of a machine (its counters; a program that has not exited)
  get proc() { return { stats: this.stats, exitCode: this.alive ? null : 0, trapped: null, depth: 0, win16Held: this.held, r0Runs: this.r0 ? [1] : [], txt: this.txt, nativeChildren: h => this.children(h) }; }
  start(bytes, prog) {
    [this.sw, this.sh] = this.system ? bootSize() : nativeMode(); if (this.system) bootMode(this.sw, this.sh);
    this.ring = W95Bridge.newRing(); this.rpcSab = new SharedArrayBuffer(16 + W95Bridge.RPC_BYTES);
    if (this.system) this.lanRing = W95Bridge.newFrames();   // (the frames for its network card: the system's machine runs the network stack)
    this.worker = new Worker('worker.js'); machineWorkers.add(this);
    this.worker.onmessage = e => this.message(e.data);
    this.worker.onerror = e => { console.error('[worker]', e.message); this.exited(-1, e.message); };
    this.worker.postMessage({ t: 'start', rpc: this.rpcSab, registry: W95Win32.regDump(), o: {
      path: this.path, arg: this.arg, system: this.system, quiet: this.quiet, bootMods: this.system ? (Array.isArray(window.W95BOOTMODS) ? window.W95BOOTMODS : (new URLSearchParams(location.search).get('bootmods') || '').split(',').filter(Boolean)) : null, pcDos: this.system && pc && pc.m.dosState ? pc.m.dosState() : null, holdStartup: this.system && !!(sharedNow() && window.W95HOST.shared.joining), session: this.system && !!sharedNow(), wallSkew: sharedNow() ? sharedNow().clockSkew() : 0, sw: this.sw, sh: this.sh, shellW: W, workH: workH(), ring: this.ring, lan: this.lanRing || null,
      bytes: bytes || null, prog: prog ? { name: prog.name, meta: prog.d.meta } : null,
      sharedStrokes: !!sharedNow(),   // (this person's mouse strokes are a shared session's (worker.js recordStroke); alone, none is recorded)
      memwatch: new URLSearchParams(location.search).get('memwatch'),
      dynat: new URLSearchParams(location.search).get('dynat'),   // (?dynat=12219c9: a VxD's blocks there run as run-time code, vmm.js vxd)   // (?memwatch=0,16: cmd 'memwatch' from the machine's first instruction, boot's writes too)
      trace: new URLSearchParams(location.search).get('trace'),   // (?trace=MSGSRV32: the imports that thread calls, read back with cmd 'trace')
      traceNames: new URLSearchParams(location.search).get('traceNames'),   // (&traceNames=Profile|DeleteFile: only the imports whose names match)
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
  /** the controls USER keeps for a native window, as the machine last reported them (none before its first answer);
   *  each look asks again, one question at a time per window */
  children(hwnd) {
    if (!this.kids) { this.kids = new Map(); this.kidsAsked = new Set(); }
    if (!this.kidsAsked.has(hwnd)) {
      this.kidsAsked.add(hwnd);
      this.cmd('children', [hwnd]).then(r => { if (!this.kids) return; this.kidsAsked.delete(hwnd); if (r) this.kids.set(hwnd, r); else this.kids.delete(hwnd); });   // (no map: the answer came to a machine travelled meanwhile, braid-page.js)
    }
    return this.kids.get(hwnd) || [];
  }
  /** a window's controls as the machine answers now (children gives the last answer, and asks again) */
  async childrenNow(hwnd) {
    if (!this.kids) { this.kids = new Map(); this.kidsAsked = new Set(); }
    const r = await this.cmd('children', [hwnd]);
    if (r) this.kids.set(hwnd, r); else this.kids.delete(hwnd);
    return this.kids.get(hwnd) || [];
  }
  /** whether the system's machine has MPR loaded, once it has come to that (worker.js loadMpr) */
  mprLoaded() { return this.mprUp !== undefined ? Promise.resolve(this.mprUp) : new Promise(ok => { this.mprReady = ok; }); }
  /** a request to the machine; resolves to its answer */
  /** `transfer`: buffers moved to the machine, not copied (an arrival's moment, hundreds of MB, is the caller's no more:
   *  copied, a second copy beside the first, Windows 95's 440 MB one was "Data cannot be cloned, out of memory") */
  cmd(name, args = [], transfer = []) {
    if (!this.alive) return Promise.resolve(null);
    const id = this.nextCall++;
    return new Promise(ok => { this.calls.set(id, ok); this.worker.postMessage({ t: 'cmd', id, name, args }, transfer); });
  }
  message(m) {
    // (a machine that has ended draws no more: its worker's last frames put its windows back on the screen, undrawn)
    if (!this.alive && m.t === 'frame') return;
    switch (m.t) {
      case 'rpc': this.serve(m); return;
      case 'started':
        this.mem = m.mem; [this.sw, this.sh] = [m.sw, m.sh];
        this.cv = mkc(this.sw, this.sh); this.cx = this.cv.getContext('2d'); this.img = this.cx.createImageData(this.sw, this.sh);
        this.ov = mkc(this.sw, this.sh); this.ox = this.ov.getContext('2d'); this.oimg = this.ox.createImageData(this.sw, this.sh); this.o32 = new Uint32Array(this.oimg.data.buffer);
        this.d32 = new Uint32Array(this.img.data.buffer); this.pal = new Uint32Array(256);
        if (this.system) fitWindow(this.sw, this.sh);
        nativeApps.add(this);
        // the system's machine has the network stack and its card, as Windows does: a station on the page's segment
        if (this.lanRing) { this.lanStation = { rx: frame => { if (this.alive) W95Bridge.framePut(this.lanRing, frame); } }; this.lanDetach = window.W95LAN && W95LAN.attach(this.lanStation); }
        if (this.system) { for (const a of machineWorkers) if (a !== this) netLink(a, this); }
        else netLink(this);
        if (this.started) this.started(true); return;
      // MPR loaded in the system's machine (or no network client): the shell's network calls go ahead (netBoot)
      case 'mpr': this.mprUp = m.up; if (this.mprReady) { this.mprReady(m.up); this.mprReady = null; } return;
      case 'session': sessionCommand(m.op); return;   // (Export or Import Session, from the Start menu: SESSION.DLL)
      // (the Braid icon's menu, SESSTRAY.DLL: Mark Now, Anchor Now, Travel To a moment; the session's, every machine's)
      case 'trayBraid': {
        if (!braid) return;
        const r = m.op === 'mark' ? braid.mark() : m.op === 'anchor' ? braid.anchor() : m.op === 'travel' && m.name ? braid.travel(m.name, { force: true }) : null;
        if (r) Promise.resolve(r).then(() => trayPeople(), e => { peerNotes.push({ text: `Braid: ${e.message}`, until: Date.now() + 4000 }); dirty(); });
        return;
      }
      case 'trayWhere': {   // (Where Is, from a person's icon: SESSTRAY.DLL)
        const who = window.W95Shared && window.W95Shared.people().find(p => p.client === m.client);
        if (who && who.x == null) { peerNotes.push({ text: `${who.user || 'Guest'} has not moved their pointer yet`, until: Date.now() + 4000 }); setTimeout(dirty, 4100); }
        else peerWhere = { client: m.client, until: Date.now() + 3000 };
        dirty(); return;
      }
      // Follow (from a person's icon): their pointer kept marked on this screen until Follow is chosen again (null)
      case 'trayFollow': { peerFollow = m.client || null; const who = peerFollow && window.W95Shared && window.W95Shared.people().find(p => p.client === peerFollow); peerNotes.push({ text: peerFollow ? `Following ${(who && who.user) || 'Guest'}` : 'No longer following', until: Date.now() + 3000 }); emit('tray.follow', { client: peerFollow }); setTimeout(dirty, 3100); dirty(); return; }
      // one of a person's windows chosen from their icon's menu: brought to the front here (it is the session's, so it is here too)
      case 'trayWindow': { emit('tray.window', { id: m.id, client: m.client }); osLocal().then(local => { const mine = local && local.get(m.id); const w = mine && windows.find(x => x.native && x.guestHwnd === mine.hwnd); if (w) activate(w); else if (mine) sysApp.cmd('focus', [mine.hwnd, 0]); }).catch(() => {}); return; }
      // a console program's output, and its end, to the MS-DOS machine that is its console
      case 'conOut': { const c = consoles.get(m.id); if (c) { c.conWrite(m.text); dirty(); } return; }
      case 'mic': { if (window.W95Mic) window.W95Mic.set(!!m.on, (samples, rate) => this.worker.postMessage({ t: 'micIn', samples, rate }, [samples.buffer])); return; }   // (the sound card capturing: the microphone opened, or let go)
      case 'cdaudio': { const A = window.W95CDAudio; if (m.op === 'play') A.play(m.from, m.to); else if (m.op === 'gain') A.gain(m.l, m.r); else A.stop(); return; }   // (the audio CD drive told to play sectors, or stop; the sound card's gain for it)
      case 'cdtrace': { if (!/\.localhost$/.test(location.hostname)) return; (window.cdLogBuf || (window.cdLogBuf = [])).push(m.s); if (!window.cdLogT) window.cdLogT = setTimeout(() => { window.cdLogT = 0; fetch('/__cdlog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: window.cdLogBuf.splice(0) }) }).catch(() => {}); }, 300); return; }
      case 'conMode': { const c = consoles.get(m.id); if (c && c.conWait) c.conWait.mode = m.mode; return; }
      case 'conExit': { const c = consoles.get(m.id); if (c) { consoles.delete(m.id); c.conDone(); } return; }
      case 'ccdTurn': emit('ccd.reply', { session: m.session, text: m.text, error: m.error, stopped: !!m.stopped }); if (m.kind) emit('ccd.notify', { kind: m.kind, session: m.session }); return;   // (a turn of the Claude program's ended)
      case 'ccdCard': { const ccd = window.win95 && window.win95.ccd; if (ccd) ccd.cardAnswer(m.task, m.label); return; }   // (a card's button, pressed in the Claude program)
      case 'ccdAnswer': { const f = this.ccdAsks && this.ccdAsks.get(m.id); if (f) { this.ccdAsks.delete(m.id); f(!!m.yes); } return; }
      // a tool the Claude program's Claude used (claude-app.js): run here, where the app's tools are (ccd.js), its answer sent back
      case 'ccd': {
        const back = o => { if (this.worker) this.worker.postMessage({ t: 'ccdReply', id: m.id, ...o }); };
        const ccd = window.win95 && window.win95.ccd;
        if (!ccd) { back({ error: 'The Claude app\'s tools are not loaded.' }); return; }
        if (m.name === '@defs') { back({ result: ccd.toolDefs() }); return; }   // (the tools themselves, as the API takes them)
        if (m.name === '@context') { back({ result: ccd.context(m.session) }); return; }   // (CLAUDE.MD and the memory, for each request)
        if (m.name === '@appendC') { try { back({ result: ccd.appendC(m.args.path, m.args.text) }); } catch (e) { back({ error: e.message }); } return; }   // (feedback written)
        if (m.name === '@readC') { try { back({ result: ccd.readC(m.args.path) }); } catch (e) { back({ error: e.message }); } return; }   // (a file attached to a prompt)
        // what the tools ask the user, asked in the program's own message box (its answer: 'ccdAnswer')
        const asks = this.ccdAsks || (this.ccdAsks = new Map());
        ccd.asker = (title, text) => new Promise(ok => { const k = (this.ccdAskN = (this.ccdAskN || 0) + 1); asks.set(k, ok); this.worker.postMessage({ t: 'ccdAsk', id: k, title, text }); });
        ccd.callAs(m.session, m.name, m.args, m.via).then(result => back({ result }), e => back({ error: String(e && e.message || e) }));
        return;
      }
      case 'lan': if (window.W95LAN && this.lanStation) W95LAN.send(this.lanStation, m.frame); return;
      case 'frame': this.frame(m); this.framed(); return;
      case 'held': this.held = m.held; this.stats = m.stats; this.framed(); return;
      // the screen's mode, DAC and the cursor sprite, as often as the machine runs, its window list or not (USER held)
      case 'scan': this.scr = m; this.followMode(m); dirty(); return;
      case 'mode': if (this.modeDone) this.modeDone(m.r); return;   // (a mode asked for while a thread held USER, made now)
      case 'debug': emit('debug.hit', m.hit); return;   // a recording breakpoint was reached (win95.debug)
      case 'intent': { const S = sharedNow(); if (S) S.intent(m.i); return; }   // (a setting this machine's person made: ne16.js hookIntents)
      case 'stroke': if (this.system) osStrokeOut(m); return;   // (this person's mouse stroke into a window, or part of one: worker.js recordStroke)
      case 'strokeAt': { const client = String(m.key).split(':')[0]; if (m.done) peerAt.delete(client); else peerAt.set(client, { x: m.x, y: m.y, t: Date.now() }); dirty(); return; }   // (another person's stroke, as far as it is drawn here: their pointer drawn on it)
      case 'text': this.txt = m.txt; if (msgApp === this) dirty(); return;
      case 'msgMode': msgApp = m.on ? this : msgApp === this ? null : msgApp; this.r0 = m.on; dirty(); return;
      case 'reset': machineReset(); return;
      case 'audio': if (window.W95Sound) W95Sound.play(this, m.rate, m.l, m.r); return;
      case 'regop': W95Win32.regApply(m.o); logonChanged(m.o); return;
      case 'closeProgram': closeProgram(this); return;
      case 'fault': braidFault(this, m.f, true); this.stopped = true; faultDialog(this.progName(), m.f, () => this.exited(-1)); dirty(); return;   // (stopped: the mouse is the page's, pointerApp)
      case 'faultDialog': braidFault(this, m.f, false); faultDialog(this.progName(), m.f); return;
      case 'pcFault':
        braidFault(this, m.f || { why: m.why, program: m.path }, false);
        emit('program.exit', { path: m.path, code: -1, why: m.why });
        if (m.shown) return;   // (the machine's own fault dialog, worker.js faultBox)
        if (m.f) faultDialog(basename(m.path).replace(/\.[^.]*$/, '').toUpperCase(), m.f);
        else msgBox(basename(m.path), `This program has performed an illegal operation and will be shut down.\n\n${m.why}`, 'error', ['OK'], null, { noTask: false, modal: false });
        return;
      // a line of the machine's log (win32.js log): into the page's ring, and to the Debug Monitor through the system's
      // machine when another machine said it
      case 'log': { m.line.posted = true; m.line.machine = this.system ? 'system' : basename(this.path || ''); W95Win32.log.put(m.line); if (!this.system && sysApp && sysApp.alive) sysApp.cmd('logPut', [m.line]); return; }
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
        else if (m.method === 'vols') v = [...fs.vols.values()].map(x => ({ letter: x.letter, kind: x.kind, label: x.label, remote: !!x.remote, unc: x.unc || '', ready: x.ready, media: x.media || 0, sectors: x.sectors || 0, ...(x.audio ? { audio: x.audio } : {}) }));
        else if (typeof fs[m.method] !== 'function') throw new Error(`the file system has no ${m.method}`);
        else {
          v = fs[m.method](...m.args);
          // (the descriptors the machine opens are its own, closed when it ends, as a process's handles are: Windows
          // keeps a 16-bit module's file open for its discardable segments, and SHELL.DLL's and DDEML.DLL's stayed open
          // on the page after Windows 95 shut down for Setup's restart, so WININIT could not replace them, a sharing
          // violation each: "Windows could not upgrade the file")
          if (m.method === 'open' && typeof v === 'number') (this.fds || (this.fds = new Set())).add(v);
          else if (m.method === 'close' && this.fds) this.fds.delete(m.args[0]);
        }
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
  // (the page's buffers follow the screen the machine scans out, by their own size: a travel puts sw and sh back from
  // the moment and leaves the canvases, the page's live things, as they were, so a moment taken at 706x859 arrived at
  // from 640x480 had sw at 706 and a 640-wide image, and the 1416-byte lines were drawn 640 to a row, sheared)
  // (and the page's screen the machine's, once it is the page's monitor: the shell came up after the machine's first
  // frame (Windows 98's start after RUNONCE's restart), and the page kept the boot logo's 320x200, the desktop cut to
  // its corner)
  followMode(m) { const s = m && m.scan; if (s && s.bpp && (s.w !== this.sw || s.h !== this.sh || !this.img || this.img.width !== s.w || this.img.height !== s.h)) this.screenSized(s.w, s.h); }
  frame(m) {
    if (this.system && bootLogo.on && m.list.length) bootLogoEnd();   // (Windows has a window up: the start-up screen goes)
    if (this.system && sharedNow()) {   // (its windows changed: the session's objects may have; win95.js osSoon)
      const sig = m.list.map(n => `${n.hwnd},${n.x},${n.y},${n.w},${n.h},${n.iconic ? 1 : 0},${n.title}`).join(';');
      if (sig !== this.listSig) { this.listSig = sig; osShellUp(m.list); osSoon(); }
      osFrame();
    }
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
    // (the machine that is the monitor is drawn whole from its screen, scanToCanvas: its windows' canvases and its
    // overlay are never shown, and making them reads every pixel of the screen on every frame)
    if (monApp() === this) return;
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
    if (W95Bridge.ringPut(this.ring, W95Bridge.MOUSE, f, Math.round(x), Math.round(y))) this.ringPut = (this.ringPut || 0) + 1;
    const k = `${Math.round(x)},${Math.round(y)}`, s = this.sentPts || (this.sentPts = []); s.push(k); if (s.length > 64) s.shift(); this.lastPtr = [Math.round(x), Math.round(y)];
    this.kick();
  }
  /** where the hardware cursor is, as the mouse's interrupt moves it on a real machine ahead of whatever runs: at the
   *  page's newest pointer, less the image's hot spot, while the machine's cursor (USER's, reported with the sprite) is
   *  at a place this page sent, that is, while it follows the mouse; the sprite's own place when the machine put its
   *  cursor elsewhere (ClipCursor's edge, SetCursorPos), or before the hot spot is known. The hot spot is kept for each
   *  image (USER's cursor less the sprite's place, reported together) */
  pointerAt(sp) {
    if (!sp || !sp.bits || !this.lastPtr) return null;
    let h = 2166136261; const n = Math.min(sp.bits.length, 64 * sp.row);
    for (let i = 0; i < n; i++) { h ^= sp.bits[i]; h = Math.imul(h, 16777619); }
    const key = `${h >>> 0}:${sp.px}:${sp.py}:${sp.cpp}`, hot = this.hots || (this.hots = new Map()), cur = this.scr && this.scr.cur;
    if (cur) {
      this.follows = (this.sentPts || []).includes(`${cur.x},${cur.y}`);
      if (sp.x === this.scr.sprite.x && sp.y === this.scr.sprite.y) hot.set(key, [cur.x - sp.x, cur.y - sp.y]);
    }
    const hs = hot.get(key); if (!this.follows || !hs) return null;
    return [this.lastPtr[0] - hs[0], this.lastPtr[1] - hs[1]];
  }
  /** the next message the machine sends of its screen (a frame, or its state while a thread holds USER) */
  nextFrame() { return new Promise(ok => (this.frameWaiters || (this.frameWaiters = [])).push(ok)); }
  framed() { const w = this.frameWaiters; if (w && w.length) { this.frameWaiters = []; for (const ok of w) ok(); } }
  /** the machine has fed USER every pointer event put in its ring so far: a frame says so (worker.js input) */
  inputFed() { const i = this.snap && this.snap.input; return !this.ring || !!i && i.taken >= (this.ringPut || 0) && !i.mouse; }
  key(e, up) { this.ringKey(e, up, true); }
  ringKey(e, up, toUser) {
    if (!this.alive || !this.ring) return;
    const vk = e.keyCode || 0; if (vk === 91 || vk === 93 || vk === 224) return;   // the Mac command keys stay with the host
    let sc = SCAN[e.code] || 0;
    if (e.code === 'Backspace' && e.ctrlKey && e.altKey) sc = 0x153;   // a Mac's Delete key: Ctrl+Alt+Del
    const a = (sc & 0x1ff) | (up ? 0x200 : 0) | (toUser ? 0x400 : 0), b = (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0);
    if (W95Bridge.ringPut(this.ring, W95Bridge.KEY, a, b, vk)) this.ringPut = (this.ringPut || 0) + 1;
    this.modsHeld = b;   // (the modifiers the machine has down after this key: let go when the page loses the keyboard)
    this.kick();
  }
  /** the page has lost the keyboard (another window or tab has it): the modifiers the machine has down are let go, as
   *  their key-ups will never come here. Alt held while switching away stayed down in Windows for good: a double-click
   *  on My Computer was Alt+double-click, its Properties, and Enter on a folder Alt+Enter */
  releaseMods() {
    const b = this.modsHeld || 0; if (!b) return;
    for (const [bit, vk, code] of [[1, 16, 'ShiftLeft'], [2, 17, 'ControlLeft'], [4, 18, 'AltLeft']]) if (b & bit) this.ringKey({ keyCode: vk, code, shiftKey: false, ctrlKey: false, altKey: false }, true, true);
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
  spawnProgram(file, arg, o) { return this.cmd('spawn', o ? [file, arg, o] : [file, arg]); }
  exited(code, why, own) {
    if (!this.alive) return;
    this.alive = false; nativeApps.delete(this); machineWorkers.delete(this);
    if (this.fds) { for (const fd of this.fds) { try { fs.close(fd); } catch (_) { /* closed already */ } } this.fds.clear(); }   // (its files, closed: serve)
    if (this.lanDetach) this.lanDetach();
    if (this.system) for (const a of machineWorkers) a.worker.postMessage({ t: 'netlink', port: null });
    if (clipOwner === this) clipOwner = null;
    if (window.W95Sound) W95Sound.close(this);
    for (const w of this.wins.values()) closeWin(w, true);
    this.wins.clear();
    // (and any of its windows the page holds outside its map, a travel's shell put back: a dead machine's window
    // took the mouse and answered nothing)
    for (const w of windows.filter(v => v.native && v.app === this)) closeWin(w, true);
    if (msgApp === this) msgApp = null;
    for (const ok of this.calls.values()) ok(null); this.calls.clear();
    if (this.mprReady) { this.mprReady(false); this.mprReady = null; }
    setTimeout(() => this.worker.terminate(), 0);
    emit('program.exit', { path: this.path, code, ...(why ? { why } : {}) });
    if (why && this.system) console.error(`[system] ${why}`);
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
  await netReady(path);   // (a program on a network drive: its file as the system's machine reads it)
  let bytes; try { bytes = fs.readFile(path); } catch (e) { return false; }
  // (a Win32 program the bundle does not carry runs too: the system's machine maps it and translates its code as it
  // runs; worker.js dynProgram)
  const prog = await nativeProgram(bytes); if (!prog && exeKind(bytes) !== 'pe' && exeKind(bytes) !== 'ne') return false;
  // in the system's machine, as Windows 95 runs every program on its one USER and its one set of drivers; a second
  // instance of a program (whose image's place there is taken) gets a machine of its own
  if (!o.apart) {
    const sys = await startSystem();
    if (sys) {
      let r = sys.spawnProgram(path, arg); if (r && r.then) r = await r;
      if (r && (r.ok || (typeof r === 'object' && !('err' in r)))) return true;
      const err = r && typeof r === 'object' ? r.err : r;
      // (a program whose DLL is missing: ShellExecute's own words for LoadModule's error 2)
      if (err === 2) { msgBox(basename(path), `Cannot find the file '${path}' (or one of its components). Make sure the path and filename are correct and that all required libraries are available.`, 'error'); return true; }
      if (err !== 8) return false;
    }
  }
  if (!prog) return false;
  return new RemoteApp(path, arg, o).start(bytes, prog);
}
/** what an executable file is: 'pe' (Win32), 'ne' (Win16), 'dos' (an MS-DOS program: an MZ image with neither, or a
 *  .COM's bare code), as the loader tells them by their headers */
function exeKind(b) {
  if (b.length < 2 || b[0] !== 0x4d || b[1] !== 0x5a) return 'dos';
  const at = b.length >= 0x40 ? (b[0x3c] | b[0x3d] << 8 | b[0x3e] << 16 | b[0x3f] << 24) >>> 0 : 0;
  // (a new-format header: the signature at the offset 3Ch gives, as Windows' loader tells them; a Win32 program's MS-DOS
  // stub may be a whole DOS program, its relocations where an old one's are: XCOPY32.EXE's is XCOPY)
  if (at >= 0x40 && at + 2 <= b.length) {
    if (b[at] === 0x50 && b[at + 1] === 0x45) return 'pe';
    if (b[at] === 0x4e && b[at + 1] === 0x45) return 'ne';
  }
  return 'dos';
}
// ---------------------------------------------------------------- the system
// Windows 95's system: one machine (one USER, one MMSYSTEM, one sound card) whose first task is MSGSRV32.EXE, started
// as the desktop comes up. USER's first-task start-up loads the installable drivers for it (MMSYSTEM, the card's), so
// sound starts once, with the system, and MSGSRV32 plays SystemStart. The programs the shell runs start in it
let sysApp = null, sysStarting = null;
// ?debug=1 (or true): a page started for testing
const DEBUG = /^(1|true)$/i.test((() => { try { return new URLSearchParams(location.search).get('debug') || ''; } catch (_) { return ''; } })());
// ?mute=1: a page that makes no sound: its start quiet, and its outputs (the sound card's streams,
// sound.js; the CD drive's, cdaudio.js) silent
window.W95MUTE = window.W95MUTE || /^(1|true)$/i.test((() => { try { return new URLSearchParams(location.search).get('mute') || ''; } catch (_) { return ''; } })());
function startSystem() {
  if (window.W95SYSTEMVM === false) return Promise.resolve(null);
  if (sysApp && sysApp.alive) return Promise.resolve(sysApp);
  return sysStarting || (sysStarting = (async () => {
    const S = window.W95SYSTEM || {}; if (!(S.ne || {}).MSGSRV32 || !Object.keys(S.programs || {}).length) return null;
    // MSGSRV32's start-up plays SystemStart at every start, as Windows 95's does (a reload, a Restart, after a crash),
    // and starts the shell SYSTEM.INI names; a page asked to be silent (?mute=1) starts quiet
    const quiet = window.W95MUTE;
    const a = new RemoteApp(join(WINDIR, 'SYSTEM', 'MSGSRV32.EXE'), '', { system: true, quiet });
    if (!(await a.start(null, null))) { bootLogoEnd(); return null; }
    sysApp = a;
    emit('system.start', {});   // (the address's settings are made in it, speed and mods: urlSettings)
    return a;
  })().finally(() => { sysStarting = null; }));
}
// The start-up screen while the system's machine boots, as IO.SYS shows it until Windows' display driver takes the
// screen, its bottom band (palette entries 236-255) rotating. After the PC's own boot it is what IO.SYS drew on the
// VGA as Windows took over (v86.js vgaFrame): the logo of the IO.SYS on the disk, Windows 98's once Setup has put its
// own there, or C:\LOGO.SYS; none when IO.SYS showed none (MSDOS.SYS Logo=0). A machine started with no PC boot
// before it shows the CD's LOGO.SYS (320x400, 8 bits, shown at 4:3). It stays until the machine has a window on
// screen (Setup's, the logon's, the shell's)
const bootLogo = { on: false, img: null, pal: null, px: null, timer: 0 };
function bootLogoStart() {
  if (window.W95SYSTEMVM === false) return;
  if (pc && pc.m && pc.m.vga) {
    const fr = pc.m.vgaFrame(); if (!fr) return;
    Object.assign(bootLogo, { px: fr.px, pal: fr.pal, w: fr.w, h: fr.h, cv: mkc(fr.w, fr.h) }); bootLogo.img = bootLogo.cv.getContext('2d').createImageData(fr.w, fr.h);
    bootLogo.fromPc = true;
  } else if (bootLogo.fromPc) bootLogo.px = null;
  const s = (window.W95SYSTEM || {}).logo;
  if (!bootLogo.px && !s) return;
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
  const L = bootLogo, step = Math.floor((performance.now() - L.t0) / 60) % 20;
  drawIndexed(L.px, L.w, L.h, L.pal.map((c, i) => (i >= 236 ? L.pal[236 + (i - 236 + step) % 20] : c)), L);
}
/** an indexed picture (`px` a palette index a pixel, `pal` [r, g, b] each) on the whole screen at 4:3, black around it,
 *  as a monitor shows the VGA's 320-wide modes; `into` keeps its canvas and image between frames */
const idxCanvas = {};
function drawIndexed(px, w, h, pal, into = idxCanvas) {
  if (!into.cv || into.cv.width !== w || into.cv.height !== h) { into.cv = mkc(w, h); into.img = into.cv.getContext('2d').createImageData(w, h); }
  const d = into.img.data;
  for (let i = 0; i < w * h; i++) { const c = pal[px[i]]; d[4 * i] = c[0]; d[4 * i + 1] = c[1]; d[4 * i + 2] = c[2]; d[4 * i + 3] = 255; }
  into.cv.getContext('2d').putImageData(into.img, 0, 0);
  fill(0, 0, W, H, '#000');
  const s = Math.min(W / 4, H / 3), dw = Math.round(s * 4), dh = Math.round(s * 3);
  ctx.imageSmoothingEnabled = false; ctx.drawImage(into.cv, (W - dw) >> 1, (H - dh) >> 1, dw, dh);
}
/** at boot: once the desktop is drawn and the page has loaded */
function systemBootLater() {
  bootLogoStart();
  const go = () => setTimeout(() => startSystem(), 50);
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
}
// the network's process, MPREXE.EXE, runs in the system's machine with the network's VxDs at ring 0 under it and the
// provider router's DLLs in it, started as Windows 95 boots (worker.js loadMpr), and logged on there as Windows starts;
// the connections to remember are made again as the shell first needs the network; each drive MPR has connected is a drive of fs.js whose files the system's machine's redirector reaches (netfs.js)
const netMachine = () => (sysApp && sysApp.alive ? sysApp : null);
/** a network drive's (or share's) files as the shell sees them: the page cannot wait on the system's machine, so what
 *  the shell lists comes from the folders the machine has listed for it, asked for as the shell first looks and shown
 *  when they arrive (fs.js's version: the views refresh). A file the shell opens is its copy of the file, read whole
 *  from the machine beforehand (netReady); one not read yet is not ready, and is asked for. What the shell writes goes
 *  to the machine as the file is closed; its changes show when the machine has made them */
function netCache(app, key) {
  const lists = new Map(), stats = new Map(), asked = new Map(), files = new Map(), reading = new Map(), handles = new Map();
  let space = { total: 0, free: 0 }, spaceAt = 0, nextH = 1;
  const call = (op, args) => (app.alive ? app.cmd('netfs', [key, op, args]) : Promise.resolve(null)).catch(e => { console.warn('[net]', key, op, e && e.message); return null; });   // (a machine gone, or an error there: no answer)
  const refresh = () => { fs.version++; dirty(); };
  const parent = rel => rel.split('\\').slice(0, -1).join('\\');
  // (by the path in capitals, as the file system's names compare)
  const listNow = rel => {
    const k = rel.toUpperCase(); asked.set(k, performance.now());
    return call('list', [rel]).then(r => {
      if (!Array.isArray(r)) { if (!lists.has(k)) { lists.set(k, []); refresh(); } return lists.get(k); }   // (a folder that cannot be listed holds nothing)
      const pre = k ? k + '\\' : '', old = new Map();   // (what the folder no longer holds goes; a file changed there is read afresh)
      for (const p of [...stats.keys()]) if (p.startsWith(pre) && !p.slice(pre.length).includes('\\')) { old.set(p, stats.get(p)); stats.delete(p); }
      for (const e of r) {
        const p = ((rel ? rel + '\\' : '') + e.name).toUpperCase(), o = old.get(p);
        if (o && (o.size !== e.size || o.mtime !== e.mtime)) files.delete(p);
        stats.set(p, e);
      }
      for (const p of old.keys()) if (!stats.has(p)) files.delete(p);
      lists.set(k, r); refresh(); return r;
    });
  };
  const list = rel => { const t = asked.get(rel.toUpperCase()); if (!t || performance.now() - t >= 2000) listNow(rel); };
  const readFile = rel => {
    const k = rel.toUpperCase(); if (files.has(k)) return Promise.resolve(files.get(k));
    if (!reading.has(k)) reading.set(k, call('readAll', [rel]).then(b => { reading.delete(k); if (b instanceof Uint8Array) files.set(k, b); return files.get(k) || null; }));
    return reading.get(k);
  };
  // a file, or a folder and everything in it (only what it lists: `deep` false), read into the shell's copy
  const ready = async (rel, deep = true) => {
    if (rel && !stats.has(rel.toUpperCase())) await listNow(parent(rel));
    const e = rel ? stats.get(rel.toUpperCase()) : { dir: true }; if (!e) return;
    if (!e.dir) { await readFile(rel); return; }
    const l = (await listNow(rel)) || [];
    if (deep) for (const x of l) await ready((rel ? rel + '\\' : '') + x.name);
  };
  const later = (op, args, then) => call(op, args).then(() => { if (then) then(); refresh(); });
  // what the shell changes shows in its copy at once, so what it does next sees it (a copy into a folder it just
  // made); the folder's listing from the machine follows
  const addTo = (prel, e) => { const pk = prel.toUpperCase(), l = lists.get(pk); if (l) lists.set(pk, [...l.filter(x => x.name.toUpperCase() !== e.name.toUpperCase()), e]); };
  const drop = rel => {
    const k = rel.toUpperCase(), pk = parent(rel).toUpperCase(), name = rel.split('\\').pop().toUpperCase();
    for (const m of [stats, files, lists]) for (const p of [...m.keys()]) if (p === k || p.startsWith(k + '\\')) m.delete(p);
    const l = lists.get(pk); if (l) lists.set(pk, l.filter(x => x.name.toUpperCase() !== name));
  };
  const done = rel => () => { asked.delete(parent(rel).toUpperCase()); list(parent(rel)); };
  const handle = h => { const o = handles.get(h); if (!o) throw new W95FS.FSError(6, key); return o; };
  const grow = (o, n) => { if (n > o.data.length) { const d = new Uint8Array(n); d.set(o.data); o.data = d; } };
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
    ready,
    // (fs.js has seen the file there, or is creating it)
    open: (rel, f) => {
      const k = rel.toUpperCase(), there = stats.get(k);
      let data;
      if (f.trunc || !there) data = new Uint8Array(0);
      else if (files.has(k)) data = f.write ? files.get(k).slice() : files.get(k);
      else { readFile(rel).then(refresh); throw new W95FS.FSError(21, rel); }   // (not read yet: not ready until it is)
      const h = nextH++; handles.set(h, { rel, k, data, dirty: !!f.write && (!!f.trunc || !there) }); return h;
    },
    read: (h, pos, n) => handle(h).data.slice(pos, pos + n),
    write: (h, pos, b) => { const o = handle(h); grow(o, pos + b.length); o.data.set(b, pos); o.dirty = true; },
    truncate: (h, n) => { const o = handle(h); if (n < o.data.length) o.data = o.data.slice(0, n); else grow(o, n); o.dirty = true; },
    size: h => handle(h).data.length,
    close: h => {
      const o = handles.get(h); handles.delete(h); if (!o || !o.dirty) return;
      const now = Date.now(), e = { attrs: 0x20, ctime: now, short: '', ...(stats.get(o.k) || {}), name: o.rel.split('\\').pop(), dir: false, size: o.data.length, mtime: now, atime: now };
      files.set(o.k, o.data); stats.set(o.k, e); addTo(parent(o.rel), e);
      later('writeAll', [o.rel, o.data], done(o.rel));
    },
    mkdir: rel => {
      const now = Date.now(), e = { dir: true, size: 0, attrs: 0x10, ctime: now, mtime: now, atime: now, name: rel.split('\\').pop(), short: '' };
      stats.set(rel.toUpperCase(), e); lists.set(rel.toUpperCase(), []); addTo(parent(rel), e);
      later('mkdir', [rel], done(rel));
    },
    rmdir: rel => { drop(rel); later('rmdir', [rel], done(rel)); },
    unlink: rel => { drop(rel); later('unlink', [rel], done(rel)); },
    rename: (a, b) => {
      const e = stats.get(a.toUpperCase()), data = files.get(a.toUpperCase());
      drop(a); drop(b);
      if (e) { const m = { ...e, name: b.split('\\').pop() }; stats.set(b.toUpperCase(), m); addTo(parent(b), m); if (data) files.set(b.toUpperCase(), data); }
      later('rename', [a, b], () => { done(a)(); done(b)(); });
    },
    setAttrs: (rel, a) => later('setAttrs', [rel, a]), setTime: (rel, ms) => later('setTime', [rel, ms]),
    space: () => { if (performance.now() - spaceAt > 5000) { spaceAt = performance.now(); call('space', []).then(r => { if (r) { space = r; refresh(); } }); } return space; },
  };
}
/** a network path read into the shell's copy (netCache) for the shell's own reads of it that follow; at once for any
 *  other path */
const netReady = (path, deep = true) => { let r = null; try { r = fs.remoteAt(path); } catch (_) { /* not a path */ } return r && r.b.ready ? r.b.ready(r.rel, deep) : Promise.resolve(); };
const netPath = path => { try { const r = fs.remoteAt(path); return !!(r && r.b.ready); } catch (_) { return false; } };
/** MPR's export `name` called on a thread of the system's machine (its dialogs run there as the process's own), with
 *  dword or string arguments; resolves to what it returns */
function netCall(name, args = []) { const a = netMachine(); return a ? a.cmd('netCall', [name, args]) : Promise.resolve(null); }
/** fs.js's drives as MPR has them connected: one for each drive letter with a connection (WNetGetConnectionA), none for
 *  one without; the other machines' drives follow */
function syncNetDrives() {
  const a = netMachine(); if (!a) return Promise.resolve();
  return a.cmd('netConnections').then(list => {
    list = list || [];
    for (let c = 65; c <= 90; c++) {
      const L = String.fromCharCode(c), v = fs.vols.get(L); if (v && (!v.remote || v.host)) continue;   // (a host share's drive is the page's, not MPR's)
      const x = list.find(y => y.letter === L), unc = x && x.unc;
      if (v && (!unc || v.unc.toUpperCase() !== unc.toUpperCase())) fs.unmount(L);
      if (unc && (!v || v.unc.toUpperCase() !== unc.toUpperCase())) fs.mount(L, { remote: netCache(a, L), unc, label: unc.split('\\').pop() || '' });
    }
    netMounts = list; for (const m of machineWorkers) m.worker.postMessage({ t: 'netmounts', list });
  }).catch(e => console.warn('[net] connections', e && e.message));   // (the system's machine gone: the drives stay as they were)
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
  const a = netMachine();
  if (!a || netUp !== a) { netBoot(); return null; }   // not yet: the network is up for the next time
  return netCache(a, unc);
};
// the network as the shell first needs it (Network Neighborhood, Map Network Drive, or connections to restore as it
// boots): MPR up in the system's machine, which logged on as it booted, and the remembered connections made again.
// Once for each start of the system's machine
let netBooting = null, netUp = null;
function netBoot() {
  if (!((window.W95SYSTEM || {}).net || {})['MPR.DLL']) return null;
  if (netUp && netUp === sysApp && netUp.alive) return Promise.resolve(netUp);
  return netBooting || (netBooting = (async () => {
    const a = await startSystem(); if (!a || !(await a.mprLoaded())) return null;
    await netCall('WNetRestoreConnectionA', [0, 0]);
    await syncNetDrives(); netUp = a; fs.uncs.clear(); return a;   // (a share asked for before: reached now)
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
/** connections MPR remembers (HKCU\Network\Persistent): the shell logs on as it boots to make them again; otherwise
 *  when it first needs the network */
const netRemembered = () => W95Win32.regKids('hkcu\\network\\persistent').some(k => W95Win32.regGet('hkcu\\network\\persistent\\' + k, 'RemotePath') !== undefined);
/** at boot, with connections to restore: once the desktop is drawn and the page has loaded */
function netBootLater() {
  const go = () => setTimeout(() => { if (netRemembered()) netBoot(); }, 100);   // after the desktop's first frames
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
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
    if (generation !== previewGeneration || !app || !app.alive) return;
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
  const txt = msgApp && msgApp.txt;
  if (txt) { drawTextScreen(txt); return; }
  if (screen === 'dos' && pc) { const fr = pc.m.vgaFrame && pc.m.vgaFrame(); if (fr) drawIndexed(fr.px, fr.w, fr.h, fr.pal); else drawTextScreen(pcText()); setTimeout(dirty, fr ? 60 : 250); return; }
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
  // (the monitor shows the system's machine; without it there is no picture, only the fault that ended it: the page
  // draws no desktop or taskbar of its own)
  if (sa) sa.scanToCanvas(); else fill(0, 0, W, H, '#000');
  // a screen saver running full screen on the machine is topmost: the shell's own windows, menus and tips stay under it
  if (sa && sa.snap && sa.snap.list.some(n => /^WindowsScreenSaverClass$/i.test(n.cls || '') && !n.preview)) { const na = pointerApp(mouse.x, mouse.y); if (na) drawSprite(na); return; }
  const m = modal();
  for (const w of windows) if (!(sa && w.app === sa && !w.win32) && !w.min && !(m && m.dim && w === m)) w.draw();
  if (m && m.dim) { ctx.fillStyle = PAT.dim; ctx.fillRect(0, 0, W, H); m.draw(); }
  for (const mm of menus) drawMenu(mm);
  if (drag) xorFrame(drag.r, drag.t);
  if (tip) {
    const tw = textW(tip.text) + 6, tx = clamp(tip.x, 0, W - tw), ty = tip.y;
    fill(tx, ty, tw, 17, K.tip); edge(tx, ty, tw, 17, K.dk, K.dk); text(tip.text, tx + 3, ty + 2);
  }
  const cur = cursorAt(mouse.x, mouse.y);
  for (const a of nativeApps) if (a.ov && a.alive && a !== sa) ctx.drawImage(a.ov, 0, 0);
  drawShellOverlays();
  if (cur === 'none') { const na = pointerApp(mouse.x, mouse.y); if (na) drawSprite(na); }
  else drawCursor(cur);
  drawPeers();
}
// ---- the shell's overlays: drawn over the machine's screen by the page, in Windows 98's look, with the shell's own
// font and bevels (no program of the machine's: they take no input and need nothing of USER). The first is the
// machine's speed meter (script API `speedMeter(true)`): how much of each 8 s of the wall's time the system's machine
// spends running its threads (worker.js switchMs.run, cmd 'views'), as Windows 98's smooth progress bar, and how far
// its own clock moves meanwhile (cmd 'now', which braid.speed stretches)
const shellOverlays = new Map();
function drawShellOverlays() { for (const o of shellOverlays.values()) o.draw(); }
const SPEED_WINDOW = 8000;
function speedMeter(on) {
  const had = shellOverlays.get('speed');
  if (!on) { if (had) { clearInterval(had.timer); shellOverlays.delete('speed'); dirty(); } return false; }
  if (had) return true;
  const o = { samples: [], run: null, mach: null };
  o.tick = async () => {
    const a = sysApp; if (!a || !a.alive) { o.run = null; dirty(); return; }
    let v, now; try { [v, now] = await Promise.all([a.cmd('views'), a.cmd('now')]); } catch (_) { return; }
    const t = performance.now(), s = o.samples; s.push([t, v && v.switchMs ? v.switchMs.run : 0, now || 0]);
    while (s.length > 1 && t - s[0][0] > SPEED_WINDOW) s.shift();
    if (s.length > 1) { const [w0, r0, m0] = s[0], [w1, r1, m1] = s[s.length - 1], k = SPEED_WINDOW / (w1 - w0); o.run = (r1 - r0) * k / 1000; o.mach = (m1 - m0) * k / 1000; }
    dirty();
  };
  o.draw = () => {
    const w = 200, h = 78, x = W - w - 6, y = 6, cy = y + 3, ch = 18;
    fill(x, y, w, h, K.face); frameRaised(x, y, w, h);
    // (the caption: Windows 98's gradient from the active caption's colour to its second one, the text bold in white)
    const g = ctx.createLinearGradient(x + 3, 0, x + w - 3, 0); g.addColorStop(0, '#000080'); g.addColorStop(1, '#1084d0');
    ctx.fillStyle = g; ctx.fillRect(x + 3, cy, w - 6, ch);
    text('Machine Speed', x + 7, cy + 3, K.hl, true);
    text('Turbo', x + 10, y + 28);
    const bx = x + 10, by = y + 44, bw = w - 20, bh = 14;
    fill(bx, by, bw, bh, K.face); edge(bx, by, bw, bh, K.sh, K.hl);   // (Windows 98's progress bar: a one-pixel sunken edge)
    if (o.run !== null) fill(bx + 2, by + 2, Math.round((bw - 4) * Math.min(1, o.run / 8)), bh - 4, K.sel);
    const l = o.run === null ? (sysApp && sysApp.alive ? '...' : 'No system machine') : `${o.run.toFixed(1)} s run`, r = o.mach === null ? '' : `${o.mach.toFixed(1)} s machine`;
    text(l, bx, y + 61); if (r) text(r, bx + bw - textW(r), y + 61);
  };
  o.timer = setInterval(o.tick, 1000); o.tick();
  shellOverlays.set('speed', o); dirty();
  return true;
}
/** this machine's own Windows Logon recorded another user (Network\Logon's user name: Shut Down's "Close all programs
 *  and log on as a different user", then the logon form): in a shared session, the page goes to that person's
 *  session (their own; Guest's the shared one), as Windows logs on there. Another person's change is no logon here */
function logonChanged(o) {
  const S = window.W95Shared, H = window.W95HOST;
  if (!S || !H || !H.shared || !o || o.op !== 'set' || o.path !== 'hklm\\network\\logon' || String(o.name).toLowerCase() !== 'username') return false;
  const v = o.value && o.value.data ? W95FS.decode(o.value.data).replace(/\0.*$/, '') : String(o.value || '');
  if (!v || v.toLowerCase() === String(S.logon.user).toLowerCase()) return false;
  S.logOff(v); return true;
}
// ---- the other people in a shared session, in the OS's own GUI: each one's icon in the taskbar's notification area
// (SESSTRAY.EXE, session-tray.js), their pointer with their name in their colour, a notice by the notification area
// as one comes or goes, and their pointer marked when Where Is is chosen from their icon's menu
const PEER_COLORS = [[0, 0, 128], [128, 0, 0], [0, 128, 0], [128, 0, 128], [0, 128, 128], [128, 128, 0], [0, 0, 255], [255, 0, 0]];
/** a person's colour, by their machine: the same on every machine */
function peerColor(client) { let h = 0; for (const ch of String(client)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PEER_COLORS[h % PEER_COLORS.length]; }
const peerNotes = [], peerAt = new Map(); let peerSeen = null, peerWhere = null, peerFollow = null, trayStarted = false;
function peopleChanged(list) {
  const now = Date.now(), names = new Map(list.map(p => [p.client, p.user || 'Guest']));
  if (peerSeen) {
    for (const [c, u] of names) if (!peerSeen.has(c)) peerNotes.push({ text: `${u} joined the session`, until: now + 5000 });
    for (const [c, u] of peerSeen) if (!names.has(c)) peerNotes.push({ text: `${u} left the session`, until: now + 5000 });
    if (peerNotes.length) setTimeout(dirty, 5100);
  }
  peerSeen = names; trayPeople(); dirty();
}
/** who is here, for the notification area's icons; SESSTRAY.EXE started the first time, once the shell is up */
function trayPeople() {
  const S = window.W95Shared, a = sysApp; if (!S || !a || !a.alive || !osCaught) return;
  // (with each person's windows: the session's objects whose origin is their machine, by title; and the session's
  // owner, whose profile every settings change goes to: a name's own session is theirs, Guest's the shared one)
  const wins = client => [...S.world()].filter(([, v]) => v && v.origin === client && v.folder === undefined).map(([id, v]) => ({ id, title: v.title || id }));
  const owner = /^guest$/i.test(S.logon.session) || S.logon.session === 'guest' ? 'Guest' : (S.logon.session === S.ownSession(S.logon.user) ? S.logon.user : S.logon.session);
  // (and the line's moments, newest first, for the Braid icon's Travel To: the session's, which a choice there travels
  // every machine to, braid-page.js viaLine)
  const moments = braid ? braid.along().filter(m => !/^(t|live)\d+$/.test(m.name)).slice(-20).reverse().map(m => ({ name: m.name, anchored: !!m.anchored, broken: m.verdict === 'broken' })) : [];
  a.cmd('tray', [S.people().map(p => ({ client: p.client, user: p.user || 'Guest', color: peerColor(p.client), wins: wins(p.client) })), owner, moments]).catch(() => {});
  if (!trayStarted) { trayStarted = true; a.cmd('run', ['SESSTRAY.EXE']).catch(() => { trayStarted = false; }); }
}
// the pointers of the other people in a shared session (shared.js), each an arrow with their name beside it in their
// colour, over the screen as this person's own is
function drawPeers() {
  const S = window.W95Shared; if (!S || !window.W95HOST || !window.W95HOST.shared) return;
  const c = CUR.arrow, now = Date.now();
  for (const q of S.people()) {
    // (a person whose stroke is being drawn here: their pointer where the line has got to, so the two meet)
    const at = peerAt.get(q.client), p = at && now - at.t < 1000 ? { ...q, x: at.x, y: at.y } : q;
    if (p.x == null || p.y == null) continue;
    const rgb = `rgb(${peerColor(p.client).join(',')})`;
    if (peerWhere && peerWhere.client === p.client && now < peerWhere.until) {   // (Where Is: rings round it, closing in)
      const k = (peerWhere.until - now) % 750 / 750;
      ctx.save(); ctx.strokeStyle = rgb; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, 10 + 30 * k, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
      requestAnimationFrame(dirty);
    }
    if (peerFollow === p.client) {   // (Follow: a ring round it, kept, until Follow is chosen again)
      ctx.save(); ctx.strokeStyle = rgb; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, 16, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
    }
    // (their pointer as their Windows shows it to them: the image they sent with it, else the arrow)
    const img = p.cur && S.cursor(p.cur), bits = img && peerBits(p.cur, img), hot = p.hot || [0, 0];
    if (bits) drawSpriteBits(bits, p.x - hot[0], p.y - hot[1]);
    else if (c) ctx.drawImage(c.i, p.x - c.hx, p.y - c.hy);
    const label = p.user || 'Guest', tw = textW(label) + 10, tx = clamp(p.x + 12, 0, W - tw), ty = clamp(p.y + 18, 0, H - 17);
    fill(tx, ty, tw, 17, K.tip); fill(tx, ty, 4, 17, rgb); edge(tx, ty, tw, 17, K.dk, K.dk); text(label, tx + 7, ty + 2);
  }
  // (a window another person is changing: its outline and their name on its title bar, in their colour)
  for (const [id, a] of peerActs) {
    if (a.until <= now) { peerActs.delete(id); continue; }
    const who = S.people().find(p => p.client === a.client); if (!who) continue;
    const rgb = `rgb(${peerColor(a.client).join(',')})`, label = who.user || 'Guest', tw = textW(label) + 6;
    ctx.save(); ctx.strokeStyle = rgb; ctx.lineWidth = 3; ctx.strokeRect(a.x - 1.5, a.y - 1.5, a.w + 3, a.h + 3); ctx.restore();
    const tx = clamp(a.x + a.w - tw - 60, a.x, W - tw), ty = clamp(a.y + 3, 0, H - 17);
    fill(tx, ty, tw, 17, rgb); text(label, tx + 3, ty + 2, '#fff');
  }
  // (the notices: by the notification area, above the taskbar, newest lowest)
  for (let i = peerNotes.length; i--;) if (peerNotes[i].until <= now) peerNotes.splice(i, 1);
  peerNotes.slice(-3).reverse().forEach((n, i) => {
    const tw = textW(n.text) + 6, tx = W - tw - 4, ty = H - 32 - 19 * (i + 1);
    fill(tx, ty, tw, 17, K.tip); edge(tx, ty, tw, 17, K.dk, K.dk); text(n.text, tx + 3, ty + 2);
  });
}
// the display adapter's hardware cursor: the sprite the program's display driver loaded and placed, overlaid on the
// whole screen as the CRTC overlays it on scanout (2 bits a pixel: bit 1 keeps the screen, bit 0 inverts it), a
// column of it to each pixel clock (cpp of them to a screen pixel at high color). The screen under it, for the pixels
// that invert it, comes from the machine's scanned screen, never read back from the page's canvas (a read back makes
// every later draw of the screen a copy through main memory, slower the larger the screen)
const spriteCv = mkc(64, 64), spriteCx = spriteCv.getContext('2d'), spriteImg = spriteCx.createImageData(64, 64), sprite32 = new Uint32Array(spriteImg.data.buffer);
function drawSprite(app) {
  let sp; try { sp = app.sprite(); } catch (e) { return; }
  if (!sp) return;
  const at = app.pointerAt ? app.pointerAt(sp) : null;
  drawSpriteBits(sp, at ? at[0] : sp.x, at ? at[1] : sp.y, app);
}
// (another person's pointer image, decoded once per key: the sprite's bits as sent)
const peerBitsCache = new Map();
function peerBits(k, img) {
  let b = peerBitsCache.get(k);
  if (!b) { try { const s = atob(img.b64), u = new Uint8Array(s.length); for (let i = 0; i < u.length; i++) u[i] = s.charCodeAt(i); b = { px: img.px, py: img.py, cpp: img.cpp, row: img.row, bits: u }; } catch (_) { b = false; } peerBitsCache.set(k, b); }
  return b || null;
}
/** a sprite's bits (px, py, cpp, row, bits) drawn with its top-left at x, y; app: the machine whose screen is under it */
function drawSpriteBits(sp, x, y, app = sysApp) {
  const cpp = sp.cpp || 1, w = Math.min(Math.floor((64 - sp.px) / cpp), W - x), h = Math.min(64 - sp.py, H - y);
  if (w <= 0 || h <= 0 || x < 0 || y < 0) return;
  const scr = app && app.d32, sw = (app && app.sw) || 0, sh = (app && app.sh) || 0;
  for (let j = 0; j < h; j++) {
    const row = (sp.py + j) * sp.row;
    for (let i = 0; i < w; i++) {
      const p = sp.px + i * cpp, v = sp.bits[row + (p >> 2)] >> ((p & 3) * 2) & 3;
      sprite32[j * 64 + i] = v === 2 ? 0 : v === 0 ? 0xff000000 : v === 1 ? 0xffffffff
        : scr && x + i < sw && y + j < sh ? (0xff000000 | ~scr[(y + j) * sw + x + i]) >>> 0 : 0xffffffff;
    }
  }
  spriteCx.putImageData(spriteImg, 0, 0, 0, 0, w, h);
  ctx.drawImage(spriteCv, 0, 0, w, h, x, y, w, h);
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
  const state = n => { try { app.cmd('closeState', [n]); } catch (e) { console.error(e); } };
  state(2);
  if (windows.some(w => w.title === 'Close Program')) { state(3); return; }
  const bu = dialogBaseUnits(), px = v => Math.round(v * bu.x / 4), py = v => Math.round(v * bu.y / 8);
  // [Not responding]: USER's own test (USER32's IsHungThread: the thread's queue has not been read for its hung-app
  // time) on the thread that owns the window
  // (a machine in a worker answers for its windows when asked: its answers arrive as the dialog is up)
  const hungRemote = new Map();
  for (const m of new Set(windows.filter(w => w.native && w.app).map(w => w.app))) {
    const ws = [...m.wins.values()]; m.cmd('hung', [ws.map(w => w.hwnd)]).then(f => { if (f) ws.forEach((w, i) => hungRemote.set(w, f[i])); dirty(); });
  }
  const hung = w => !!hungRemote.get(w);
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
/** the details KERNEL32 writes for a fault (win32.js faultText, the system's machine's own fault dialog's too) */
const faultDetails = (prog, f) => (k32() ? W95Win32.faultText(k32(), prog, f) : '');
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
    win.message = { type: 'error', text: details.split(/\n\s*\n|\nRegisters:|\nEAX=/)[0] };   // (what faulted and where, for scripts: window.open)
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
/** VWIN32's fatal-exception message for fault `f`, its inserts as VMM's message formatter takes them (%<insert><width>x,
 *  %<insert>s) */
function fatalText(f) {
  const fmt = vwin32Text(!!f.vxd); if (!fmt) return null;
  const vals = [f.n, f.cs, f.eip, f.vxd ? `${f.vxd}(01) + ${(f.offset >>> 0).toString(16).toUpperCase().padStart(8, '0')}` : ''];
  return fmt.replace(/%(\d)(\d?)([xs])/g, (m, k, w, c) => c === 's' ? String(vals[+k - 1]) : (vals[+k - 1] >>> 0).toString(16).toUpperCase().padStart(+w || 0, '0'));
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
// (a machine stopped by a fault, its fault dialog up, moves no pointer: the page's own is drawn over it, not the
// machine's frozen one where the mouse last left it)
const pointerApp = (x, y) => { const a = cap ? cap.native || null : !menus.length && !modal() ? nativeAt(x, y) : null; return a && a.alive && !a.stopped ? a : null; };
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
function winAt(x, y) { const sa = monApp(); for (let i = windows.length - 1; i >= 0; i--) if ((windows[i].app !== sa || windows[i].win32) && !windows[i].min && !(windows[i].native && !windows[i].app.alive) && inR(windows[i], x, y)) return windows[i]; return null; }   // (a window of a machine that has ended takes no pointer)
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
  shareInput({ t: 'down', x, y });
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
  shareInput({ t: 'move', x, y });   // (where it is, to the others in the session, each move as it happens)
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
  shareInput({ t: 'up', x, y });
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
kbd.addEventListener('input', () => { const s = kbd.value; kbd.value = ''; shareInput({ t: 'text' }); typed(s); });
function typed(s) {
  { const a = nativeFocus(); if (a) { lastInput = performance.now(); a.typeText(s.replace(/\r/g, '')); return; } }
  for (const ch of s.replace(/\r/g, '')) handleKey({ key: ch === '\n' ? 'Enter' : ch, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
}
// the keys go to USER while one of a native program's windows is active and the shell has nothing open over it
// (or, the system's machine being the screen, while no window of the page's own is active)
const nativeFocus = () => (!menus.length && !ren && !modal() && screen === 'desktop' ? (fullSaver && fullSaver.app && fullSaver.app.alive ? fullSaver.app : active && active.native && active.app.alive ? active.app : !(active && windows.includes(active)) ? monApp() : null) : null);
// the keyboard reaches VKD before anything: the system in message mode (a blue screen) takes every key, and a hot key
// goes to the native system with the focus, else to one that is frozen, else to any
const vkdApp = () => msgApp || nativeFocus() || [...nativeApps].find(a => a.alive && a.proc && a.proc.win16Held) || [...nativeApps].find(a => a.alive);
window.addEventListener('blur', () => { for (const a of nativeApps) if (a.alive && a.releaseMods) a.releaseMods(); });
window.addEventListener('keyup', e => { shareKey(); keyUp(e); });
window.addEventListener('keydown', e => { shareKey(); keyDown(e); });
function keyUp(e) { if (devtoolsKey(e)) return; const v = vkdApp(); if (v && v.vkd(e, true)) { e.preventDefault(); return; } const a = nativeFocus(); if (a) { e.preventDefault(); if (e.keyCode) a.key(e, true); } }
// the browser's own DevTools key (Cmd/Ctrl+Alt+I, Ctrl+Shift+I, F12) is not the machine's: it goes to the browser
// untouched, before anything here sees it (the Windows 95 app opens its DevTools on it itself, electron/main.js)
const devtoolsKey = e => (e.code === 'KeyI' && e.altKey && (e.metaKey || e.ctrlKey)) || (e.code === 'KeyI' && e.ctrlKey && e.shiftKey) || e.code === 'F12';
// whether DevTools are open: told by the app (W95HOST.devtools), else guessed from the window's chrome. The machine is
// told as a registry value (HKLM\...\CurrentVersion\Debug, DevTools), which the Debug Monitor and scripts can read
let devtoolsOpen = false;
const listeners = new Map();   // (win95.on's: before devtoolsState runs at load, which emits)
function devtoolsState(open) {
  if (open === devtoolsOpen) return;
  devtoolsOpen = open;
  try { W95Win32.regSet('hklm\\software\\microsoft\\windows\\currentversion\\debug', 'DevTools', { type: 4, data: Uint8Array.of(open ? 1 : 0, 0, 0, 0), name: 'DevTools' }); } catch (_) {}
  W95Win32.log('info', 'page', open ? 'DevTools opened' : 'DevTools closed');
  emit('devtools', { open });
}
{
  const H = window.W95HOST && window.W95HOST.devtools;
  if (H) { H.on(open => devtoolsState(!!open)); if (H.open !== undefined) devtoolsState(!!H.open); }   // (a browser tab tells nothing: false there)
  // (the value as of this load: a disk kept from a load where they were open says nothing about now)
  try { W95Win32.regSet('hklm\\software\\microsoft\\windows\\currentversion\\debug', 'DevTools', { type: 4, data: Uint8Array.of(devtoolsOpen ? 1 : 0, 0, 0, 0), name: 'DevTools' }); } catch (_) {}
}
function keyDown(e) {
  if (devtoolsKey(e)) return;
  if (screen === 'dos' && pc) { lastInput = performance.now(); if (pcKey(e)) e.preventDefault(); return; }
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
}
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
    // (a screen larger than the page, one the machine kept when asked for the page's: its middle shown, as it is in the middle of a larger page)
    cv.style.marginLeft = ((innerWidth - cw) >> 1) + 'px'; cv.style.marginTop = ((innerHeight - ch) >> 1) + 'px';
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
pcBoot();
loadTaskbar();
// (the shell's desktop folder: Windows 95's; a disk of Windows 3.1 has none, its Program Manager is its shell)
desk.src = fs.exists(DESKTOP_DIR) ? new FsSource(DESKTOP_DIR) : null;
fs.on(() => dirty());
Promise.all(ready).then(() => { resize(); kbd.focus(); dirty(); });
// ---------------------------------------------------------------- events
// What happened in the shell, for scripts: win95.on(type, fn) in the page, and over the DevTools protocol to a
// client that registered the binding __w95event (Runtime.addBinding), as JSON { type, ...data }.
// Window, menu and screen saver events come from comparing the shell's state after each change; file system
// events come straight from the file system.
// (every event but the file system's and a session's sync, since the last win95.outcome took them: an action's answer
// carries what happened since the one before, whenever it came, so nothing that came between is lost)
// (kept on the window: emit runs from the page's first lines, before a module constant here would exist)
function emit(type, data = {}) {
  const ev = { type, ...data, t: Date.now() };
  if (!/^(sync|fs)\./.test(type)) {
    const j = window.W95Journal || (window.W95Journal = []), keys = ['type', 'title', 'modal', 'screen', 'kind', 'text', 'path', 'code', 'why', 'machine', 'menus'];
    j.push(Object.fromEntries(Object.entries(ev).filter(([k]) => keys.includes(k)))); if (j.length > 400) j.shift();
  }
  if (DEBUG && /^sync\./.test(type)) { const l = window.W95SYNCLOG || (window.W95SYNCLOG = []); l.push(ev); if (l.length > 200) l.shift(); }   // (a shared session's sync, from the page's start: ?debug=1)
  for (const k of [type, type.split('.')[0], '*']) for (const fn of listeners.get(k) || []) { try { fn(ev); } catch (e) { console.error(e); } }
  if (typeof window.__w95event === 'function') { try { window.__w95event(JSON.stringify(ev)); } catch (_) { /* client gone */ } }
}
// The system failing: a console error or an uncaught exception of the page's, a worker's error (its console.error), a
// fault a machine reports (braid.fault). Each is the event 'system.fail' ({ kind, text }), and every wait of the API
// (next, an element's lookup) ends on it, rejecting with it: a script waiting for a window does not sit on a
// system that has gone wrong
let lastFail = null;
const systemFail = (kind, text) => { lastFail = { kind, text: String(text).slice(0, 600), at: performance.now() }; emit('system.fail', { kind, text: lastFail.text }); };
{
  const ce = console.error.bind(console); let inside = false;
  console.error = (...a) => { ce(...a); if (inside) return; inside = true; try { systemFail('console', a.map(x => (x && x.stack) || (typeof x === 'object' ? (() => { try { return JSON.stringify(x); } catch (_) { return String(x); } })() : String(x))).join(' ')); } finally { inside = false; } };
  window.addEventListener('error', e => systemFail('exception', (e.error && e.error.stack) || e.message));
  window.addEventListener('unhandledrejection', e => systemFail('rejection', (e.reason && e.reason.stack) || e.reason));
}
const failText = e => `${e.kind}: ${e.text || (e.fault && (e.fault.why || e.fault.module)) || ''}`;
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

// ---------------------------------------------------------------- a session shared with others (shared.js)
// The OS is the session's world (tools/sessions.py). Every machine runs its own Windows on the session's C: and
// registry; a person's action runs on their own machine only, and what it changes in the OS goes to every other
// machine as the state of the OS's objects, which each sets its own OS to:
// - the objects: each program's top-level window (ne16.js osWorld), by an id every machine gives it alike (the
//   program, which of its kind it is, the window's class and which of those), with its program's command line, its
//   place, size and shown state, and its edits', combo boxes' and check boxes' contents
// - this machine's are read after its person's input and whenever its window list changes (osSoon), and the ones
//   that changed go to the others; one set here from another machine's state is not sent back
// - another machine's: a program this machine does not run is started with the same command line; its window is
//   put where the other's is, its controls set to the other's contents (not while this person is typing there); a
//   window gone there is closed here. One that comes up here and the session already has (a program started for
//   another) is set to the session's, not sent as new
// - a machine that joins, or reconnects, is given every object as it is and changes only what differs on it
// Another person's pointer is drawn over this screen (drawPeers); it never moves this machine's mouse
// - a machine joining a running session holds the programs it would start of itself as Windows starts (worker.js
//   holdStartup) until its person first does something on it: the session's are started for it instead
let osWanted = false, osBusy = false, osAgain = false, osHeld = true;
const osSeen = new Map(), osStarting = new Set(), osOpened = new Set();
const osHwnd = new Map(), osRemoteClosed = new Set();   // (each id's window at the last read; the ids closed here under a remote cause, by the machine's own tag)
let osArea = null;   // (this machine's work area at its last read: its screen changing is its own)
const osTries = new Map();   // (the session's programs started here and not up yet: how many times)
// the image this person's pointer shows (USER's cursor, the machine's sprite), keyed by its bits, with its hot spot
// where the pointer is in it: sent with the pointer, once per image, for the others to draw this pointer as it is
let curKeyLast = null, curSprite = null;
function peerCursorOf(x, y) {
  const a = sysApp; if (!a || !a.alive || !a.sprite) return null;
  let sp; try { sp = a.sprite(); } catch (_) { return null; }
  if (!sp || !sp.bits) return null;
  const n = Math.min(sp.bits.length, 64 * sp.row); let h = 2166136261;
  for (let i = 0; i < n; i++) { h ^= sp.bits[i]; h = Math.imul(h, 16777619); }
  h ^= sp.px | sp.py << 6 | sp.cpp << 12 | sp.row << 16; h = Math.imul(h, 16777619) >>> 0;
  const k = h.toString(16);
  // (where the pointer is in the image: USER's cursor less the sprite's place, as the machine reported both together;
  // kept per image, since the page's pointer runs ahead of the sprite)
  const cur = a.scr && a.scr.cur; if (cur) curHot.set(k, [cur.x - sp.x, cur.y - sp.y]);
  const [hx, hy] = curHot.get(k) || [0, 0];
  if (k === curKeyLast && curSprite) return { k, hx, hy };
  curKeyLast = k; curSprite = { px: sp.px, py: sp.py, cpp: sp.cpp, row: sp.row, b64: btoa(String.fromCharCode(...sp.bits.subarray(0, n))) };
  return { k, hx, hy, img: curSprite };
}
const curHot = new Map();
function shareInput(ev) {
  const S = sharedNow(); if (!S) return;
  if (ev.t === 'move') { S.pointer(ev.x, ev.y, peerCursorOf(ev.x, ev.y)); return; }
  if (osHeld && sysApp && sysApp.alive) { osHeld = false; sysApp.cmd('holdStartup', [false]); }
  osSoon();
}
function shareKey() { shareInput({ t: 'key' }); }
/** the OS may have changed: read once the machine has run on (its next frame: RemoteApp.frame) */
function osSoon() { if (sharedNow()) osWanted = true; }
function osFrame() { if (osWanted) { osWanted = false; osRead(); } }
/** this machine's OS objects, by their session ids */
async function osLocal() {
  const a = sysApp; if (!a || !a.alive) return null;
  const got = await a.cmd('world'); if (!got) return null;
  const { list, area, closed } = got;
  // (a program's instances counted by its command line: RUNDLL32 with DESK.CPL is another object than RUNDLL32 with
  // SYSDM.CPL, whichever a machine started first)
  const prog = w => `${w.path}\n${w.cmd}`;
  const byPath = new Map(); for (const w of list) (byPath.get(prog(w)) || byPath.set(prog(w), new Set()).get(prog(w))).add(w.pid);
  const out = new Map(), count = new Map();
  for (const w of [...list].sort((p, q) => p.pid - q.pid || p.hwnd - q.hwnd)) {
    const place = { x: w.x, y: w.y, w: w.w, h: w.h, min: !!w.min, max: !!w.max };
    if (w.folder) {   // (one of Explorer's folders: known by its title, opened as the shell opens it)
      const kind = `FOLDER/${w.title}`, k = count.get(kind) || 0; count.set(kind, k + 1);
      out.set(`${kind}#${k}`, { hwnd: w.hwnd, v: { folder: osFolder(w.title), cls: w.cls, title: w.title, ...place, ctrls: {} } });
      continue;
    }
    const n = [...byPath.get(prog(w))].sort((p, q) => p - q).indexOf(w.pid), base = basename(w.path).toUpperCase();
    const args = String(w.cmd || '').replace(/^\s*("[^"]*"|\S+)\s*/, '');
    const kind = `${base}${args ? ' ' + args : ''}#${n}/${w.cls}`, k = count.get(kind) || 0; count.set(kind, k + 1);
    // (a control the machine could not ask now, null: as it was last read here, else left out)
    const was = osSeen.get(`${kind}#${k}`), ctrls = {};
    for (const [c, val] of Object.entries(w.ctrls)) if (val !== null) ctrls[c] = val; else if (was && was.ctrls && c in was.ctrls) ctrls[c] = was.ctrls[c];
    // (a derived object, RUNDLL32 running a Control Panel applet: its command line and controls are the session's, its
    // window's place each machine's own; osclass.js program)
    const derived = W95OSClass.program(w.path, w.cmd) === 'derived';
    out.set(`${kind}#${k}`, { hwnd: w.hwnd, v: { path: w.path, cmd: w.cmd, t0: w.t0 || null, cls: w.cls, title: w.title, ...(derived ? { derived: true } : place), ctrls } });
  }
  out.area = area;
  // (the windows the machine closed under a remote cause, as ids: by the window each id had at the last read, or has now)
  for (const [id, o] of out) osHwnd.set(id, o.hwnd);
  for (const h of closed || []) for (const [id, hw] of osHwnd) if (hw === h) osRemoteClosed.add(id);
  for (const id of [...osHwnd.keys()]) if (!out.has(id) && !osRemoteClosed.has(id)) osHwnd.delete(id);
  return out;
}
const osSame = (p, q) => JSON.stringify(p) === JSON.stringify(q);
/** how a folder window with this title is opened: one of the shell's own folders by its CSIDL (Control Panel,
 *  Printers, Fonts, My Computer, Network Neighborhood, Recycle Bin); else the folder's path (a drive's root from
 *  "(C:)", else the folder of that name on the disks, the one nearest the root), which the shell opens */
function osFolder(title) {
  const t = String(title || '').trim();
  const csidl = { 'control panel': 3, printers: 4, fonts: 0x14, 'my computer': 0x11, 'network neighborhood': 0x12, 'recycle bin': 0x0a }[t.toLowerCase()];
  if (csidl !== undefined) return { csidl };
  const drive = /\(([A-Za-z]):\)$/.exec(t); if (drive) return { path: drive[1].toUpperCase() + ':\\' };
  let best = null;
  const walk = (dir, depth) => {
    let kids; try { kids = fs.readdir(dir); } catch (_) { return; }
    for (const k of kids) {
      if (!k.isDir) continue;
      if (k.name.toLowerCase() === t.toLowerCase() && (!best || k.path.length < best.length)) best = k.path;
      if (depth < 4) walk(k.path, depth + 1);
    }
  };
  walk('C:\\', 0);
  return best ? { path: best } : null;
}
async function osRead() {
  if (osBusy) { osAgain = true; return; }
  osBusy = true;
  try {
    const S = sharedNow(), local = await osLocal(); if (!S || !local) return;
    // (what to send and what to set here: oslogic.js read. A change of this machine's screen is its own: the session's
    // places set again, fitted to it, nothing sent)
    const r = W95OSLogic.read({ world: S.world(), local: new Map([...local].map(([id, o]) => [id, o.v])), seen: osSeen, starting: osStarting,
      remoteClosed: osRemoteClosed, area: local.area, lastArea: osArea, caught: osCaught });
    osArea = r.area; for (const id of local.keys()) osTries.delete(id);
    for (const [id, v, patch] of r.sends) { S.obj(id, v, patch); emit(v ? 'sync.send' : 'sync.closed', v ? { id, x: v.x, y: v.y } : { id }); }
    for (const [id, v] of r.applies) osApply(id, v, local);
    for (const id of r.retries) { emit('sync.retry', { id }); osApply(id, S.world().get(id), local); }
    for (const id of osOpened) { osOpened.delete(id); if (!local.has(id)) osStarting.delete(id); }   // (a folder opened, not up by now: the next change tries again)
    // (an object up here that the session had: the strokes made into it so far, fed into this copy of it, once; and
    // the strokes that came for any object before its window was here)
    // (not before the window here has the session's size and state: the strokes are offsets from the window as it
    // was there, and a window still to be placed takes them wrong)
    for (const [id] of r.applies) if (!osFed.has(id)) osHistWait.add(id);
    for (const id of osHistWait) if (osFitted(local, id)) { osHistWait.delete(id); osFed.add(id); for (const part of S.inputs().get(id) || []) osStroke(id, part, part.by || 'session', local); }
    for (const [id, list] of osInputWait) if (osFitted(local, id)) { osInputWait.delete(id); for (const [part, by] of list) osStroke(id, part, by, local); }
  } finally { osBusy = false; if (osAgain) { osAgain = false; osRead(); } }
}
/** another machine's state of an object, set on this one */
async function osApply(id, v, local, by) {
  local = local || await osLocal(); if (!local) return;
  const mine = local.get(id), a = sysApp;
  if (v == null) {   // (gone there: closed here)
    if (mine) {
      emit('sync.close', { id });   // (the machine marks the window closed under a remote cause itself: cmd 'end', 'close')
      // (its program's only object: the program ended here, as the person there ended it, without asking again; one
      // of several windows of a program, or a folder: closed as its own close box closes it)
      const prog = id.slice(0, id.lastIndexOf('/'));
      if (!mine.v.folder && ![...local.keys()].some(k => k !== id && k.startsWith(prog + '/'))) { a.cmd('end', [mine.hwnd]); return; }
      a.cmd('closeRemote', [mine.hwnd]);
    }
    return;
  }
  if (!mine) {   // (not here: started, with the same command line, or opened as the shell opens it; once, until it is up)
    if (osStarting.has(id)) return;
    if (v.folder !== undefined) {
      if (!v.folder) return;
      osStarting.add(id); emit('sync.start', { id, folder: v.folder });
      // (it could not be: free to try again; it was: tried again if its window has not come by this machine's next
      // window change, as an open sent before the shell could open folders came to nothing. Opening a folder that is
      // open brings its window up, so a second open makes no second window)
      const done = r => { if (!r || r.err || r === false || (typeof r === 'number' && r <= 32)) osStarting.delete(id); else osOpened.add(id); };
      (v.folder.csidl !== undefined ? a.cmd('shellOpenSpecial', [v.folder.csidl]) : a.cmd('shellOpen', [v.folder.path])).then(done, () => osStarting.delete(id));
      return;
    }
    // (one of its program's windows here already, or one closing: its program is running, or the next window it has
    // comes when that one has gone)
    const prog = id.slice(0, id.lastIndexOf('/'));   // (its command line can have a slash in it; its class has none)
    if ([...local.keys()].some(k => k.startsWith(prog + '/'))) return;
    // (started three times and not come: a program that hands its start to one already running, as a single-instance
    // program does, or one that cannot start here; not started again)
    const n = (osTries.get(id) || 0) + 1; if (n > 3) return; osTries.set(id, n);
    osStarting.add(id); emit('sync.start', { id, cmd: v.cmd });
    // (with its clock, as of its start where it was started)
    a.cmd('run', [v.cmd || v.path, v.t0 || null, 'remote']).then(r => { if (!r || r.err) { osStarting.delete(id); emit('sync.failed', { id, cmd: v.cmd, r }); } }, e => { osStarting.delete(id); emit('sync.failed', { id, cmd: v.cmd, err: String(e) }); });
    return;
  }
  // (its place fitted to this machine's screen, its title bar on it: this machine's own adjustment, which it does not
  // send back; seen as it will be here)
  const m = mine.v, f = W95OSLogic.fit(v, local.area); osSeen.set(id, f);
  if (f.x !== undefined && (m.x !== f.x || m.y !== f.y || m.w !== f.w || m.h !== f.h || m.min !== f.min || m.max !== f.max)) {   // (a derived object carries no place)
    emit('sync.place', { id, x: f.x, y: f.y });
    a.cmd('place', [mine.hwnd, f.x, f.y, f.w, f.h, f.min ? 7 : f.max ? 3 : m.min || m.max ? 9 : 0]);
    if (by) peerActing(id, by, f);
  }
  for (const [k, val] of Object.entries(v.ctrls || {})) {
    if (osSame(m.ctrls && m.ctrls[k], val)) continue;
    const [cid, kind] = k.split(':'); emit('sync.control', { id, control: k });
    a.cmd('setCtrl', [mine.hwnd, +cid, kind, val]);
    if (by) peerActing(id, by, f);
  }
}
// ---- the session's input: a person's mouse strokes into an object's window (a button pressed, the moves while it
// is held, its release) go to every machine's copy of the window, as offsets from it, so what the program makes of
// them (a line drawn in Paint, a card moved in Solitaire, a button pressed in Calculator) it makes everywhere. The
// machine records this person's (worker.js recordStroke) and feeds the others' one stroke at a time between this
// person's own (feedStroke); the server keeps each object's for a machine joining, which feeds them into its copy
// once the object is up (osRead). A stroke into a popup of the object's (a menu, a dialog) names the popup by class
// and title, by which each machine finds its own copy of it
const osInputWait = new Map(), osFed = new Set(), osHistWait = new Set();   // (strokes for an object whose window is not here yet; the objects whose history was fed, and those whose history waits for the window's place)
/** this person's stroke, or part of one (the machine's message): to the session, by the object its window is */
function osStrokeOut(m, again) {
  const S = sharedNow(); if (!S) return;
  let id = null; for (const [k, h] of osHwnd) if (h === m.root) { id = k; break; }
  if (!id) { if (!again) osLocal().then(() => osStrokeOut(m, true)).catch(() => {}); return; }   // (a window not read yet: read, then once more)
  const part = { n: m.n, ev: m.ev, done: !!m.done, ...(m.pop ? { pop: m.pop } : {}) };
  S.input(id, part); emit('sync.input', { id, n: m.n, events: m.ev.length, done: !!m.done });
}
/** another machine's stroke into an object, fed into this machine's copy of its window (kept until the window is here) */
/** whether an object's window here has the session's size and state: the strokes are offsets from the window as it
 *  was there, and a window still to be placed would take them wrong (a derived object carries no place: as it is) */
function osFitted(local, id) {
  const m = local.get(id), S = sharedNow(), v = S && S.world().get(id);
  return !!m && (!v || v.x === undefined || (m.v.w === v.w && m.v.h === v.h && !!m.v.max === !!v.max));
}
function osStroke(id, part, by, local) {
  const a = sysApp; if (!a || !a.alive) return;
  if (!local) { osLocal().then(l => osStroke(id, part, by, l || new Map())).catch(() => {}); return; }   // (the machine's windows now: the object's may be new)
  const mine = local.get(id);
  if (!mine || !osFitted(local, id)) { (osInputWait.get(id) || osInputWait.set(id, []).get(id)).push([part, by]); osSoon(); return; }   // (not here, or not placed, yet: fed once it is, osRead)
  a.cmd('stroke', [`${by}:${part.n}`, mine.hwnd, part.pop || null, part.ev || [], !!part.done]).catch(() => {});
  emit('sync.stroke', { id, by, events: (part.ev || []).length, done: !!part.done });
  const S = sharedNow(), v = S && S.world().get(id); if (v && by !== 'session') peerActing(id, by, v);
}
/** another person changed a window here (moved, sized, typed in, checked): its outline in their colour, their name on
 *  its title bar, for a moment after each change */
const peerActs = new Map();
function peerActing(id, client, r) {
  if (r.min || r.x === undefined) return;
  peerActs.set(id, { client, x: r.x, y: r.y, w: r.w, h: r.h, until: Date.now() + 1500 }); dirty(); setTimeout(dirty, 1600);
}
/** every object of the session set on this machine, and its settings made here, as a machine joining (or come back)
 *  does */
async function osCatchUp() {
  const S = sharedNow(), local = await osLocal(); if (!S || !local) return;
  for (const i of S.intents().values()) await osIntent(i);
  for (const [id, v] of S.world()) osApply(id, v, local);
}
/** another machine's intent made here: the same call, on a thread of its own (worker.js 'intent'), as it is made there */
function osIntent(i, reset) {
  emit('sync.intent', { key: i.key });
  // (a mark, anchor or travel on the shared line, anyone's, this person's too, made as it reaches this machine:
  // braid-page.js remote. A travel that set the session's shared state back (`reset`, shared.js) has this machine's
  // copies of the session's objects set to it after its own moment is put back, as a machine joining sets them: even
  // a machine that has no such moment of its own then has the session's state at it)
  if (i.kind === 'braid') return (braid ? Promise.resolve(braid.remote(i)).then(() => { if (reset) return osCatchUp(); }) : Promise.resolve(reset ? osCatchUp() : null)).then(() => trayPeople());   // (the Braid icon's moments, as the line has them now)
  return sysApp && sysApp.alive ? sysApp.cmd('intent', [i]) : null;
}
if (sharedNow()) {
  sharedNow().onObj((id, v, by) => { if (osCaught) osApply(id, v, null, by); });   // (by: the machine whose person did it)
  sharedNow().onIntent((i, by, reset) => { if (osCaught) osIntent(i, reset); });
  sharedNow().onInput((id, part, by) => { if (osCaught) osStroke(id, part, by); else (osInputWait.get(id) || osInputWait.set(id, []).get(id)).push([part, by]); });
}
// (once this machine's shell is up, its first window list with the desktop's: the session's objects as they are)
let osCaught = false;
function osShellUp(list) {
  if (osCaught || !list.some(n => n.cls === 'Progman')) return;
  osCaught = true; osCatchUp().then(osSoon); trayPeople();
}

// ---------------------------------------------------------------- scripting
// Drives the shell through the same input paths a person uses: pointer events on the screen canvas in screen
// pixels, keys through the shell's key handler. Documented in SCRIPTING.md.
/** the pointer input sent so far fed to USER by each machine it went to (its frames say so), then drawn by the page */
async function inputDrawn() {
  for (const a of [sysApp, ...nativeApps]) for (let n = 0; a && a.alive && !a.inputFed() && n < 600; n++) await a.nextFrame();
  await new Promise(ok => requestAnimationFrame(() => ok()));
}
function pointer(type, x, y, button = 0) {
  const el = cv, r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent(type, { clientX: r.left + (x + 0.5) * r.width / W, clientY: r.top + (y + 0.5) * r.height / H,
    button, buttons: type === 'pointerup' ? 0 : 1 << (button === 2 ? 1 : 0), pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true }));
}
const winInfo = w => ({ title: w.title, x: w.x, y: w.y, w: w.w, h: w.h, active: w === active, minimized: !!w.min, maximized: !!w.max, modal: modals.includes(w) || !!w.nativeModal, ...(w.message ? { message: w.message } : {}) });
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
const label = s => amp(s || '')[0];
/** a native window's controls (USER's window tree, as the machine reports it) as elements; a tab control's tabs each
 *  as a pushbutton. Explorer's tray (Shell_TrayWnd: its task switcher among them) is the Taskbar, as the page's own
 *  taskbar is named when that one is drawn: its Start button, its task buttons, its clock */
function nativeEls(kids, win) {
  const out = [], add = (role, name, r, o = {}) => out.push({ role, name: name ?? '', x: r.x, y: r.y, w: r.w, h: r.h, ...o });
  if (kids.some(c => c.cls === 'MSTaskSwWClass')) win = { ...win, window: 'Taskbar' };
  for (const c of kids) {
    const bs = c.style & 0x0f, k = c.cls.toLowerCase();
    // a popup menu's items (the Start menu, a context menu): as the page's own menus are listed, under 'Menu' with the
    // menu's depth; a separator is no item
    if (k === 'menuitem') { if (!c.separator) add('menuitem', label(c.text.split('\t')[0]), c, { window: 'Menu', depth: win.menuDepth || 0, disabled: !c.enabled, submenu: !!c.submenu, checked: !!c.checked }); continue; }
    if (k === 'traynotifywnd' || k === 'mstaskswwclass') continue;   // (holders of the clock and the tabs, listed for themselves)
    if (k === 'trayclockwclass') { add('clock', c.text, c, win); continue; }
    if (k === 'systabcontrol32' && c.items) { for (const t of c.items) add('pushbutton', label(t.text), t, { ...win, pressed: !!t.selected }); continue; }
    // (a static of an icon or a bitmap, SS_ICON or SS_BITMAP: a graphic, its window text the resource's id, "\xff" and
    // a word, not its name)
    const pic = k === 'static' && [3, 0x0e].includes(c.style & 0x1f);
    if (pic) { add('graphic', '', c, { ...win, cls: c.cls, id: c.id, hwnd: c.hwnd }); continue; }
    const role = k === 'button' ? (bs === 7 ? 'grouping' : [2, 3, 5, 6].includes(bs) ? 'checkbutton' : [4, 9].includes(bs) ? 'radiobutton' : 'pushbutton')
      : k === 'edit' ? 'text-edit' : k === 'static' ? 'text' : k === 'combobox' ? 'combobox' : k === 'listbox' ? 'list'
      : k === 'scrollbar' ? 'scrollbar' : /listview/i.test(k) ? 'list' : /toolbar/i.test(k) ? 'toolbar' : 'client';
    // (the taskbar's Start button is a bitmap button, BS_BITMAP, with no window text: named as Windows' accessibility names it)
    const name = win.window === 'Taskbar' && role === 'pushbutton' && !c.text && (c.style & 0x80) ? 'Start' : label(c.text);
    add(role, name, c, { ...win, cls: c.cls, id: c.id, hwnd: c.hwnd, disabled: !c.enabled, focused: c.focused,
      ...(c.checked !== undefined ? { checked: !!c.checked } : {}), ...(role === 'text-edit' || role === 'combobox' ? { value: c.text } : {}) });
    if (role === 'list' && c.items) for (const it of c.items) add('listitem', it.text, it, { ...win, selected: !!it.selected, list: c.hwnd, index: it.index });   // (a list view's items: the desktop's icons, a folder's files)
  }
  return out;
}
function elements() {
  render();
  const out = [], add = (role, name, r, o = {}) => out.push({ role, name: name ?? '', x: r.x, y: r.y, w: r.w, h: r.h, ...o });
  const cell = (c, o) => add('listitem', c.it.label, c.small ? { x: c.ix, y: c.iy, w: c.lx - c.ix + c.lw + 2, h: 16 }
    : { x: Math.min(c.ix, c.lx), y: c.iy, w: Math.max(32, c.lw), h: c.ly + c.lines.length * 13 - c.iy }, o);
  for (const c of desk.cells) cell(c, { window: 'Desktop', selected: desk.selKey === c.it.key });
  let menuDepth = 0;   // (the machine's popup menus, bottom to top: the Start menu, then its submenus)
  for (const w of windows) {
    if (w.min) continue;
    const win = { window: w.title };
    if (w.native && w.cls === '#32768') win.menuDepth = menuDepth++;
    add('window', w.title, w, { active: w.isActive, modal: modals.includes(w) || !!w.nativeModal, maximized: !!w.max });
    add('titlebar', w.title, w.capR, win);
    for (const b of w.buttons()) add('pushbutton', { close: 'Close', max: 'Maximize', restore: 'Restore', min: 'Minimize' }[b.id], b, { ...win, disabled: !!b.disabled });
    if (w.native && w.app.alive && w.app.proc && !w.app.proc.depth) {   // the controls USER keeps for a native window
      let kids = []; try { kids = w.app.proc.nativeChildren(w.hwnd); } catch (e) { console.error(e); }
      out.push(...nativeEls(kids, win));
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
  // the page's own taskbar, while it is the one drawn (once Explorer is the shell, its tray is: a native window above)
  let bar = null;
  if (!monApp()) {
    const L = taskLayout();
    add('pushbutton', 'Start', L.start, { window: 'Taskbar', pressed: !!(menuSrc && menuSrc.kind === 'start') });
    for (const b of L.btns) add('pushbutton', b.t.title, b, { window: 'Taskbar', pressed: b.t === active && !b.t.min });
    for (const i of L.icons) add('icon', i.t.tip, i, { window: 'Taskbar' });
    if (tbar.clock) add('clock', clockStr(), L.tray, { window: 'Taskbar' });
    bar = { x: 0, y: L.y, w: W, h: TB };
  }
  menus.forEach((m, d) => m.items.forEach((it, i) => {
    const r = m.rows[i]; if (it.sep) return;
    add('menuitem', label(it.label), { x: m.x + 3, y: m.y + r.y, w: m.w - 6, h: r.h }, { window: 'Menu', depth: d, disabled: !!it.disabled, submenu: !!it.sub, hot: m.hover === i, checked: !!it.check });
  }));
  // covered: a click at its centre would land on something drawn over it (a later window, the taskbar, a menu)
  const above = [];
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i], cx = e.x + (e.w >> 1), cy = e.y + (e.h >> 1);
    if (e.window === 'Menu') { above.push(e); continue; }
    // (and what covers it: the front-most window or menu over that point, else the taskbar)
    const over = [...above].reverse().find(a => inR(a, cx, cy)) || (!!bar && e.window !== 'Taskbar' && inR(bar, cx, cy) ? 'taskbar' : null);
    e.covered = !!over;
    if (over) e.coveredBy = over === 'taskbar' ? 'the taskbar' : over.window === 'Menu' ? 'a menu' : `'${over.name}'`;
    if (e.role === 'window') above.push(e);
  }
  return out;
}
// the front-most element matching every given field: strings match exactly, RegExps test
function findEl(q, all = elements()) {
  if (typeof q === 'string' || q instanceof RegExp) q = { name: q };
  const ok = e => Object.entries(q).every(([k, v]) => v instanceof RegExp ? v.test(String(e[k] ?? '')) : e[k] === v);
  for (let i = all.length - 1; i >= 0; i--) if (ok(all[i])) return all[i];
  return null;
}
const qText = q => JSON.stringify(q, (k, v) => v instanceof RegExp ? String(v) : v);
// an element object from an earlier listing names the element it was (its geometry may have moved since); a native
// control is the same window whatever its text is now (an edit's name is its text, which typing changes)
const asQuery = q => (q && typeof q === 'object' && !(q instanceof RegExp) && 'x' in q && 'w' in q
  ? q.hwnd && q.list === undefined ? { hwnd: q.hwnd, role: q.role, ...(q.window ? { window: q.window } : {}) } : { name: q.name, role: q.role, ...(q.window ? { window: q.window } : {}) } : q);
/** the elements a query matches (a name, or { field: value or RegExp }) */
function filterEls(all, q) {
  if (!q) return all; if (typeof q === 'string' || q instanceof RegExp) q = { name: q };
  return all.filter(e => Object.entries(q).every(([k, v]) => v instanceof RegExp ? v.test(String(e[k] ?? '')) : e[k] === v));
}
/** the elements with every native window's controls as its machine answers now (elements gives the last answer) */
async function elementsNow() {
  await Promise.all(windows.filter(w => w.native && !w.min && w.app && w.app.alive && w.app.childrenNow).map(w => w.app.childrenNow(w.hwnd).catch(() => null)));
  return elements();
}
/** the element a query names, as its machine shows it now: waited for up to `ms`, else an error saying what is there */
async function resolveEl(q, ms = 5000) {
  q = asQuery(q);
  const t0 = performance.now();
  let e = null, all = [];
  for (;;) {
    all = await elementsNow(); e = findEl(q, all);
    if (e) return e;
    if (typeof lastFail !== 'undefined' && lastFail && lastFail.at >= t0) throw new Error(`no element matches ${qText(q)}: the system failed, ${failText(lastFail)}`);
    if (performance.now() - t0 >= ms) break;
    await new Promise(r => setTimeout(r, 50));
  }
  const win = q && typeof q === 'object' && q.window, there = win ? all.filter(x => x.window === win && x.name).map(x => x.name) : [];
  throw new Error(`no element matches ${qText(q)} within ${ms} ms${win ? `; '${win}' has ${there.length ? there.map(n => `'${n}'`).join(', ') : 'none named'}` : ''}`);
}
/** the input for the element `q` names. A native list view's item (a desktop icon, a folder window's file) is
 *  selected, or opened (`item.open`), by its list view itself (listItem), wherever it is on screen; anything else gets
 *  the pointer input `send` makes at its centre, which must not be covered. Resolves with the element */
async function actOn(q, send, item) {
  const e = await resolveEl(q), w = item && e.list && windows.find(x => x.native && x.title === e.window && x.app);
  if (w) { await w.app.cmd('listItem', [e.list, e.index, !!item.open]); return { ...e, how: 'its list view selected it' }; }
  // (a native button, a radio button or a check box: pressed by its own window, the machine's 'press', which refuses
  // one a person could not press now (disabled, under a dialog, its window not the active one) and says which. By
  // the pointer at the place it was listed at, a dialog that came or moved meanwhile took the click instead, and
  // Monitor Settings' Yes went to what lay under it)
  const btn = item && !item.open && e.hwnd && /^(pushbutton|radiobutton|checkbutton)$/.test(e.role) && windows.find(x => x.native && x.title === e.window && x.app);
  if (btn) {
    const r = await btn.app.cmd('press', [e.hwnd]);
    if (r !== true) { const a = windows.map(winInfo).filter(x => x.active).pop(); throw new Error(`${qText(asQuery(q))} is not pressed: ${r}${a ? `; the active window is '${a.title}'` : ''}`); }
    return { ...e, how: 'pressed by its own window' };
  }
  const cx = e.x + (e.w >> 1), cy = e.y + (e.h >> 1);
  if (e.covered) throw new Error(`${qText(asQuery(q))} is covered by ${e.coveredBy || 'another window'}`);
  // (the pointer's click goes to whatever is at the point: named in the answer, the element itself or not)
  const at = elements().filter(x => x.window === e.window && x.role !== 'titlebar' && cx >= x.x && cx < x.x + x.w && cy >= x.y && cy < x.y + x.h).pop();
  send(cx, cy);
  e.how = `pointer at ${cx},${cy}, on ${at ? `${at.role} '${at.name}'` : 'no listed element'} of '${e.window}'`;
  return e;
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
  // (given coordinates, at once; given an element or a query for one, a promise: see actOn)
  down(x, y, o = {}) {
    if (typeof x !== 'number') return actOn(x, (px, py) => script.down(px, py, y || {}));
    pointer('pointerdown', x, y, o.button === 'right' ? 2 : 0);
  },
  up(x, y, o = {}) {
    if (typeof x !== 'number') return actOn(x, (px, py) => script.up(px, py, y || {}));
    pointer('pointerup', x, y, o.button === 'right' ? 2 : 0);
  },
  click(x, y, o = {}) {
    if (typeof x !== 'number') return actOn(x, (px, py) => script.click(px, py, y || {}), y && y.button === 'right' ? null : { open: !!(y && y.double) });
    const b = o.button === 'right' ? 2 : 0;
    for (let i = 0; i < (o.double ? 2 : 1); i++) { pointer('pointermove', x, y); pointer('pointerdown', x, y, b); pointer('pointerup', x, y, b); }
  },
  dblclick(x, y) {
    if (typeof x !== 'number') return actOn(x, (px, py) => script.click(px, py, { double: true }), { open: true });
    script.click(x, y, { double: true });
  },
  waitFor: (q, ms) => resolveEl(q, ms),
  drag(x1, y1, x2, y2, steps = 8) {
    if (typeof x1 !== 'number') {
      const n = x2 ?? 8;
      return resolveEl(y1).then(to => actOn(x1, (px, py) => script.drag(px, py, to.x + (to.w >> 1), to.y + (to.h >> 1), n)));
    }
    // (paced as a person's come in: each part once the machine has fed USER the last and the page has drawn it, so a
    // window dragged by its title moves: sent at once, the button was up before USER's move loop began)
    return (async () => {
      const part = async (type, x, y) => { pointer(type, x, y); await inputDrawn(); };
      await part('pointermove', x1, y1); await part('pointerdown', x1, y1);
      for (let i = 1; i <= steps; i++) await part('pointermove', Math.round(x1 + (x2 - x1) * i / steps), Math.round(y1 + (y2 - y1) * i / steps));
      await part('pointerup', x2, y2);
    })();
  },
  type(text) { shareInput({ t: 'text' }); script.typeOwn(text); },
  typeOwn(text) { const na = nativeFocus(); if (na) { na.typeText(String(text).replace(/\r/g, '')); return; } for (const ch of String(text).replace(/\r/g, '')) handleKey({ key: ch === '\n' ? 'Enter' : ch, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} }); },
  key(...specs) { for (const k of specs) { shareInput({ t: 'key' }); pressKey(k); } },
  elements(q) { return filterEls(elements(), q); },
  // (the same, each native window's controls asked of its machine now: elements() gives its last answer, none yet for
  // a window that has just come)
  async elementsNow(q) { return filterEls(await elementsNow(), q); },
  find: q => findEl(q),
  windows() { return windows.map(winInfo); },
  // what is on the screen and what went wrong, in one call (SCRIPTING.md, Reading the screen): the screen, each window
  // with its controls' text as its machine has them now, the line's last n faults and the fault log's last entry
  async report(n = 3) {
    const els = await elementsNow(), hx = v => (typeof v === 'number' ? (v >>> 0).toString(16) : v);
    const wins = windows.map(winInfo).map(w => ({ ...w, text: els.filter(e => e.window === w.title && e.name).map(e => `${e.role}: ${e.name}`) }));
    const evs = braid ? braid.faultEvents() : [];
    const faults = evs.slice(-n).map(e => { const f = e.fault || {}; return { why: f.why, program: f.program, module: f.module, eip: hx(f.eip), cr2: hx(f.cr2), gen: e.gen, machine: e.machine }; });
    const log = evs.length && evs[evs.length - 1].faults, l = Array.isArray(log) && log[log.length - 1];
    return { screen, windows: wins, faults, last: l ? { why: l.why, at: l.at || l.atIn, stack: (l.stack || []).slice(0, 8) } : null };
  },
  // until the machines have taken the input and the page has drawn it (inputDrawn: their frames say so); ends at once
  // when the system fails
  async settle() {
    await inputDrawn();
    if (lastFail && lastFail.at > (this.settleFrom || 0)) throw new Error(`the system failed: ${failText(lastFail)}`);
  },
  // an action's outcome: fn run (a win95 call, or none: what happened since the last outcome), the machines having
  // taken it, then { result, error, events, report }: every event since the last outcome (journal), and the screen
  // now (win95.report). What a script acts on next is this, never a state assumed
  async outcome(fn, n = 3) {
    let result = null, error = null; this.settleFrom = performance.now();
    try { if (fn) result = await fn(); await script.settle(); } catch (e) { error = e.message; }
    const report = await script.report(n);   // (the machines' windows asked of them now; their frames meanwhile shown)
    observe();   // (the shell's changes as events now, not on its next look)
    if (result && typeof result === 'object') result = { name: result.name, role: result.role, window: result.window, how: result.how };
    return { result, error, events: (window.W95Journal || []).splice(0), report };
  },
  // the machines' log (win32.js log): the emulator's messages, programs' OutputDebugString, KERNEL's LogError, each
  // { n, t, level, tag, text, machine }, since line n; the same lines are in DevTools' console at their level and in
  // the Debug Monitor (Programs > Accessories > System Tools)
  log(since = 0) { return W95Win32.log.lines(since); },
  // the input's latency, measured: `n` pointer moves (to a diagonal of points) and `keys` key presses sent to the
  // system's machine as a person's are, each timed from the page's send to the machine taking it from its ring, to
  // its feed into USER's drivers, and (a move) to the sprite showing it on the page; the samples and their medians, ms
  async lag(n = 20, keys = 10) {
    const a = sysApp; if (!a || !a.alive) throw new Error('no system machine');
    await a.cmd('lag', [true]);
    const moves = [], presses = [], med = v => { const s = v.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : null; };
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const sw = a.sw || 640, sh = a.sh || 480;
    for (let i = 0; i < n; i++) {
      const x = 40 + Math.round(i * (sw - 80) / Math.max(1, n - 1)), y = 40 + Math.round(i * (sh - 120) / Math.max(1, n - 1)), t0 = Date.now();
      a.pointer('move', x, y);
      let seen = null; for (let k = 0; k < 60 && seen == null; k++) { await wait(2); const s = a.sprite(); if (s && Math.abs(s.x - x) <= 1 && Math.abs(s.y - y) <= 1) seen = Date.now() - t0; }
      moves.push({ x, y, t0, seen });
      await wait(40);
    }
    for (let i = 0; i < keys; i++) { const t0 = Date.now(); a.key({ keyCode: 16, code: 'ShiftLeft', shiftKey: true, ctrlKey: false, altKey: false }, false); presses.push({ t0 }); await wait(20); a.key({ keyCode: 16, code: 'ShiftLeft', shiftKey: false, ctrlKey: false, altKey: false }, true); await wait(40); }
    await wait(100);
    const log = await a.cmd('lag'); await a.cmd('lag', [false]);
    const ins = log.filter(e => e.k === 'mouse-in'), feds = log.filter(e => e.k === 'mouse-fed');
    for (const m of moves) { const i = ins.find(e => e.x === m.x && e.y === m.y), f = feds.find(e => e.t >= (i ? i.t : m.t0) && Math.abs(Math.round(e.x * (sw - 1) / 65535) - m.x) <= 1); m.ring = i ? i.t - m.t0 : null; m.fed = f ? f.t - m.t0 : null; }
    const kin = log.filter(e => e.k === 'key-in' && !e.up), kfed = log.filter(e => e.k === 'key-fed' && !e.up);
    presses.forEach((p, i) => { p.ring = kin[i] ? kin[i].t - p.t0 : null; p.fed = kfed[i] ? kfed[i].t - p.t0 : null; });
    return { moves, keys: presses, median: { moveRing: med(moves.map(m => m.ring)), moveFed: med(moves.map(m => m.fed)), moveSeen: med(moves.map(m => m.seen)), keyRing: med(presses.map(p => p.ring)), keyFed: med(presses.map(p => p.fed)) }, stats: a.stats || null };
  },
  get devtools() { return devtoolsOpen; },
  window(title) { const w = findWin(title); return w ? winInfo(w) : null; },
  activate(title) { const w = findWin(title); if (!w) return false; if (w.min) w.min = false; activate(w); dirty(); return true; },
  close(title) { const w = findWin(title); if (!w) return false; closeWin(w); dirty(); return true; },
  menus() { return menus.map(m => m.items.map(i => i.sep ? '-' : amp(i.label || '')[0])); },
  run(cmd) { runCommand(cmd); dirty(); },
  open(path) { openPath(path); dirty(); },
  saver(path) { startFullSaver(path); },
  stopSaver() { if (!fullSaver || !fullSaver.pid) return false; stopSaverProcess(fullSaver); fullSaver = null; return true; },
  screen() { return { width: W, height: H, taskbar: barTop(), screen }; },   // (screen: what the 'screen' event carries, readable before waiting on it)
  screenshot() { render(); return cv.toDataURL('image/png'); },
  // the machine the saver runs on, as its last frame reported it (the saver is a process of the system's machine, so
  // the counts are the machine's: its timers, its GL frames, its guest time; the bench takes differences while it runs)
  saverStats() { const a = fullSaver && fullSaver.pid && fullSaver.app; return a && a.alive && a.stats ? { ...a.stats } : null; },
  // the shell's speed meter over the screen (drawShellOverlays), on or off
  speedMeter(on = true) { return speedMeter(on); },
  on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
  // resolves with the next event of this type that passes the test; rejects at once when the system fails meanwhile
  // (system.fail, braid.fault: what failed), else after the timeout
  next(type, test, ms = 10000) {
    test = test || (() => true);   // (no test, or null: any event of the type)
    return new Promise((ok, no) => {
      const end = () => { off(); offFail(); offFault(); clearTimeout(t); };
      const off = script.on(type, e => { if (test(e)) { end(); ok(e); } });
      const fail = e => { end(); no(new Error(`${type} not reached: ${failText(e.type === 'braid.fault' ? { kind: 'fault', ...e } : e)}`)); };
      const offFail = type === 'system.fail' ? () => {} : script.on('system.fail', fail);
      const offFault = type === 'braid.fault' ? () => {} : script.on('braid.fault', fail);
      const t = setTimeout(() => { end(); no(new Error(`no ${type} within ${ms} ms`)); }, ms);
    });
  },
};

// the Claude desktop app's tools (ccd.js), made on first use: the registry they keep their records in is loaded by then
let ccdApi = null;
// a script of the site's loaded again from its server into the running page, no restart (the page's half of a change:
// ccd.js's tools are made again on next use from their records in the registry); a script of the machines' goes to the
// system's machine (worker.js cmd 'reload')
const WORKER_SCRIPTS = new Set(['claude-app.js', 'session-dll.js', 'session-tray.js', 'dbwin.js', 'debugger.js', 'dynjs.js', 'shell32.js', 'osclass.js', 'saver-runtime.js', 'gl.js', 'sound.js']);
// the page's scripts that only define things, so can be loaded again (win95.js loaded twice ran two shells on one screen)
const PAGE_SCRIPTS = new Set(['ccd.js']);
// ---------------------------------------------------------------- ring α on the page (braid.js, braid-page.js): the machines' moments with the disk, the registry and the shell beside them, on one line
// What of the shell Braid needs: the machines, the file system, the shell's own state (the windows it draws itself: a
// fault's box, a message box, a folder, the mirrors of the machines'; the active one, the modals, the menus, a
// capture or drag in progress, the clipboard), given as one object and put back by assignment, so the screen after
// travel is the moment's screen; the dialogs and drawing for the Braid window; the session, for the line shared with
// the other people in it
const braidUi = () => ({
  W95Win32, fs, emit, dirty, closeMenus, dialog, closeWin, msgBox, activate, script,
  machines: () => [...machineWorkers], sysApp: () => sysApp, startSystem, pcBoot: () => pcBoot(), windows: () => windows, shared: () => sharedNow(),
  pcSpeed: x => { if (x === undefined) return pcSpeed; pcSpeed = Math.max(1, Number(x) || 1); if (pc && pc.m) pc.m.speed = pcSpeed; return pcSpeed; },   // (no argument: read)
  shell: () => ({ windows, tasks, modals, active, menus, menuSrc, cap, drag, ghost, screen, textClip, clipOwner, msgApp, cascadeN }),
  setShell: sh => {
    ({ windows, tasks, modals, active, menus, menuSrc, cap, drag, ghost, screen, textClip, clipOwner, msgApp, cascadeN } = sh);
    // (a machine's windows only while it runs: one ended since the moment leaves none behind to hold the mouse)
    const dead = w => w && w.native && !(w.app && w.app.alive);
    windows = windows.filter(w => !dead(w)); tasks = tasks.filter(w => !dead(w)); modals = modals.filter(w => !dead(w));
    if (dead(active)) active = windows[windows.length - 1] || null;
    if (cap && cap.native && !cap.native.alive) cap = null;
  },
  // a machine's window the page is told of (a moment arrived at: its windows as the record has them, braid-page.js
  // arrive), placed as a frame's list places one, with no focus given to the machine; one the page has by that key
  // takes the new place instead
  adoptNative: (app, n, o = {}) => {
    const key = n.key || n.hwnd; let w = app.wins.get(key);
    if (w) w.set(n); else { w = new NativeWin(app, n); app.wins.set(key, w); windows.push(w); if (!w.noTask) tasks.push(w); }
    Object.assign(w, o); if (o.noTask !== undefined && !o.noTask && !tasks.includes(w)) tasks.push(w);
    windows = windows.filter(v => v !== w); windows.push(w); dirty(); return w;
  },
  setActive: w => { active = w; blinkOn = true; dirty(); },
  gfx: { K, fill, text, textW, btnUp, focusRect },
});
const braid = window.W95BraidPage ? window.W95BraidPage(braidUi()) : null;
/** a fault a machine reported, written to the line under its generation (braid-page.js fault) */
function braidFault(app, f, fatal) { if (braid) braid.fault(app, f, fatal); }
// win95.debug: the debugger for the system machine's translated code (dynjs.js). Every method returns a promise.
//   modules()                 the translated modules: [{ name, lo, hi, base, blocks, js }]
//   run(names)                run exactly these modules as JavaScript ('*' for all); returns the names running so
//   breakpoint({ at, when, capture })
//                             Records a hit each time the block at `at` is entered, and runs on. at: a guest address
//                             (number or hex string) where a block starts, in a module run as JavaScript.
//                             when / capture: expressions over R (registers), r8/r16/r32 (memory), n (times reached)
//                             and thread. Returns { id, at }.
//   remove(id), clear()       remove one breakpoint, or all of them and the recorded hits
//   breakpoints()             [{ id, at, when, capture, n }]
//   hits(since)               recorded hits with seq above `since`: [{ seq, id, at, n, thread, regs, stack, value }]
//   next(id, ms)              the next hit of breakpoint `id` (any, when id is omitted); rejects after ms
//   source(address)           the JavaScript of the block holding an address: { module, block, text }
//   read(address, n)          n bytes of guest memory
// The Windows API. A place is an address, 'MODULE+offset' or an API 'DLL!Export' ('USER32!DrawIconEx', 'USER!#123').
//   resolve(place), where(address)   a place's address and name; an address's name (module+offset, nearest export)
//   watch(dll, name, n), calls(), unwatch(dll)
//                             trace calls of an export (or '/regexp/' over the DLL's exports) with n arguments, without
//                             stopping; calls() returns and clears them: [{ t, name, args, text, from, stack, eax }]
//   stopAt(call, n), unstop(id), stops()
//                             route each call of an API through dynjs.js's w95ApiEntry, where a debugger's breakpoint
//                             stops at it (tools/devtools-mcp.mjs api_break); any module, wasm or JavaScript
//   state()                   registers, flags, the stack with each code address named, the thread and its program
// Each hit is also the page event 'debug.hit' (win95.on('debug.hit', fn)).
const debugApi = (() => {
  const call = (method, ...args) => { if (!sysApp || !sysApp.alive) return Promise.reject(new Error('debug: the system\'s machine is not running')); return sysApp.cmd('debug', [method, ...args]); };
  const api = {};
  for (const m of ['modules', 'run', 'breakpoint', 'remove', 'clear', 'breakpoints', 'hits', 'source', 'read', 'resolve', 'where', 'stopAt', 'unstop', 'stops', 'watch', 'unwatch', 'calls', 'state']) api[m] = (...a) => call(m, ...a);
  api.next = (id, ms = 10000) => script.next('debug.hit', h => id === undefined || h.id === id, ms);
  return api;
})();
// a script of the site's loaded again over the running machine or page: a mod of ring α's, named (with the sum of its
// text) beside every moment marked from then on, never carried in one (braid.js mod)
async function reloadScript(f) {
  f = String(f || ''); if (!/^[\w.-]+\.js$/.test(f)) throw new Error(`reloadScript: a script of the site's, by name (${f})`);
  if (WORKER_SCRIPTS.has(f)) { if (!sysApp || !sysApp.alive) throw new Error('reloadScript: the system\'s machine is not running'); const r = await sysApp.cmd('reload', [f]); if (braid && r) braid.modded({ name: f, sum: r.sum }); return { machine: r }; }
  if (!PAGE_SCRIPTS.has(f)) throw new Error(`reloadScript: ${f} runs the page itself and cannot be loaded twice: reload the page`);
  const url = `${f}?reload=${Date.now()}`;
  const text = await fetch(url, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(`reloadScript: ${f} did not load (${r.status})`); return r.text(); });
  await new Promise((ok, no) => { const s = document.createElement('script'); s.src = url; s.onload = ok; s.onerror = () => no(new Error(`reloadScript: ${f} did not load`)); document.head.appendChild(s); });
  if (f === 'ccd.js') ccdApi = null;
  const rec = W95Braid.mod(f, text); if (braid) braid.modded(rec);
  return { page: f, sum: rec.sum };
}
const ccdUi = () => ({
  W95Win32, fs, emit, dirty, dialog, msgBox, openWin, closeWin, activate, notepad, runCommand, openPath, netBoot, dosRun: window.W95V86 && window.W95DOS ? dosRun : null,
  windows: () => windows, screen: script.screen, key: script.key, netUp: () => !!(netUp && netUp.alive), icon: 'app',
  holdSaver: on => { saverHeld = !!on; if (on) lastInput = performance.now(); },
  gfx: { K, fill, field, text, esc, wrap, textW, ellipsis, btnUp, btnDown, focusRect, clip: (x, y, w, h, f) => { ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); try { f(); } finally { ctx.restore(); } } },
  Win, DialogBody, popup: openPopup, on: script.on,
});
// (the API's actions go to ring α's journal as they are made, with the machine's clock: braid-page.js note)
if (braid) for (const k of braid.actions) { const f = script[k]; if (typeof f === 'function') script[k] = function (...a) { braid.note(k, a); return f.apply(this, a); }; }
window.win95 = { ...script,
  // the PC: its text screen as lines, keys typed at its keyboard (each character; {Enter}, {F8}, ... by DOS_KEYS' names),
  // a power cycle; its machine and whether Windows has the screen
  pc: {
    get machine() { return pc && pc.m; }, get failed() { return pc && pc.failed; }, get inWindows() { return !!(pc && pc.m.winWait); },
    text() { if (!pc) return ''; const t = pcText(); let s = ''; for (let r = 0; r < 25; r++) s += String.fromCharCode(...t.ch.subarray(r * 80, r * 80 + 80)).replace(/\0/g, ' ').trimEnd() + '\n'; return s.replace(/\n+$/, '\n'); },
    type(s) { if (!pc) return false; for (const m of String(s).matchAll(/\{(\w+)\}|([\s\S])/g)) pcKey({ key: m[1] || m[2], shiftKey: false, ctrlKey: false, altKey: false }); return true; },
    reset: () => pcBoot(),
    // a 1.44 MB disk image in drive A: (its bytes; the written sectors stay in them), or taken out (null); what is in it
    floppy(image, name = '') { pcFloppy.image = image ? new Uint8Array(image) : null; pcFloppy.name = image ? name : null; pcFloppy.changed = true; return true; },
    get disk() { return pcFloppy.image ? { name: pcFloppy.name, image: pcFloppy.image } : null; },
  },
  braid,
  cd: { images: () => cdImages().map(i => i.name), insert: name => cdInsert(name), eject: () => cdInsert(null), get disc() { const v = fs.vols.get('D'); return v.ready ? { label: v.label, serial: v.serial, sectors: v.sectors } : null; } }, get ccd() { return ccdApi || (ccdApi = window.W95Ccd ? window.W95Ccd(ccdUi()) : null); }, get nativeApps() { return [...nativeApps]; }, get dos() { return [...dosMachines]; }, startSystem, get sysApp() { return sysApp; }, debug: debugApi, reloadScript, netBoot, netCall, syncNetDrives, mapNetDrive, disconnectNetDrive, fs, render, displayProperties, startFullSaver, get fullSaver() { return fullSaver; }, properties, driveProps, openFolder, openPath, shellOpen, notepad, msgBox, runDialog, findComputer, findFiles, winHelp, shutDownDialog, MyComputer, get state() { return { menus: menus.length, menuSrc, modals: modals.length, cap: !!cap, drag: !!drag, screen, active: active && active.title }; } };
// the scripting API's calls shown as they are made (?scriptlog=1, or win95.scriptLog = true): each win95.* call and each
// win95.sysApp.cmd, then what it answered, as 'script' lines at the debug level in DevTools' console and the machines'
// log (Verbose in both: Debug Monitor's Options > Verbose),
// so the person at the screen sees what a script (an agent driving the system) does; win95.note(text) adds a line of its own
{
  let on = new URLSearchParams(location.search).has('scriptlog'), seq = 0;
  const show = v => {
    let s; try { s = typeof v === 'function' ? 'function' : JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? `<${x.length} bytes>` : x)); } catch (_) { s = String(v); }
    if (s === undefined) s = 'undefined';
    return s.length > 300 ? `${s.slice(0, 300)}... (${s.length} characters)` : s;
  };
  const say = text => {
    const line = W95Win32.log('debug', 'script', text);   // (Verbose: DevTools' level, Debug Monitor's Options > Verbose)
    if (line && sysApp && sysApp.alive) sysApp.cmd('logPut', [{ ...line, posted: true, machine: 'page' }]);   // (Debug Monitor is the system's machine's)
  };
  // (a call, and its answer once a promise's comes: numbered, so a slow answer is matched to its call)
  const traced = (name, f) => function (...args) {
    if (!on) return f.apply(this, args);
    const n = ++seq; say(`#${n} ${name}(${args.map(show).join(', ')})`);
    let r; try { r = f.apply(this, args); } catch (e) { say(`#${n} threw ${e && e.message}`); throw e; }
    if (r && typeof r.then === 'function') r.then(v => say(`#${n} -> ${show(v)}`), e => say(`#${n} rejected: ${e && e.message}`));
    else say(`#${n} -> ${show(r)}`);
    return r;
  };
  const api = window.win95;
  for (const k of Object.keys(api)) {
    const d = Object.getOwnPropertyDescriptor(api, k);
    if (typeof d.value === 'function' && k !== 'log') api[k] = traced(k, d.value);
  }
  // (the system's machine as the script sees it: its cmd traced, everything else its own)
  const cmdOf = new WeakMap();
  Object.defineProperty(api, 'sysApp', { enumerable: true, get() {
    if (!sysApp) return sysApp;
    if (!cmdOf.has(sysApp)) { const a = sysApp, c = traced('sysApp.cmd', (name, args) => a.cmd(name, args)); cmdOf.set(a, new Proxy(a, { get: (t, p) => (p === 'cmd' ? c : typeof t[p] === 'function' ? t[p].bind(t) : t[p]) })); }
    return cmdOf.get(sysApp);
  } });
  Object.defineProperty(api, 'scriptLog', { get: () => on, set: v => { on = !!v; say(`script log ${on ? 'on' : 'off'}`); } });
  api.note = text => say(String(text));
}
// the page's settings from its address (an experiment): ?name=value as the page loads, and #name=value at any time, a
// change to the part after # being no reload, each made as it changes; a name the part after # gives takes the place
// of the query's. mod, once for each of the site's mods, NAME or NAME:VALUE (mod-NAME.js, its setting VALUE):
// #mod=turbo:8&mod=setupclock loads mod-turbo.js with 8 (cmd 'reload', its self.W95ModArg) and mod-setupclock.js, into
// the system's machine and into each one after it (a restart's); a new value loads it again, and taken out, the mod is
// ended as it ends itself (cmd 'modOff'; one with no end stays until the page reloads).
// mute: 0 or 1, the sound output on or off; anchor: an anchored moment, travelled to once, as the system's machine
// first comes up
{
  // (the address's parameters, each name's values: the part after #'s where it has the name, else the query's)
  const read = () => {
    const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.replace(/^#/, ''));
    return { all: k => (h.has(k) ? h : q).getAll(k), get: k => (h.has(k) ? h : q).get(k), has: k => h.has(k) || q.has(k) };
  };
  // (each mod's file and setting: turbo:8, mod-turbo:8 and mod-turbo.js:8 are mod-turbo.js with 8)
  const modsOf = list => {
    const out = new Map();
    for (const e of list) {
      const i = e.indexOf(':'), n = (i < 0 ? e : e.slice(0, i)).trim().replace(/\.js$/i, '').replace(/^mod-/i, ''), v = i < 0 ? '' : e.slice(i + 1);
      if (/^[\w-]+$/.test(n)) out.set(`mod-${n}.js`, v);
    }
    return out;
  };
  // (the site's mod file, NAME.mod: the address's mods=NAME, else the one its server names (tools/serve.py --mods),
  // else prod.mod; one mod a line, # a comment. Loaded as the address's mods are, the address's added to them, one of
  // the same name in the address taking its place)
  let served = [];
  const modFile = async () => {
    const name = read().get('mods') || await fetch('/__mods', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null), () => null).then(j => j && j.profile, () => null) || 'prod';
    if (!/^[\w-]+$/.test(name)) { console.warn('[address] mods', name, 'is no mod file\'s name'); return; }
    const t = await fetch(`${name}.mod`, { cache: 'no-store' }).then(r => (r.ok ? r.text() : null), () => null);
    if (t === null) { console.warn('[address] mods', `${name}.mod`, 'could not be read'); return; }
    served = t.split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  };
  const made = {}, mods = new Map(); let anchored = false, busy = modFile().catch(e => console.warn('[address] mods', e && e.message));
  const apply = why => (busy = busy.then(async () => {
    const o = read(), a = sysApp && sysApp.alive ? sysApp : null;
    const mute = o.get('mute');
    if (mute !== null && mute !== made.mute) { made.mute = mute; if (window.W95Sound && W95Sound.setMuted) W95Sound.setMuted(/^(1|true)$/i.test(mute)); }
    if (!a) return;
    if (why === 'system') mods.clear();   // (a new system's machine: its mods are its own to be loaded)
    const want = modsOf([...served, ...o.all('mod')]);
    for (const [f, v] of want) if (mods.get(f) !== v) { try { await a.cmd('reload', [f, v]); mods.set(f, v); } catch (e) { console.warn('[address] mod', f, e && e.message); } }
    for (const f of [...mods.keys()]) if (!want.has(f)) { mods.delete(f); try { if (!(await a.cmd('modOff', [f]))) console.warn('[address] mod', f, 'has no way to end itself: it stays until the page reloads'); } catch (e) { console.warn('[address] mod', f, e && e.message); } }
    const anchor = o.get('anchor');
    if (anchor && !anchored) { anchored = true; try { await braid.travel(anchor); } catch (e) { console.warn('[address] anchor', anchor, e && e.message); } }
  }).catch(e => console.warn('[address]', e && e.message)));
  window.addEventListener('hashchange', () => apply('hash'));
  window.win95.on('system.start', () => apply('system'));
  apply('load');
}
})();
