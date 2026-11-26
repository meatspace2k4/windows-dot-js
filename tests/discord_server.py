"""tools/discord_api.py and tools/discord_stub.py, run by tests/discord.test.mjs: the exchange of a code for an access
token (what is refused before Discord is asked, what Discord's answer becomes, the secret never in an answer), the two
endpoints over HTTP, and the whole way round with the stand-in for Discord: a code its client issued, exchanged by the
page's server at its token endpoint through its proxy, good once, and the person its client then names for the token."""
import http.client, http.server, json, os, socket, subprocess, sys, threading, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tools'))
import discord_api as D

for k in ('W95_DISCORD_CLIENT_ID', 'W95_DISCORD_CLIENT_SECRET', 'W95_DISCORD_API'): os.environ.pop(k, None)
D.ID_FILE = D.SECRET_FILE = os.path.join(HERE, 'no-such-file')   # (this computer's own application is not the test's)

# ---- the exchange: refused before anything is asked without a code or an application
asked = []
def post(status, body):
    def f(url, form): asked.append((url, form)); return status, json.dumps(body).encode()
    return f
for bad in (None, '', 5, 'a b', 'x' * 257, 'a&client_secret=1'):
    assert D.exchange(bad, post(200, {}))[0] == 400, bad
assert D.exchange('abc', post(200, {}))[0] == 500 and not asked, 'no application: nothing asked'
os.environ['W95_DISCORD_CLIENT_ID'] = 'app1'; os.environ['W95_DISCORD_CLIENT_SECRET'] = 's3cret'
assert D.client_id() == 'app1'
# Discord's grant: the access token alone goes on to the page
r = D.exchange('abc-DEF_1.2', post(200, {'access_token': 'tok', 'refresh_token': 'ref', 'token_type': 'Bearer', 'expires_in': 604800, 'scope': 'identify'}))
assert r == (200, {'access_token': 'tok'}), r
assert asked == [('https://discord.com/api/oauth2/token', {'client_id': 'app1', 'client_secret': 's3cret', 'grant_type': 'authorization_code', 'code': 'abc-DEF_1.2'})], asked
# Discord's refusal, an answer that is no grant, an endpoint that is not there: 502, and why, never the secret
r = D.exchange('abc', post(400, {'error': 'invalid_grant', 'error_description': 'Invalid "code" in request.'}))
assert r == (502, {'error': 'invalid_grant', 'error_description': 'Invalid "code" in request.'}), r
for status, body in ((200, {}), (200, {'access_token': ''}), (200, ['x']), (500, {})):
    r = D.exchange('abc', post(status, body)); assert r[0] == 502 and 's3cret' not in json.dumps(r[1]), r
def gone(url, form): raise ConnectionRefusedError('refused')
assert D.exchange('abc', gone)[0] == 502
os.environ['W95_DISCORD_API'] = 'http://127.0.0.1:1/api/'; assert D.api() == 'http://127.0.0.1:1/api'

# ---- over HTTP, as serve.py and win95_server.py answer: /__discord/config and /__discord/token; anything else not theirs
class App(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def answer(self, method):
        if self.path.startswith('/__discord/') and D.handle(self, method): return
        b = b'the page' if self.path.split('?')[0] == '/' else b''
        self.send_response(200 if b else 404); self.send_header('Content-Type', 'text/html'); self.send_header('Content-Length', str(len(b)))
        self.send_header('Document-Isolation-Policy', 'isolate-and-require-corp'); self.end_headers(); self.wfile.write(b)
    def do_GET(self): self.answer('GET')
    def do_POST(self): self.answer('POST')
app = http.server.ThreadingHTTPServer(('127.0.0.1', 0), App); threading.Thread(target=app.serve_forever, daemon=True).start()
def req(port, method, path, body=None, headers=None, raw=False):
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    h = dict(headers or {})
    if body is not None and not isinstance(body, (bytes, str)): body = json.dumps(body); h['Content-Type'] = 'application/json'
    c.request(method, path, body=body, headers=h); r = c.getresponse(); b = r.read(); c.close()
    return (r.status, b, r) if raw else (r.status, json.loads(b) if b else None)
AP = app.server_address[1]
assert req(AP, 'GET', '/__discord/config') == (200, {'client_id': 'app1'})
assert req(AP, 'POST', '/__discord/token', {'code': 'a b'})[0] == 400
assert req(AP, 'POST', '/__discord/token', 'not json')[0] == 400
assert req(AP, 'POST', '/__discord/token', {'code': 'x' * 9000})[0] == 400, 'a body past the limit is not read'
assert req(AP, 'GET', '/__discord/token')[0] == 404 and req(AP, 'POST', '/__discord/config', {})[0] == 404
assert req(AP, 'POST', '/__discord/token', {'code': 'abc'})[0] == 502, 'no Discord at that address'

# ---- the whole way round with the stand-in for Discord (tools/discord_stub.py): its client's page, its proxy to the
# page's server, its token endpoint
s = socket.socket(); s.bind(('127.0.0.1', 0)); SP = s.getsockname()[1]; s.close()
stub = subprocess.Popen([sys.executable, os.path.join(HERE, '..', 'tools', 'discord_stub.py'), str(SP), '--same-origin', '--app', f'http://127.0.0.1:{AP}',
                         '--client-id', 'app1', '--client-secret', 's3cret'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
try:
    for _ in range(100):
        try: socket.create_connection(('127.0.0.1', SP), timeout=0.2).close(); break
        except OSError:
            assert stub.poll() is None, stub.stderr.read().decode()
            time.sleep(0.05)
    os.environ['W95_DISCORD_API'] = f'http://127.0.0.1:{SP}/api'
    origin = {'Origin': f'http://127.0.0.1:{SP}'}
    # the client's page: not cross-origin isolated, the Activity's frame as Discord frames it
    st, b, r = req(SP, 'GET', '/discord-client?user=Ann', raw=True)
    assert st == 200 and b'sandbox="allow-pointer-lock allow-scripts allow-same-origin allow-forms"' in b and b'"clientId": "app1"' in b
    assert not r.getheader('Cross-Origin-Embedder-Policy') and not r.getheader('Document-Isolation-Policy'), 'the client is not isolated'
    # the proxy: the page's server's answer with its own headers, and a policy that keeps the page to its origin
    st, b, r = req(SP, 'GET', '/?frame_id=f&instance_id=i-1&platform=desktop', raw=True)
    assert (st, b) == (200, b'the page') and r.getheader('Document-Isolation-Policy') == 'isolate-and-require-corp' and "default-src 'self'" in r.getheader('Content-Security-Policy')
    assert req(SP, 'GET', '/.proxy/__discord/config') == (200, {'client_id': 'app1'}), 'Discord\'s /.proxy/ prefix is the same site'
    assert req(SP, 'GET', '/nothing')[0] == 404
    # a code from the client (its own page asks, not another origin's), exchanged by the page's server through the proxy
    ann = {'id': '111', 'username': 'annlee', 'global_name': 'Ann Lee', 'discriminator': '0', 'avatar': None, 'public_flags': 0}
    assert req(SP, 'POST', '/stub/authorize', {'user': ann, 'scopes': ['identify']}, {'Origin': 'http://evil.example'})[0] == 403
    code = req(SP, 'POST', '/stub/authorize', {'user': ann, 'scopes': ['identify']}, origin)[1]['code']
    st, grant = req(SP, 'POST', '/__discord/token', {'code': code}); assert st == 200 and list(grant) == ['access_token'], grant
    assert req(SP, 'POST', '/stub/authenticate', {'access_token': grant['access_token']}, origin) == (200, {'user': ann, 'scopes': ['identify']})
    assert req(SP, 'POST', '/stub/authenticate', {'access_token': 'forged'}, origin)[0] == 401
    # a code is good once; another application's secret is refused
    assert req(SP, 'POST', '/__discord/token', {'code': code}) == (502, {'error': 'invalid_grant', 'error_description': 'Invalid "code" in request.'})
    code = req(SP, 'POST', '/stub/authorize', {'user': ann, 'scopes': ['identify']}, origin)[1]['code']
    os.environ['W95_DISCORD_CLIENT_SECRET'] = 'wrong'
    st, why = req(SP, 'POST', '/__discord/token', {'code': code}); assert st == 502 and why['error'] == 'invalid_client', why
finally:
    stub.terminate(); stub.wait(timeout=5); app.shutdown()
print('discord_server: ok')
