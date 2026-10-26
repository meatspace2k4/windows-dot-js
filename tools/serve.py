"""The dev server: the project folder over HTTP on 127.0.0.1, answering byte ranges (the CD drive reads its disc a few
sectors at a time), with cdrom.iso the CD image given by --iso.

    python3 tools/serve.py 8095 --iso "Win95 OSR2.ISO"
"""
import argparse, base64, http.server, json, os, re, shutil, socket

ap = argparse.ArgumentParser(); ap.add_argument('port', type=int); ap.add_argument('--iso'); ap.add_argument('--host', default='127.0.0.1')
# HTTPS with this certificate and key: a page from another computer is a secure context only over HTTPS, and only a
# secure context has the shared memory the machines run on (SharedArrayBuffer) and the sound's AudioWorklet
ap.add_argument('--cert'); ap.add_argument('--key'); a = ap.parse_args()
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# the Mac's folders the LAN's other computer serves (lanhost.js), as the app's shares.js serves them: the home folder as
# HOME, without the folders macOS asks permission for; every path relative to its share's folder and refused outside it
PROTECTED = {'desktop', 'documents', 'downloads', 'library'}
SHARES = [{'name': 'HOME', 'path': os.path.expanduser('~'), 'home': True}]
def resolve(sh, rel):
    root = os.path.realpath(sh['path']); parts = [x for x in re.split(r'[\\/]+', rel or '') if x and x != '.']
    if '..' in parts: raise PermissionError(13, 'outside the share')
    if sh.get('home') and parts and parts[0].lower() in PROTECTED: raise FileNotFoundError(2, 'not shared')
    full = os.path.join(root, *parts); probe = full
    while probe != root and not os.path.exists(probe): probe = os.path.dirname(probe)
    real = os.path.realpath(probe)
    if real != root and not real.startswith(root + os.sep): raise PermissionError(13, 'outside the share')
    return full
def info(full, st):
    import stat as S
    d = S.S_ISDIR(st.st_mode)
    return {'size': 0 if d else st.st_size, 'dir': d, 'mtime': st.st_mtime * 1000, 'ctime': getattr(st, 'st_birthtime', st.st_ctime) * 1000,
            'atime': st.st_atime * 1000, 'readonly': not (st.st_mode & 0o200), 'hidden': os.path.basename(full).startswith('.')}
def share_op(sh, op, *a):
    if op == 'stat':
        f = resolve(sh, a[0])
        try: return info(f, os.stat(f))
        except (FileNotFoundError, NotADirectoryError): return None
    if op == 'list':
        d = resolve(sh, a[0]); out = []
        for n in os.listdir(d):
            if sh.get('home') and not re.sub(r'[\\/]', '', a[0] or '') and n.lower() in PROTECTED: continue
            try: st = os.stat(os.path.join(d, n))
            except OSError: continue
            import stat as S
            if not (S.S_ISREG(st.st_mode) or S.S_ISDIR(st.st_mode)): continue
            out.append({'name': n, **info(os.path.join(d, n), st)})
        return out
    if op == 'read':
        with open(resolve(sh, a[0]), 'rb') as f: f.seek(a[1]); return {'$b64': base64.b64encode(f.read(max(0, min(a[2], 1 << 20)))).decode()}
    if op == 'write':
        with open(resolve(sh, a[0]), 'r+b') as f: f.seek(a[1]); f.write(base64.b64decode(a[2]['$b64']))
        return None
    if op == 'truncate': os.truncate(resolve(sh, a[0]), a[1]); return None
    if op == 'create':
        open(resolve(sh, a[0]), 'xb' if len(a) > 1 and a[1] else 'wb').close(); return None
    if op == 'mkdir': os.mkdir(resolve(sh, a[0])); return None
    if op == 'rmdir': os.rmdir(resolve(sh, a[0])); return None
    if op == 'unlink': os.unlink(resolve(sh, a[0])); return None
    if op == 'rename': os.rename(resolve(sh, a[0]), resolve(sh, a[1])); return None
    if op == 'times': t = a[1] / 1000; os.utime(resolve(sh, a[0]), (t, t)); return None
    if op == 'space': u = shutil.disk_usage(sh['path']); return {'total': u.total, 'free': u.free}
    raise FileNotFoundError(2, op)
ERRNO = {2: 'ENOENT', 20: 'ENOTDIR', 13: 'EACCES', 1: 'EACCES', 17: 'EEXIST', 66: 'ENOTEMPTY', 39: 'ENOTEMPTY', 21: 'EISDIR'}

# /__claude: the Win95 Claude window's prompts to the Claude API (ccd.js), streamed back as one JSON object per line. The
# API key stays here: ANTHROPIC_API_KEY, or the first line of ~/.config/win95/anthropic-api-key, read at each request; a
# key not scoped to a workspace names one in ANTHROPIC_WORKSPACE_ID or ~/.config/win95/anthropic-workspace-id.
# Answered only for a page of this machine (a loopback client, a localhost Host, an Origin of that host when one is sent)
# asking with JSON, which a page of any other site can't send here without a CORS preflight this server never answers
KEY_FILE = os.path.expanduser('~/.config/win95/anthropic-api-key')
WORKSPACE_FILE = os.path.expanduser('~/.config/win95/anthropic-workspace-id')
MODELS = {'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'}
EFFORTS = {'low', 'medium', 'high', 'xhigh', 'max'}
SYSTEM = ('You are Claude, talking with the user through the Claude desktop app recreated inside Windows 95. '
          'Answer in plain text: the window shows no Markdown.')
TOOLS_NOTE = (' You have the Claude desktop app\'s own tools (the ccd_* tools), acting on this Windows 95 system: its sessions, '
              'their task lists and next-step box, the sidebar, panes, windows, settings and folders. Use them when the user asks '
              'for something they do; a tool the app would ask the user about shows a message box, and its result says what they chose. '
              'Read, Write, Edit, Glob and Grep are Claude Code\'s file tools, on the C: drive only; Bash runs MS-DOS commands.')
def setting(env, path):
    if os.environ.get(env): return os.environ[env]
    try:
        with open(path) as f: return f.readline().strip() or None
    except OSError: return None
api_key = lambda: setting('ANTHROPIC_API_KEY', KEY_FILE)
workspace_id = lambda: setting('ANTHROPIC_WORKSPACE_ID', WORKSPACE_FILE)
def local_request(h):
    host = (h.headers.get('Host') or '').rsplit(':', 1)[0].strip('[]').lower()
    origin = h.headers.get('Origin')
    return (h.client_address[0] in ('127.0.0.1', '::1') and (host in ('localhost', '127.0.0.1', '::1') or host.endswith('.localhost'))
            and (origin is None or re.sub(r'^https?://', '', origin).rsplit(':', 1)[0].strip('[]').lower() == host)
            and (h.headers.get('Content-Type') or '').startswith('application/json'))
TOOL_NAME = re.compile(r'^[a-zA-Z0-9_-]{1,64}$')
def tools_of(q):
    """the page's tools (the Claude app's own, ccd.js), checked: a name, a description and an object schema each"""
    out = []
    for t in (q.get('tools') or [])[:128]:
        if isinstance(t, dict) and TOOL_NAME.match(str(t.get('name', ''))) and isinstance(t.get('input_schema'), dict) and t['input_schema'].get('type') == 'object':
            out.append({'name': t['name'], 'description': str(t.get('description', ''))[:2000], 'input_schema': t['input_schema']})
    return out
def content_of(c):
    """a message's content: text, or its blocks as the API gave them (thinking and tool use passed back unchanged)"""
    return c if isinstance(c, list) and all(isinstance(b, dict) and b.get('type') for b in c) else str(c)
def claude(h, q):
    import anthropic   # (only this endpoint needs it)
    line = lambda o: (h.wfile.write((json.dumps(o) + '\n').encode()), h.wfile.flush())
    msgs = [{'role': m['role'], 'content': content_of(m['content'])} for m in q.get('messages', []) if m.get('role') in ('user', 'assistant') and m.get('content')]
    tools = tools_of(q)
    model = q.get('model') if q.get('model') in MODELS else 'claude-opus-5-5'
    effort = q.get('effort') if q.get('effort') in EFFORTS else 'medium'
    h.send_response(200); h.send_header('Content-Type', 'application/x-ndjson'); h.send_header('Cache-Control', 'no-store'); h.end_headers()
    key = api_key()
    if q.get('info'): line({'t': 'info', 'key': bool(key), 'workspace': bool(workspace_id())}); return   # (the account menu: whether there is a key and a workspace, never either)
    if not key: line({'t': 'error', 'e': f'No API key: set ANTHROPIC_API_KEY or put the key in {KEY_FILE}'}); return
    try:
        ws = workspace_id()
        client = anthropic.Anthropic(api_key=key, default_headers={'anthropic-workspace-id': ws} if ws else None)
        # a refusal is answered by another model the server picks (server-side fallback), not ended
        extra = {'tools': tools} if tools else {}
        with client.beta.messages.stream(model=model, max_tokens=64000, system=SYSTEM + (TOOLS_NOTE if tools else ''), messages=msgs,
                                         thinking={'type': 'adaptive', 'display': 'summarized'}, output_config={'effort': effort},
                                         betas=['server-side-fallback-2026-07-01'], extra_body={'fallbacks': 'default'}, **extra) as stream:
            for ev in stream:
                if ev.type == 'content_block_delta' and ev.delta.type == 'text_delta': line({'t': 'text', 'd': ev.delta.text})
                elif ev.type == 'content_block_delta' and ev.delta.type == 'thinking_delta': line({'t': 'thinking', 'd': ev.delta.thinking})
            m = stream.get_final_message()
        # the whole message, for the next request of a tool loop (its blocks go back as they came)
        line({'t': 'done', 'stop': m.stop_reason, 'model': m.model, 'in': m.usage.input_tokens, 'out': m.usage.output_tokens,
              'content': [b.model_dump(exclude_none=True) for b in m.content]})
    except anthropic.AuthenticationError: line({'t': 'error', 'e': 'The API key was refused (401)'})
    except anthropic.RateLimitError: line({'t': 'error', 'e': 'Rate limited (429): try again shortly'})
    except anthropic.APIStatusError as e: line({'t': 'error', 'e': f'API error {e.status_code}: {e.message}'})
    except anthropic.APIConnectionError: line({'t': 'error', 'e': 'Could not reach the Claude API'})
    except (BrokenPipeError, ConnectionResetError): pass   # (the page went away)

def page_text(html_s, base):
    """a web page as the Claude program's Browser pane shows it: its title, its text in lines, its links numbered"""
    import html.parser, urllib.parse
    class P(html.parser.HTMLParser):
        def __init__(s): super().__init__(convert_charrefs=True); s.out, s.title, s.links, s.skip, s.intitle, s.href, s.pre = [], '', [], 0, False, None, 0
        def handle_starttag(s, t, a):
            if t == 'pre': s.pre += 1
            if t in ('script', 'style', 'noscript', 'svg', 'template'): s.skip += 1
            elif t == 'title': s.intitle = True
            elif t == 'a': s.href = dict(a).get('href')
            if t in ('p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer', 'pre', 'blockquote', 'dl', 'dt', 'dd', 'ul', 'ol', 'table', 'hr'): s.out.append('\n')
            if t == 'li': s.out.append('* ')
        def handle_endtag(s, t):
            if t == 'pre' and s.pre: s.pre -= 1
            if t in ('script', 'style', 'noscript', 'svg', 'template') and s.skip: s.skip -= 1
            elif t == 'title': s.intitle = False
            elif t == 'a' and s.href:
                if len(s.links) < 300: s.links.append(urllib.parse.urljoin(base, s.href)); s.out.append(f' [{len(s.links)}]')
                s.href = None
            if t in ('p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'dl', 'dt', 'dd', 'ul', 'ol', 'table'): s.out.append('\n')
        def handle_data(s, d):
            if s.skip: return
            if s.intitle: s.title += d; return
            s.out.append(d.replace('\n', '\x00').replace(' ', '\x01') if s.pre else re.sub(r'\s+', ' ', d))   # (a browser's whitespace: runs of it one space, but in <pre>)
    p = P(); p.feed(html_s)
    text = re.sub(r'[ \t\r\f\v]+', ' ', ''.join(p.out)); text = re.sub(r' *\n[ \n]*', '\n\n', text).replace('\x00', '\n').replace('\x01', ' ').strip()
    return {'title': p.title.strip(), 'text': text[:200000], 'links': p.links}
def fetch_page(h, q):
    import urllib.request, urllib.error
    url = str(q.get('url', '')).strip()
    if not re.match(r'^https?://', url, re.I): url = 'https://' + url if url and '://' not in url else url
    if not re.match(r'^https?://[^/\s]+', url, re.I): r = {'error': 'Only http and https addresses.'}
    else:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/4.0 (compatible; Windows 95; Claude)'})
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read(2 << 20); ctype = resp.headers.get('Content-Type', ''); final = resp.geturl()
            cs = (re.search(r'charset=([\w-]+)', ctype) or [None, 'utf-8'])[1]
            s = body.decode(cs, 'replace')
            r = {'url': final, **(page_text(s, final) if 'html' in ctype or s.lstrip()[:1] == '<' else {'title': final, 'text': s[:200000], 'links': []})}
        except urllib.error.HTTPError as e: r = {'error': f'HTTP {e.code} {e.reason}'}
        except Exception as e: r = {'error': str(e)[:200]}
    b = json.dumps(r).encode()
    h.send_response(200); h.send_header('Content-Type', 'application/json'); h.send_header('Cache-Control', 'no-store'); h.send_header('Content-Length', str(len(b))); h.end_headers(); h.wfile.write(b)

class H(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):   # /__share: the shares' list, an operation on one ({ ok } or { err }), and the host's name
        if self.path.split('?')[0] == '/__fetch':   # (the Claude program's Browser pane: a web page as text, for this machine's own pages only)
            if not local_request(self): self.send_error(403); return
            try: q = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            except ValueError: self.send_error(400); return
            fetch_page(self, q); return
        if self.path.split('?')[0] == '/__claude':
            if not local_request(self): self.send_error(403); return
            try: q = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            except ValueError: self.send_error(400); return
            claude(self, q); return
        if self.path.split('?')[0] != '/__share': self.send_error(404); return
        q = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        if q.get('op') == '$list': r = [{'name': x['name'], 'remark': ''} for x in SHARES if os.path.isdir(x['path'])]
        elif q.get('op') == '$host': r = socket.gethostname().split('.')[0]
        else:
            sh = next((x for x in SHARES if x['name'].upper() == str(q.get('name', '')).upper()), None)
            if not sh: r = {'err': 'ENOENT'}
            else:
                try: r = {'ok': share_op(sh, q['op'], *q.get('args', []))}
                except OSError as e: r = {'err': ERRNO.get(e.errno, 'EIO')}
        b = json.dumps(r).encode(); self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

    def __init__(self, *x, **k): super().__init__(*x, directory=root, **k)
    def translate_path(self, p):
        if a.iso and p.split('?')[0] == '/cdrom.iso': return a.iso
        return super().translate_path(p)
    def send_head(self):
        for k in ('If-Modified-Since', 'If-None-Match'): del self.headers[k]   # (never a 304: a copy the browser kept from before is not reused)
        m = re.match(r'bytes=(\d+)-(\d*)$', self.headers.get('Range', ''))
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path): return super().send_head()
        size = os.path.getsize(path); lo = int(m[1]); hi = min(int(m[2]) if m[2] else size - 1, size - 1)
        if lo > hi: self.send_error(416); return None
        f = open(path, 'rb'); f.seek(lo); self.range_left = hi - lo + 1
        self.send_response(206); self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {lo}-{hi}/{size}'); self.send_header('Content-Length', str(hi - lo + 1))
        self.send_header('Accept-Ranges', 'bytes'); self.end_headers(); return f
    def end_headers(self):   # (nothing kept: every load fetches every file whole, so an edited one is never run stale; no-cache let a 304 by a modification time in seconds answer with the old copy)
        self.send_header('Cache-Control', 'no-store')
        # cross-origin isolated, for the shared memory the machines' workers run on (SharedArrayBuffer)
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin'); self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()
    def copyfile(self, src, dst):
        n = getattr(self, 'range_left', None)
        if n is None: return super().copyfile(src, dst)
        while n > 0:
            b = src.read(min(n, 1 << 20))
            if not b: break
            dst.write(b); n -= len(b)
        self.range_left = None

class S(http.server.ThreadingHTTPServer): request_queue_size = 128   # (a cold load asks for every script at once)
srv = S((a.host, a.port), H)
if a.cert:
    import ssl
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(a.cert, a.key)
    srv.socket = tls.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
