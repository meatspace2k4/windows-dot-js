"""tools/src_api.py (/__src, CLAUDE.EXE's SRC:\\): the checkout's files read, listed and written; refused outside it,
in .git, and through a symbolic link (a generated bundle a worktree links to another checkout's)."""
import os, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import src_api as s

with tempfile.TemporaryDirectory() as t, tempfile.TemporaryDirectory() as other:
    os.makedirs(f'{t}/tools'); open(f'{t}/a.js', 'w').write('one\n'); open(f'{t}/tools/b.py', 'w').write('two\n')
    os.makedirs(f'{t}/.git'); open(f'{t}/.git/config', 'w').write('x')
    open(f'{other}/big.js', 'w').write('generated'); os.symlink(f'{other}/big.js', f'{t}/system.js')
    assert s.op(t, {'op': 'read', 'path': 'a.js'})['text'] == 'one\n'
    assert s.op(t, {'op': 'read', 'path': 'tools\\b.py'})['text'] == 'two\n'
    assert s.op(t, {'op': 'stat', 'path': 'tools'})['isDir'] is True
    assert s.op(t, {'op': 'write', 'path': 'new/c.js', 'text': 'three\n'}) == {'ok': True}
    assert open(f'{t}/new/c.js').read() == 'three\n'
    assert sorted(e['path'] for e in s.op(t, {'op': 'list', 'path': ''})['files']) == ['a.js', 'new/c.js', 'tools/b.py']
    for bad in ({'op': 'read', 'path': '../x'}, {'op': 'read', 'path': '.git/config'}, {'op': 'write', 'path': 'system.js', 'text': 'x'}, {'op': 'read', 'path': 'system.js'}):
        try: s.op(t, bad); raise AssertionError(f'not refused: {bad}')
        except PermissionError: pass
    assert open(f'{other}/big.js').read() == 'generated'
print('src_api: ok')
