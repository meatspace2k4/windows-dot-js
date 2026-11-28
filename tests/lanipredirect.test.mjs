import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
const seen = [];
const pages = {
  'https://a.test/': { status: 301, headers: [['Location', '/b']] },
  'https://a.test/b': { status: 302, headers: [['location', 'https://c.test/x?q=1']] },
  'https://c.test/x?q=1': { status: 200, headers: [['content-type', 'text/plain']], body: new TextEncoder().encode('ok') },
  'https://loop.test/': { status: 302, headers: [['Location', 'https://loop.test/']] },
  'https://post.test/': { status: 303, headers: [['Location', '/done']] },
  'https://post.test/done': { status: 200, headers: [], body: new Uint8Array(0) },
};
window.W95NETFETCH = async req => { seen.push([req.method, req.url, req.body]); return pages[req.url] || { status: 404, headers: [], body: new Uint8Array(0) }; };
const src = readFileSync(new URL('../lanip.js', import.meta.url), 'utf8');
window.W95LAN = { stations: new Set(), attach() { return { send() {} }; }, join() { return { send() {} }; } };
new Function(src)();
const follow = window.W95LANIP.followRedirects;
const r = await follow({ url: 'https://a.test/', method: 'GET', headers: {}, body: null });
assert.equal(r.status, 200);
assert.deepEqual(seen.map(s => s[1]), ['https://a.test/', 'https://a.test/b', 'https://c.test/x?q=1']);
const l = await follow({ url: 'https://loop.test/', method: 'GET', headers: {}, body: null });
assert.match(l.error, /more than 20 redirects/);
seen.length = 0;
const p = await follow({ url: 'https://post.test/', method: 'POST', headers: {}, body: [1, 2] });
assert.equal(p.status, 200);
assert.deepEqual(seen[1], ['GET', 'https://post.test/done', null]);
console.log('lanipredirect: ok');
