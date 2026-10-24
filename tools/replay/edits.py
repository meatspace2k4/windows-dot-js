"""Apply one recorded file mutation to a replay run. Run inside the run's sandbox: edits.py RUN_DIR < event.json

The session's project folder is the run's tree (RUN/tree) and its scratch folders are RUN/t. Edit and Write are
applied directly; shell commands run with RUN/bin first on PATH (copies of ordinary tools; network, process and
app-control commands answer nothing), in the directory the session's shell was in, which RUN/cwd.json keeps."""
import json, os, re, subprocess, sys
run = os.path.abspath(sys.argv[1]); W, T = os.environ.get('W95_TREE') or run + '/tree', run + '/t'
MAP = [('/Users/johusha/Win95', W), ('/private/tmp/claude-501/-Users-johusha-Win95', T), ('/tmp/claude-501/-Users-johusha-Win95', T)]
_RX = re.compile('(' + '|'.join(re.escape(a) for a, _ in MAP) + r')(?=/|$|[\s\'"`;&|)])'); _D = dict(MAP)
mp = lambda s: _RX.sub(lambda m: _D[m.group(1)], s)
e = json.load(sys.stdin); n, inp = e['name'], e['input']
state = run + '/cwd.json'; CWD = json.load(open(state)) if os.path.exists(state) else {}
out = {'edit': n}
if n == 'Write':
    p = mp(inp['file_path'])
    if p.startswith(run + '/') or p.startswith(W + '/'): os.makedirs(os.path.dirname(p), exist_ok=True); open(p, 'w').write(inp['content']); out['file'] = os.path.relpath(p, run)
elif n == 'Edit':
    p = mp(inp['file_path'])
    if (p.startswith(run + '/') or p.startswith(W + '/')) and os.path.exists(p):
        s = open(p).read(); o, nw = inp['old_string'], inp['new_string']
        if o in s: open(p, 'w').write(s.replace(o, nw) if inp.get('replace_all') else s.replace(o, nw, 1)); out['file'] = os.path.relpath(p, run)
        else: out['nomatch'] = os.path.relpath(p, run)
elif re.search(r'(?:>|\btee\b|\bcp\b|\bmv\b|\bln\b)[^\n;&|]*\bbin/python3?\b', inp.get('command', '')):
    # a write onto a bin/python3 shim: what replaced the system python launcher through a symlink (2026-10-14).
    # Never run, whatever the sandbox would allow.
    out['skipped'] = 'writes a bin/python3 shim'
else:
    cmd = mp(inp['command']); cwd = CWD.get(e['sess'], W)
    if not os.path.isdir(cwd): cwd = W
    env = {'PATH': run + '/bin', 'HOME': os.environ.get('HOME', ''), 'LANG': 'en_US.UTF-8', 'TMPDIR': run + '/tmp', 'W95_REPLAY_CACHE': os.environ.get('W95_REPLAY_CACHE', ''), 'W95_REPLAY_TREE': W}
    try:
        r = subprocess.run(['/bin/bash', '-c', cmd], cwd=cwd, env=env, capture_output=True, text=True, timeout=120)
        out['rc'] = r.returncode
        if r.returncode: out['stderr'] = r.stderr[-300:]
    except subprocess.TimeoutExpired: out['rc'] = 'timeout'
    c = cwd   # where the session's shell ended up: the command's cd's, read from its text
    for m in re.finditer(r'(?:^|&&|;|\n|\|\|)\s*cd\s+("[^"]+"|\'[^\']+\'|[^\s;&|]+)', cmd):
        t = m.group(1).strip('"\'')
        if '$' in t: c = None; break
        c = os.path.normpath(os.path.join(c, os.path.expanduser(t)))
    if c: CWD[e['sess']] = c
    if e.get('reset'): CWD[e['sess']] = W
    json.dump(CWD, open(state, 'w'))
print(json.dumps(out))
