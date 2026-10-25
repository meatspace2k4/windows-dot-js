#!/usr/bin/env python3
"""The Pi's Windows 95 server: the deployed site over HTTP, answering byte ranges (the CD drive reads cdrom.iso a few
sectors at a time), cross-origin isolated for the machines' shared memory. Reached only through cloudflared.

    python3 win95_server.py --host 127.0.0.1 --port 8770

Serves <install>/site to every Host but DEV_HOSTS, which get the dev tree beside the install (<install>-dev/site).
/__share answers as tools/serve.py's with no folders shared: nothing outside the site tree is reachable.
"""
import argparse, http.server, json, os, re, socket
from pathlib import Path

# Hostnames that are served the dev site instead of the production one: the Pi's, and the same name on this machine
# (a PI_ROOT install, win95-dev.localhost:8770). Constants, never a parameter or an env var: anything that can be set
# from outside can be set to the production hostname, which would hand the dev site to production. Changing staging's
# address is a code change.
DEV_HOSTS = ("win95-dev.funstuff.app", "win95-dev.localhost")

BASE = Path(__file__).resolve().parent
PROD_SITE = BASE / "site"
DEV_SITE = BASE.parent / (BASE.name + "-dev") / "site"


def site_for(host):
    """The site root for a request's Host. A missing or half-synced dev tree falls back to production, so a failed
    dev deploy degrades to the live site instead of a broken page."""
    host = (host or "").split(":")[0].strip().lower()
    if host in DEV_HOSTS and (DEV_SITE / "index.html").exists():
        return DEV_SITE
    return PROD_SITE


class H(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    def translate_path(self, p):
        root = site_for(self.headers.get("Host"))
        rel = [x for x in re.split(r"/+", p.split("?", 1)[0].split("#", 1)[0]) if x and x not in (".", "..")]
        return str(root.joinpath(*rel)) if rel else str(root)

    def send_head(self):
        m = re.match(r"bytes=(\d+)-(\d*)$", self.headers.get("Range", ""))
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        lo = int(m[1])
        hi = min(int(m[2]) if m[2] else size - 1, size - 1)
        if lo > hi:
            self.send_error(416)
            return None
        f = open(path, "rb")
        f.seek(lo)
        self.range_left = hi - lo + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {lo}-{hi}/{size}")
        self.send_header("Content-Length", str(hi - lo + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        return f

    def end_headers(self):
        # The page revalidates (the edge may keep it for its s-maxage); every other file carries the deploy's ?v=
        # and is never kept by a browser: a new deploy is always a new URL, and an old one is never served stale.
        page = self.path.split("?", 1)[0] in ("/", "/index.html")
        self.send_header("Cache-Control", "public, no-cache, s-maxage=60" if page else "no-store, max-age=0")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def copyfile(self, src, dst):
        n = getattr(self, "range_left", None)
        if n is None:
            return super().copyfile(src, dst)
        while n > 0:
            b = src.read(min(n, 1 << 20))
            if not b:
                break
            dst.write(b)
            n -= len(b)
        self.range_left = None

    def do_POST(self):
        # /__share as tools/serve.py answers it, with no folders shared: the host's name, an empty list, and no share
        # by any name (the page learns its computer's name here, as on the dev server and in the app)
        if self.path.split("?")[0] != "/__share":
            self.send_error(404)
            return
        try:
            q = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except ValueError:
            q = {}
        op = q.get("op")
        r = socket.gethostname().split(".")[0] if op == "$host" else [] if op == "$list" else {"err": "ENOENT"}
        b = json.dumps(r).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


class S(http.server.ThreadingHTTPServer):
    request_queue_size = 128   # (a cold load asks for every script at once)
    daemon_threads = True


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8770)
    a = ap.parse_args()
    S((a.host, a.port), H).serve_forever()
