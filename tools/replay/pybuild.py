"""python3 for replays: the CD build tools run for real, with their output cached by the hash of the tools and the
inputs' names (a build takes minutes and gives the same bytes every time); everything else is plain python."""
import hashlib, os, shutil, subprocess, sys
PY = os.environ.get('W95_REAL_PYTHON') or '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11'
args = sys.argv[1:]; script = next((a for a in args if a.endswith('.py')), '')
base = os.path.basename(script)
if not (base.startswith('build_') or base == 'recomp.py') or not os.environ.get('W95_REPLAY_CACHE'):
    os.execv(PY, [PY] + args)
rest = args[args.index(script) + 1:]
outs = [a for a in rest if a.endswith('.js')]
# a build or recompile whose output is not in the project tree fed the session's headless Node harness: not replayed
tree = os.environ.get('W95_REPLAY_TREE', '')
if base == 'recomp.py' or not tree or not any(os.path.abspath(o).startswith(tree + '/') for o in outs):
    sys.exit(0)
tools = os.path.dirname(os.path.abspath(script))
h = hashlib.sha256()
for f in sorted(os.listdir(tools)):
    if f.endswith('.py'): h.update(f.encode()); h.update(open(os.path.join(tools, f), 'rb').read())
h.update(os.path.basename(script).encode())
for a in rest: h.update(os.path.basename(a.rstrip('/')).encode())
key = h.hexdigest()[:20]; cache = os.environ['W95_REPLAY_CACHE']
hits = [os.path.join(cache, f'build-{key}-{i}') for i in range(len(outs))]
if outs and all(os.path.exists(x) for x in hits):
    for x, o in zip(hits, outs): os.makedirs(os.path.dirname(os.path.abspath(o)) or '.', exist_ok=True); shutil.copyfile(x, o)
    sys.exit(0)
r = subprocess.run([PY] + args)
if r.returncode == 0:
    for x, o in zip(hits, outs):
        if os.path.exists(o): shutil.copyfile(o, x + '.part'); os.replace(x + '.part', x)
sys.exit(r.returncode)
