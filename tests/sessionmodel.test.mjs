// A shared session's protocol, model-checked (tools/convolution/model.mjs): two machines and the server, with the
// decisions the page makes (oslogic.js) and the session's ordering (shared.js, sessions.py). Every interleaving of
// the people's actions (move, close, reopen), the posts and the deliveries is explored; once nothing is in flight,
// every machine must show what the session holds: no machine with a window the session closed, none without one it
// has, every place the same, no machine's copy of the world unlike the server's, and a close or an open made with
// nothing else in flight not undone. Then a third machine joining late, and two objects.
import assert from 'node:assert/strict';
import { model } from '../tools/convolution/model.mjs';

const n = model().explore(4);
// the rules the session keeps: a machine's own change on its way wins over another's the server put before it
// (shared.js); a change made before its object was closed is passed over (sessions.py: close wins, and an object
// opened again after its close is a new one). Without either, the machines are found to disagree
for (const off of ['ownWins', 'gens'])
  assert.throws(() => model({ rules: { ownWins: true, gens: true, [off]: false } }).explore(3), /server W=/, `without ${off}: a disagreement found`);
const late = model({ machines: ['A', 'B', 'C'], late: ['C'] }).explore(3);
const two = model({ ids: ['W', 'X'] }).explore(3);
console.log(`sessionmodel: ok (${n} states; with a late join ${late}, two objects ${two})`);
