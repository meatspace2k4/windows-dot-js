'use strict';
// The LAN's gateway to the Internet (lan.js's segment): a station that answers Windows 95's TCP/IP as a home router
// does. ARP for the 10.0.2.0/24 network, DHCP (the PC is 10.0.2.15, the gateway 10.0.2.2, its DNS 10.0.2.3), DNS (each
// name answered with an address of its own in 10.1.0.0/16, the name kept for it), ICMP echo, and TCP to port 80: the
// HTTP request a connection carries is made from the host (window.W95HOST.net, the app's: today's TLS) to the name the
// request asks for, https first, and the answer goes back as HTTP/1.0 with its https:// links made http://, so Internet
// Explorer 4, which has no TLS it could use, reaches today's sites. Other ports are refused (RST).
(function () {
const LAN = window.W95LAN; if (!LAN) return;
const MAC = Uint8Array.from([0x02, 0x00, 0x4e, 0x45, 0x54, 0x01]);
const ip = s => Uint8Array.from(s.split('.').map(Number));
const NET = ip('10.0.2.0'), GW = ip('10.0.2.2'), DNS = ip('10.0.2.3'), PC = ip('10.0.2.15'), MASK = ip('255.255.255.0');
const BCAST_MAC = Uint8Array.from([255, 255, 255, 255, 255, 255]);
const eq = (a, ao, b) => { for (let i = 0; i < b.length; i++) if (a[ao + i] !== b[i]) return false; return true; };
const be16 = (b, o) => (b[o] << 8) | b[o + 1], be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const put16 = (b, o, v) => { b[o] = (v >> 8) & 0xff; b[o + 1] = v & 0xff; };
const put32 = (b, o, v) => { b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff; };
const sum = (b, o, n, s = 0) => { for (let i = 0; i < n; i += 2) s += (b[o + i] << 8) | (i + 1 < n ? b[o + i + 1] : 0); return s; };
const fold = s => { while (s > 0xffff) s = (s & 0xffff) + (s >>> 16); return ~s & 0xffff; };
const enc = s => new TextEncoder().encode(s), latin = b => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const gw = window.W95LANIP = { trace: null, conns: new Map(), names: new Map(), addrs: new Map(), pcMac: null };

const station = { mac: MAC, rx: f => { try { receive(f); } catch (e) { console.error('[lanip]', e); } } };
LAN.attach(station);
const sendEth = (dst, type, payload) => {
  const f = new Uint8Array(Math.max(60, 14 + payload.length));
  f.set(dst, 0); f.set(MAC, 6); put16(f, 12, type); f.set(payload, 14);
  LAN.send(station, f);
};

function receive(f) {
  if (f.length < 14) return;
  const toUs = eq(f, 0, MAC), bcast = eq(f, 0, BCAST_MAC), type = be16(f, 12);
  if (!toUs && !bcast) return;
  gw.rx = (gw.rx || 0) + 1;
  if (type === 0x0806) arp(f);
  else if (type === 0x0800) ipv4(f.subarray(14), f.slice(6, 12));   // (the sender's address copied: a connection keeps it, and the frame's buffer is the card's to reuse)
  else if (type >= 0x600 && !gw.saidType) { gw.saidType = true; console.info(`[lanip] a frame of type ${type.toString(16)}h: not IP`); }
}

// ---------------------------------------------------------------- ARP: every address on the network but the PC's is
// the gateway's (the router, its DNS, and the names' addresses through it)
function arp(f) {
  const a = f.subarray(14);
  if (be16(a, 6) !== 1) return;   // (a request)
  const target = a.subarray(24, 28);
  if (eq(target, 0, PC) || target[0] === 0) return;
  const r = new Uint8Array(28);
  put16(r, 0, 1); put16(r, 2, 0x0800); r[4] = 6; r[5] = 4; put16(r, 6, 2);
  r.set(MAC, 8); r.set(target, 14); r.set(a.subarray(8, 14), 18); r.set(a.subarray(14, 18), 24);
  sendEth(a.subarray(8, 14), 0x0806, r);
}

// ---------------------------------------------------------------- IPv4
let ipId = 1;
function sendIP(dstMac, src, dst, proto, payload) {
  const h = new Uint8Array(20 + payload.length);
  h[0] = 0x45; put16(h, 2, h.length); put16(h, 4, ipId++ & 0xffff); h[8] = 64; h[9] = proto;
  h.set(src, 12); h.set(dst, 16); put16(h, 10, fold(sum(h, 0, 20)));
  h.set(payload, 20);
  sendEth(dstMac, 0x0800, h);
}
const pseudo = (src, dst, proto, len) => sum(src, 0, 4) + sum(dst, 0, 4) + proto + len;
function ipv4(p, srcMac) {
  if ((p[0] >> 4) !== 4) return;
  const hl = (p[0] & 15) * 4, len = Math.min(be16(p, 2), p.length), proto = p[9];
  if (be16(p, 6) & 0x3fff) return;   // (fragments: none sent here)
  const src = p.slice(12, 16), dst = p.slice(16, 20), body = p.subarray(hl, len);
  if (!src.every(x => !x)) gw.pcMac = srcMac.slice();
  if (proto === 1) icmp(src, dst, body, srcMac);
  else if (proto === 17) udp(src, dst, body, srcMac);
  else if (proto === 6) tcp(src, dst, body, srcMac);
}
function icmp(src, dst, b, mac) {
  if (b[0] !== 8) return;   // (echo request: answered from whatever it was sent to)
  const r = b.slice(); r[0] = 0; put16(r, 2, 0); put16(r, 2, fold(sum(r, 0, r.length)));
  sendIP(mac, dst, src, 1, r);
}

// ---------------------------------------------------------------- UDP: DHCP and DNS
function sendUDP(mac, src, dst, sport, dport, data) {
  const u = new Uint8Array(8 + data.length);
  put16(u, 0, sport); put16(u, 2, dport); put16(u, 4, u.length); u.set(data, 8);
  put16(u, 6, fold(pseudo(src, dst, 17, u.length) + sum(u, 0, u.length)) || 0xffff);
  sendIP(mac, src, dst, 17, u);
}
function udp(src, dst, u, mac) {
  const sport = be16(u, 0), dport = be16(u, 2), data = u.subarray(8, be16(u, 4));
  if (dport === 67) dhcp(data, mac);
  else if (dport === 53) dns(src, dst, sport, data, mac);
}
function dhcp(d, mac) {
  if (d[0] !== 1 || be32(d, 236) !== 0x63825363) return;
  let type = 0; for (let o = 240; o < d.length && d[o] !== 255;) { if (d[o] === 0) { o++; continue; } if (d[o] === 53) type = d[o + 2]; o += 2 + d[o + 1]; }
  const reply = type === 1 ? 2 : type === 3 ? 5 : 0;
  console.info(`[lanip] DHCP ${['', 'DISCOVER', 'OFFER', 'REQUEST', 'DECLINE', 'ACK', 'NAK', 'RELEASE', 'INFORM'][type] || type} from ${[...d.subarray(28, 34)].map(x => x.toString(16).padStart(2, '0')).join(':')}${reply ? ', answered' : ''}`);
  if (!reply) return;
  const r = new Uint8Array(300);
  r[0] = 2; r[1] = 1; r[2] = 6; r.set(d.subarray(4, 8), 4); r.set(d.subarray(10, 12), 10); r.set(PC, 16); r.set(GW, 20); r.set(d.subarray(28, 44), 28);
  put32(r, 236, 0x63825363);
  const opts = [[53, [reply]], [54, [...GW]], [51, [0, 1, 0x51, 0x80]], [1, [...MASK]], [3, [...GW]], [6, [...DNS]], [15, [...enc('lan')]]];
  let o = 240; for (const [k, v] of opts) { r[o++] = k; r[o++] = v.length; r.set(v, o); o += v.length; } r[o] = 255;
  sendUDP(d.subarray(28, 34), GW, ip('255.255.255.255'), 67, 68, r);
}
// a name's address: its own in 10.1.0.0/16, kept both ways
function addrOf(name) {
  name = name.toLowerCase().replace(/\.$/, '');
  let a = gw.names.get(name);
  if (!a) { const n = gw.names.size + 1; a = Uint8Array.from([10, 1, (n >> 8) & 0xff, n & 0xff]); gw.names.set(name, a); gw.addrs.set(a.join('.'), name); }
  return a;
}
function dns(src, dst, sport, q, mac) {
  if (q.length < 12 || q[2] & 0x80) return;
  let o = 12; const labels = [];
  while (o < q.length && q[o]) { labels.push(latin(q.subarray(o + 1, o + 1 + q[o]))); o += 1 + q[o]; }
  const qtype = be16(q, o + 1), qend = o + 5, name = labels.join('.');
  const answer = qtype === 1 && name.includes('.');
  const r = new Uint8Array(qend + (answer ? 16 : 0));
  r.set(q.subarray(0, qend)); r[2] = 0x81; r[3] = answer || qtype !== 1 ? 0x80 : 0x83; put16(r, 6, answer ? 1 : 0); put16(r, 8, 0); put16(r, 10, 0);
  if (answer) { const a = qend; put16(r, a, 0xc00c); put16(r, a + 2, 1); put16(r, a + 4, 1); put32(r, a + 6, 300); put16(r, a + 10, 4); r.set(addrOf(name), a + 12); }
  sendUDP(mac, dst, src, 53, sport, r);
}

// ---------------------------------------------------------------- TCP
const FIN = 1, SYN = 2, RST = 4, PSH = 8, ACK = 16, MSS = 1460;
function sendTCP(c, flags, data = new Uint8Array(0), seq = c.sndNxt) {
  const t = new Uint8Array(20 + data.length);
  put16(t, 0, c.lport); put16(t, 2, c.rport); put32(t, 4, seq); put32(t, 8, flags & ACK ? c.rcvNxt : 0);
  t[12] = 5 << 4; t[13] = flags; put16(t, 14, 0xffff); t.set(data, 20);
  put16(t, 16, fold(pseudo(c.local, c.remote, 6, t.length) + sum(t, 0, t.length)));
  sendIP(c.mac, c.local, c.remote, 6, t);
}
function tcp(src, dst, t, mac) {
  const sport = be16(t, 0), dport = be16(t, 2), seq = be32(t, 4), ack = be32(t, 8), off = (t[12] >> 4) * 4, flags = t[13], win = be16(t, 14);
  const data = t.subarray(off), key = `${src.join('.')}:${sport}>${dst.join('.')}:${dport}`;
  let c = gw.conns.get(key);
  if (flags & RST) { if (c) close(c); return; }
  if (!c) {
    if (!(flags & SYN) || flags & ACK) { if (!(flags & RST)) rst(src, dst, sport, dport, seq + data.length + (flags & (SYN | FIN) ? 1 : 0), ack, mac, flags); return; }
    if (dport !== 80) { rst(src, dst, sport, dport, seq + 1, 0, mac, flags); return; }
    c = { key, mac, local: dst, remote: src, lport: dport, rport: sport, rcvNxt: (seq + 1) >>> 0, iss: (Math.random() * 0xffffffff) >>> 0,
      win, req: [], out: new Uint8Array(0), outAt: 0, state: 'syn', host: gw.addrs.get(dst.join('.')) || dst.join('.') };
    c.sndUna = c.iss; c.sndNxt = c.iss; gw.conns.set(key, c);
    sendTCP(c, SYN | ACK, undefined, c.iss); c.sndNxt = (c.iss + 1) >>> 0; c.sndUna = c.iss;
    return;
  }
  c.win = win;
  if (flags & ACK && ((ack - c.sndUna) | 0) > 0 && ((c.sndNxt - ack) | 0) >= 0) {
    if (c.state === 'syn') c.state = 'open';
    const was = c.sndUna; c.sndUna = ack;
    if (c.outBase !== undefined) c.outAt = Math.max(c.outAt, (ack - c.outBase) | 0);
    if (ack !== was) c.retries = 0;
    if (c.state === 'finwait' && ack === c.sndNxt) { c.state = 'done'; if (c.peerFin) close(c); }
  }
  if (data.length || flags & FIN) {
    if (seq !== c.rcvNxt) { sendTCP(c, ACK); return; }   // (out of order: asked again for what is next)
    if (data.length) { c.rcvNxt = (c.rcvNxt + data.length) >>> 0; c.req.push(data.slice()); }
    if (flags & FIN) { c.rcvNxt = (c.rcvNxt + 1) >>> 0; c.peerFin = true; }
    sendTCP(c, ACK);
    if (data.length && !c.asked) request(c);
    if (c.peerFin && (c.state === 'done' || (c.asked && c.state === 'closed'))) close(c);
  }
  pump(c);
}
function rst(src, dst, sport, dport, ackNo, seqNo, mac, flags) {
  const c = { mac, local: dst, remote: src, lport: dport, rport: sport, rcvNxt: ackNo >>> 0, sndNxt: flags & ACK ? seqNo : 0 };
  sendTCP(c, RST | ACK);
}
function close(c) { gw.conns.delete(c.key); clearTimeout(c.timer); c.state = 'closed'; }
// what the answer has left to send, as much as the PC's window takes, MSS at a time; FIN after the last of it
function pump(c) {
  if (c.outBase === undefined || c.state === 'closed') return;
  while (c.state !== 'finwait' && c.state !== 'done') {
    const at = (c.sndNxt - c.outBase) | 0, inFlight = (c.sndNxt - c.sndUna) | 0;
    if (at >= c.out.length) { sendTCP(c, FIN | ACK); c.sndNxt = (c.sndNxt + 1) >>> 0; c.state = 'finwait'; break; }
    const room = Math.max(0, c.win - inFlight); if (room <= 0) break;
    const n = Math.min(MSS, room, c.out.length - at);
    sendTCP(c, ACK | PSH, c.out.subarray(at, at + n)); c.sndNxt = (c.sndNxt + n) >>> 0;
  }
  clearTimeout(c.timer);
  if (c.sndUna !== c.sndNxt) c.timer = setTimeout(() => retransmit(c), 600);
}
function retransmit(c) {
  if (c.state === 'closed' || c.sndUna === c.sndNxt) return;
  if ((c.retries = (c.retries || 0) + 1) > 12) { sendTCP(c, RST | ACK); close(c); return; }
  c.sndNxt = c.sndUna; if (c.state === 'finwait' || c.state === 'done') c.state = 'open';
  pump(c);
}

// ---------------------------------------------------------------- HTTP: the request, made from the host
const concat = parts => { const n = parts.reduce((a, b) => a + b.length, 0), o = new Uint8Array(n); let at = 0; for (const p of parts) { o.set(p, at); at += p.length; } return o; };
async function request(c) {
  const all = concat(c.req), text = latin(all), end = text.indexOf('\r\n\r\n');
  if (end < 0) return;
  const head = text.slice(0, end).split('\r\n'), [method, target] = head[0].split(' ');
  const hdrs = {}; for (const l of head.slice(1)) { const i = l.indexOf(':'); if (i > 0) hdrs[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
  const blen = +(hdrs['content-length'] || 0);
  if (all.length - end - 4 < blen) return;   // (the body still coming)
  c.asked = true;
  const body = all.subarray(end + 4, end + 4 + blen);
  let host = hdrs.host || c.host, path = target;
  const abs = /^https?:\/\/([^/]+)(.*)$/i.exec(target); if (abs) { host = abs[1]; path = abs[2] || '/'; }
  host = host.replace(/:80$/, '');
  const out = {}; for (const [k, v] of Object.entries(hdrs)) if (!['host', 'connection', 'proxy-connection', 'keep-alive', 'accept-encoding', 'content-length', 'upgrade-insecure-requests'].includes(k)) out[k] = v;
  let r = null;
  for (const scheme of ['https', 'http']) {
    r = await followRedirects({ url: `${scheme}://${host}${path}`, method, headers: out, body: blen ? Array.from(body) : null });
    if (!r.error) break;
  }
  respond(c, r);
}
const MAX_REDIRECTS = 20;
async function followRedirects(req) {
  for (let hop = 0; ; hop++) {
    const r = await hostFetch(req);
    const loc = !r.error && r.status >= 300 && r.status < 400 && r.headers.find(([k]) => k.toLowerCase() === 'location');
    if (!loc) return r;
    if (hop >= MAX_REDIRECTS) return { error: `more than ${MAX_REDIRECTS} redirects from ${req.url}` };
    const url = new URL(loc[1], req.url).href;
    const keep = r.status === 307 || r.status === 308 || (r.status !== 303 && req.method === 'GET') || req.method === 'HEAD';
    req = keep ? { ...req, url } : { ...req, url, method: 'GET', body: null };
  }
}
gw.followRedirects = followRedirects;
async function hostFetch(req) {
  const h = window.W95HOST && window.W95HOST.net;
  if (h) return h.fetch(req);
  if (window.W95NETFETCH) return window.W95NETFETCH(req);
  try {
    const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body ? new Uint8Array(req.body) : undefined, redirect: 'manual' });
    return { status: r.status || 200, statusText: r.statusText, headers: [...r.headers], body: new Uint8Array(await r.arrayBuffer()) };
  } catch (e) { return { error: String(e.message || e) }; }
}
const REASON = { 200: 'OK', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway' };
const deTLS = s => s.replace(/https:(\/\/|\\\/\\\/)/gi, 'http:$1');
function respond(c, r) {
  let status, headers = [], body;
  if (r.error) { status = 502; body = enc(`<html><body><h1>The gateway could not reach the site</h1><p>${r.error.replace(/</g, '&lt;')}</p></body></html>`); headers.push(['content-type', 'text/html']); }
  else {
    status = r.status === 308 ? 301 : r.status === 307 ? 302 : r.status;
    body = r.body instanceof Uint8Array ? r.body : new Uint8Array(r.body || []);
    const type = (r.headers.find(([k]) => k.toLowerCase() === 'content-type') || [, ''])[1];
    if (/text\/|javascript|json|xml/i.test(type)) {
      let s = deTLS(new TextDecoder(/charset=([\w-]+)/i.exec(type)?.[1] || 'utf-8').decode(body));
      if (/javascript|ecmascript/i.test(type)) s = self.W95IE4JS.script(s);
      else if (/text\/html/i.test(type)) s = self.W95IE4JS.html(s);
      body = enc(s);
    }
    for (const [k, v] of r.headers) {
      const l = k.toLowerCase();
      if (['content-encoding', 'transfer-encoding', 'content-length', 'connection', 'keep-alive', 'strict-transport-security', 'content-security-policy', 'alt-svc'].includes(l)) continue;
      if (l === 'content-type' && /text\/|javascript|json|xml/i.test(v)) { headers.push([k, v.replace(/;\s*charset=[^;]*/i, '') + '; charset=utf-8']); continue; }
      headers.push([k, l === 'location' || l === 'set-cookie' ? deTLS(v).replace(/;\s*secure/gi, '') : v]);
    }
  }
  const head = `HTTP/1.0 ${status} ${REASON[status] || (r.statusText || 'OK')}\r\n` + headers.map(([k, v]) => `${k}: ${v}\r\n`).join('') + `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  c.out = concat([enc(head), body]); c.outBase = c.sndNxt;
  pump(c);
}
})();
