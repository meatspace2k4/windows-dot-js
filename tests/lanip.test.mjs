// The LAN's gateway (lanip.js): DHCP gives the PC 10.0.2.15 with the gateway and its DNS; DNS answers a name with an
// address of its own; a TCP connection to port 80 carries an HTTP request, made from the host over https, and the
// answer comes back as HTTP/1.0 with its https:// links made http://
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis;
const sent = [];
window.W95LAN = { stations: new Set(), send(from, f) { sent.push(f); }, attach(s) { this.stations.add(s); } };
const asked = [];
window.W95HOST = { net: { fetch: async req => { asked.push(req); return { status: 200, statusText: 'OK', headers: [['content-type', 'text/html'], ['content-encoding', 'gzip']], body: new TextEncoder().encode('<a href="https://example.com/x">x</a>') }; } } };
new Function(readFileSync(new URL('../lanip.js', import.meta.url), 'utf8'))();
const gw = [...window.W95LAN.stations][0];
const PCMAC = [0, 0, 0xe8, 0x95, 1, 2];
const be16 = (b, o) => (b[o] << 8) | b[o + 1], be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const sum = (b, o, n, s = 0) => { for (let i = 0; i < n; i += 2) s += (b[o + i] << 8) | (i + 1 < n ? b[o + i + 1] : 0); return s; };
const fold = s => { while (s > 0xffff) s = (s & 0xffff) + (s >>> 16); return ~s & 0xffff; };
const eth = (dst, type, p) => { const f = new Uint8Array(14 + p.length); f.set(dst); f.set(PCMAC, 6); f[12] = type >> 8; f[13] = type & 255; f.set(p, 14); return f; };
const ipPkt = (src, dst, proto, body) => { const h = new Uint8Array(20 + body.length); h[0] = 0x45; h[2] = h.length >> 8; h[3] = h.length & 255; h[8] = 64; h[9] = proto; h.set(src, 12); h.set(dst, 16); h.set(body, 20); return h; };
const udpPkt = (sp, dp, d) => { const u = new Uint8Array(8 + d.length); u[0] = sp >> 8; u[1] = sp & 255; u[2] = dp >> 8; u[3] = dp & 255; u[4] = u.length >> 8; u[5] = u.length & 255; u.set(d, 8); return u; };
const GWMAC = gw.mac, BC = [255, 255, 255, 255, 255, 255];
const take = () => sent.splice(0).map(f => ({ type: be16(f, 12), ip: f.subarray(14) }));

// DHCP discover -> offer of 10.0.2.15
const dh = new Uint8Array(244); dh[0] = 1; dh[1] = 1; dh[2] = 6; dh.set(PCMAC, 28); dh[236] = 0x63; dh[237] = 0x82; dh[238] = 0x53; dh[239] = 0x63; dh.set([53, 1, 1, 255], 240);
gw.rx(eth(BC, 0x800, ipPkt([0, 0, 0, 0], [255, 255, 255, 255], 17, udpPkt(68, 67, dh))));
let [o] = take(); const off = o.ip.subarray(28);
assert.deepEqual([...off.subarray(16, 20)], [10, 0, 2, 15], 'the offer gives 10.0.2.15');
// DNS: a name -> an address of its own
const q = [0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 7, ...Buffer.from('example'), 3, ...Buffer.from('com'), 0, 0, 1, 0, 1];
gw.rx(eth(GWMAC, 0x800, ipPkt([10, 0, 2, 15], [10, 0, 2, 3], 17, udpPkt(1053, 53, Uint8Array.from(q)))));
[o] = take(); const ans = o.ip.subarray(28), addr = [...ans.subarray(ans.length - 4)];
assert.equal(be16(ans, 6), 1, 'one answer'); assert.deepEqual(addr.slice(0, 2), [10, 1]);
// TCP to port 80: SYN, then the request
const tcpPkt = (seq, ack, flags, data = []) => { const t = new Uint8Array(20 + data.length); t[0] = 0x04; t[1] = 0x01; t[2] = 0; t[3] = 80; t[4] = seq >>> 24; t[5] = (seq >> 16) & 255; t[6] = (seq >> 8) & 255; t[7] = seq & 255; t[8] = ack >>> 24; t[9] = (ack >> 16) & 255; t[10] = (ack >> 8) & 255; t[11] = ack & 255; t[12] = 0x50; t[13] = flags; t[14] = 0x22; t[15] = 0x38; t.set(data, 20); return t; };
gw.rx(eth(GWMAC, 0x800, ipPkt([10, 0, 2, 15], addr, 6, tcpPkt(1000, 0, 2))));
[o] = take(); let t = o.ip.subarray(20); assert.equal(t[13], 0x12, 'SYN+ACK'); const iss = be32(t, 4);
const req = Buffer.from('GET /page HTTP/1.0\r\nHost: example.com\r\n\r\n');
gw.rx(eth(GWMAC, 0x800, ipPkt([10, 0, 2, 15], addr, 6, tcpPkt(1001, iss + 1, 0x18, [...req]))));
await new Promise(r => setTimeout(r, 20));
assert.equal(asked[0].url, 'https://example.com/page', 'made over https from the host');
const segs = take().map(s => s.ip.subarray(20, be16(s.ip, 2))), text = Buffer.concat(segs.map(s => Buffer.from(s.subarray(20)))).toString('latin1');
assert.match(text, /^HTTP\/1\.0 200 OK\r\n/); assert.doesNotMatch(text, /content-encoding/i);
assert.match(text, /href="http:\/\/example\.com\/x"/, 'its https links made http');
for (const s of segs) { const ipH = ipPkt([10, 0, 2, 15], addr, 6, s); }
console.log('lanip: ok');
setTimeout(() => process.exit(0), 0);
