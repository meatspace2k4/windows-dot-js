// The bench harness (runner.mjs boot, explore.mjs reload) waits for the shell before it drives it. With the system's
// machine built in (W95SYSTEM), the shell is that machine's Explorer: the page shows its own desktop a second after
// a reload, six seconds before the machine's Explorer takes the screen, and the explorer's clicks and keys went to
// the page's placeholder shell, whose states vanished under it mid-walk.
import assert from 'node:assert/strict';
import { SHELL_READY } from '../bench/runner.mjs';

const ready = (win95, system = true, fonts = 'loaded') => new Function('win95', 'document', 'W95SYSTEM', 'return ' + SHELL_READY)(win95, { fonts: { status: fonts } }, system ? {} : undefined);
const page = (screen, sysApp, wins = []) => ({ state: { screen }, sysApp, windows: () => wins.map(title => ({ title })) });

assert.equal(ready(undefined), false, 'no win95 yet');
assert.equal(ready(page('boot', null)), false, 'booting');
assert.equal(ready(page('desktop', null)), false, "the page's own desktop, the machine not started: not the shell");
assert.equal(ready(page('desktop', { alive: true }, [])), false, 'the machine up, its Explorer not yet');
assert.equal(ready(page('desktop', { alive: true }, ['Program Manager', ''])), true, "Explorer's desktop window: the shell");
assert.equal(ready(page('desktop', { alive: false }, ['Program Manager'])), false, 'a dead machine is not the shell');
assert.equal(ready(page('desktop', { alive: true }, ['Program Manager']), true, 'loading'), false, 'fonts still loading');
assert.equal(ready(page('desktop', null), false), true, "without a system machine the page's desktop is the shell");
console.log('shellready: ok');
