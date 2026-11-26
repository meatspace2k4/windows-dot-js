"""A stand-in for Discord, to run the page as a Discord Activity on this computer before it runs in the real one: the
three parts of Discord an Activity meets, on one port, told apart by the Host asked.

    python3 tools/discord_stub.py 3333 --app http://127.0.0.1:8161 --client-id 1234567890123456789 --client-secret stub-secret

    http://localhost:3333/discord-client?user=Ann%20Lee&username=annlee&id=111     Discord's client, as one person in a voice channel
        The Activity in a frame, as Discord's client frames it: another origin than the client's own, which is not
        cross-origin isolated; the launch parameters on the frame's URL (instance_id, guild_id, channel_id, frame_id,
        platform); and the client's side of the Embedded App SDK's RPC, the messages the real SDK posts to its parent:
        HANDSHAKE answered with READY, then AUTHORIZE (a code) and AUTHENTICATE (the person), each checked as Discord
        checks it (the application's id, the frame's id, the scope, a token this API issued). &launch=, &guild= and
        &channel= say which instance: the same ones in two tabs are two people in one Activity.
        (The SDK takes messages from Discord's own origins and http://localhost:3333 only: the port is that one.)
    http://<client id>.discordsays.localhost:3333/...                Discord's proxy to the Activity (discordsays.com)
        Every request passed to --app, the mapped site (/.proxy/... too), with a content security policy that lets the
        page reach its own origin only, as the proxy's does.
    POST http://localhost:3333/api/oauth2/token                      Discord's API: the code for an access token
        For the application's id and secret and a code this client issued, once; the errors Discord's gives otherwise.
        The page's server asks here when W95_DISCORD_API is http://127.0.0.1:3333/api (tools/discord_api.py).

--same-origin: the client's page (/discord-client) and the Activity (every other path, passed to --app) on the one
origin asked, for a port that is not 3333 (the SDK takes a parent of the frame's own origin too). The client's page
is still not cross-origin isolated, so the frame has shared memory only by its own document's policy; what it does not
show is the frame as another site's (its storage partitioned, a permission policy from its embedder).

What is Discord's own and is only approximated: the policy's exact text, and the frame's sandbox and allow lists.
"""
import argparse, http.client, http.server, json, re, secrets, threading, urllib.parse

ap = argparse.ArgumentParser(); ap.add_argument('port', type=int); ap.add_argument('--app', required=True, help='the Activity\'s own server (the URL mapping\'s target)')
ap.add_argument('--client-id', default='1234567890123456789'); ap.add_argument('--client-secret', default='stub-secret')
ap.add_argument('--same-origin', action='store_true', help='the client and the Activity on one origin (a port other than 3333)'); a = ap.parse_args()
APP = urllib.parse.urlsplit(a.app)
ACTIVITY_HOST = f'{a.client_id}.discordsays.localhost'
LOCK = threading.Lock()
CODES, TOKENS = {}, {}   # (code -> { user, scopes }, given once; access token -> the same)
SCOPES = {'identify', 'guilds', 'guilds.members.read', 'rpc.activities.write', 'rpc.voice.read', 'applications.commands'}
CSP = ("default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; "
       "connect-src 'self' blob: data:; worker-src 'self' blob:; frame-ancestors http://localhost:%d http://127.0.0.1:%d" % (a.port, a.port))
HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length'}

CLIENT = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Discord (stub)</title>
<style>
  html, body { margin: 0; height: 100%; background: #313338; color: #dbdee1; font: 13px/1.4 system-ui, sans-serif; }
  body { display: flex; flex-direction: column; }
  header { padding: 6px 10px; background: #1e1f22; display: flex; gap: 14px; align-items: baseline; }
  header b { color: #fff; } #state { color: #949ba4; }
  iframe { flex: 1; border: 0; width: 100%; background: #000; }
  #log { height: 96px; overflow: auto; margin: 0; padding: 4px 10px; background: #1e1f22; color: #949ba4; font: 11px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
</style></head><body>
<header><b id="who"></b><span id="where"></span><span id="state">launching</span></header>
<iframe id="activity" sandbox="allow-pointer-lock allow-scripts allow-same-origin allow-forms" allow="autoplay; encrypted-media"></iframe>
<pre id="log"></pre>
<script>
const CFG = __CFG__;
const q = new URLSearchParams(location.search);
const digits = (v, d) => (String(v || '').replace(/\D/g, '') || d);
const user = { id: digits(q.get('id'), '111111111111111111'), username: (q.get('username') || (q.get('user') || 'stubuser').toLowerCase().replace(/[^a-z0-9_.]/g, '')) || 'stubuser',
  discriminator: '0', global_name: q.has('user') ? q.get('user') : 'Stub User', avatar: null, public_flags: 0 };
const guild = digits(q.get('guild'), '444444444444444444'), channel = digits(q.get('channel'), '555555555555555555'), launch = digits(q.get('launch'), '1');
const instance = `i-${launch}-gc-${guild}-${channel}`;
const frameId = crypto.randomUUID();
const origin = CFG.sameOrigin ? location.origin : `http://${CFG.activityHost}:${location.port}`;
const frame = document.getElementById('activity');
const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, HELLO: 3 };
const rpc = [];   // (every message, for the tests to read: window.stub.rpc)
const log = (dir, what) => { rpc.push({ dir, what }); const el = document.getElementById('log'); el.textContent += `${dir} ${typeof what === 'string' ? what : JSON.stringify(what)}\n`; el.scrollTop = el.scrollHeight; };
const state = s => { document.getElementById('state').textContent = s; };
document.getElementById('who').textContent = `${user.global_name} (@${user.username})`;
document.getElementById('where').textContent = instance;

let shaken = false, authed = null;
const post = m => frame.contentWindow.postMessage(m, origin);
const reply = (m, data) => { log('<-', { cmd: m.cmd, data: m.cmd === 'AUTHENTICATE' ? { user: data.user } : data }); post([OP.FRAME, { cmd: m.cmd, evt: null, data, nonce: m.nonce }]); };
const fail = (m, code, message) => { log('<-', { cmd: m.cmd, error: code, message }); post([OP.FRAME, { cmd: m.cmd, evt: 'ERROR', data: { code, message }, nonce: m.nonce }]); };
const close = (code, message) => { log('<-', { close: code, message }); state('closed: ' + message); post([OP.CLOSE, { code, message }]); };
const api = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ ok: r.ok, body: await r.json() }));

// Discord's client's side of the SDK's RPC. A message from anywhere but the Activity's frame and origin is not one
addEventListener('message', async e => {
  if (e.source !== frame.contentWindow || e.origin !== origin || !Array.isArray(e.data)) return;
  const [op, m] = e.data;
  if (op === OP.HANDSHAKE) {
    log('->', { handshake: m });
    if (!m || m.v !== 1 || m.encoding !== 'json') return close(4004, 'Invalid version or encoding');
    if (m.client_id !== CFG.clientId) return close(4000, 'Invalid Client ID');
    if (m.frame_id !== frameId) return close(4001, 'Invalid Origin');
    shaken = true; state('handshake done');
    log('<-', 'READY');
    return post([OP.FRAME, { cmd: 'DISPATCH', evt: 'READY', nonce: null, data: { v: 1, config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' } } }]);
  }
  if (op === OP.CLOSE) { log('->', { close: m }); return state('the Activity closed'); }
  if (op !== OP.FRAME || !m || typeof m.cmd !== 'string') return;
  const args = m.args || {};
  if (m.cmd !== 'CAPTURE_LOG') log('->', { cmd: m.cmd, args: m.cmd === 'AUTHENTICATE' ? { access_token: '...' } : args });
  if (!shaken) return fail(m, 4003, 'Not handshaken');
  if (m.cmd === 'AUTHORIZE') {
    if (args.client_id !== CFG.clientId) return fail(m, 4007, 'Invalid Client ID');
    if (args.response_type !== 'code') return fail(m, 4000, 'Invalid response_type');
    const scopes = Array.isArray(args.scope) ? args.scope : [];
    if (!scopes.length || scopes.some(s => !CFG.scopes.includes(s))) return fail(m, 4005, 'Invalid scope');
    const r = await api('/stub/authorize', { user, scopes });
    return r.ok ? reply(m, { code: r.body.code }) : fail(m, 5000, 'OAuth2 error');
  }
  if (m.cmd === 'AUTHENTICATE') {
    const r = await api('/stub/authenticate', { access_token: args.access_token });
    if (!r.ok) return fail(m, 4009, 'Invalid access token');
    authed = r.body; state(`authenticated as ${authed.user.username}`);
    return reply(m, { access_token: args.access_token, user: authed.user, scopes: authed.scopes, expires: new Date(Date.now() + 6048e5).toISOString(),
      application: { id: CFG.clientId, name: 'Windows 95 (stub)', description: '', icon: null, rpc_origins: [] } });
  }
  if (m.cmd === 'CAPTURE_LOG') return reply(m, null);
  if (!authed) return fail(m, 4006, 'Not authenticated');
  if (m.cmd === 'GET_INSTANCE_CONNECTED_PARTICIPANTS') return reply(m, { participants: [{ ...user, flags: 0, bot: false, nickname: user.global_name }] });
  if (m.cmd === 'SUBSCRIBE' || m.cmd === 'UNSUBSCRIBE') return post([OP.FRAME, { cmd: m.cmd, evt: null, data: { evt: m.evt }, nonce: m.nonce }]);
  return fail(m, 4002, `Invalid command: ${m.cmd}`);
});

const launchUrl = new URL(origin + '/');
for (const [k, v] of Object.entries({ instance_id: instance, location_id: `gc-${guild}-${channel}`, launch_id: launch, guild_id: guild, channel_id: channel, frame_id: frameId, platform: 'desktop' })) launchUrl.searchParams.set(k, v);
for (const [k, v] of q) if (k.startsWith('app.')) launchUrl.searchParams.set(k.slice(4), v);   // (?app.x=y: x=y on the Activity's own URL, for a test)
window.stub = { user, instance, frameId, origin, rpc, frame, url: launchUrl.toString() };
frame.src = launchUrl.toString();
</script></body></html>
"""


def send(h, status, body, ctype='application/json'):
    b = body if isinstance(body, bytes) else json.dumps(body).encode()
    h.send_response(status); h.send_header('Content-Type', ctype); h.send_header('Cache-Control', 'no-store')
    h.send_header('Content-Length', str(len(b))); h.end_headers(); h.wfile.write(b)


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, format, *args): pass
    def host(self): return (self.headers.get('Host') or '').rsplit(':', 1)[0].strip('[]').lower()
    def body(self):
        try: return self.rfile.read(int(self.headers.get('Content-Length') or 0))
        except ValueError: return b''

    def do_GET(self): self.route('GET')
    def do_HEAD(self): self.route('HEAD')
    def do_POST(self): self.route('POST')

    def route(self, method):
        host = self.host()
        if host.endswith('.discordsays.localhost'):
            if host != ACTIVITY_HOST: return send(self, 404, {'message': 'Unknown application'})
            return self.proxy(method)
        path = self.path.split('?')[0]
        if method == 'GET' and path == '/discord-client':
            cfg = {'clientId': a.client_id, 'activityHost': ACTIVITY_HOST, 'scopes': sorted(SCOPES), 'sameOrigin': a.same_origin}
            return send(self, 200, CLIENT.replace('__CFG__', json.dumps(cfg)).encode(), 'text/html; charset=utf-8')
        if a.same_origin and not re.match(r'^/(api/oauth2/token|stub/(authorize|authenticate))$', path): return self.proxy(method)
        if method == 'GET' and path == '/':
            self.send_response(302); self.send_header('Location', '/discord-client' + (self.path[1:] if self.path.startswith('/?') else '')); self.send_header('Content-Length', '0'); self.end_headers(); return
        if method == 'POST' and path == '/api/oauth2/token': return self.token()
        if method == 'POST' and path in ('/stub/authorize', '/stub/authenticate'):
            # (the client's own page only: the Activity's frame is another origin, and gets no code or person from here)
            origin = self.headers.get('Origin')
            if origin not in (f'http://localhost:{a.port}', f'http://127.0.0.1:{a.port}'): return send(self, 403, {'message': 'not the client'})
            try: q = json.loads(self.body() or b'{}')
            except ValueError: return send(self, 400, {'message': 'not JSON'})
            if path == '/stub/authorize':
                code = secrets.token_urlsafe(22)
                with LOCK: CODES[code] = {'user': q.get('user') or {}, 'scopes': q.get('scopes') or []}
                return send(self, 200, {'code': code})
            with LOCK: who = TOKENS.get(str(q.get('access_token')))
            return send(self, 200, who) if who else send(self, 401, {'message': '401: Unauthorized'})
        send(self, 404, {'message': '404: Not Found'})

    def token(self):
        """Discord's token endpoint for the authorization code grant: the application's id and secret, a code given once"""
        f = dict(urllib.parse.parse_qsl(self.body().decode('utf-8', 'replace')))
        if f.get('grant_type') != 'authorization_code': return send(self, 400, {'error': 'unsupported_grant_type'})
        if f.get('client_id') != a.client_id or f.get('client_secret') != a.client_secret: return send(self, 401, {'error': 'invalid_client'})
        with LOCK: grant = CODES.pop(f.get('code') or '', None)
        if not grant: return send(self, 400, {'error': 'invalid_grant', 'error_description': 'Invalid "code" in request.'})
        tok = secrets.token_urlsafe(24)
        with LOCK: TOKENS[tok] = grant
        send(self, 200, {'token_type': 'Bearer', 'access_token': tok, 'expires_in': 604800, 'refresh_token': secrets.token_urlsafe(24), 'scope': ' '.join(grant['scopes'])})

    def proxy(self, method):
        """the request passed to the Activity's server and its answer back as it comes (an event stream stays open)"""
        path = re.sub(r'^/\.proxy(?=/)', '', self.path)
        body = self.body() if method == 'POST' else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        headers['Host'] = APP.netloc
        up = http.client.HTTPConnection(APP.hostname, APP.port or 80, timeout=60)
        try:
            up.request(method, path, body=body, headers=headers); r = up.getresponse()
        except OSError as e:
            up.close(); return send(self, 502, {'message': f'the mapped site did not answer: {e}'})
        self.close_connection = True
        try:
            self.send_response(r.status)
            for k, v in r.getheaders():
                if k.lower() not in HOP and k.lower() != 'content-security-policy': self.send_header(k, v)
            n = r.getheader('Content-Length')
            if n is not None: self.send_header('Content-Length', n)
            self.send_header('Content-Security-Policy', CSP); self.send_header('Connection', 'close'); self.end_headers()
            if method != 'HEAD':
                r.fp.raw._sock.settimeout(None) if getattr(getattr(r.fp, 'raw', None), '_sock', None) else None   # (an event stream waits as long as it is open)
                while True:
                    b = r.read1(1 << 16)
                    if not b: break
                    self.wfile.write(b); self.wfile.flush()
        except OSError: pass
        finally: up.close()


class S(http.server.ThreadingHTTPServer): request_queue_size = 128; daemon_threads = True
S(('127.0.0.1', a.port), H).serve_forever()
