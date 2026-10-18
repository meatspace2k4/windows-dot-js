"""The dev server: the project folder over HTTP on 127.0.0.1, answering byte ranges (the CD drive reads its disc a few
sectors at a time), with cdrom.iso the CD image given by --iso.

    python3 tools/serve.py 8095 --iso "Win95 OSR2.ISO"
"""
import argparse, http.server, os, re

ap = argparse.ArgumentParser(); ap.add_argument('port', type=int); ap.add_argument('--iso'); a = ap.parse_args()
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *x, **k): super().__init__(*x, directory=root, **k)
    def translate_path(self, p):
        if a.iso and p.split('?')[0] == '/cdrom.iso': return a.iso
        return super().translate_path(p)
    def send_head(self):
        m = re.match(r'bytes=(\d+)-(\d*)$', self.headers.get('Range', ''))
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path): return super().send_head()
        size = os.path.getsize(path); lo = int(m[1]); hi = min(int(m[2]) if m[2] else size - 1, size - 1)
        if lo > hi: self.send_error(416); return None
        f = open(path, 'rb'); f.seek(lo); self.range_left = hi - lo + 1
        self.send_response(206); self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {lo}-{hi}/{size}'); self.send_header('Content-Length', str(hi - lo + 1))
        self.send_header('Accept-Ranges', 'bytes'); self.end_headers(); return f
    def end_headers(self):   # (scripts revalidate on every load: an edited one is never run stale)
        self.send_header('Cache-Control', 'no-cache'); super().end_headers()
    def copyfile(self, src, dst):
        n = getattr(self, 'range_left', None)
        if n is None: return super().copyfile(src, dst)
        while n > 0:
            b = src.read(min(n, 1 << 20))
            if not b: break
            dst.write(b); n -= len(b)
        self.range_left = None

class S(http.server.ThreadingHTTPServer): request_queue_size = 128   # (a cold load asks for every script at once)
S(('127.0.0.1', a.port), H).serve_forever()
