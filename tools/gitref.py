"""A commit's build on the page's own origin: /__ref/<rev>/<path> is <path> as the commit has it (git's blob), so a page
loaded from /__ref/<rev>/index.html runs that commit's scripts with this origin's disk and Braid anchors (IndexedDB is
per origin), and two builds live the same anchored moment (bench/fork98.mjs). A path the commit does not track is the
server's own: the endpoints (__cd, __claude, __cdlog, ...), the CD images, and the bundles generated from the CD
(system.js, savers.js, ...: .gitignore), which no commit carries.
"""
import re, subprocess

REF = re.compile(r'^/__ref/([\w.\-^~]{1,80})/(.*)$')   # (a rev is one segment: a sha, a branch without a slash, HEAD~n)
_shas = {}


def split(path):
    """(rev, rest) for a /__ref/ path (rest without its query), else None"""
    m = REF.match(path.split('?')[0])
    if not m or '..' in m[1].split('/') or '..' in m[2].split('/'): return None
    return m[1], m[2]


def sha(root, rev):
    """the commit `rev` names, or None"""
    if rev not in _shas:
        p = subprocess.run(['git', 'rev-parse', '--verify', '--quiet', rev + '^{commit}'], cwd=root, capture_output=True, text=True)
        _shas[rev] = p.stdout.strip() if p.returncode == 0 else None
        if _shas[rev] is None: del _shas[rev]; return None
    return _shas[rev]


def blob(root, rev, rest):
    """the bytes of `rest` in commit `rev`; None when the commit does not track it (or there is no such commit)"""
    c = sha(root, rev)
    if not c or not rest or rest.endswith('/'): return None
    p = subprocess.run(['git', 'cat-file', 'blob', f'{c}:{rest}'], cwd=root, capture_output=True)
    return p.stdout if p.returncode == 0 else None
