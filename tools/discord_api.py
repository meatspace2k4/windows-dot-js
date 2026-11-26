"""The Discord Activity's server side (discord.js), shared by serve.py and the deployed win95_server.py, as
~/kkfm-jukebox's StreamServer answers its own Activity:

    GET  /__discord/config     { client_id }: the Discord application's id, for the page's Embedded App SDK
    POST /__discord/token      { code }  ->  { access_token }: the code the SDK's authorize gave, exchanged at Discord's
                               token endpoint with the application's secret, which never leaves this server

The application: W95_DISCORD_CLIENT_ID and W95_DISCORD_CLIENT_SECRET, or the first line of
~/.config/win95/discord-client-id and discord-client-secret (as claude_api.py keeps its key), read at each request.
W95_DISCORD_API names another API root than Discord's (tools/discord_stub.py's, for testing).

The application, at discord.com/developers/applications: Activities enabled, its URL mapping `/` set to this site's
public host, and its OAuth2 client id and secret given here as above. The page needs vendor/embedded-app-sdk.js beside
it (@discord/embedded-app-sdk's ES module build, as ~/kkfm-jukebox/browser/vendor has it).

Discord's frame reaches these through its proxy (https://<application id>.discordsays.com/ mapped to this site), so they
are answered for any host; the exchange gives a token only for a code Discord issued to this application.
"""
import json, os, re, urllib.error, urllib.parse, urllib.request

ID_FILE = os.path.expanduser('~/.config/win95/discord-client-id')
SECRET_FILE = os.path.expanduser('~/.config/win95/discord-client-secret')
API = 'https://discord.com/api'
CODE = re.compile(r'^[A-Za-z0-9_.\-]{1,256}$')
MAX_BODY = 8192


def setting(env, path):
    if os.environ.get(env): return os.environ[env].strip()
    try:
        with open(path) as f: return f.readline().strip() or None
    except OSError: return None
client_id = lambda: setting('W95_DISCORD_CLIENT_ID', ID_FILE)
client_secret = lambda: setting('W95_DISCORD_CLIENT_SECRET', SECRET_FILE)
api = lambda: (os.environ.get('W95_DISCORD_API') or API).rstrip('/')


def exchange(code, post=None):
    """(status, body) for a code: 200 { access_token }, or why not. `post(url, form) -> (status, bytes)` is the request
    to the token endpoint (the tests' own; urllib's otherwise)"""
    if not isinstance(code, str) or not CODE.match(code): return 400, {'error': 'invalid_request', 'error_description': 'missing or malformed code'}
    cid, secret = client_id(), client_secret()
    if not cid or not secret: return 500, {'error': 'server_not_configured', 'error_description': 'W95_DISCORD_CLIENT_ID / W95_DISCORD_CLIENT_SECRET unset'}
    form = {'client_id': cid, 'client_secret': secret, 'grant_type': 'authorization_code', 'code': code}
    try: status, raw = (post or http_post)(api() + '/oauth2/token', form)
    except OSError as e: return 502, {'error': 'token_endpoint_unreachable', 'error_description': str(e)[:200]}
    try: r = json.loads(raw or b'{}')
    except ValueError: r = {}
    if status == 200 and isinstance(r, dict) and isinstance(r.get('access_token'), str) and r['access_token']:
        return 200, {'access_token': r['access_token']}   # (the access token alone: the page needs nothing else of the grant)
    err = r if isinstance(r, dict) else {}
    return 502, {'error': str(err.get('error') or 'token_exchange_failed')[:80], 'error_description': str(err.get('error_description') or f'the token endpoint answered {status}')[:200]}


def http_post(url, form):
    # (a User-Agent of its own: Discord's edge refuses urllib's default)
    q = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(), method='POST',
                               headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Windows95Activity (win95, 1.0)', 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(q, timeout=10) as r: return r.status, r.read(1 << 16)
    except urllib.error.HTTPError as e: return e.code, e.read(1 << 16)


def send(h, status, body):
    b = json.dumps(body).encode()
    h.send_response(status); h.send_header('Content-Type', 'application/json'); h.send_header('Cache-Control', 'no-store')
    h.send_header('Content-Length', str(len(b))); h.end_headers(); h.wfile.write(b)
    return True


def handle(h, method):
    """answer a request for /__discord/...: True if it was one"""
    path = h.path.split('?')[0]
    if path == '/__discord/config' and method == 'GET': return send(h, 200, {'client_id': client_id() or ''})
    if path == '/__discord/token' and method == 'POST':
        try: n = int(h.headers.get('Content-Length') or 0)
        except ValueError: n = -1
        if n < 0 or n > MAX_BODY: return send(h, 400, {'error': 'invalid_request', 'error_description': 'no body, or one too long'})
        try: body = json.loads(h.rfile.read(n) or b'{}')
        except ValueError: body = None
        return send(h, *exchange(body.get('code') if isinstance(body, dict) else None))
    return False
