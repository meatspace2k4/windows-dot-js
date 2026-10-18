'use strict';
// The page and a machine's worker (worker.js): what passes between them on shared memory, so neither ever waits on the
// other's event loop when it must not.
// - Calls the worker makes to the page (the file system, which lives on the page with the shell) are synchronous for
//   the guest: the worker posts the call and waits on its RPC block (Atomics.wait) until the page has written the
//   answer there. The page answers on its own event loop, which a guest never holds.
// - Input the page takes (keys, the mouse) goes into the worker's input ring, which the machine reads between its
//   instructions as interrupts arrive, even while the guest runs on without returning to its event loop.
(function () {
const RPC_BYTES = 64 << 20;   // the answer's room: a whole file read at once fits
const RING = 4096;            // input records (4 dwords each)

// ---------------------------------------------------------------- answers: JSON with the binary parts after it
// typed arrays, Maps, undefined and errors survive; everything else is JSON
const pack = (value, bins) => JSON.stringify(value, function (k, v) {
  const raw = this[k];
  if (raw instanceof Uint8Array) { bins.push(raw); return { $t: 'u8', i: bins.length - 1 }; }
  if (ArrayBuffer.isView(raw)) { const b = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength); bins.push(b); return { $t: raw.constructor.name, i: bins.length - 1 }; }
  if (raw instanceof Map) return { $t: 'map', v: [...raw.entries()] };
  if (raw === undefined) return { $t: 'u' };
  if (raw instanceof Error) return { $t: 'err', name: raw.name, code: raw.code, message: raw.message, path: raw.path };
  return v;
});
const unpack = (text, bins, mkErr) => JSON.parse(text, (k, v) => {
  if (!v || typeof v !== 'object' || !v.$t) return v;
  if (v.$t === 'u8') return bins[v.i];
  if (v.$t === 'map') return new Map(v.v);
  if (v.$t === 'u') return undefined;
  if (v.$t === 'err') return mkErr(v);
  const C = self[v.$t]; const b = bins[v.i]; return C ? new C(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : b;
});
const enc = new TextEncoder(), dec = new TextDecoder();
/** the page's side: the answer `value` into the RPC block, and the worker woken */
function answer(sab, value) {
  const ctl = new Int32Array(sab, 0, 4), data = new Uint8Array(sab, 16);
  const bins = [], text = enc.encode(pack(value, bins));
  let at = 0; const room = data.length;
  const put = b => { if (at + 4 + b.length > room) throw new Error('RPC answer too large'); new DataView(sab, 16 + at).setUint32(0, b.length, true); data.set(b, at + 4); at += 4 + b.length; };
  try { put(text); for (const b of bins) put(b); }
  catch (e) { at = 0; put(enc.encode(pack({ $err: true, e }, []))); }
  ctl[1] = bins.length;
  Atomics.store(ctl, 0, 2); Atomics.notify(ctl, 0);
}
/** the worker's side: the answer the page wrote */
function take(sab, mkErr) {
  const ctl = new Int32Array(sab, 0, 4), view = new DataView(sab, 16), data = new Uint8Array(sab, 16);
  let at = 0; const get = () => { const n = view.getUint32(at, true), b = data.slice(at + 4, at + 4 + n); at += 4 + n; return b; };
  const text = dec.decode(get()), bins = []; for (let i = 0; i < ctl[1]; i++) bins.push(get());
  return unpack(text, bins, mkErr);
}

// ---------------------------------------------------------------- the input ring: [head, tail, then records]
const ringPut = (ring, kind, a, b, c) => {
  const h = Atomics.load(ring, 0), n = (h + 1) % RING;
  if (n === Atomics.load(ring, 1)) return false;   // full: the machine is not taking input
  const o = 4 + 4 * h; ring[o] = kind; ring[o + 1] = a; ring[o + 2] = b; ring[o + 3] = c;
  Atomics.store(ring, 0, n); return true;
};
const ringTake = ring => {
  const t = Atomics.load(ring, 1); if (t === Atomics.load(ring, 0)) return null;
  const o = 4 + 4 * t, r = [ring[o], ring[o + 1], ring[o + 2], ring[o + 3]];
  Atomics.store(ring, 1, (t + 1) % RING); return r;
};
const newRing = () => new Int32Array(new SharedArrayBuffer(16 + 16 * RING));

// ---------------------------------------------------------------- frames for a machine's network card: a byte ring
// [head, tail] then the bytes, each frame its length (2 bytes) and itself; the card takes them as they arrive, while
// ring 0 waits for them too
const FRAMES = 1 << 20;
const newFrames = () => new SharedArrayBuffer(8 + FRAMES);
function framePut(sab, frame) {
  const ctl = new Int32Array(sab, 0, 2), d = new Uint8Array(sab, 8), n = frame.length + 2;
  const h = Atomics.load(ctl, 0), t = Atomics.load(ctl, 1), free = (t - h - 1 + FRAMES) % FRAMES;
  if (n > free) return false;   // full: dropped, as a card's buffer overflows
  const put = (k, v) => { d[(h + k) % FRAMES] = v; };
  put(0, frame.length & 0xff); put(1, frame.length >> 8);
  for (let i = 0; i < frame.length; i++) put(2 + i, frame[i]);
  Atomics.store(ctl, 0, (h + n) % FRAMES); Atomics.notify(ctl, 0); return true;
}
function frameTake(sab) {
  const ctl = new Int32Array(sab, 0, 2), d = new Uint8Array(sab, 8);
  const t = Atomics.load(ctl, 1); if (t === Atomics.load(ctl, 0)) return null;
  const n = d[t] | (d[(t + 1) % FRAMES] << 8), f = new Uint8Array(n);
  for (let i = 0; i < n; i++) f[i] = d[(t + 2 + i) % FRAMES];
  Atomics.store(ctl, 1, (t + 2 + n) % FRAMES); return f;
}
/** wait (in a worker) up to `ms` for a frame to arrive */
function frameWait(sab, ms) { const ctl = new Int32Array(sab, 0, 2), h = Atomics.load(ctl, 0); if (h !== Atomics.load(ctl, 1)) return true; return Atomics.wait(ctl, 0, h, ms) !== 'timed-out'; }

self.W95Bridge = { RPC_BYTES, answer, take, ringPut, ringTake, newRing, newFrames, framePut, frameTake, frameWait, KEY: 1, MOUSE: 2 };
})();
