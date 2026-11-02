'use strict';
// Ring α: the ground the processor's rings stand on, from which the machine's time is braided. A moment is the whole
// machine at an instant, kept in memory and put back later (rewound), so the system's run is a line to move along,
// not a sequence to repeat: a lock-up or a crash is left by going back to a moment before it and running on, with
// the code changed meanwhile if need be (the scripts loaded over the machine as it runs, cmd 'reload', are not part
// of a moment: it is named in it and runs under whatever is loaded when it is rewound to).
//
// A moment is a record of named sections, each a part of the machine's state, with a checksum over all of them and
// the signature of the build that made it (braid.js, win32.js, ne16.js, vmm.js, v86.js, dyn.js, fs.js: the code that
// gives the state its meaning), so a moment is never put back into code that reads it differently.
//
//   memory     the processor's memory, whole (the WebAssembly memories of the machine's processes)
//   cpu        every register, as WebAssembly globals (the running thread's; the others' contexts are in `host`)
//   host       the machine's own objects: threads, tasks, windows USER keeps for the host, VxD time-outs, the VMs,
//              heaps, faults, logs: the graph of the machine's objects, each kept by identity and put back in place,
//              so what holds a reference to one (a closure, the page) holds the restored one
//   probe      what the lint reads: the threads, who holds the Win16Lock, the faults, the heap (a small record)
//   registry   the registry, as its store loads it
//   disk       (the page's) the file system's volumes, by the same graph
//   mods       the scripts loaded over the machine while it ran: named, not kept
//
// The graph: an object is walked through its own data properties (never its getters, never its prototype); a Map, a
// Set and an Array through their contents; a typed array and an ArrayBuffer are copied; a canvas by its pixels; a
// function, a promise, a module, an instance and any platform object are kept by reference, not walked. Rewinding
// writes each object's properties back into the same object, so nothing made since the moment is reached from it
// any more, and nothing that held an object before the moment loses it.
(function () {
const MAGIC = 'W95BRAID', VERSION = 1;
class Ref { constructor(i) { this.i = i; } }
const TAG = v => Object.prototype.toString.call(v);
const isTA = v => ArrayBuffer.isView(v) && !(v instanceof DataView);
const hasWasm = typeof WebAssembly === 'object';
const hasShared = typeof SharedArrayBuffer === 'function';
const isCanvas = v => (typeof OffscreenCanvas === 'function' && v instanceof OffscreenCanvas) || (typeof HTMLCanvasElement === 'function' && v instanceof HTMLCanvasElement);
const isCtx = v => (typeof OffscreenCanvasRenderingContext2D === 'function' && v instanceof OffscreenCanvasRenderingContext2D) || (typeof CanvasRenderingContext2D === 'function' && v instanceof CanvasRenderingContext2D);
const isImageData = v => typeof ImageData === 'function' && v instanceof ImageData;

// ---------------------------------------------------------------- the checksum: FNV-1a over bytes, 32 bits, cheap and good enough to tell a damaged copy
function fnv(h, bytes) { for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h; }
function fnvStr(h, s) { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193) >>> 0; } return h; }
const FNV0 = 0x811c9dc5;

// ---------------------------------------------------------------- the graph
/** the objects reachable from `roots`, each entry { o, kind, ... } by index; refs into them in the entries' contents.
 *  opts.opaque: a Set of objects kept by reference; opts.skip(obj, key): a property left out (a live thing of the host's) */
function takeGraph(roots, opts = {}) {
  const opaque = opts.opaque || new Set(), skip = opts.skip || (() => false);
  const entries = [], index = new Map();
  let bytes = 0;
  const ref = v => {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
    if (typeof v === 'function' || opaque.has(v)) return v;   // (by reference: the same function, the same opaque object)
    let i = index.get(v); if (i !== undefined) return new Ref(i);
    i = entries.length; index.set(v, i);
    const e = { o: v }; entries.push(e);
    if (hasWasm && v instanceof WebAssembly.Memory) { e.kind = 'mem'; e.bytes = new Uint8Array(v.buffer).slice(); bytes += e.bytes.length; return new Ref(i); }
    if (hasWasm && v instanceof WebAssembly.Global) { e.kind = 'global'; e.value = v.value; return new Ref(i); }
    if (v instanceof ArrayBuffer) { e.kind = 'ab'; e.bytes = new Uint8Array(v).slice(); bytes += e.bytes.length; return new Ref(i); }
    if (hasShared && v instanceof SharedArrayBuffer) { e.kind = 'ref'; return new Ref(i); }   // (shared with another worker or the page: a ring; a memory is copied through its Memory)
    if (isTA(v)) {
      if (hasShared && v.buffer instanceof SharedArrayBuffer) { e.kind = 'ref'; return new Ref(i); }
      e.kind = 'ta'; e.bytes = v.slice(); bytes += v.byteLength; return new Ref(i);
    }
    if (v instanceof DataView) { e.kind = 'ref'; return new Ref(i); }
    if (isCanvas(v) || isCtx(v)) {
      const c = isCtx(v) ? v.canvas : v; e.kind = 'canvas'; e.canvas = c; e.w = c.width; e.h = c.height;
      try { e.img = c.getContext('2d').getImageData(0, 0, Math.max(1, c.width), Math.max(1, c.height)); bytes += e.img.data.length; } catch (_) { e.img = null; }
      return new Ref(i);
    }
    if (isImageData(v)) { e.kind = 'ta'; e.bytes = v.data.slice(); e.ta = v.data; bytes += v.data.length; return new Ref(i); }
    const tag = TAG(v);
    if (v instanceof Map) { e.kind = 'map'; e.items = [...v].map(([k, x]) => [ref(k), ref(x)]); return new Ref(i); }
    if (v instanceof Set) { e.kind = 'set'; e.items = [...v].map(ref); return new Ref(i); }
    if (Array.isArray(v)) { e.kind = 'arr'; e.items = v.map(ref); return new Ref(i); }
    if (tag !== '[object Object]') { e.kind = 'ref'; return new Ref(i); }   // (a platform object, a promise, a date, an error: by reference)
    e.kind = 'obj'; e.props = [];
    const d = Object.getOwnPropertyDescriptors(v);
    for (const k of Object.keys(d)) { const p = d[k]; if (!('value' in p) || !p.writable) continue; if (skip(v, k)) { (e.left || (e.left = [])).push(k); continue; } e.props.push([k, ref(p.value)]); }   // (left: the host's live things, not touched either way)
    return new Ref(i);
  };
  const rootRefs = roots.map(ref);
  return { entries, roots: rootRefs, bytes };
}
/** the graph's objects put back as they were: contents first, then every object's properties */
function restoreGraph(g) {
  const E = g.entries, resolve = r => (r instanceof Ref ? (E[r.i].repl || E[r.i].o) : r);
  for (const e of E) {
    if (e.kind === 'mem') new Uint8Array(e.o.buffer).set(e.bytes);
    else if (e.kind === 'global') e.o.value = e.value;
    else if (e.kind === 'ab') { if (e.o.byteLength === e.bytes.length) new Uint8Array(e.o).set(e.bytes); else e.repl = e.bytes.slice().buffer; }
    else if (e.kind === 'ta') { const t = e.ta || e.o; if (t.length === e.bytes.length) t.set(e.bytes); else if (!e.ta) e.repl = e.bytes.slice(); }
    else if (e.kind === 'canvas' && e.img) { const c = e.canvas; if (c.width !== e.w || c.height !== e.h) { c.width = e.w; c.height = e.h; } c.getContext('2d').putImageData(e.img, 0, 0); }
  }
  for (const e of E) {
    if (e.kind === 'map') { e.o.clear(); for (const [k, v] of e.items) e.o.set(resolve(k), resolve(v)); }
    else if (e.kind === 'set') { e.o.clear(); for (const v of e.items) e.o.add(resolve(v)); }
    else if (e.kind === 'arr') { e.o.length = 0; for (let i = 0; i < e.items.length; i++) e.o[i] = resolve(e.items[i]); }
    else if (e.kind === 'obj') {
      const keep = new Set([...e.props.map(p => p[0]), ...(e.left || [])]);
      for (const k of Object.keys(e.o)) if (!keep.has(k)) { try { delete e.o[k]; } catch (_) { /* not configurable */ } }
      for (const [k, v] of e.props) e.o[k] = resolve(v);
    }
  }
  return g.roots.map(resolve);
}
/** the graph's bytes and shape, hashed: the same moment hashes the same; a damaged copy does not */
function hashGraph(h, g) {
  for (const e of g.entries) {
    h = fnvStr(h, e.kind);
    if (e.bytes) h = fnv(h, e.bytes);
    else if (e.kind === 'global') h = fnvStr(h, String(e.value));
    else if (e.kind === 'obj') for (const [k, v] of e.props) h = fnvStr(h, k + ':' + (v instanceof Ref ? '#' + v.i : typeof v === 'object' ? '' : String(v)));
    else if (e.items) h = fnvStr(h, String(e.items.length));
  }
  return h;
}

// ---------------------------------------------------------------- a graph exported and brought into another page's machine
// A moment held in memory puts its objects back by identity. Exported, it has no identities to go back to: a fresh
// page boots its own machine, whose objects are then overlaid from the export by their path from the root (the same
// code builds the same shape: machine.proc.threadsById, ...). An object the fresh machine has at the path takes the
// exported properties; one it has not is made anew (its prototype the one the fresh machine's objects have there, or
// the constructor of that name from `protos`, or Object's); a function the export could not carry (a closure) is left
// as the fresh machine has it at that key. Memories, globals, typed arrays and canvases carry their bytes
/** the graph as JSON-able meta and one byte blob: entries by index, refs as { r: i }, prototypes by constructor name */
function serialize(g, nameOf = () => null) {
  const chunks = [], meta = []; let total = 0;
  const put = bytes => { const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength); chunks.push(u); const at = total; total += u.length; return [at, u.length]; };
  // (an opaque object or a function the export cannot carry goes by the name the host gives it, when it has one:
  // the bundle's images and metadata, found again by name where the export is brought in)
  const val = v => (v instanceof Ref ? { r: v.i } : typeof v === 'function' ? { fn: nameOf(v) || true } : (v !== null && typeof v === 'object') ? { opaque: nameOf(v) || true } : (typeof v === 'bigint' ? { big: v.toString() } : v === undefined ? { u: true } : Number.isNaN(v) ? { nan: true } : v));
  for (const e of g.entries) {
    const m = { kind: e.kind }; const p = Object.getPrototypeOf(e.o); m.proto = p && p.constructor && p.constructor.name !== 'Object' ? p.constructor.name : null;
    if (e.kind === 'mem' || e.kind === 'ab') m.bytes = put(e.bytes);
    else if (e.kind === 'ta') { m.bytes = put(e.bytes); m.ta = e.bytes.constructor.name; }
    else if (e.kind === 'global') m.value = e.value;
    else if (e.kind === 'canvas') { m.w = e.w; m.h = e.h; if (e.img) m.bytes = put(e.img.data); }
    else if (e.kind === 'map') m.items = e.items.map(([k, v]) => [val(k), val(v)]);
    else if (e.kind === 'set' || e.kind === 'arr') m.items = e.items.map(val);
    else if (e.kind === 'obj') { m.props = e.props.map(([k, v]) => [k, val(v)]); if (e.left) m.left = e.left; }
    meta.push(m);
  }
  const blob = new Uint8Array(total); let at = 0; for (const c of chunks) { blob.set(c, at); at += c.length; }
  return { meta, roots: g.roots.map(val), blob };
}
const TA = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray, ...(typeof BigInt64Array === 'function' ? { BigInt64Array, BigUint64Array } : {}) };
/** the export put into the live graph from `roots`: each exported entry matched to a live object by path */
function rebind(roots, ex, opts = {}) {
  const protos = opts.protos || {}, opaque = opts.opaque || new Set(), skip = opts.skip || (() => false), named = opts.named || (() => undefined);
  // the live objects by path, as the export's walk numbered its entries: both walks are depth-first from the roots in
  // property order, so the n-th entry of each is the same path when the shapes agree; where they part, by path name
  const live = new Map(), lvisit = new Set();
  const walkLive = (v, path) => {
    if (v === null || typeof v !== 'object' || opaque.has(v) || lvisit.has(v)) return; lvisit.add(v); live.set(path, v);
    if (hasWasm && (v instanceof WebAssembly.Memory || v instanceof WebAssembly.Global)) return;
    if (v instanceof ArrayBuffer || (hasShared && v instanceof SharedArrayBuffer) || ArrayBuffer.isView(v) || isCanvas(v) || isCtx(v) || isImageData(v)) return;
    if (v instanceof Map) { let i = 0; for (const [k, x] of v) { walkLive(k, path + '/k' + i); walkLive(x, path + '/' + (typeof k === 'string' || typeof k === 'number' ? k : 'v' + i)); i++; } return; }
    if (v instanceof Set) { let i = 0; for (const x of v) walkLive(x, path + '/' + i++); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walkLive(x, path + '/' + i)); return; }
    if (TAG(v) !== '[object Object]') return;
    const d = Object.getOwnPropertyDescriptors(v);
    for (const k of Object.keys(d)) { const p = d[k]; if (!('value' in p) || !p.writable || skip(v, k)) continue; walkLive(p.value, path + '/' + k); }
  };
  roots.forEach((r, i) => walkLive(r, '#' + i));
  // the export's entries by path, the same walk over the meta
  const path = new Array(ex.meta.length).fill(null), order = [];
  const walkEx = (v, p) => {
    if (!v || typeof v !== 'object' || !('r' in v)) return; const i = v.r; if (path[i] !== null) return; path[i] = p; order.push(i);
    const m = ex.meta[i];
    if (m.kind === 'map') m.items.forEach(([k, x], n) => { walkEx(k, p + '/k' + n); walkEx(x, p + '/' + (typeof k === 'string' || typeof k === 'number' ? k : 'v' + n)); });
    else if (m.kind === 'set' || m.kind === 'arr') m.items.forEach((x, n) => walkEx(x, p + '/' + n));
    else if (m.kind === 'obj') m.props.forEach(([k, x]) => walkEx(x, p + '/' + k));
  };
  ex.roots.forEach((r, i) => walkEx(r, '#' + i));
  // each exported entry's live object: the one at its path, or one made anew
  const obj = new Array(ex.meta.length).fill(null), made = [];
  const protoAt = (m, p) => { const sib = live.get(p); if (sib && Object.getPrototypeOf(sib) && Object.getPrototypeOf(sib).constructor.name === m.proto) return Object.getPrototypeOf(sib); const parent = live.get(p.replace(/\/[^/]*$/, '')); for (const c of parent instanceof Map ? parent.values() : parent instanceof Set ? parent : Array.isArray(parent) ? parent : []) if (c && typeof c === 'object' && Object.getPrototypeOf(c).constructor.name === m.proto) return Object.getPrototypeOf(c); return protos[m.proto] ? protos[m.proto].prototype : Object.prototype; };
  const bytesOf = m => ex.blob.subarray(m.bytes[0], m.bytes[0] + m.bytes[1]);
  for (const i of order) {
    const m = ex.meta[i], p = path[i], l = live.get(p);
    if (m.kind === 'mem' || m.kind === 'global' || m.kind === 'canvas' || m.kind === 'ref') { obj[i] = l || null; continue; }   // (what cannot be made anew: the fresh machine's own, or nothing)
    if (m.kind === 'ab') { obj[i] = l instanceof ArrayBuffer && l.byteLength === m.bytes[1] ? l : bytesOf(m).slice().buffer; continue; }
    if (m.kind === 'ta') { const C = TA[m.ta] || Uint8Array, b = bytesOf(m); const want = b.length / C.BYTES_PER_ELEMENT; obj[i] = l && l.constructor === C && l.length === want ? l : isImageData(l) && l.data.length === want ? l.data : new C(b.slice().buffer, 0, want); continue; }
    if (m.kind === 'map') { obj[i] = l instanceof Map ? l : new Map(); continue; }
    if (m.kind === 'set') { obj[i] = l instanceof Set ? l : new Set(); continue; }
    if (m.kind === 'arr') { obj[i] = Array.isArray(l) ? l : []; continue; }
    if (l && typeof l === 'object' && !(l instanceof Map) && !(l instanceof Set) && !Array.isArray(l) && TAG(l) === '[object Object]') obj[i] = l;
    else { obj[i] = Object.create(m.proto ? protoAt(m, p) : Object.prototype); made.push(p); }
  }
  // the contents: bytes first, then every object's properties, a function the export could not carry kept as it is
  const resolve = (v, l, k) => { if (v && typeof v === 'object') { if ('r' in v) return obj[v.r]; if (v.fn || v.opaque) { const n = v.fn || v.opaque; if (typeof n === 'string') { const got = named(n); if (got !== undefined) return got; } return l && k !== undefined ? l[k] : undefined; } if (v.u) return undefined; if (v.nan) return NaN; if ('big' in v) return BigInt(v.big); } return v; };
  for (const i of order) {
    const m = ex.meta[i], o = obj[i]; if (!o) continue;
    if (m.kind === 'mem') new Uint8Array(o.buffer).set(bytesOf(m));
    else if (m.kind === 'global') o.value = m.value;
    else if (m.kind === 'ab') { if (o.byteLength === m.bytes[1]) new Uint8Array(o).set(bytesOf(m)); }
    else if (m.kind === 'ta') { const b = bytesOf(m); if (o.byteLength === b.length) new Uint8Array(o.buffer, o.byteOffset, o.byteLength).set(b); }
    else if (m.kind === 'canvas') { const c = isCtx(o) ? o.canvas : o; if (c && m.bytes && typeof ImageData === 'function') { if (c.width !== m.w || c.height !== m.h) { c.width = m.w; c.height = m.h; } c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytesOf(m).slice().buffer), m.w, m.h), 0, 0); } }
  }
  for (const i of order) {
    const m = ex.meta[i], o = obj[i]; if (!o) continue;
    if (m.kind === 'map') { o.clear(); for (const [k, v] of m.items) o.set(resolve(k), resolve(v)); }
    else if (m.kind === 'set') { o.clear(); for (const v of m.items) o.add(resolve(v)); }
    else if (m.kind === 'arr') { const was = o.slice(); o.length = 0; m.items.forEach((v, n) => { o[n] = resolve(v, was, n); }); }
    else if (m.kind === 'obj') {
      const keep = new Set([...m.props.map(p => p[0]), ...(m.left || [])]);
      for (const k of Object.keys(o)) if (!keep.has(k) && typeof o[k] !== 'function') { try { delete o[k]; } catch (_) { /* not configurable */ } }
      for (const [k, v] of m.props) { const r = resolve(v, o, k); if (v && typeof v === 'object' && (v.fn || v.opaque) && r === undefined) continue; o[k] = r; }
    }
  }
  return { made, matched: order.length - made.length };
}

// ---------------------------------------------------------------- the record
/** a moment: `sections` { name: { kind: 'graph'|'json'|'bytes', ... } }, with its header: when, the build, the mods */
function make(sections, o = {}) {
  const s = { magic: MAGIC, version: VERSION, name: o.name || '', at: Date.now(), now: o.now || 0, build: o.build || '', mods: [...(o.mods || [])], sections, bytes: 0, objects: 0 };
  for (const sec of Object.values(sections)) { if (sec.kind === 'graph') { s.bytes += sec.graph.bytes; s.objects += sec.graph.entries.length; } else if (sec.kind === 'bytes') s.bytes += sec.bytes.length; }
  s.sum = checksum(s);
  return s;
}
function checksum(s) {
  let h = fnvStr(FNV0, `${s.magic}/${s.version}/${s.build}/${s.name}`);
  for (const name of Object.keys(s.sections).sort()) {
    const sec = s.sections[name]; h = fnvStr(h, name + ':' + sec.kind);
    if (sec.kind === 'graph') h = hashGraph(h, sec.graph);
    else if (sec.kind === 'bytes') h = fnv(h, sec.bytes);
    else if (sec.kind === 'json') h = fnvStr(h, JSON.stringify(sec.value));
  }
  return h >>> 0;
}
/** why a moment cannot be put back here: a damaged copy (its checksum), another build's (its signature); null when it can */
function refuse(s, build) {
  if (!s || s.magic !== MAGIC) return 'not a moment';
  if (s.version !== VERSION) return `moment version ${s.version}, this code reads ${VERSION}`;
  if (checksum(s) !== s.sum) return 'the moment is damaged (checksum)';
  if (build && s.build && s.build !== build) return `the moment is build ${s.build}'s, this is ${build}: the state's meaning may differ`;
  return null;
}
/** what a moment has, without its contents: for a list */
function describe(s) { return { name: s.name, at: s.at, now: s.now, build: s.build, mods: s.mods, bytes: s.bytes, objects: s.objects, sum: s.sum, sections: Object.keys(s.sections) }; }

// ---------------------------------------------------------------- the build's signature: the scripts that give the state its meaning, hashed
const BUILD_FILES = ['braid.js', 'win32.js', 'ne16.js', 'vmm.js', 'v86.js', 'dyn.js', 'fs.js'];
async function buildSignature(fetchText) {
  let h = FNV0;
  for (const f of BUILD_FILES) h = fnvStr(h, f + '\0' + await fetchText(f));
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------- the lint: two moments of the same machine compared, for what looks like a machine that will not come back
/** the probe of a machine's state the lint reads: { threads: [{ id, state, cs, ip, blocked, wait, preempted, path }], held: { who, since, cpu, hung },
 *  faults: n, heapTop, allocs, r0: n, queue: n, now }: taken by the worker (worker.js braidProbe) into the moment's `probe` section.
 *  The halting problem allows no proof; these are the signs: the lock held by one thread across both moments, a thread
 *  at the same place in both with its time running out each slice, faults since, a heap or a queue that only grows */
function lint(a, b) {
  const out = [], A = a.sections.probe && a.sections.probe.value, B = b.sections.probe && b.sections.probe.value;
  if (!A || !B) return [{ level: 'info', what: 'no probe in one of the moments' }];
  const dt = B.now - A.now;
  if (A.held && B.held && A.held.who === B.held.who && B.held.since === A.held.since && dt > 2000) out.push({ level: 'warn', what: `the Win16Lock held by ${A.held.who} across ${Math.round(dt)} ms (since ${A.held.since}): a thread that never gives USER back`, who: A.held.who });
  if (B.held && B.held.hung) out.push({ level: 'error', what: `${B.held.who} hung holding the Win16Lock` });
  for (const t of B.threads || []) {
    const was = (A.threads || []).find(x => x.id === t.id); if (!was) continue;
    if (t.state === 'running' && was.state === 'running' && t.cs === was.cs && t.ip === was.ip && t.preempted && was.preempted && dt > 1000) out.push({ level: 'warn', what: `thread ${t.id} (${t.path || '?'}) at ${(t.cs >>> 0).toString(16)}:${(t.ip >>> 0).toString(16)} in both moments, its time running out each slice: a spin`, thread: t.id });
    if (t.blocked && was.blocked && t.wait && was.wait && t.wait.on === was.wait.on && dt > 30000) out.push({ level: 'info', what: `thread ${t.id} blocked on ${t.wait.on} for ${Math.round(dt)} ms`, thread: t.id });
  }
  if (B.faults > A.faults) out.push({ level: 'error', what: `${B.faults - A.faults} fault(s) since: code the machine found none at, or a processor exception` });
  if (B.heapTop - A.heapTop > 8 << 20) out.push({ level: 'warn', what: `the heap grew ${((B.heapTop - A.heapTop) >> 20)} MB` });
  if (B.allocs - A.allocs > 5000) out.push({ level: 'warn', what: `${B.allocs - A.allocs} more live heap blocks: a leak` });
  if (B.queue > 200 && B.queue > A.queue) out.push({ level: 'warn', what: `${B.queue} messages waiting in USER's queues and growing` });
  return out;
}

const api = { Ref, takeGraph, restoreGraph, serialize, rebind, make, checksum, refuse, describe, buildSignature, lint, BUILD_FILES, MAGIC, VERSION, fnv, fnvStr, FNV0 };
if (typeof self !== 'undefined') self.W95Braid = api;
if (typeof window !== 'undefined') window.W95Braid = api;
})();
