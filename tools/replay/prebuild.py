"""Build the files a checkout leaves out (they come from the Windows 95 CD) with that checkout's own tools.

    prebuild.py TREE CACHE_DIR [CD_ROOT]

CD_ROOT holds the extracted CD files (default ~/Win95-tmp-backup): system modules, fonts, screen savers and the
shell bitmaps. Results are cached under CACHE_DIR by the hash of the tools that make them, so commits whose
tools did not change share one build. assets.js and cdrom.js have no tool in the repo; the recorded copies in
CD_ROOT/generated are used for them."""
import hashlib, os, re, shutil, subprocess, sys
tree, cache = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
cd = os.path.abspath(sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser('~/Win95-tmp-backup'))
A, C = cd + '/a9a557c2-6bc5-4990-8d3d-332462b487b9/scratchpad', cd + '/c289926e-e82e-4cb1-938a-de8763ed0f76/scratchpad'
INPUTS = {'sys': A + '/sys', 'fonts': C + '/fonts', 'scr': C + '/scr', 'tb': A + '/tb'}
page = open(tree + '/index.html').read() if os.path.exists(tree + '/index.html') else ''
wanted = set(re.findall(r'<script src="([\w.-]+\.js)"', page))
for f in ('host-web.js',):   # files a page loads that load others
    if f in wanted and os.path.exists(tree + '/' + f): wanted |= set(re.findall(r"s\.src = '([\w.-]+\.js)'", open(tree + '/' + f).read()))
def h(*paths):
    d = hashlib.sha256()
    for p in paths:
        for root, _, fs in sorted(os.walk(p)) if os.path.isdir(p) else [(os.path.dirname(p), [], [os.path.basename(p)])]:
            for f in sorted(fs):
                if f.endswith('.pyc'): continue
                q = os.path.join(root, f); d.update(q.replace(tree, '').encode()); d.update(open(q, 'rb').read())
    return d.hexdigest()[:16]
def build(out, tools, cmd):
    # built for the tools the tree has now: a stamp beside the file names the tools' hash it was built with
    if out not in wanted: return
    stamp = f'{tree}/.{out}.tools'
    if not all(os.path.exists(tree + '/' + t) for t in tools):
        if not os.path.exists(tree + '/' + out): print(f'{out}: no tool in this commit')
        return
    key0 = h(*[tree + '/' + t for t in tools])
    if os.path.exists(tree + '/' + out) and os.path.exists(stamp) and open(stamp).read() == key0: return
    if not all(os.path.exists(tree + '/' + t) for t in tools): print(f'{out}: no tool in this commit'); return
    key = h(*[tree + '/' + t for t in tools]); hit = f'{cache}/{out}.{key}'
    if not os.path.exists(hit):
        tmp = hit + '.part'
        r = subprocess.run(cmd(tmp), cwd=tree, capture_output=True, text=True)
        if r.returncode or not os.path.exists(tmp): print(f'{out}: build failed\n{r.stderr[-2000:]}'); return
        os.replace(tmp, hit)
    shutil.copyfile(hit, tree + '/' + out); open(stamp, 'w').write(key); print(f'{out}: {key}')
os.makedirs(cache, exist_ok=True)
py = sys.executable
build('system.js', ['tools/build_system.py', 'tools/recomp.py'], lambda o: [py, 'tools/build_system.py', INPUTS['sys'], o, INPUTS['fonts']])
build('savers.js', ['tools/build_savers.py', 'tools/recomp.py'], lambda o: [py, 'tools/build_savers.py', INPUTS['scr'], INPUTS['fonts'], o])
build('assets-shell.js', ['tools/build_shell_assets.py'], lambda o: [py, 'tools/build_shell_assets.py', INPUTS['tb'], o])
for f in ('assets.js', 'cdrom.js'):
    if f in wanted and not os.path.exists(tree + '/' + f):
        src = cd + '/generated/' + f
        if os.path.exists(src): shutil.copyfile(src, tree + '/' + f); print(f'{f}: recorded copy')
        else: print(f'{f}: missing ({src})')
