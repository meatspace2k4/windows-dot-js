"""tools/gitref.py: /__ref/<rev>/<path> is the file as the commit has it; untracked paths and bad revs answer None (the
server's own then); no path climbs out"""
import os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(here)
sys.path.insert(0, os.path.join(root, 'tools')); import gitref

assert gitref.split('/index.html') is None
assert gitref.split('/__ref/HEAD/index.html?debug=1') == ('HEAD', 'index.html')
assert gitref.split('/__ref/main~3/bench/x.mjs') == ('main~3', 'bench/x.mjs')
assert gitref.split('/__ref/refs/mutants/x/index.html') == ('refs', 'mutants/x/index.html'), 'a rev is one segment (refs alone, which names no commit)'
assert gitref.blob(root, 'refs', 'mutants/x/index.html') is None
assert gitref.split('/__ref/HEAD/../.git/config') is None
assert gitref.split('/__ref/../x/y') is None

head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=root, capture_output=True, text=True).stdout.strip()
assert gitref.sha(root, 'HEAD') == head
assert gitref.sha(root, 'no-such-ref-xyz') is None
want = subprocess.run(['git', 'show', 'HEAD:index.html'], cwd=root, capture_output=True).stdout
assert gitref.blob(root, 'HEAD', 'index.html') == want and want
assert gitref.blob(root, 'HEAD', 'system.js') is None, 'a generated bundle is not in any commit: the server\'s own'
assert gitref.blob(root, 'HEAD', '__cd') is None
assert gitref.blob(root, 'no-such-ref-xyz', 'index.html') is None
print('gitref: ok')
