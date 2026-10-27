// Another person's pointer in a shared session (win95.js remoteInput): moving over the screen it moves only their
// pointer (drawn over this machine's), not this machine's one mouse; a press, a drag and the release go to the
// machine; once no one else holds a button, this machine's pointer goes back to its own person's mouse
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const fn = name => { const i = w.indexOf(`function ${name}(`); return w.slice(i, w.indexOf('\n}\n', i) + 3); };
const events = [];
const env = new Function('pointer', 'mouse', 'dirty', 'performance', `
  let replaying = null, lastInputOther = false; const peers = new Map();
  const keyDown = () => {}, keyUp = () => {}, typed = () => {}, pressKey = () => {};
  ${fn('peerAt')}${fn('remoteInput')}
  return { remoteInput, peers };`)((t, x, y) => events.push([t, x, y]), { x: 300, y: 400 }, () => {}, { now: () => 0 });
env.remoteInput({ t: 'move', x: 10, y: 20, who: 'bob' });
assert.deepEqual(events, [], 'a hover: their pointer only');
assert.deepEqual([env.peers.get('bob').x, env.peers.get('bob').y], [10, 20]);
env.remoteInput({ t: 'down', x: 10, y: 20, b: 0, who: 'bob' });
env.remoteInput({ t: 'move', x: 50, y: 60, who: 'bob' });
env.remoteInput({ t: 'up', x: 50, y: 60, b: 0, who: 'bob' });
assert.deepEqual(events, [['pointerdown', 10, 20], ['pointermove', 50, 60], ['pointerup', 50, 60], ['pointermove', 300, 400]],
  'the drag to the machine, then this machine\'s pointer back at its own mouse');
console.log('peerpointer: ok');
