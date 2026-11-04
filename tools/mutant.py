"""A mutation of tests/mutations.json as a commit: HEAD with the fix's bug put back in one file, made with git's plumbing
(no checkout, no branch, the working tree untouched) and kept at refs/mutants/<id>, so a page loads it as a build
(/__ref/refs/mutants/<id>/, tools/gitref.py) and bench/falsify98.mjs checks that the anchored case sees it.

    python3 tools/mutant.py <id>     prints the commit; exit 1 when the mutation is stale in HEAD (not found once)
"""
import json, os, subprocess, sys, tempfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def git(*a, env=None, data=None):
    p = subprocess.run(['git', *a], cwd=root, capture_output=True, input=data, env={**os.environ, **(env or {})})
    if p.returncode: raise RuntimeError(f"git {' '.join(a)}: {p.stderr.decode().strip()}")
    return p.stdout


def make(mid, base='HEAD'):
    ms = {m['id']: m for m in json.load(open(os.path.join(root, 'tests', 'mutations.json')))['mutations']}
    m = ms.get(mid)
    if not m: raise KeyError(f'no mutation {mid}: {", ".join(ms)}')
    src = git('show', f'{base}:{m["file"]}').decode()
    if src.count(m['from']) != 1: raise ValueError(f'{mid} is stale in {base}: {m["file"]} has its text {src.count(m["from"])} times')
    blob = git('hash-object', '-w', '--stdin', data=src.replace(m['from'], m['to']).encode()).decode().strip()
    with tempfile.TemporaryDirectory() as d:
        env = {'GIT_INDEX_FILE': os.path.join(d, 'index')}
        git('read-tree', base, env=env)
        git('update-index', '--cacheinfo', f'100644,{blob},{m["file"]}', env=env)
        tree = git('write-tree', env=env).decode().strip()
    parent = git('rev-parse', base).decode().strip()
    commit = git('commit-tree', tree, '-p', parent, '-m', f'mutant {mid}: {m["fix"]} undone').decode().strip()
    git('update-ref', f'refs/mutants/{mid}', commit)
    return commit


if __name__ == '__main__':
    try: print(make(sys.argv[1]))
    except (KeyError, ValueError, RuntimeError, IndexError) as e: print(e, file=sys.stderr); sys.exit(1)
