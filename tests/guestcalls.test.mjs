// The page's own calls into a machine's guest code (a network connection's name, Close Program's hung test and its
// state for REBOOT, the controls USER keeps for a window) answer to that machine (caught): a fault there is its
// fault, anything else its end. Each was a console line, and the page went on with a made-up answer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const guest = /\bp\.call\(|q\.call\(|nativeChildren\(|k32CloseState\(|\.user16\(|keyEvent16\(|mouseEvent16\(|vkdKey\(|vxdRunTimeOuts\(|nativeWindows\(/;
for (const file of ['win95.js', 'worker.js']) {
  const lines = readFileSync(new URL('../' + file, import.meta.url), 'utf8').split('\n');
  const swallowed = lines.map((l, i) => [i + 1, l]).filter(([, l]) => guest.test(l) && /catch \(\w+\) \{ console\.error\([^)]*\);( return[^}]*;)? \}/.test(l));
  assert.deepEqual(swallowed.map(([n, l]) => `${n}: ${l.trim().slice(0, 100)}`), [], `${file}: no guest call ends in a console line`);
}
console.log('guestcalls: ok');
