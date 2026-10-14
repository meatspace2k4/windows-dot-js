'use strict';
// Windows 95 shell rendered on a single canvas. All bitmaps, icons, cursors and
// fonts come from assets.js, which is extracted from the OSR2 CD's WIN95_02.CAB.
(() => {
const A = window.W95;
const cv = document.getElementById('screen');
const ctx = cv.getContext('2d', { alpha: false });
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

let rafPending = false;
function dirty() { if (!rafPending) { rafPending = true; requestAnimationFrame(render); } }

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

const maxRect = b => ({ x: -b, y: -b, w: W + 2 * b, h: H - TB + 2 * b });

function openWin(w) {
  windows.push(w); if (!w.noTask) tasks.push(w);
  activate(w); dirty(); return w;
}
function activate(w) {
  if (w && modal() && w !== modal()) w = modal();
  if (w) { w.min = false; windows = windows.filter(v => v !== w); windows.push(w); }
  active = w; blinkOn = true; dirty();
}
function topVisible() { for (let i = windows.length - 1; i >= 0; i--) if (!windows[i].min) return windows[i]; return null; }
function closeWin(w) {
  if (w.body && w.body.onClose) w.body.onClose();
  windows = windows.filter(v => v !== w); tasks = tasks.filter(v => v !== w); modals = modals.filter(v => v !== w);
  if (menuSrc && menuSrc.win === w) closeMenus();
  if (active === w || !windows.includes(active)) active = modal() || topVisible();
  dirty();
}
function minimize(w) { if (!w.minimizable) return; w.min = true; if (active === w) active = topVisible(); dirty(); }
function toggleMax(w) {
  if (!w.maximizable) return;
  if (w.max) { Object.assign(w, w.saved); w.max = false; }
  else { w.saved = { x: w.x, y: w.y, w: w.w, h: w.h }; Object.assign(w, maxRect(w.b)); w.max = true; }
  dirty();
}
function nextPos(w, h) {
  const k = cascadeN++ % 8;
  return { x: clamp(24 + k * 22, 0, Math.max(0, W - w)), y: clamp(16 + k * 22, 0, Math.max(0, H - TB - h)) };
}
function centered(w, h) { return { x: Math.max(0, (W - w) >> 1), y: Math.max(0, (H - TB - h) >> 1) }; }

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
  const m = makeMenu(START, 'start'); placeMenu(m, 2, H - TB + 2 - m.h); menus = [m];
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
  closeMenus(); if (it.fn) it.fn();
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
    if (it.check) mglyph('check', x + 6, iy + ((r.h - 7) >> 1), color);
    if (it.disabled && !hot) textEmboss(it.label, x + m.tx, ty, it.bold); else text(it.label, x + m.tx, ty, color, it.bold);
    if (it.acc) { if (it.disabled && !hot) textEmboss(it.acc, x + m.ax, ty); else text(it.acc, x + m.ax, ty, color); }
    if (it.sub) mglyph('submenu', x + w - 3 - 6 - 4, iy + ((r.h - 7) >> 1), color);
  });
}

// ---------------------------------------------------------------- folders
const N = (label, icon, extra = {}) => ({ label, icon, ...extra });
const cdRoot = ['Admin', 'Autorun', 'Datalink', 'Demos', 'Drivers', 'Funstuff', 'Help', 'Other', 'Sampler', 'Win95']
  .map(n => N(n, 'folder', { children: [] }))
  .concat([N('Autorun.inf', 'sysfile'), N('Readme.txt', 'textdoc'), N('Setup.exe', 'app')]);
const FS = {
  mycomputer: N('My Computer', 'mycomputer', { children: [
    N('3\u00bd Floppy (A:)', 'floppy', { error: ['3\u00bd Floppy (A:)', 'A:\\ is not accessible.\n\nThe device is not ready.'] }),
    N('(C:)', 'hdd', { children: [
      N('Program Files', 'folder', { children: [N('Accessories', 'folder', { children: [] })] }),
      N('Windows', 'folder', { children: [
        N('Command', 'folder', { children: [] }), N('Desktop', 'folder', { children: [] }),
        N('Fonts', 'folder', { children: [] }), N('Start Menu', 'folder', { children: [] }),
        N('System', 'folder', { children: [] }), N('Notepad', 'notepad', { open: () => notepad() }),
      ] }),
      N('My Documents', 'folder', { children: [] }),
      N('Autoexec.bat', 'batch', { open: () => notepad('Autoexec.bat', 'SET PATH=C:\\WINDOWS;C:\\WINDOWS\\COMMAND\n') }),
      N('Config.sys', 'sysfile', { open: () => notepad('Config.sys', 'DEVICE=C:\\WINDOWS\\HIMEM.SYS\nDOS=HIGH\n') }),
    ] }),
    N('Win_95c (D:)', 'cdrom', { children: cdRoot }),
    N('Control Panel', 'controlpanel', { children: [] }),
    N('Printers', 'printers', { children: [] }),
  ] }),
  network: N('Network Neighborhood', 'network', { children: [
    N('Entire Network', 'globe', { error: ['Entire Network', 'Unable to browse the network.\n\nThe network is not accessible.'] }),
  ] }),
  recycle: N('Recycle Bin', 'recycle', { children: [] }),
};

function openItem(n) {
  if (n.children) return openFolder(n);
  if (n.open) return n.open();
  if (n.error) return msgBox(n.error[0], n.error[1], 'error');
}

const CW = 75, CH = 70;
class FolderView {
  constructor(node) { this.node = node; this.sel = -1; this.sb = new ScrollBar(true, () => dirty()); this.cells = []; }
  layout(r) {
    this.fr = { x: r.x, y: r.y, w: r.w, h: r.h - 22 };
    this.st = { x: r.x, y: r.y + r.h - 20, w: r.w, h: 20 };
    const n = this.node.children.length;
    let iw = this.fr.w - 4; const ih = this.fr.h - 4;
    let cols = Math.max(1, Math.floor(iw / CW)), content = Math.ceil(n / cols) * CH;
    this.showSb = content > ih;
    if (this.showSb) { iw -= 16; cols = Math.max(1, Math.floor(iw / CW)); content = Math.ceil(n / cols) * CH; }
    this.cols = cols; this.inner = { x: this.fr.x + 2, y: this.fr.y + 2, w: iw, h: ih };
    this.sb.set(this.inner.x + iw, this.inner.y, ih, content, ih);
    if (!this.showSb) this.sb.pos = 0;
    this.cells = this.node.children.map((c, i) => {
      const cx = this.inner.x + (i % cols) * CW, cy = this.inner.y + Math.floor(i / cols) * CH - this.sb.pos;
      const lines = wrap(c.label, CW - 4), lw = Math.max(...lines.map(l => textW(esc(l))));
      return { node: c, ix: cx + ((CW - 32) >> 1), iy: cy + 2, lines, lw, lx: cx + ((CW - lw) >> 1), ly: cy + 36 };
    });
  }
  draw(r, win) {
    this.layout(r);
    field(this.fr.x, this.fr.y, this.fr.w, this.fr.h);
    ctx.save(); ctx.beginPath(); ctx.rect(this.inner.x, this.inner.y, this.inner.w, this.inner.h); ctx.clip();
    this.cells.forEach((c, i) => drawIconLabel(c, i === this.sel, win.isActive, K.dk, K.win));
    ctx.restore();
    if (this.showSb) this.sb.draw();
    const s = this.st, n = this.node.children.length;
    edge(s.x, s.y, s.w - 16, s.h, K.sh, K.hl);
    text(this.sel >= 0 ? '1 object(s) selected' : `${n} object(s)`, s.x + 3, s.y + 4);
    if (!win.max) sizeGrip(r.x + r.w, r.y + r.h);
  }
  itemAt(x, y) {
    if (!inR(this.inner, x, y)) return -1;
    return this.cells.findIndex(c => inR({ x: c.ix, y: c.iy, w: 32, h: 32 }, x, y) ||
      inR({ x: c.lx - 1, y: c.ly, w: c.lw + 2, h: c.lines.length * 13 }, x, y));
  }
  down(x, y, btn, dbl, win) {
    if (this.showSb && this.sb.contains(x, y)) return this.sb.down(x, y);
    const i = this.itemAt(x, y); this.sel = i;
    if (btn === 2) {
      if (i >= 0) openPopup([{ label: '&Open', bold: true, fn: () => openItem(this.node.children[i]) }, { sep: true }, { label: 'P&roperties' }], x, y);
      else openPopup([{ label: '&View', sub: [{ label: 'Lar&ge Icons', check: true }] }, { sep: true }, { label: 'P&roperties' }], x, y);
    } else if (dbl && i >= 0) openItem(this.node.children[i]);
    return null;
  }
  key(e) {
    const n = this.node.children.length; if (!n) return false;
    const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -this.cols, ArrowDown: this.cols }[e.key];
    if (d) { this.sel = this.sel < 0 ? 0 : clamp(this.sel + d, 0, n - 1); return true; }
    if (e.key === 'Enter' && this.sel >= 0) { openItem(this.node.children[this.sel]); return true; }
    return false;
  }
}
function drawIconLabel(c, sel, focused, fg, bg) {
  icon(c.node.icon + '32', c.ix, c.iy, sel && focused);
  const lh = c.lines.length * 13;
  if (sel) fill(c.lx - 1, c.ly, c.lw + 2, lh, focused ? K.sel : K.face);
  c.lines.forEach((l, j) => {
    const lw = textW(esc(l));
    text(esc(l), c.lx + ((c.lw - lw) >> 1), c.ly + j * 13, sel && focused ? K.hl : fg);
  });
  if (sel && focused) focusRect(c.lx - 1, c.ly, c.lw + 2, lh);
  void bg;
}

function openFolder(node) {
  const open = windows.find(w => w.body instanceof FolderView && w.body.node === node);
  if (open) { activate(open); return open; }
  const p = nextPos(330, 240);
  return openWin(new Win({
    ...p, w: 330, h: 240, title: node.label, icon: node.icon, minW: 160, minH: 100,
    body: new FolderView(node),
    menu: [
      { label: '&File', items: () => [{ label: '&Open', disabled: true }, { sep: true }, { label: '&Close', fn: () => closeWin(active) }] },
      { label: '&Edit', items: [{ label: '&Undo', disabled: true }, { sep: true }, { label: 'Cu&t', acc: 'Ctrl+X', disabled: true }, { label: '&Copy', acc: 'Ctrl+C', disabled: true }, { label: '&Paste', acc: 'Ctrl+V', disabled: true }, { sep: true }, { label: 'Select &All', acc: 'Ctrl+A' }] },
      { label: '&View', items: [{ label: '&Toolbar' }, { label: 'Status &Bar', check: true }, { sep: true }, { label: 'Lar&ge Icons', check: true }, { label: 'S&mall Icons' }, { label: '&List' }, { label: '&Details' }, { sep: true }, { label: 'Line &up Icons' }, { sep: true }, { label: '&Refresh' }, { label: '&Options...' }] },
      { label: '&Help', items: [{ label: '&Help Topics' }, { sep: true }, { label: '&About Windows 95', fn: aboutWin95 }] },
    ],
  }));
}

// ---------------------------------------------------------------- notepad
class Notepad {
  constructor(txt) {
    this.lines = txt.replace(/\r/g, '').replace(/\t/g, '        ').split('\n');
    this.cx = 0; this.cy = 0; this.top = 0; this.left = 0;
    this.vs = new ScrollBar(true, p => { this.top = p; dirty(); });
    this.hs = new ScrollBar(false, p => { this.left = p; dirty(); });
    this.f = A.fixed; this.cw = this.f.g[77][0]; this.lh = this.f.h;
  }
  layout(r) {
    const i = { x: r.x + 2, y: r.y + 2, w: r.w - 4, h: r.h - 4 };
    this.ta = { x: i.x, y: i.y, w: i.w - 16, h: i.h - 16 };
    this.rows = Math.max(1, Math.floor(this.ta.h / this.lh)); this.colsVis = Math.max(1, Math.floor((this.ta.w - 2) / this.cw));
    const longest = Math.max(...this.lines.map(l => l.length)) + 1;
    this.vs.pos = this.top; this.hs.pos = this.left;
    this.vs.set(i.x + i.w - 16, i.y, i.h - 16, this.lines.length, this.rows);
    this.hs.set(i.x, i.y + i.h - 16, i.w - 16, Math.max(longest, 1024), this.colsVis);
    this.top = this.vs.pos; this.left = this.hs.pos;
    this.corner = { x: i.x + i.w - 16, y: i.y + i.h - 16 };
  }
  draw(r, win) {
    this.layout(r);
    field(r.x, r.y, r.w, r.h);
    ctx.save(); ctx.beginPath(); ctx.rect(this.ta.x, this.ta.y, this.ta.w, this.ta.h); ctx.clip();
    for (let k = 0; k < this.rows + 1; k++) {
      const line = this.lines[this.top + k]; if (line === undefined) break;
      const s = line.slice(this.left, this.left + this.colsVis + 1);
      if (s) text(esc(s), this.ta.x + 1, this.ta.y + k * this.lh, K.dk, false, this.f);
    }
    if (win.isActive && blinkOn && this.cy >= this.top && this.cx >= this.left)
      fill(this.ta.x + 1 + (this.cx - this.left) * this.cw, this.ta.y + (this.cy - this.top) * this.lh, 1, this.lh, K.dk);
    ctx.restore();
    this.vs.draw(); this.hs.draw();
    fill(this.corner.x, this.corner.y, 16, 16, K.face);
  }
  show() {
    if (!this.rows) return;
    if (this.cy < this.top) this.top = this.cy;
    if (this.cy >= this.top + this.rows) this.top = this.cy - this.rows + 1;
    if (this.cx < this.left) this.left = Math.max(0, this.cx - 8);
    if (this.cx > this.left + this.colsVis - 1) this.left = this.cx - this.colsVis + 8;
    blinkOn = true;
  }
  down(x, y) {
    if (this.vs.contains(x, y)) return this.vs.down(x, y);
    if (this.hs.contains(x, y)) return this.hs.down(x, y);
    if (!inR(this.ta, x, y)) return null;
    const place = (px, py) => {
      this.cy = clamp(this.top + Math.floor((py - this.ta.y) / this.lh), 0, this.lines.length - 1);
      this.cx = clamp(this.left + Math.round((px - this.ta.x - 1) / this.cw), 0, this.lines[this.cy].length);
      blinkOn = true;
    };
    place(x, y);
    return { move: place };
  }
  cursor(x, y) { return inR(this.ta, x, y) ? 'ibeam' : null; }
  insert(s) {
    const L = this.lines, l = L[this.cy];
    const parts = s.split('\n');
    if (parts.length === 1) { L[this.cy] = l.slice(0, this.cx) + s + l.slice(this.cx); this.cx += s.length; }
    else {
      const tail = l.slice(this.cx);
      L[this.cy] = l.slice(0, this.cx) + parts[0];
      L.splice(this.cy + 1, 0, ...parts.slice(1));
      this.cy += parts.length - 1; this.cx = L[this.cy].length; L[this.cy] += tail;
    }
  }
  key(e) {
    const L = this.lines, k = e.key;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k.length === 1) this.insert(k);
    else if (k === 'Enter') this.insert('\n');
    else if (k === 'Tab') this.insert(' '.repeat(8 - (this.cx % 8)));
    else if (k === 'Backspace') {
      if (this.cx > 0) { L[this.cy] = L[this.cy].slice(0, this.cx - 1) + L[this.cy].slice(this.cx); this.cx--; }
      else if (this.cy > 0) { this.cx = L[this.cy - 1].length; L[this.cy - 1] += L[this.cy]; L.splice(this.cy, 1); this.cy--; }
    } else if (k === 'Delete') {
      if (this.cx < L[this.cy].length) L[this.cy] = L[this.cy].slice(0, this.cx) + L[this.cy].slice(this.cx + 1);
      else if (this.cy < L.length - 1) { L[this.cy] += L[this.cy + 1]; L.splice(this.cy + 1, 1); }
    } else if (k === 'ArrowLeft') { if (this.cx > 0) this.cx--; else if (this.cy > 0) { this.cy--; this.cx = L[this.cy].length; } }
    else if (k === 'ArrowRight') { if (this.cx < L[this.cy].length) this.cx++; else if (this.cy < L.length - 1) { this.cy++; this.cx = 0; } }
    else if (k === 'ArrowUp') { if (this.cy > 0) { this.cy--; this.cx = Math.min(this.cx, L[this.cy].length); } }
    else if (k === 'ArrowDown') { if (this.cy < L.length - 1) { this.cy++; this.cx = Math.min(this.cx, L[this.cy].length); } }
    else if (k === 'Home') this.cx = 0;
    else if (k === 'End') this.cx = L[this.cy].length;
    else if (k === 'PageUp') { this.cy = Math.max(0, this.cy - this.rows); this.cx = Math.min(this.cx, L[this.cy].length); }
    else if (k === 'PageDown') { this.cy = Math.min(L.length - 1, this.cy + this.rows); this.cx = Math.min(this.cx, L[this.cy].length); }
    else return false;
    this.show(); return true;
  }
}
function notepad(name = 'Untitled', txt = '') {
  const p = nextPos(440, 300);
  const np = new Notepad(txt);
  const w = new Win({
    ...p, w: 440, h: 300, title: `${name} - Notepad`, icon: 'notepad', minW: 160, minH: 100, body: np,
    menu: [
      { label: '&File', items: () => [{ label: '&New', fn: () => { np.lines = ['']; np.cx = np.cy = np.top = np.left = 0; w.title = 'Untitled - Notepad'; } },
        { label: '&Open...' }, { label: '&Save' }, { label: 'Save &As...' }, { sep: true }, { label: 'Page Se&tup...' }, { label: '&Print' }, { sep: true }, { label: 'E&xit', fn: () => closeWin(w) }] },
      { label: '&Edit', items: [{ label: '&Undo', acc: 'Ctrl+Z', disabled: true }, { sep: true }, { label: 'Cu&t', acc: 'Ctrl+X', disabled: true }, { label: '&Copy', acc: 'Ctrl+C', disabled: true },
        { label: '&Paste', acc: 'Ctrl+V', disabled: true }, { label: 'De&lete', acc: 'Del', disabled: true }, { sep: true }, { label: 'Select &All' },
        { label: 'Time/&Date', acc: 'F5', fn: () => { np.insert(timeDate()); np.show(); } }, { sep: true }, { label: '&Word Wrap' }] },
      { label: '&Search', items: [{ label: '&Find...' }, { label: 'Find &Next', acc: 'F3' }] },
      { label: '&Help', items: [{ label: '&Help Topics' }, { sep: true }, { label: '&About Notepad', fn: () => msgBox('About Notepad', 'Microsoft Notepad\nWindows 95', 'info') }] },
    ],
  });
  return openWin(w);
}

// ---------------------------------------------------------------- dialogs
class DialogBody {
  constructor(ctrls, o = {}) {
    this.c = ctrls; this.o = o;
    this.focus = ctrls.findIndex(c => c.focus);
    if (this.focus < 0) this.focus = ctrls.findIndex(c => c.def);
  }
  abs(c) { return { x: this.r.x + c.x, y: this.r.y + c.y, w: c.w || 0, h: c.h || 0 }; }
  draw(r, win) {
    this.r = r;
    this.c.forEach((c, i) => {
      const a = this.abs(c), foc = i === this.focus && win.isActive;
      if (c.type === 'label') wrap(c.text, c.w || 9999).forEach((l, j) => text(c.amp ? l : esc(l), a.x, a.y + j * 13));
      else if (c.type === 'icon') icon(c.name, a.x, a.y);
      else if (c.type === 'button') pushButton(a.x, a.y, a.w, a.h, c.label, { def: c.def && !this.c.some(o => o.type === 'button' && o !== c && this.c.indexOf(o) === this.focus), pressed: c.pressed, focus: foc });
      else if (c.type === 'radio') {
        radio(a.x, a.y + 1, c.checked); text(c.label, a.x + 18, a.y);
        if (foc) focusRect(a.x + 16, a.y - 1, textW(c.label) + 4, 15);
      } else if (c.type === 'edit') {
        field(a.x, a.y, a.w, a.h);
        const ty = a.y + ((a.h - 13) >> 1);
        text(esc(c.value), a.x + 3, ty);
        if (c.combo) { const bx = a.x + a.w - 2 - 16; btnUp(bx, a.y + 2, 16, a.h - 4); mglyph('down', bx + 4, a.y + 2 + ((a.h - 4 - 4) >> 1)); }
        if (foc && blinkOn) fill(a.x + 3 + textW(esc(c.value.slice(0, c.caret))), ty, 1, 13, K.dk);
      }
    });
  }
  ctrlAt(x, y) { return this.c.findIndex(c => c.type !== 'label' && c.type !== 'icon' && inR(c.type === 'radio' ? { ...this.abs(c), w: 18 + textW(c.label), h: 14 } : this.abs(c), x, y)); }
  down(x, y) {
    const i = this.ctrlAt(x, y); if (i < 0) return null;
    const c = this.c[i]; this.focus = i;
    if (c.type === 'radio') { this.pick(c); return null; }
    if (c.type === 'edit') { c.caret = c.value.length; return null; }
    if (c.type === 'button') {
      c.pressed = true;
      return { move: (mx, my) => { c.pressed = inR(this.abs(c), mx, my); }, up: (mx, my) => { const hit = inR(this.abs(c), mx, my); c.pressed = false; if (hit && c.fn) c.fn(); } };
    }
    return null;
  }
  cursor(x, y) { const i = this.ctrlAt(x, y); return i >= 0 && this.c[i].type === 'edit' ? 'ibeam' : null; }
  pick(c) { this.c.forEach(o => { if (o.type === 'radio' && o.group === c.group) o.checked = o === c; }); }
  key(e) {
    const c = this.c[this.focus];
    if (e.key === 'Tab') {
      const f = this.c.map((o, i) => i).filter(i => ['button', 'edit', 'radio'].includes(this.c[i].type) && (this.c[i].type !== 'radio' || this.c[i].checked));
      const k = f.indexOf(this.focus); this.focus = f[(k + (e.shiftKey ? f.length - 1 : 1)) % f.length]; return true;
    }
    if (e.key === 'Enter') { const b = c && c.type === 'button' ? c : this.c.find(o => o.def); if (b && b.fn) b.fn(); return true; }
    if (e.key === 'Escape') { const b = this.c.find(o => o.cancel); if (b && b.fn) b.fn(); return true; }
    if (e.key === ' ' && c && c.type === 'button') { if (c.fn) c.fn(); return true; }
    if (c && c.type === 'radio' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const g = this.c.filter(o => o.type === 'radio' && o.group === c.group);
      const n = g[(g.indexOf(c) + (e.key === 'ArrowDown' ? 1 : g.length - 1)) % g.length];
      this.pick(n); this.focus = this.c.indexOf(n); return true;
    }
    if (c && c.type === 'edit' && !e.ctrlKey && !e.metaKey) {
      const v = c.value;
      if (e.key.length === 1) { c.value = v.slice(0, c.caret) + e.key + v.slice(c.caret); c.caret++; }
      else if (e.key === 'Backspace') { if (c.caret > 0) { c.value = v.slice(0, c.caret - 1) + v.slice(c.caret); c.caret--; } }
      else if (e.key === 'Delete') c.value = v.slice(0, c.caret) + v.slice(c.caret + 1);
      else if (e.key === 'ArrowLeft') c.caret = Math.max(0, c.caret - 1);
      else if (e.key === 'ArrowRight') c.caret = Math.min(v.length, c.caret + 1);
      else if (e.key === 'Home') c.caret = 0;
      else if (e.key === 'End') c.caret = v.length;
      else return false;
      blinkOn = true; return true;
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
  const lines = msg.split('\n'), tw = Math.max(...lines.map(l => textW(esc(l)))), th = lines.length * 13;
  const tx = type ? 12 + 32 + 16 : 12, bw = buttons.length * 75 + (buttons.length - 1) * 6;
  const cw = Math.max(tx + tw + 14, bw + 24, 120);
  const by = 12 + Math.max(type ? 32 : 0, th) + 16, ch = by + 23 + 11;
  let win;
  const done = b => { closeWin(win); if (cb) cb(b); };
  const ctrls = [];
  if (type) ctrls.push({ type: 'icon', name: type, x: 12, y: 12 });
  ctrls.push({ type: 'label', text: msg, x: tx, y: 12 + Math.max(0, ((type ? 32 : 0) - th) >> 1) });
  buttons.forEach((b, i) => ctrls.push({ type: 'button', label: b, x: ((cw - bw) >> 1) + i * 81, y: by, w: 75, h: 23, def: i === 0, cancel: buttons.length === 1 || i === buttons.length - 1, fn: () => done(b) }));
  win = dialog(title, cw, ch, ctrls);
  win.body.onClose = null;
  return win;
}
function aboutWin95() { msgBox('About Windows 95', 'Microsoft Windows 95\n4.00.950 B\nCopyright \u00a9 1981-1996 Microsoft Corp.', 'info'); }

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
    { type: 'button', label: '&Browse...', x: 255, y: 84, w: 75, h: 23 },
  ], { modal: false, noTask: false });
}
function runCommand(v) {
  const c = v.toLowerCase().replace(/^"|"$/g, '');
  if (!c) return;
  if (c === 'notepad' || c === 'notepad.exe') return notepad();
  if (c === 'explorer' || c === 'explorer.exe') return openFolder(FS.mycomputer);
  if (/^c:\\?$/.test(c)) return openFolder(FS.mycomputer.children[1]);
  if (/^d:\\?$/.test(c)) return openFolder(FS.mycomputer.children[2]);
  if (/^a:\\?$/.test(c)) return msgBox('3\u00bd Floppy (A:)', 'A:\\ is not accessible.\n\nThe device is not ready.', 'error');
  msgBox(v, `Cannot find the file '${v}' (or one of its components). Make sure the\npath and filename are correct and that all required libraries are available.`, 'error');
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
    if (pick === 3) { [...windows].forEach(closeWin); return; }
    shutdownSeq(pick !== 0);
  };
  const bx = (cw - (3 * 75 + 12)) >> 1;
  win = dialog('Shut Down Windows', cw, 150, [
    { type: 'icon', name: 'shutdown32', x: 14, y: 12 },
    { type: 'label', text: 'Are you sure you want to:', x: 60, y: 14 },
    ...radios,
    { type: 'button', label: '&Yes', x: bx, y: 118, w: 75, h: 23, def: true, fn: yes },
    { type: 'button', label: '&No', x: bx + 81, y: 118, w: 75, h: 23, cancel: true, fn: () => closeWin(win) },
    { type: 'button', label: '&Help', x: bx + 162, y: 118, w: 75, h: 23 },
  ], { dim: true });
}
function shutdownSeq(restart) {
  [...windows].forEach(closeWin); closeMenus();
  screen = 'logow'; dirty();
  setTimeout(() => {
    if (restart) { screen = 'black'; dirty(); setTimeout(boot, 1200); } else { screen = 'logos'; dirty(); }
  }, 2600);
}
function boot() { screen = 'desktop'; resetDesktop(); active = null; dirty(); }

// ---------------------------------------------------------------- desktop
let desk = { icons: [], sel: -1 };
function resetDesktop() {
  desk = { sel: -1, icons: [FS.mycomputer, FS.network, FS.recycle].map((node, i) => ({ node, gx: 0, gy: i })) };
  layoutDesk();
}
function layoutDesk() {
  for (const d of desk.icons) {
    if (d.gx !== undefined) { d.x = d.gx * 75 + 21; d.y = d.gy * 75 + 6; delete d.gx; delete d.gy; }
    const lines = wrap(d.node.label, 72), lw = Math.max(...lines.map(l => textW(esc(l))));
    Object.assign(d, { ix: d.x, iy: d.y, lines, lw, lx: d.x + 16 - (lw >> 1), ly: d.y + 35 });
  }
}
function deskIconAt(x, y) {
  for (let i = desk.icons.length - 1; i >= 0; i--) {
    const c = desk.icons[i];
    if (inR({ x: c.ix, y: c.iy, w: 32, h: 32 }, x, y) || inR({ x: c.lx - 1, y: c.ly, w: c.lw + 2, h: c.lines.length * 13 }, x, y)) return i;
  }
  return -1;
}
function drawDesktop() {
  fill(0, 0, W, H, K.desk);
  desk.icons.forEach((c, i) => {
    if (ghost && ghost.i === i) return;
    drawIconLabel(c, i === desk.sel, active === null && !modal(), K.hl, K.desk);
  });
  if (ghost) {
    const c = desk.icons[ghost.i];
    ctx.save(); ctx.globalAlpha = 0.6;
    drawIconLabel({ ...c, ix: c.ix + ghost.dx, iy: c.iy + ghost.dy, lx: c.lx + ghost.dx, ly: c.ly + ghost.dy }, true, true, K.hl, K.desk);
    ctx.restore();
  }
}
const DESK_MENU = () => [
  { label: 'Arrange &Icons', sub: [{ label: 'by &Name', fn: () => arrangeDesk() }, { label: 'by &Type', fn: () => arrangeDesk() }, { label: 'by Si&ze', fn: () => arrangeDesk() }, { label: 'by &Date', fn: () => arrangeDesk() }, { sep: true }, { label: '&Auto Arrange' }] },
  { label: 'Line &up Icons', fn: lineUpDesk },
  { sep: true }, { label: '&Paste', disabled: true }, { label: 'Paste &Shortcut', disabled: true },
  { sep: true }, { label: 'Ne&w', sub: [{ label: '&Folder' }, { label: '&Shortcut' }, { sep: true }, { label: 'Text Document' }] },
  { sep: true }, { label: 'P&roperties' },
];
function arrangeDesk() {
  const rows = Math.max(1, Math.floor((H - TB - 6) / 75));
  desk.icons.forEach((d, i) => { d.x = Math.floor(i / rows) * 75 + 21; d.y = (i % rows) * 75 + 6; });
  layoutDesk();
}
function lineUpDesk() {
  for (const d of desk.icons) { d.x = Math.max(0, Math.round((d.x - 21) / 75)) * 75 + 21; d.y = Math.max(0, Math.round((d.y - 6) / 75)) * 75 + 6; }
  layoutDesk();
}
function deskDown(x, y, btn, dbl) {
  active = null;
  const i = deskIconAt(x, y); desk.sel = i;
  if (btn === 2) {
    if (i >= 0) { const n = desk.icons[i].node; openPopup([{ label: '&Open', bold: true, fn: () => openItem(n) }, { label: '&Explore', fn: () => openItem(n) }, { sep: true }, { label: 'P&roperties' }], x, y); }
    else openPopup(DESK_MENU(), x, y);
    return;
  }
  if (i < 0) return;
  if (dbl) { openItem(desk.icons[i].node); return; }
  const sx = x, sy = y;
  cap = {
    move: (mx, my) => { if (ghost || Math.abs(mx - sx) > 2 || Math.abs(my - sy) > 2) ghost = { i, dx: mx - sx, dy: my - sy }; },
    up: () => {
      if (ghost) {
        const d = desk.icons[ghost.i];
        d.x = clamp(d.x + ghost.dx, 0, W - 32); d.y = clamp(d.y + ghost.dy, 0, H - TB - 48); ghost = null; layoutDesk();
      }
    },
  };
}

// ---------------------------------------------------------------- taskbar
function clockStr() { const d = new Date(); const h = d.getHours() % 12 || 12; return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`; }
function timeDate() { const d = new Date(); return `${clockStr()} ${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; }
function taskLayout() {
  const y = H - TB;
  const start = { x: 2, y: y + 4, w: 54, h: 22 };
  const cw = textW(clockStr()) + 14;
  const tray = { x: W - 2 - cw, y: y + 4, w: cw, h: 22 };
  const x0 = start.x + start.w + 3, avail = tray.x - 3 - x0, n = tasks.length;
  const bw = n ? Math.min(160, Math.floor((avail - (n - 1) * 3) / n)) : 0;
  const btns = tasks.map((t, i) => ({ t, x: x0 + i * (bw + 3), y: y + 4, w: bw, h: 22 }));
  return { y, start, tray, btns };
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
  const t = L.tray; edge(t.x, t.y, t.w, t.h, K.sh, K.hl);
  const cs = clockStr(); text(cs, t.x + t.w - 7 - textW(cs), t.y + 4);
}
function taskDown(x, y, btn) {
  const L = taskLayout();
  if (inR(L.start, x, y)) { if (menuSrc && menuSrc.kind === 'start') closeMenus(); else openStart(); return; }
  const b = L.btns.find(v => inR(v, x, y));
  if (b) {
    if (btn === 2) { activate(b.t); sysMenu(b.t, x, y - 4, true); return; }
    if (b.t === active && !b.t.min) minimize(b.t); else activate(b.t);
    return;
  }
  if (btn === 2 && !inR(L.tray, x, y)) {
    openPopup([
      { label: '&Cascade', fn: cascadeAll }, { label: 'Tile &Horizontally', fn: () => tileAll(false) }, { label: 'Tile &Vertically', fn: () => tileAll(true) },
      { sep: true }, { label: '&Minimize All Windows', fn: () => tasks.forEach(minimize) }, { sep: true }, { label: 'P&roperties' },
    ], x, y);
    const m = menus[0]; placeMenu(m, x, y - m.h);
  }
}
function restorable() { return tasks.filter(t => !t.min && t.resizable); }
function cascadeAll() {
  restorable().forEach((t, i) => { if (t.max) toggleMax(t); Object.assign(t, { x: i * 22, y: i * 22, w: Math.min(t.w, W - i * 22), h: Math.min(t.h, H - TB - i * 22) }); activate(t); });
}
function tileAll(vert) {
  const ts = restorable(), n = ts.length; if (!n) return;
  ts.forEach((t, i) => {
    if (t.max) toggleMax(t);
    if (vert) Object.assign(t, { x: Math.floor(i * W / n), y: 0, w: Math.floor(W / n), h: H - TB });
    else Object.assign(t, { x: 0, y: Math.floor(i * (H - TB) / n), w: W, h: Math.floor((H - TB) / n) });
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

// ---------------------------------------------------------------- start menu
const START = [
  { label: '&Programs', icon: 'programs', sub: () => [
    { label: 'Accessories', icon: 'programs', sub: [{ label: 'Notepad', icon: 'notepad', fn: () => notepad() }] },
    { label: 'StartUp', icon: 'programs', sub: [] },
    { label: 'Windows Explorer', icon: 'explorer', fn: () => openFolder(FS.mycomputer) },
  ] },
  { label: '&Documents', icon: 'documents', sub: [] },
  { label: '&Settings', icon: 'settings', sub: [
    { label: '&Control Panel', icon: 'controlpanel', fn: () => openFolder(FS.mycomputer.children[3]) },
    { label: '&Printers', icon: 'printers', fn: () => openFolder(FS.mycomputer.children[4]) },
  ] },
  { label: '&Find', icon: 'find', sub: [
    { label: '&Files or Folders...', icon: 'findfiles' },
    { label: '&Computer...', icon: 'findcomp' },
  ] },
  { label: '&Help', icon: 'help' },
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
  for (const w of windows) if (!w.min && !(m && m.dim && w === m)) w.draw();
  drawTaskbar();
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
  const c = CUR[name] || CUR.arrow; if (!c || mouse.x < 0) return;
  ctx.drawImage(c.i, mouse.x - c.hx, mouse.y - c.hy);
}
const SIZE_CUR = { n: 'sizens', s: 'sizens', e: 'sizewe', w: 'sizewe', nw: 'sizenwse', se: 'sizenwse', ne: 'sizenesw', sw: 'sizenesw' };
function cursorAt(x, y) {
  if (drag) return drag.cursor;
  if (menus.length && menuAt(x, y) >= 0) return 'arrow';
  if (y >= H - TB) return 'arrow';
  const w = winAt(x, y);
  if (!w || (modal() && w !== modal())) return 'arrow';
  const part = w.hit(x, y);
  if (SIZE_CUR[part]) return SIZE_CUR[part];
  if (part === 'client' && w.body && w.body.cursor) return w.body.cursor(x, y) || 'arrow';
  return 'arrow';
}

// ---------------------------------------------------------------- input
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
      move: (mx, my) => { drag.r.x = mx - ox; drag.r.y = clamp(my - oy, -w.b, H - TB - 8); },
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
  e.preventDefault(); cv.focus();
  const [x, y] = pos(e); mouse = { x, y };
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
  const btn = e.button === 2 ? 2 : 0, now = performance.now();
  const dbl = btn === 0 && now - lastDown.t < 500 && Math.abs(x - lastDown.x) <= 4 && Math.abs(y - lastDown.y) <= 4;
  lastDown = dbl ? { t: 0, x, y } : { t: btn === 0 ? now : 0, x, y };
  hideTip();
  if (screen === 'logos') { screen = 'black'; dirty(); setTimeout(boot, 1200); return; }
  if (screen !== 'desktop') return;
  if (menus.length && menuDown(x, y)) { dirty(); return; }
  const m = modal();
  if (y >= H - TB) { if (!m) taskDown(x, y, btn); dirty(); return; }
  const w = winAt(x, y);
  if (m && w !== m) { activate(m); dirty(); return; }
  if (w) winDown(w, x, y, btn, dbl); else deskDown(x, y, btn, dbl);
  dirty();
});
cv.addEventListener('pointermove', e => {
  const [x, y] = pos(e); mouse = { x, y };
  if (cap && cap.move) cap.move(x, y);
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
  const t = taskLayout().tray;
  if (inR(t, x, y) && screen === 'desktop' && !menus.length) {
    if (!tip && !tipTimer) tipTimer = setTimeout(() => {
      const d = new Date();
      tip = { text: d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), x: mouse.x, y: H - TB - 20 };
      dirty();
    }, 600);
  } else hideTip();
  dirty();
});
function hideTip() { clearTimeout(tipTimer); tipTimer = 0; if (tip) { tip = null; dirty(); } }
cv.addEventListener('pointerup', e => {
  const [x, y] = pos(e);
  if (cap) { const c = cap; cap = null; if (c.up) c.up(x, y); dirty(); return; }
  if (menus.length) {
    const d = menuAt(x, y);
    if (d >= 0) { const i = rowAt(menus[d], x, y); if (i >= 0) activateItem(menus[d].items[i]); }
  }
  dirty();
});
cv.addEventListener('pointerleave', () => { mouse = { x: -100, y: -100 }; hideTip(); dirty(); });
cv.addEventListener('contextmenu', e => e.preventDefault());

window.addEventListener('keydown', e => {
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
    else if (e.key === 'Enter') {
      const it = m.items[m.hover];
      if (it && it.sub) { openSub(d, m.hover); menus[d + 1].hover = 0; } else activateItem(it);
      handled = true;
    }
  } else {
    const target = modal() || active;
    if (target && target.body && target.body.key) handled = target.body.key(e);
    if (!handled && target && e.key === 'F4' && e.altKey) { closeWin(target); handled = true; }
    if (!handled && !target) {
      const n = desk.icons.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { desk.sel = (desk.sel + 1) % n; handled = true; }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { desk.sel = (desk.sel + n - 1) % n; handled = true; }
      else if (e.key === 'Enter' && desk.sel >= 0) { openItem(desk.icons[desk.sel].node); handled = true; }
    }
  }
  if (handled || ['Tab', 'Backspace', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
  dirty();
});

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

Promise.all(ready).then(() => { resize(); resetDesktop(); cv.focus(); dirty(); });
window.win95 = { openFolder, notepad, msgBox, runDialog, shutDownDialog, FS, get windows() { return windows; } };
})();
