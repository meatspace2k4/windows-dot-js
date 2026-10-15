// Deterministic page for history replays: injected before any page script (DevTools
// Page.addScriptToEvaluateOnNewDocument), so it works on every commit without changes to the shell.
//
// - Time is virtual. performance.now, Date and every timer read one clock that moves only while a replay
//   step runs; each clock read advances it 1 µs, so guest code that waits for time to pass finishes.
// - Timers and animation frames fire in (time, order) sequence, one per turn of the page's event loop, and
//   only after every tracked asynchronous host operation (fetch, wasm compile, digests, image and font loads)
//   has settled, so real I/O speed cannot reorder them.
// - Math.random is seeded. There is no IndexedDB, so each run starts from a fresh disk and registry.
// - __replay.run(fn) runs one step: the clock runs while it is pending and stops when it settles.
(() => {
  if (window.__replay) return;
  const real = { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), now: performance.now.bind(performance), Date };
  let EPOCH = Date.UTC(2026, 9, 14, 12, 0, 0);
  try { const e = +sessionStorage.getItem('__replayEpoch'); if (e) EPOCH = e; } catch (_) {}   // the recorded time this page loaded at
  let holding = false;
  let vnow = 0, seq = 0, active = 0, pending = 0, turn = null, released = false;
  const timers = new Map();            // id -> { at, seq, fn, args, every }
  const due = () => { let best = null; for (const t of timers.values()) if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t; return best; };
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { turn = null; pump(); };
  const schedule = () => { if (!turn && active) { turn = 1; ch.port2.postMessage(0); } };
  function pump() {
    if (!active || pending) return;    // a tracked host operation settling schedules the next turn
    const t = due(); if (!t) return;
    if (released && t.at > performance.now()) { if (!turn) { turn = 1; real.setTimeout(() => { turn = null; pump(); }, t.at - vnow); } return; }
    vnow = Math.max(vnow, t.at);
    if (t.every !== undefined) { t.at = vnow + t.every; t.seq = ++seq; } else timers.delete(t.id);
    try { t.fn(...t.args); } catch (e) { real.setTimeout(() => { throw e; }); }
    schedule();
  }
  const add = (fn, ms, args, every) => {
    const id = ++seq; if (typeof fn !== 'function') { const src = String(fn); fn = () => (0, eval)(src); }
    timers.set(id, { id, at: vnow + Math.max(0, +ms || 0), seq: id, fn, args, every }); schedule(); return id;
  };
  window.setTimeout = (fn, ms, ...args) => add(fn, ms, args);
  window.setInterval = (fn, ms, ...args) => add(fn, ms, args, Math.max(1, +ms || 0));
  window.clearTimeout = window.clearInterval = id => { timers.delete(id); };
  // after each frame the page draws: the held frame (see below) comes off once the shell's canvas has content
  const drawn = () => { const c = document.getElementById('screen'); if (!c || !c.width) return false;
    try { const g = c.getContext('2d'); if (!g) return true; const d = g.getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4 * 97) if (d[i] && (d[i - 1] | d[i - 2] | d[i - 3])) return true; } catch (_) { return true; } return false; };
  window.requestAnimationFrame = fn => add(() => { fn(vnow); if (holding && drawn()) { holding = false; const h = document.getElementById('__replay_hold'); if (h) h.remove(); } }, (Math.floor(vnow / 16.667) + 1) * 16.667 - vnow, []);
  window.cancelAnimationFrame = id => { timers.delete(id); };
  window.requestIdleCallback = fn => add(() => fn({ didTimeout: false, timeRemaining: () => 0 }), 0, []);
  window.cancelIdleCallback = id => { timers.delete(id); };
  performance.now = () => (vnow += 0.001);
  class VDate extends real.Date {
    constructor(...a) { if (a.length) super(...a); else super(EPOCH + (vnow += 0.001)); }
    static now() { return Math.floor(EPOCH + (vnow += 0.001)); }
  }
  window.Date = VDate;
  // seeded random (mulberry32)
  let s = 0x9e3779b9; Math.random = () => { s |= 0; s = s + 0x6d2b79f5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  if (crypto.getRandomValues) { const g = crypto.getRandomValues.bind(crypto); crypto.getRandomValues = a => { const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < b.length; i++) b[i] = Math.random() * 256 | 0; return a; }; void g; }
  // IndexedDB stays (the shell keeps its disk and registry there across page loads, as the session did); each
  // request holds the clock until it completes, so its real timing cannot reorder anything. The run clears the store
  // once at its start.
  const trackReq = r => { if (r && r.addEventListener) track(new Promise(ok => { r.addEventListener('success', ok, { once: true }); r.addEventListener('error', ok, { once: true }); r.addEventListener('blocked', ok, { once: true }); })); return r; };
  if (window.IDBFactory) { const o = IDBFactory.prototype.open; IDBFactory.prototype.open = function (...a) { return trackReq(o.apply(this, a)); }; }
  for (const C of [window.IDBObjectStore, window.IDBIndex]) if (C) for (const m of ['get', 'getAll', 'getAllKeys', 'getKey', 'count', 'put', 'add', 'delete', 'clear', 'openCursor', 'openKeyCursor'])
    if (C.prototype[m]) { const f = C.prototype[m]; C.prototype[m] = function (...a) { return trackReq(f.apply(this, a)); }; }
  // no service worker: it would serve cached files from an earlier run
  if (navigator.serviceWorker) navigator.serviceWorker.register = () => new Promise(() => {});
  // host operations whose completion time is real: the clock waits for them
  const track = p => { pending++; const done = () => { pending--; schedule(); }; p.then(done, done); return p; };
  const wrap = (obj, name) => { const f = obj && obj[name]; if (typeof f === 'function') obj[name] = function (...a) { return track(f.apply(this, a)); }; };
  wrap(window, 'fetch'); wrap(window, 'createImageBitmap');
  wrap(WebAssembly, 'compile'); wrap(WebAssembly, 'instantiate'); wrap(WebAssembly, 'compileStreaming'); wrap(WebAssembly, 'instantiateStreaming');
  if (crypto.subtle) wrap(crypto.subtle, 'digest');
  if (document.fonts) { const l = document.fonts.load.bind(document.fonts); document.fonts.load = (...a) => track(l(...a)); }
  // images loading through src (data URIs included), fonts, and reads of fetched or blob bodies
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, get() { return srcDesc.get.call(this); }, set(v) {
    // the load event comes later even for an image that reports itself complete (a data URI): wait for it
    track(new Promise(ok => { this.addEventListener('load', ok, { once: true }); this.addEventListener('error', ok, { once: true }); real.setTimeout(ok, 10000); }));
    srcDesc.set.call(this, v);
  } });
  if (window.FontFace) wrap(FontFace.prototype, 'load');
  for (const m of ['arrayBuffer', 'text', 'json', 'blob']) { wrap(Response.prototype, m); }
  for (const m of ['arrayBuffer', 'text']) wrap(Blob.prototype, m);
  if (window.HTMLCanvasElement) { const tb = HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob = function (cb, ...a) { let done; track(new Promise(ok => done = ok)); return tb.call(this, b => { done(); cb(b); }, ...a); }; }
  if (window.OffscreenCanvas) wrap(OffscreenCanvas.prototype, 'convertToBlob');
  const dec = HTMLImageElement.prototype.decode; HTMLImageElement.prototype.decode = function () { return track(dec.call(this)); };
  // a script or image loading from the network: the clock waits until it has loaded or failed
  new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if ((n.tagName === 'SCRIPT' && n.src) || (n.tagName === 'IMG' && n.getAttribute('src'))) track(new Promise(ok => { n.addEventListener('load', ok, { once: true }); n.addEventListener('error', ok, { once: true }); })); })
    .observe(document, { childList: true, subtree: true });
  let leaving = false; addEventListener('beforeunload', () => { leaving = true; }); addEventListener('pagehide', () => { leaving = true; });
  const reload = Location.prototype.reload; try { Location.prototype.reload = function () { leaving = true; if (window.__replayReload) { window.__replayReload(location.href); return; } return reload.call(this); }; } catch (_) {}
  // the page paints its first frame as soon as it has loaded, as it would in real time, without waiting for the
  // driver; the driver's next step waits for that frame (firstFrame) so the amount of time it covers is fixed
  // across a reload, the page shows the frame it left on until it paints its own: the raw pixels, kept in this tab's
  // sessionStorage, are drawn onto an overlay canvas before the new document's first paint (synchronously: an image
  // would decode too late)
  try {
    const held = sessionStorage.getItem('__replayFrame');
    if (held) {
      const { w, h, k, b } = JSON.parse(held), bin = atob(b), px = new Uint8ClampedArray(bin.length);
      for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
      { let z = 0; for (let i = 0; i < px.length; i += 4) if (!(px[i] | px[i + 1] | px[i + 2])) z++; window.__holdInfo = [w, h, k, +(z / (px.length / 4)).toFixed(2)]; }
      const c = document.createElement('canvas'); c.id = '__replay_hold'; c.width = w; c.height = h;
      c.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
      c.style.cssText = `position:fixed;left:0;top:0;width:${w * k}px;height:${h * k}px;z-index:2147483646;pointer-events:none;image-rendering:pixelated`;
      // the injected script runs before <html> exists: attach as soon as it does, which is before the first paint
      const put = () => { document.documentElement.appendChild(c); holding = true; };
      if (document.documentElement) put();
      else { const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); put(); } }); mo.observe(document, { childList: true }); }
    }
  } catch (_) {}
  addEventListener('pagehide', () => {
    try {
      const c = document.getElementById('__replay_frozen') || document.getElementById('screen'); if (!c || !c.width) return;
      // full size when it fits the storage, else every other pixel (drawn back at twice the size)
      const k = c.width * c.height * 4 * 4 / 3 > 4e6 ? 2 : 1, w = Math.floor(c.width / k), h = Math.floor(c.height / k);
      const t = document.createElement('canvas'); t.width = w; t.height = h; const g = t.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(c, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data; let bin = ''; for (let i = 0; i < d.length; i += 32768) bin += String.fromCharCode.apply(null, d.subarray(i, i + 32768));
      sessionStorage.setItem('__replayFrame', JSON.stringify({ w, h, k: c.clientWidth / w || k, b: btoa(bin) }));
    } catch (_) { try { sessionStorage.removeItem('__replayFrame'); } catch (_) {} }
  });
  let firstFrame = Promise.resolve();
  addEventListener('load', () => { firstFrame = window.__replay.drive(new Promise(ok => add(ok, 17, []))); }, { once: true });
  // input from whoever is watching the window (mouse, keys, focus changes) never reaches the page: only the actions
  // the replay sends, between allow(1) and allow(0)
  // Chrome's own context menu never opens over the page (the session's pane showed none); the page's own handlers run
  addEventListener('contextmenu', e => e.preventDefault());
  let inputOpen = 0;
  const gate = e => { if (!inputOpen && e.isTrusted) { e.stopImmediatePropagation(); if (e.cancelable) e.preventDefault(); } };
  for (const type of ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel', 'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'pointercancel', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'keydown', 'keyup', 'keypress', 'touchstart', 'touchmove', 'touchend', 'blur', 'focus', 'focusin', 'focusout', 'visibilitychange', 'pagehide', 'pageshow'].filter(t => t !== 'pagehide' && t !== 'pageshow'))
    for (const target of [window, document]) target.addEventListener(type, gate, { capture: true, passive: false });
  window.__replay = {
    get now() { return vnow; }, get leaving() { return leaving; }, allow(on) { inputOpen = on ? 1 : 0; }, get timers() { return timers.size; }, get pending() { return pending; },
    // run one step with the clock going; resolves with the step's value
    async run(fn) { active++; schedule(); try { return await fn(); } finally { active--; } },
    // run the clock until promise `p` settles, and stop it in the same microtask: how far time gets does not depend
    // on when the driver hears about it
    drive(p) {
      active++; schedule();
      return Promise.resolve(p).then(v => { active--; return { value: v }; }, e => { active--; return { exception: String(e && e.stack || e).split('\n')[0] }; });
    },
    // let the clock run until nothing is scheduled before `ms` from now
    // the run is over: time runs on its own from here, so the page stays live for whoever looks at it
    release() { const base = vnow, t0 = real.now(); released = true; active = 1; performance.now = () => (vnow = Math.max(vnow, base + real.now() - t0)); schedule(); },
    // the replay's progress, drawn over the page; it takes no input and no part in the page's own layout
    status(text) {
      let el = document.getElementById('__replay_status');
      if (!el) {
        el = document.createElement('div'); el.id = '__replay_status';
        el.style.cssText = 'position:fixed;right:6px;top:6px;z-index:2147483647;pointer-events:none;max-width:60%;padding:4px 7px;font:10px/1.35 Menlo,monospace;color:#fff;background:rgba(0,0,0,.72);border-radius:4px;white-space:pre-wrap;word-break:break-all';
        (document.body || document.documentElement).appendChild(el);
      }
      // the step's own elapsed time, counted on a real timer of its own (outside the page's clock)
      const t0 = real.now(); clearTimeout(this._tick);
      const draw = () => { const sec = Math.floor((real.now() - t0) / 1000); el.textContent = text + (sec >= 2 ? `   (this step: ${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s)` : ''); };
      draw(); const loop = () => { draw(); this._tick = real.setTimeout(loop, 1000); }; this._tick = real.setTimeout(loop, 1000);
    },
    // keep what shows now on screen through what comes next (a resize clears the shell's canvas): a copy over it
    freeze() {
      const c = document.getElementById('screen'); if (!c || !c.width) return false;
      const f = document.createElement('canvas'); f.id = '__replay_frozen'; f.width = c.width; f.height = c.height; f.getContext('2d').drawImage(c, 0, 0);
      f.style.cssText = `position:fixed;left:0;top:0;width:${c.clientWidth}px;height:${c.clientHeight}px;z-index:2147483645;pointer-events:none;image-rendering:pixelated`;
      document.documentElement.appendChild(f); return true;
    },
    async advance(ms) { await firstFrame; return this.drive(new Promise(ok => add(ok, ms, []))); },
    ready() { return firstFrame.then(() => true); },
  };
})();
