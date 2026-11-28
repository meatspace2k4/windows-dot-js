// The sound card is tended inside a long run too (win32.js tick, every 10 ms of the wall's time): tended only between
// slices, a run that went on under load left its queue to run dry and the startup sound stuttered
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../win32.js', import.meta.url), 'utf8');
const i = src.indexOf('this.cpu.budget.value = BUDGET;'), tick = src.slice(i, src.indexOf('if (this.runLevel === this.yieldLevel', i));
assert.ok(i > 0 && /this\.sound16\(\)/.test(tick), 'tick tends the sound card');
assert.match(tick, /performance\.now\(\)[\s\S]*>= 10/, 'every 10 ms of the wall');
assert.match(tick, /!this\.inSound/, 'never inside the card\'s own run');
console.log('soundinrun: ok');
