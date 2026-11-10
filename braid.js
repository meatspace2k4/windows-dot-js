'use strict';
// Ring α ("Braid"): the ground the processor's rings stand on, from which the machine's time is braided. A moment is
// the whole machine at an instant, held in memory and travelled to, so the system's run is a line to move along, not
// a sequence to repeat: a lock-up or a crash is left by travelling to a moment before it and going on, with the code
// changed meanwhile if need be (the scripts loaded over the machine as it runs, cmd 'reload', are not part of a
// moment: it names them, a sidecar, and runs under whatever is loaded when it is travelled to).
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
//   mods       the scripts loaded over the machine while it ran: named (with the sum of their text), never carried
//
// The graph: an object is walked through its own data properties (never its getters, never its prototype); a Map, a
// Set and an Array through their contents; a typed array and an ArrayBuffer are copied; a canvas by its pixels; a
// function, a promise, a module, an instance and any platform object are held by reference, not walked. Travel
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

// ---------------------------------------------------------------- a memory's bytes, in chunks shared between moments
// A memory is taken as chunks of 256 KB, and a chunk whose bytes are the same as the memory's last moment's at that
// place is that moment's chunk itself, not a copy: moments of a machine share the memory that did not change between
// them, as anchors share their chunks on this computer. Copied whole, each moment held all of a machine's memory
// (685 MB in Windows 98 Setup), and the line marking itself as Setup ran held five and more at once, and the page ran
// out of memory. A chunk is never written once taken.
const MEM_CHUNK = 0x40000;
class Chunked {
  constructor(chunks, length) { this.chunks = chunks; this.length = length; }
  /** into `dst` (a Uint8Array at least as long), from its start */
  copyTo(dst) { let at = 0; for (const c of this.chunks) { dst.set(c, at); at += c.length; } }
}
const lastChunks = new WeakMap();   // (a memory's chunks as its last moment took them)
const sameBytes = (a, b) => {
  if (a.length !== b.length) return false;
  const n = a.length >>> 3, a8 = new BigUint64Array(a.buffer, a.byteOffset, n), b8 = new BigUint64Array(b.buffer, b.byteOffset, n);
  for (let i = 0; i < n; i++) if (a8[i] !== b8[i]) return false;
  for (let i = n << 3; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
function takeMemory(mem) {
  const live = new Uint8Array(mem.buffer), was = lastChunks.get(mem) || [], chunks = [];
  for (let at = 0, k = 0; at < live.length; at += MEM_CHUNK, k++) {
    const cur = live.subarray(at, Math.min(at + MEM_CHUNK, live.length)), old = was[k];
    chunks.push(old && sameBytes(old, cur) ? old : cur.slice());
  }
  lastChunks.set(mem, chunks);
  return new Chunked(chunks, live.length);
}

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
    if (hasWasm && v instanceof WebAssembly.Memory) { e.kind = 'mem'; e.bytes = takeMemory(v); bytes += e.bytes.length; return new Ref(i); }
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
    if (e.kind === 'mem') { e.bytes.copyTo(new Uint8Array(e.o.buffer)); lastChunks.set(e.o, e.bytes.chunks); }   // (the memory is the moment's again: its next moment shares these)
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
    if (e.bytes instanceof Chunked) for (const c of e.bytes.chunks) h = fnv(h, c);
    else if (e.bytes) h = fnv(h, e.bytes);
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
    if (e.kind === 'mem') { const at = total; for (const c of e.bytes.chunks) put(c); m.bytes = [at, e.bytes.length]; }
    else if (e.kind === 'ab') m.bytes = put(e.bytes);
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
// an array's element named by what it is, where it says so: a record's name, key, id, pid or path (a module, a thunk,
// a thread, a process), so the records of two machines pair by identity, not by position (a module record paired by
// position with another module's record took that module's code, its wasm run, and ran nothing at its own addresses);
// its index otherwise, or where the name repeats
const IDK = ['name', 'key', 'id', 'pid', 'path'];
const elKey = (get, i, used) => {
  if (get) for (const k of IDK) { const v = get(k); if (typeof v === 'string' || typeof v === 'number') { const s = k + '=' + String(v).replace(/\//g, '%2F'); if (!used.has(s)) { used.add(s); return s; } break; } }
  return String(i);
};
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
    if (Array.isArray(v)) { const used = new Set(); v.forEach((x, i) => walkLive(x, path + '/' + elKey(x && typeof x === 'object' && !Array.isArray(x) ? k => x[k] : null, i, used))); return; }
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
    else if (m.kind === 'set') m.items.forEach((x, n) => walkEx(x, p + '/' + n));
    else if (m.kind === 'arr') { const used = new Set(); m.items.forEach((x, n) => { const e = x && typeof x === 'object' && 'r' in x ? ex.meta[x.r] : null; walkEx(x, p + '/' + elKey(e && e.kind === 'obj' ? k => { const pr = e.props.find(q => q[0] === k); return pr ? pr[1] : undefined; } : null, n, used)); }); }
    else if (m.kind === 'obj') m.props.forEach(([k, x]) => walkEx(x, p + '/' + k));
  };
  ex.roots.forEach((r, i) => walkEx(r, '#' + i));
  // each exported entry's live object: the one at its path, or one made anew
  const obj = new Array(ex.meta.length).fill(null), made = [], unmade = [], lost = []; let curPath = '';   // (unmade: an object made without its class, [path, class wanted, class got]; lost: a function or opaque thing the record names that nothing here answers to, [name, key])
  const protoAt = (m, p) => { const sib = live.get(p); if (sib && Object.getPrototypeOf(sib) && Object.getPrototypeOf(sib).constructor.name === m.proto) return Object.getPrototypeOf(sib); const parent = live.get(p.replace(/\/[^/]*$/, '')); for (const c of parent instanceof Map ? parent.values() : parent instanceof Set ? parent : Array.isArray(parent) ? parent : []) if (c && typeof c === 'object' && Object.getPrototypeOf(c).constructor.name === m.proto) return Object.getPrototypeOf(c); return protos[m.proto] ? protos[m.proto].prototype : Object.prototype; };
  const bytesOf = m => ex.blob.subarray(m.bytes[0], m.bytes[0] + m.bytes[1]);
  for (const i of order) {
    const m = ex.meta[i], p = path[i], l = live.get(p);
    if (m.kind === 'mem' || m.kind === 'canvas' || m.kind === 'ref') { obj[i] = l || null; continue; }   // (what cannot be made anew: the fresh machine's own, or nothing)
    if (m.kind === 'global') { obj[i] = hasWasm && l instanceof WebAssembly.Global ? l : hasWasm ? new WebAssembly.Global({ value: 'i32', mutable: true }, m.value | 0) : null; continue; }   // (a register of a machine this page had not: made anew with its value, as a VM's are)
    if (m.kind === 'ab') { obj[i] = l instanceof ArrayBuffer && l.byteLength === m.bytes[1] ? l : bytesOf(m).slice().buffer; continue; }
    if (m.kind === 'ta') { const C = TA[m.ta] || Uint8Array, b = bytesOf(m); const want = b.length / C.BYTES_PER_ELEMENT; obj[i] = l && l.constructor === C && l.length === want ? l : isImageData(l) && l.data.length === want ? l.data : new C(b.slice().buffer, 0, want); continue; }
    if (m.kind === 'map') { obj[i] = l instanceof Map ? l : new Map(); continue; }
    if (m.kind === 'set') { obj[i] = l instanceof Set ? l : new Set(); continue; }
    if (m.kind === 'arr') { obj[i] = Array.isArray(l) ? l : []; continue; }
    if (l && typeof l === 'object' && !(l instanceof Map) && !(l instanceof Set) && !Array.isArray(l) && TAG(l) === '[object Object]') obj[i] = l;
    else { const pr = m.proto ? protoAt(m, p) : Object.prototype; obj[i] = Object.create(pr); made.push(p); if (m.proto && m.proto !== 'Object' && (pr === Object.prototype || pr.constructor.name !== m.proto)) unmade.push([p, m.proto, pr.constructor ? pr.constructor.name : '?']); }
  }
  // the contents: bytes first, then every object's properties, a function the export could not carry kept as it is
  const resolve = (v, l, k) => { if (v && typeof v === 'object') { if ('r' in v) return obj[v.r]; if (v.fn || v.opaque) { const n = v.fn || v.opaque; if (typeof n === 'string') { const got = named(n); if (got !== undefined) return got; } if (!(l && k !== undefined && l[k] !== undefined)) lost.push([typeof n === 'string' ? n : v.fn ? 'fn' : 'opaque', k, curPath]); return l && k !== undefined ? l[k] : undefined; } if (v.u) return undefined; if (v.nan) return NaN; if ('big' in v) return BigInt(v.big); } return v; };
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
    curPath = path[i];
    // (a function the record could not carry, a map's value, kept as the live map has it by its key: IFSHLP's real-mode
    // entry (ne16.js rmEntries) came back undefined)
    if (m.kind === 'map') { const was = new Map(o); o.clear(); for (const [k, v] of m.items) { const key = resolve(k); let val = resolve(v); if (val === undefined && v && typeof v === 'object' && v.fn && was.has(key)) val = was.get(key); o.set(key, val); } }
    else if (m.kind === 'set') { o.clear(); for (const v of m.items) o.add(resolve(v)); }
    else if (m.kind === 'arr') { const was = o.slice(); o.length = 0; m.items.forEach((v, n) => { o[n] = resolve(v, was, n); }); }
    else if (m.kind === 'obj') {
      const keep = new Set([...m.props.map(p => p[0]), ...(m.left || [])]);
      for (const k of Object.keys(o)) if (!keep.has(k) && typeof o[k] !== 'function') { try { delete o[k]; } catch (_) { /* not configurable */ } }
      for (const [k, v] of m.props) { const r = resolve(v, o, k); if (v && typeof v === 'object' && (v.fn || v.opaque) && r === undefined) continue; o[k] = r; }
    }
  }
  return { made, matched: order.length - made.length, unmade, lost };
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
 *  faults: n, fatal: n, heapTop, allocs, r0: n, r0At, queue: n, now, exited }: taken by the worker (worker.js braidProbe) into the
 *  moment's `probe` section. The halting problem allows no proof; these are the signs: the lock held by one thread
 *  across both moments, a thread at the same place in both with its time running out each slice, a ring-0 run at the
 *  same place across both, lines in the fault log since, the machine's process ended, a heap or a queue that only grows.
 *  Each finding has a level: `error` is a state the system does not come back from (a processor exception it answered
 *  with a fault dialog or a blue screen, a hang the machine itself has called, its process ended), `warn` the look of one */
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
  if (A.r0 && B.r0 && A.r0At !== undefined && A.r0At === B.r0At && dt > 2000) out.push({ level: 'warn', what: `a ring-0 run at ${(B.r0At >>> 0).toString(16)} in both moments, ${Math.round(dt)} ms apart: a VxD that does not come back` });
  if ((B.fatal || 0) > (A.fatal || 0)) out.push({ level: 'error', what: `${B.fatal - (A.fatal || 0)} processor exception(s) the system answered since: a fault dialog, or a blue screen` });
  if (B.faults > A.faults) out.push({ level: 'warn', what: `${B.faults - A.faults} line(s) in the fault log since: a parameter error, a LogError, or code the machine found none at` });
  if (B.exited != null && A.exited == null) out.push({ level: 'error', what: `the machine's process ended (${B.exited})` });
  if (B.heapTop - A.heapTop > 8 << 20) out.push({ level: 'warn', what: `the heap grew ${((B.heapTop - A.heapTop) >> 20)} MB` });
  if (B.allocs - A.allocs > 5000) out.push({ level: 'warn', what: `${B.allocs - A.allocs} more live heap blocks: a leak` });
  if (B.queue > 200 && B.queue > A.queue) out.push({ level: 'warn', what: `${B.queue} messages waiting in USER's queues and growing` });
  return out;
}
/** what the findings add up to: `broken` (an error: the system does not come back), `suspect` (a warning), `ok` */
function verdict(findings) { return findings.some(f => f.level === 'error') ? 'broken' : findings.some(f => f.level === 'warn') ? 'suspect' : 'ok'; }

// ---------------------------------------------------------------- mods: scripts loaded over the running machine, named beside a moment, never in it
/** a mod's record: the script's name and the sum of its text, as the moments it ran under name it (a sidecar: the
 *  moment holds the state, the record says what code was over it; the same script changed is another mod) */
function mod(name, text) { return { name: String(name), sum: (fnvStr(FNV0, String(text || '')) >>> 0).toString(16).padStart(8, '0') }; }

// ---------------------------------------------------------------- an anchored moment: everything as bytes and meta, on this computer
// A moment held in the page's memory puts its objects back by identity; one anchored on this computer (IndexedDB) has
// no identities and is arrived at by path (rebind). Its record: the magic, the version, the build, every machine's
// export, the page's, the registry, the line and the mods, and a checksum over all of it, so a damaged copy or
// another build's is refused the same way a moment in memory is
const ANCHOR = 'W95ANCHOR';
function anchor(o) {
  const rec = { magic: ANCHOR, version: VERSION, name: String(o.name), at: o.at || Date.now(), now: o.now || 0, gen: o.gen || 0, build: o.build || '', mods: [...(o.mods || [])], machines: o.machines, page: o.page, registry: o.registry, line: o.line || null };
  rec.sum = anchorSum(rec); return rec;
}
function anchorSum(rec) {
  let h = fnvStr(FNV0, `${rec.magic}/${rec.version}/${rec.build}/${rec.name}/${rec.now}`);
  const blob = b => (b instanceof Uint8Array ? b : new Uint8Array(b.buffer || b));
  for (const k of Object.keys(rec.machines || {}).sort()) { const m = rec.machines[k]; h = fnvStr(h, k + JSON.stringify(m.meta) + JSON.stringify(m.roots) + JSON.stringify(m.registry || null) + m.now); h = fnv(h, blob(m.blob)); }
  if (rec.page) { h = fnvStr(h, JSON.stringify(rec.page.meta) + JSON.stringify(rec.page.roots)); h = fnv(h, blob(rec.page.blob)); }
  h = fnvStr(h, JSON.stringify(rec.registry || null) + JSON.stringify(rec.mods || []));
  return h >>> 0;
}
function refuseAnchor(rec, build) {
  if (!rec || rec.magic !== ANCHOR) return 'not an anchored moment';
  if (rec.version !== VERSION) return `anchored moment version ${rec.version}, this code reads ${VERSION}`;
  if (anchorSum(rec) !== rec.sum) return 'the anchored moment is damaged (checksum)';
  if (build && rec.build && rec.build !== build) return `the moment is build ${rec.build}'s, this is ${build}: the state's meaning may differ`;
  return null;
}

// An anchored moment as stored: its blobs (each machine's and the page's) cut in chunks of CHUNK bytes, each kept once
// under its SHA-256, and the record holding each blob as the list of its chunks' hashes and its length. Anchors taken
// minutes apart share every chunk of memory that did not change, so the line anchoring itself keeps a few of them
// for little more than one. The checksum (anchorSum) stays over the blobs put back together: a chunk damaged or
// missing is refused as the whole moment's damage is.
// (cut where the blob's own entries begin: serialize packs every entry's bytes (the guest memory, buffers, typed
// arrays, canvases) one after another in the graph's order, so an earlier entry that grows, shrinks, comes or goes
// moves every byte after it. Cut at fixed offsets, two anchors six minutes apart in one Setup run shared 27% of their
// chunks. An entry of CHUNK bytes or more is cut from its own start, so its unchanged pages are the same chunks
// wherever it lies; the small entries between two such are cut as one run, where a shift stays)
const CHUNK = 64 * 1024;
const hex = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
const blobOf = b => (b instanceof Uint8Array ? b : new Uint8Array(b.buffer || b));
/** where a blob is cut: the start and end of each entry of `meta` (serialize's: bytes [at, length]) of CHUNK or more,
 *  then every CHUNK from each such start; the blob's own ends */
function cutPoints(len, meta) {
  const big = (Array.isArray(meta) ? meta : []).map(m => m && m.bytes).filter(x => Array.isArray(x) && x[1] >= CHUNK).sort((a, b) => a[0] - b[0]);
  const at = new Set([0, len]); for (const [s, n] of big) { at.add(s); at.add(s + n); }
  const marks = [...at].filter(x => x >= 0 && x <= len).sort((a, b) => a - b), out = [];
  for (let i = 0; i + 1 < marks.length; i++) for (let s = marks[i]; s < marks[i + 1]; s += CHUNK) out.push([s, Math.min(s + CHUNK, marks[i + 1])]);
  return out;
}
/** the record to store and its chunks: { rec, chunks: Map(hash -> bytes) }; `sha` hashes bytes to an ArrayBuffer */
async function packAnchor(rec, sha = b => crypto.subtle.digest('SHA-256', b)) {
  const chunks = new Map();
  const cut = async (b, meta) => {
    b = blobOf(b); const hs = [];
    for (const [s, e] of cutPoints(b.length, meta)) { const c = b.subarray(s, e), h = hex(await sha(c)); if (!chunks.has(h)) chunks.set(h, c.slice()); hs.push(h); }
    return { chunks: hs, length: b.length };
  };
  const machines = {};
  for (const [k, m] of Object.entries(rec.machines || {})) machines[k] = { ...m, blob: await cut(m.blob, m.meta) };
  const page = rec.page ? { ...rec.page, blob: await cut(rec.page.blob, rec.page.meta) } : rec.page;
  return { rec: { ...rec, machines, page, packed: CHUNK }, chunks };
}
/** the stored record made whole again: each blob from its chunks (`get(hash)` the chunk's bytes, or a promise of
 *  them); a record stored whole (before chunks) comes back as it is. A missing chunk throws */
async function unpackAnchor(s, get) {
  if (!s || !s.packed) return s;
  const join = async b => {
    if (!b || !Array.isArray(b.chunks)) return b;
    const out = new Uint8Array(b.length); let at = 0;
    for (const h of b.chunks) { const c = await get(h); if (!c) throw new Error(`the anchored moment is damaged (chunk ${h.slice(0, 12)} missing)`); out.set(blobOf(c), at); at += c.byteLength; }
    if (at !== b.length) throw new Error('the anchored moment is damaged (chunks short)');
    return out;
  };
  const machines = {};
  for (const [k, m] of Object.entries(s.machines || {})) machines[k] = { ...m, blob: await join(m.blob) };
  const page = s.page ? { ...s.page, blob: await join(s.page.blob) } : s.page;
  const rec = { ...s, machines, page }; delete rec.packed; return rec;
}
/** every chunk the stored records refer to: what a chunk store keeps when one of them is let go */
function chunkRefs(records) {
  const out = new Set();
  for (const s of records) { if (!s || !s.packed) continue; for (const b of [...Object.values(s.machines || {}).map(m => m.blob), s.page && s.page.blob]) if (b && b.chunks) for (const h of b.chunks) out.add(h); }
  return out;
}
/** a blob's length whether stored whole or as chunks */
const blobLength = b => (!b ? 0 : Array.isArray(b.chunks) ? b.length : (b.length !== undefined ? b.length : b.byteLength || 0));

// ---------------------------------------------------------------- the line: the machine's time as a whole, in generations
// Generation 0 is the run from the page's start. Travel to a moment begins the next generation, which grows from that
// moment (in the generation it was taken in); the one left runs no further, but its moments stay on the line and are
// travelled to again. Every moment is at a machine time (`at`: the system's machine's own clock, worker.js vclock), so
// a time on the line names a place on it: the moment at or before it on the generation's lineage, and the run from
// there to it. The journal keeps the API's actions by machine time, closed into segments between moments: a segment
// from a moment with the same actions as one lived before is a span already computed, and its end is where it leads
// (memo). Every fault a machine reports is an event on the line, under its generation
class Line {
  constructor() { this.gen = 0; this.forks = [{ gen: 0, from: null, fromGen: null, at: 0 }]; this.moments = new Map(); this.events = []; this.segments = []; this.j = { from: null, fromSum: null, at0: 0, actions: [] }; this.broken = new Map(); }
  /** a moment taken: on the generation now, at machine time `at` */
  took(m) {
    const d = { name: String(m.name), gen: this.gen, at: m.at, wall: m.wall || Date.now(), sum: m.sum, build: m.build || '', mods: [...(m.mods || [])], bytes: m.bytes || 0 };
    this.moments.set(d.name, d);
    if (this.j.from !== null) this.segments.push({ from: this.j.from, fromSum: this.j.fromSum, to: d.name, toSum: d.sum, actions: this.j.actions.slice(), at0: this.j.at0, at1: d.at, gen: this.gen });
    this.j = { from: d.name, fromSum: d.sum, at0: d.at, actions: [] };
    return d;
  }
  forget(name) { this.broken.delete(String(name)); return this.moments.delete(String(name)); }
  /** travel to a moment: the next generation grows from it (`how`: 'travel', 'anchor', 'memo', 'scrub') */
  fork(name, how = 'travel', extra = {}) {
    const m = this.moments.get(String(name));
    // (the journal since the last moment, closed into an open segment (no end): the actions of the generation left, by time)
    if (this.j.actions.length) this.segments.push({ from: this.j.from, fromSum: this.j.fromSum, to: null, toSum: null, actions: this.j.actions.slice(), at0: this.j.at0, at1: extra.now != null ? extra.now : null, gen: this.gen });
    this.gen++; this.forks.push({ gen: this.gen, from: String(name), fromGen: m ? m.gen : null, at: m ? m.at : (extra.at || 0), how, left: this.gen - 1, ...extra });
    this.j = { from: String(name), fromSum: m ? m.sum : null, at0: m ? m.at : (extra.at || 0), actions: [] };
    return this.gen;
  }
  /** the generations a generation grew from, nearest first, each with the machine time its successor left it at */
  lineage(gen = this.gen) {
    const out = []; let g = gen, until = Infinity;
    for (let n = 0; n < 10000 && g !== null && g !== undefined; n++) {
      const f = this.forks.find(x => x.gen === g); if (!f) break;
      out.push({ gen: g, until }); until = f.at; g = f.fromGen;
    }
    return out;
  }
  /** the moments of a generation's lineage in machine order: each generation's up to where the next left it */
  along(gen = this.gen) {
    const L = this.lineage(gen), out = [];
    for (const m of this.moments.values()) { const l = L.find(x => x.gen === m.gen); if (l && m.at <= l.until) out.push(m); }
    return out.sort((a, b) => a.at - b.at || a.wall - b.wall);
  }
  /** the latest moment at or before machine time t on the lineage, or null; `after`: the earliest past t */
  before(t, gen = this.gen) { const a = this.along(gen).filter(m => m.at <= t); return a.length ? a[a.length - 1] : null; }
  after(t, gen = this.gen) { return this.along(gen).find(m => m.at > t) || null; }
  /** whether a generation's record runs past machine time t: a moment of its past t, or left (travelled away from) past t */
  ranPast(gen, t) { for (const m of this.moments.values()) if (m.gen === gen && m.at > t) return true; return this.forks.some(f => f.fromGen === gen && f.at > t); }
  /** the place on the line machine time t names: the moment at or before it on this lineage when the lineage has a
   *  moment past t; else the newest generation left behind whose record runs past t, at its lineage's moment at or
   *  before t (a scrub into a run left behind brings that run back, its actions with it); else this lineage's, the
   *  run from there on being new. { moment, gen }, or null */
  at(t) {
    const cur = this.before(t);
    if (cur && this.after(t)) return { moment: cur, gen: this.gen };
    for (let g = this.gen - 1; g >= 0; g--) { if (!this.ranPast(g, t)) continue; const m = this.before(t, g); if (m) return { moment: m, gen: g }; }
    return cur ? { moment: cur, gen: this.gen } : null;
  }
  /** the journal's actions of one generation between two machine times (the open journal's too when it is this one) */
  actionsIn(gen, t0, t1) {
    const out = [];
    for (const s of this.segments) if (s.gen === gen) for (const a of s.actions) if (a.at > t0 && a.at <= t1) out.push(a);
    if (gen === this.gen) for (const a of this.j.actions) if (a.at > t0 && a.at <= t1) out.push(a);
    return out.sort((a, b) => a.at - b.at);
  }
  /** the line's extent in machine time, for a slider: the first moment's time and the last's (or `now`) */
  extent(now) { let lo = Infinity, hi = -Infinity; for (const m of this.moments.values()) { lo = Math.min(lo, m.at); hi = Math.max(hi, m.at); } if (now !== undefined) { lo = Math.min(lo, now); hi = Math.max(hi, now); } return lo === Infinity ? null : { lo, hi }; }
  /** an action of the API's, into the journal, at machine time `at` (filled in when the machine answers) */
  note(a) { this.j.actions.push(a); return a; }
  /** the journal's actions on this lineage between two machine times */
  actionsBetween(t0, t1, gen = this.gen) {
    const L = this.lineage(gen), out = [];
    for (const s of this.segments) { const l = L.find(x => x.gen === s.gen); if (l) for (const a of s.actions) if (a.at > t0 && a.at <= t1 && a.at <= l.until) out.push(a); }
    for (const a of this.j.actions) if (a.at > t0 && a.at <= t1) out.push(a);
    return out.sort((a, b) => a.at - b.at);
  }
  /** the segment from the moment the line is at now whose actions are these ([[op, args], ...]) and whose end is a
   *  moment on the line: a span already computed, its end where it leads. null when there is none */
  memo(actions) {
    const key = JSON.stringify(actions);
    return this.segments.find(s => s.from === this.j.from && s.fromSum === this.j.fromSum && JSON.stringify(s.actions.map(a => [a.op, a.args])) === key && this.moments.has(s.to)) || null;
  }
  /** a fault a machine reported, on the line under its generation */
  event(e) { this.events.push({ gen: this.gen, ...e }); return this.events[this.events.length - 1]; }
  /** the line as data: the generation now, every fork, every moment (with the lint's verdict where it has one), the segments, the events */
  describe() { return { gen: this.gen, forks: this.forks.map(f => ({ ...f })), moments: [...this.moments.values()].map(m => ({ ...m, verdict: this.broken.get(m.name) || m.verdict || null })), segments: this.segments.map(s => ({ from: s.from, to: s.to, gen: s.gen, at0: s.at0, at1: s.at1, actions: s.actions.length })), events: this.events.map(e => ({ gen: e.gen, t: e.t, machine: e.machine, fatal: e.fatal, why: e.fault && e.fault.why, fault: e.fault, faults: e.faults })), journal: { from: this.j.from, actions: this.j.actions.slice() } }; }
  /** the line as a record (anchored beside a moment), and one made from a record */
  toJSON() { return { gen: this.gen, forks: this.forks, moments: [...this.moments.values()], events: this.events.map(e => ({ gen: e.gen, t: e.t, machine: e.machine, fatal: e.fatal, fault: e.fault })), segments: this.segments, j: this.j, broken: [...this.broken] }; }
  static from(o) { const l = new Line(); if (!o) return l; l.gen = o.gen || 0; l.forks = o.forks || l.forks; for (const m of o.moments || []) l.moments.set(m.name, m); l.events = o.events || []; l.segments = o.segments || []; l.j = o.j || l.j; l.broken = new Map(o.broken || []); return l; }
}

const api = { Ref, takeGraph, restoreGraph, serialize, rebind, make, checksum, refuse, describe, buildSignature, lint, verdict, mod, anchor, anchorSum, refuseAnchor, packAnchor, unpackAnchor, chunkRefs, blobLength, cutPoints, CHUNK, Line, BUILD_FILES, MAGIC, ANCHOR, VERSION, fnv, fnvStr, FNV0 };
if (typeof self !== 'undefined') self.W95Braid = api;
if (typeof window !== 'undefined') window.W95Braid = api;
})();
