"""The dev server: the project folder over HTTP on 127.0.0.1, answering byte ranges (the CD drive reads its disc a few
sectors at a time), with cdrom.iso the CD image given by --iso, and each --cd another the drive can take (/__cd lists them).

    python3 tools/serve.py 8095 --iso "Win95 OSR2.ISO" --cd "Windows 98 SE.iso"
"""
import argparse, base64, hashlib, http.server, json, os, re, shutil, socket

ap = argparse.ArgumentParser(); ap.add_argument('port', type=int); ap.add_argument('--iso'); ap.add_argument('--host', default='127.0.0.1')
# HTTPS with this certificate and key: a page from another computer is a secure context only over HTTPS, and only a
# secure context has the shared memory the machines run on (SharedArrayBuffer) and the sound's AudioWorklet
ap.add_argument('--cert'); ap.add_argument('--key')
ap.add_argument('--mods', help="the mod file the page loads its machines' mods from, NAME.mod in the project (debug, test, prod; /__mods names it), when its address names none (mods=NAME)")
ap.add_argument('--cd', action='append', default=[], help='another CD image the drive can take (each served read-only at /cd/<n>/<name>)'); a = ap.parse_args()
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CDS = ([{'name': os.path.basename(a.iso), 'path': a.iso, 'url': 'cdrom.iso'}] if a.iso else []) + \
      [{'name': os.path.basename(p), 'path': p, 'url': f'cd/{i + (1 if a.iso else 0)}/' + os.path.basename(p).replace(' ', '%20')} for i, p in enumerate(a.cd)]
# the sessions people share (tools/sessions.py: /__sessions, /__session/<id>/...), kept in .sessions beside the project,
# one folder of them per port (each port a page origin of its own, as each has its own disk)
import sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import sessions
SESSIONS = sessions.Sessions(os.path.join(root, '.sessions', str(a.port)))

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

from claude_api import local_request, claude, fetch_page
import src_api, gitref, git_api

class H(http.server.SimpleHTTPRequestHandler):
    def ref(self):
        """a commit's build (gitref.py, /__ref/<rev>/...): its file answered (True), or the path made the server's own"""
        r = gitref.split(self.path)
        if not r: return False
        if self.client_address[0] not in ('127.0.0.1', '::1'): self.send_error(403); return True   # (this computer's pages only)
        b = gitref.blob(root, *r) if self.command in ('GET', 'HEAD') else None
        if b is None:
            q = self.path.find('?'); self.path = '/' + r[1] + (self.path[q:] if q >= 0 else ''); return False
        self.send_response(200); self.send_header('Content-Type', self.guess_type(r[1])); self.send_header('Content-Length', str(len(b))); self.end_headers()
        if self.command == 'GET': self.wfile.write(b)
        return True
    def do_HEAD(self):
        if self.ref(): return
        super().do_HEAD()
    def do_GET(self):
        if self.ref(): return
        if self.path.startswith('/__session') and SESSIONS.handle(self, 'GET'): return
        super().do_GET()
    def do_POST(self):   # /__share: the shares' list, an operation on one ({ ok } or { err }), and the host's name
        if self.ref(): return
        if self.path.startswith('/__session') and SESSIONS.handle(self, 'POST'): return
        if self.path.split('?')[0] == '/__fetch':   # (the Claude program's Browser pane: a web page as text, for this machine's own pages only)
            if not local_request(self): self.send_error(403); return
            try: q = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            except ValueError: self.send_error(400); return
            fetch_page(self, q); return
        if self.path.split('?')[0] == '/__src':   # (the project's own files, CLAUDE.EXE's SRC:\: this machine's own pages only)
            if not local_request(self): self.send_error(403); return
            src_api.handle(self, root); return
        if self.path.split('?')[0] == '/__git':   # (a fixed set of git commands on that checkout, each argument checked: tools/git_api.py; this machine's own pages only)
            if not local_request(self): self.send_error(403); return
            git_api.handle(self, root); return
        if self.path.split('?')[0] == '/__claude':
            if not local_request(self): self.send_error(403); return
            try: q = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            except ValueError: self.send_error(400); return
            claude(self, q); return
        if self.path.split('?')[0] == '/__cdlog':   # (the dev page's CD request trace, as deploy/win95/win95_server.py keeps it)
            if not local_request(self, json=False): self.send_error(403); return
            try:
                q = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
                os.makedirs('/tmp/w95', exist_ok=True)
                with open('/tmp/w95/cdlog.txt', 'a') as f: f.write('\n'.join(str(x)[:300] for x in q.get('lines', [])[:500]) + '\n')
            except (ValueError, OSError): pass
            self.send_response(204); self.end_headers(); return
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
        q = p.split('?')[0]
        if a.iso and q == '/cdrom.iso': return a.iso
        m = re.match(r'/cd/(\d+)/', q)
        if m and int(m[1]) < len(CDS): return CDS[int(m[1])]['path']
        return super().translate_path(p)
    def send_head(self):
        if self.path.split('?')[0] == '/__w98key':   # (the Windows 98 product key, from this server's environment (W98KEY) to the page, never to a file: bench/setup98.mjs; a page of this computer's only)
            if self.client_address[0] not in ('127.0.0.1', '::1'): self.send_response(403); self.end_headers(); import io; return io.BytesIO(b'')
            b = os.environ.get('W98KEY', '').encode()
            self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(b))); self.end_headers()
            import io; return io.BytesIO(b)
        if self.path.split('?')[0] == '/__mods':   # (the mod file given by --mods, the page's to load: win95.js)
            b = json.dumps({'profile': a.mods}).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(b))); self.end_headers()
            import io; return io.BytesIO(b)
        if self.path.split('?')[0] == '/__cd':   # (the CD images the drive can take: --iso's first, as cdrom.iso, then each --cd)
            b = json.dumps([{'name': c['name'], 'url': c['url']} for c in CDS if os.path.isfile(c['path'])]).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers()
            import io; return io.BytesIO(b)
        return self.send_range()
    def send_range(self):
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
