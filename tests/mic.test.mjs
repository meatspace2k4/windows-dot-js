// The page's microphone for the sound card's capture (mic.js): asked for when capture starts, its samples sent with the
// device's rate, its tracks stopped when capture stops; refused, nothing is sent (the card records silence); stopped
// while the person is still being asked, the stream it then gets is let go at once
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../mic.js', import.meta.url), 'utf8');
const env = allow => {
  const log = { asked: 0, stopped: 0, closed: 0 }, node = { connect() {}, disconnect() {} };
  const navigator = { mediaDevices: { getUserMedia: () => { log.asked++; return allow ? Promise.resolve({ getTracks: () => [{ stop: () => { log.stopped++; } }] }) : Promise.reject(new Error('denied')); } } };
  class AudioContext { constructor() { this.sampleRate = 48000; this.destination = {}; } createMediaStreamSource() { return { connect() {} }; } createScriptProcessor() { log.node = node; return node; } close() { log.closed++; return Promise.resolve(); } }
  const window = {}, console = { warn() {} };
  new Function('window', 'navigator', 'AudioContext', 'console', src)(window, navigator, AudioContext, console);
  return { M: window.W95Mic, log, node };
};
{
  const { M, log, node } = env(true), got = [];
  assert.equal(await M.set(true, (s, rate) => got.push([s.length, rate, s[0]])), true); assert.equal(log.asked, 1); assert.ok(M.open());
  node.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.25) } });
  assert.deepEqual(got, [[2048, 48000, 0.25]]);
  assert.equal(await M.set(true, () => {}), true); assert.equal(log.asked, 1, 'asked once while open');
  await M.set(false); assert.equal(log.stopped, 1); assert.equal(log.closed, 1); assert.ok(!M.open());
}
{ const { M } = env(false); assert.equal(await M.set(true, () => { throw new Error('sent'); }), false); assert.ok(!M.open()); }
{
  const { M, log } = env(true), p = M.set(true, () => {}); M.set(false); assert.equal(await p, false); assert.equal(log.stopped, 1, 'let go at once'); assert.ok(!M.open());
}
console.log('mic: ok');
