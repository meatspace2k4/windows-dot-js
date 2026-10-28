#!/usr/bin/env python3
"""The Pi's Windows 95 server: the deployed site over HTTP, answering byte ranges (the CD drive reads cdrom.iso a few
sectors at a time), cross-origin isolated for the machines' shared memory. Reached only through cloudflared.

    python3 win95_server.py --host 127.0.0.1 --port 8770

Serves <install>/site to every Host but DEV_HOSTS, which get the dev tree beside the install (<install>-dev/site).
/__share answers as tools/serve.py's: the public names get the install's share folder, read-only; this machine's own
names (LOCAL_HOSTS) the home folder.
"""
import argparse, base64, http.server, json, os, re, shutil, socket
from pathlib import Path

# Hostnames that get the home folder as the LAN's other computer's HOME share, as the dev server (tools/serve.py) and
# the app give it: names only this machine resolves (the PI_ROOT install). Constants, as DEV_HOSTS: a Host the public
# reaches through cloudflared never gets a share
LOCAL_HOSTS = ("win95.localhost", "win95-dev.localhost")
PROTECTED = {"desktop", "documents", "downloads", "library"}   # (the folders macOS asks permission for: not shared)
SHARES = [{"name": "HOME", "path": os.path.expanduser("~"), "home": True}]
# Every other Host (the public names) gets the install's own share folder, which deploy.sh fills from deploy/win95/share,
# read-only: nothing from the public reaches this machine's files outside it, and nothing in it can be changed
PUBLIC_SHARES = [{"name": "PUBLIC", "path": str(Path(__file__).resolve().parent / "share"), "readonly": True}]
WRITES = {"write", "truncate", "create", "mkdir", "rmdir", "unlink", "rename", "times"}
ERRNO = {2: "ENOENT", 20: "ENOTDIR", 13: "EACCES", 1: "EACCES", 17: "EEXIST", 66: "ENOTEMPTY", 39: "ENOTEMPTY", 21: "EISDIR"}


def resolve(sh, rel):
    """a share's path for `rel`, refused outside the share's folder (tools/serve.py's)"""
    root = os.path.realpath(sh["path"])
    parts = [x for x in re.split(r"[\\/]+", rel or "") if x and x != "."]
    if ".." in parts:
        raise PermissionError(13, "outside the share")
    if sh.get("home") and parts and parts[0].lower() in PROTECTED:
        raise FileNotFoundError(2, "not shared")
    full = os.path.join(root, *parts)
    probe = full
    while probe != root and not os.path.exists(probe):
        probe = os.path.dirname(probe)
    real = os.path.realpath(probe)
    if real != root and not real.startswith(root + os.sep):
        raise PermissionError(13, "outside the share")
    return full


def info(full, st, ro=False):
    import stat as S
    d = S.S_ISDIR(st.st_mode)
    return {"size": 0 if d else st.st_size, "dir": d, "mtime": st.st_mtime * 1000, "ctime": getattr(st, "st_birthtime", st.st_ctime) * 1000,
            "atime": st.st_atime * 1000, "readonly": ro or not (st.st_mode & 0o200), "hidden": os.path.basename(full).startswith(".")}


def share_op(sh, op, *a):
    """an operation on a share, as tools/serve.py answers it"""
    import stat as S
    ro = bool(sh.get("readonly"))
    if ro and op in WRITES:
        raise PermissionError(13, "read-only share")
    if op == "stat":
        f = resolve(sh, a[0])
        try:
            return info(f, os.stat(f), ro)
        except (FileNotFoundError, NotADirectoryError):
            return None
    if op == "list":
        d, out = resolve(sh, a[0]), []
        for n in os.listdir(d):
            if sh.get("home") and not re.sub(r"[\\/]", "", a[0] or "") and n.lower() in PROTECTED:
                continue
            try:
                st = os.stat(os.path.join(d, n))
            except OSError:
                continue
            if S.S_ISREG(st.st_mode) or S.S_ISDIR(st.st_mode):
                out.append({"name": n, **info(os.path.join(d, n), st, ro)})
        return out
    if op == "read":
        with open(resolve(sh, a[0]), "rb") as f:
            f.seek(a[1])
            return {"$b64": base64.b64encode(f.read(max(0, min(a[2], 1 << 20)))).decode()}
    if op == "write":
        with open(resolve(sh, a[0]), "r+b") as f:
            f.seek(a[1])
            f.write(base64.b64decode(a[2]["$b64"]))
        return None
    if op == "truncate":
        os.truncate(resolve(sh, a[0]), a[1])
        return None
    if op == "create":
        open(resolve(sh, a[0]), "xb" if len(a) > 1 and a[1] else "wb").close()
        return None
    if op == "mkdir":
        os.mkdir(resolve(sh, a[0]))
        return None
    if op == "rmdir":
        os.rmdir(resolve(sh, a[0]))
        return None
    if op == "unlink":
        os.unlink(resolve(sh, a[0]))
        return None
    if op == "rename":
        os.rename(resolve(sh, a[0]), resolve(sh, a[1]))
        return None
    if op == "times":
        t = a[1] / 1000
        os.utime(resolve(sh, a[0]), (t, t))
        return None
    if op == "space":
        u = shutil.disk_usage(sh["path"])
        return {"total": u.total, "free": u.free}
    raise FileNotFoundError(2, op)

# Hostnames that are served the dev site instead of the production one: the Pi's, and the same name on this machine
# (a PI_ROOT install, win95-dev.localhost:8770). Constants, never a parameter or an env var: anything that can be set
# from outside can be set to the production hostname, which would hand the dev site to production. Changing staging's
# address is a code change.
DEV_HOSTS = ("win95-dev.funstuff.app", "win95-dev.localhost")

BASE = Path(__file__).resolve().parent
PROD_SITE = BASE / "site"
DEV_SITE = BASE.parent / (BASE.name + "-dev") / "site"


# The sessions people share (sessions.py, copied beside this by deploy.sh: /__sessions, /__session/<id>/...), the dev
# site's apart from production's, each kept in a folder beside its site
import sys
sys.path.insert(0, str(BASE))
import sessions
from claude_api import local_request, claude, fetch_page   # (tools/claude_api.py, copied beside this by deploy.sh)
SESSIONS = {"prod": sessions.Sessions(str(BASE / "sessions")), "dev": sessions.Sessions(str(BASE.parent / (BASE.name + "-dev") / "sessions"))}


def sessions_for(host):
    host = (host or "").split(":")[0].strip().lower()
    return SESSIONS["dev" if host in DEV_HOSTS else "prod"]


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

    def do_GET(self):
        if self.path.startswith("/__session") and sessions_for(self.headers.get("Host")).handle(self, "GET"):
            return
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/__session") and sessions_for(self.headers.get("Host")).handle(self, "POST"):
            return
        if self.path.split("?")[0] in ("/__claude", "/__fetch"):   # (local_request: only this machine's own *.localhost pages)
            if not local_request(self):
                self.send_error(403)
                return
            try:
                q = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            except ValueError:
                self.send_error(400)
                return
            (claude if self.path.startswith("/__claude") else fetch_page)(self, q)
            return
        # /__share as tools/serve.py answers it: the host's name, the shares' list, and an operation on one (the page
        # learns its computer's name here, as on the dev server and in the app)
        if self.path.split("?")[0] != "/__share":
            self.send_error(404)
            return
        try:
            q = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except ValueError:
            q = {}
        op = q.get("op")
        host = (self.headers.get("Host") or "").split(":")[0].strip().lower()
        shares = SHARES if host in LOCAL_HOSTS and self.client_address[0] in ("127.0.0.1", "::1") else PUBLIC_SHARES
        if op == "$host":
            r = socket.gethostname().split(".")[0]
        elif op == "$list":
            r = [{"name": x["name"], "remark": ""} for x in shares if os.path.isdir(x["path"])]
        else:
            sh = next((x for x in shares if x["name"].upper() == str(q.get("name", "")).upper()), None)
            if not sh:
                r = {"err": "ENOENT"}
            else:
                try:
                    r = {"ok": share_op(sh, op, *q.get("args", []))}
                except OSError as e:
                    r = {"err": ERRNO.get(e.errno, "EIO")}
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
