"""Rebuild the Win95 project's history as git commits: replay every recorded mutation from an empty tree in a
write-sandbox, pinned to the file-history checkpoints, one commit per assistant step that changed files."""
import pickle, os, sys, subprocess, shutil, json, re, glob, textwrap
H = os.path.dirname(os.path.abspath(__file__)); R = os.environ.get('RDIR') or H + '/R'; W, T, G = R + '/w', R + '/t', R + '/git'
LIVE = '/Users/johusha/Win95'
CUTOFF = os.environ.get('CUTOFF', '9999')        # replay events before this time only
TARGET = os.environ.get('TARGET', LIVE)          # the tree the history is brought up to at the end
MAP = [(LIVE, W), ('/private/tmp/claude-501/-Users-johusha-Win95', T), ('/tmp/claude-501/-Users-johusha-Win95', T)]
_RX = re.compile('|'.join(re.escape(a) for a, _ in MAP)); _D = dict(MAP)
def mp(s): return _RX.sub(lambda m: _D[m.group(0)], s)
V1_START = '2026-10-14T12:24:09'
GITIGNORE = """# generated from the Windows 95 CD (tools/build_system.py, build_savers.py, build_shell_assets.py, extract.py)
/system.js
/savers.js
/assets.js
/assets-shell.js
/cdrom.js
# built apps and dependencies
electron/node_modules/
electron/Windows 95.app/
mac/Windows 95.app/
__pycache__/
.DS_Store
.claude/settings.local.json
"""
L = pickle.load(open(H + '/events.pkl', 'rb')); M = pickle.load(open(H + '/marks.pkl', 'rb'))
# side conversations (this rebuild's own session and the 'btw' fork) did no project work: their own calls are left out
SIDE = {'985053b8', 'a0b916ef'}
L = [e for e in L if not set(e.get('files', [])) <= SIDE]
CO = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'

def git(*a, env=None, check=True):
    e = dict(os.environ, GIT_DIR=G, GIT_WORK_TREE=W, **(env or {}))
    return subprocess.run(['git', *a], cwd=W, env=e, capture_output=True, text=True, check=check).stdout

# ---- checkpoints and injected files: the replay's pins.json (saved copies kept under ~/Win95-tmp-backup/pins)
PINS = json.load(open(os.path.join(H, '..', 'replay', 'pins.json')))
CP = sorted((p['t'], p['rel'], p['from']) for p in PINS if p['kind'] == 'pin' and not p.get('missing') and os.path.exists(p['from']))

# ---- tracked files of the live tree, and where files the replay never produces first appeared

subprocess.run([H + '/mkbin.sh'], check=True)
assert not os.path.exists(R), 'RDIR must be a fresh directory'
os.makedirs(R)
SB = R + '.sb'   # write sandbox for replayed commands: this run's directory only
open(SB, 'w').write('(version 1)\n(allow default)\n(deny network*)\n(deny signal (target others))\n(deny file-write*)\n'
                    f'(allow file-write* (subpath "{R}") (subpath "{os.path.abspath(os.path.join(H, "..", "replay", "cache"))}") (subpath "/dev") (subpath "/private/var/folders"))\n')
os.makedirs(W); os.makedirs(T); os.makedirs(R + '/tmp')
for d in glob.glob('/private/tmp/claude-501/-Users-johusha-Win95/*/'): os.makedirs(T + '/' + os.path.basename(d.rstrip('/')) + '/scratchpad', exist_ok=True)
env = {'PATH': H + '/bin', 'HOME': os.environ['HOME'], 'LANG': 'en_US.UTF-8', 'TMPDIR': R + '/tmp'}
# the same command environment as a replay (replay/edits.py): tool wrappers, real CD builds (cached), the CD folders
RP = os.path.join(H, '..', 'replay'); os.makedirs(R + '/bin', exist_ok=True)
REALPY = '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11'
for c in ['bash', 'sh', 'cat', 'sed', 'cp', 'mv', 'rm', 'mkdir', 'ls', 'grep', 'head', 'tail', 'cut', 'sort', 'uniq', 'awk', 'touch', 'find', 'wc', 'tr', 'chmod', 'ln', 'basename', 'dirname', 'diff', 'xargs', 'tee', 'env', 'base64', 'stat', 'mktemp', 'perl', 'cmp', 'seq', 'printf', 'echo', 'test', 'true', 'false']:
    w = subprocess.run(['/usr/bin/which', c], capture_output=True, text=True).stdout.strip()
    open(f'{R}/bin/{c}', 'w').write(f'#!/bin/sh\nexec {w} "$@"\n' if w else '#!/bin/sh\nexit 0\n'); os.chmod(f'{R}/bin/{c}', 0o755)
open(f'{R}/bin/python3', 'w').write(f'#!/bin/sh\nW95_REAL_PYTHON={REALPY} exec {REALPY} {os.path.abspath(RP)}/pybuild.py "$@"\n'); os.chmod(f'{R}/bin/python3', 0o755)
for c in ['node', 'npm', 'npx', 'timeout', 'sleep', 'curl', 'osascript', 'pkill', 'kill', 'pgrep', 'open', 'plutil', 'codesign', 'sips', 'iconutil', 'swiftc', 'lsof', 'ps', 'git', 'gh', 'du', 'which', 'say', 'screencapture', 'defaults', 'launchctl', 'killall', 'python', 'rsync', 'cabextract', '7z', '7zz', 'hdiutil']:
    open(f'{R}/bin/{c}', 'w').write('#!/bin/sh\nexit 0\n'); os.chmod(f'{R}/bin/{c}', 0o755)
CD = os.path.expanduser('~/Win95-tmp-backup')
for d in os.listdir(CD):
    sp = os.path.join(CD, d, 'scratchpad')
    if not os.path.isdir(sp): continue
    dst = os.path.join(T, d, 'scratchpad'); os.makedirs(dst, exist_ok=True)
    for x in ['sys', 'sys95', 'scr', 'fonts', 'raw', 'tb', 'cab', 'cab2', 'infs', 'out', 'out2']:
        if os.path.isdir(os.path.join(sp, x)) and not os.path.exists(os.path.join(dst, x)): shutil.copytree(os.path.join(sp, x), os.path.join(dst, x), symlinks=True)
    if os.path.isdir(os.path.join(sp, 'cab3')) and not os.path.exists(os.path.join(dst, 'cab3')): os.symlink(os.path.join(sp, 'cab3'), os.path.join(dst, 'cab3'))
subprocess.run(['git', 'init', '-q', '-b', 'main', '--separate-git-dir', G, W], check=True)
os.remove(W + '/.git')
open(W + '/.gitignore', 'w').write(GITIGNORE)

def when(t): return {'GIT_AUTHOR_DATE': t, 'GIT_COMMITTER_DATE': t}
git('add', '-A'); git('commit', '-q', '-m', 'Ignore files generated from the Windows 95 CD\n\n' + CO, env=when('2026-10-14T04:31:00Z'))
git('checkout', '-q', '-b', 'v0')

def subject(text):
    t = re.sub(r'[*`_#>|]', '', text).strip().split('\n')[0]
    t = re.split(r'(?<=[.!?])\s', t)[0].rstrip('.:')
    return t if len(t) <= 72 else t[:69].rstrip() + '...'
cur_msg = ['Start of the project', '']; pending = None; notes = []; v0_tip = None; n_commits = 0
def commit(t):
    global pending, notes, n_commits
    git('add', '-A')
    if not git('status', '--porcelain'): pending = None; notes = []; return
    msg, body = pending or cur_msg
    body = textwrap.fill(body[:900], 100, break_long_words=False, replace_whitespace=False) if body else ''
    if notes: body += ('\n\n' if body else '') + 'Pinned to recorded file contents: ' + ', '.join(sorted(set(notes)))
    git('commit', '-q', '-m', subject(msg) + '\n\n' + (body + '\n\n' if body else '') + CO, env=when(t))
    n_commits += 1; pending = None; notes = []

CWD = {}; log = []; ci = 0; mi = 0
def apply(i, e):
    n = e['name']
    if n not in ('Write', 'Edit', 'Bash'): return
    inp = e['input']; cmd = inp.get('command', '')
    if n == 'Bash' and not any(k in cmd for k in ('cd ', 'open(', '>', 'sed -i', 'cp ', 'mv ', 'rm ', 'mkdir', 'write', 'touch', 'ln ')): return
    ev = {'name': n, 'input': {k: inp[k] for k in ('file_path', 'content', 'old_string', 'new_string', 'replace_all', 'command') if k in inp}, 'sess': e['sess'], 'reset': 'Shell cwd was reset' in (e['result'] or '')}
    r = subprocess.run(['/usr/bin/sandbox-exec', '-f', SB, REALPY, os.path.join(RP, 'edits.py'), R], input=json.dumps(ev), capture_output=True, text=True,
                       env={**os.environ, 'TMPDIR': R + '/tmp', 'W95_TREE': W, 'W95_REPLAY_CACHE': os.path.abspath(os.path.join(RP, 'cache'))})
    log.append((i, 'edit', r.stdout.strip()[-300:]))

INJECT = json.load(open(H + '/inject.json')) if os.path.exists(H + '/inject.json') else {}
for i, e in enumerate(L):
    t = e['t']
    if t >= CUTOFF: break
    while mi < len(M) and M[mi][0] <= t:                      # a message: close the step before it
        commit(M[mi][0]); cur_msg = [M[mi][2], M[mi][2] if M[mi][1] == 'asst' else '']; mi += 1
    if v0_tip is None and t >= V1_START:
        commit(t); v0_tip = git('rev-parse', 'HEAD').strip(); git('checkout', '-q', '-b', 'v1')
    while ci < len(CP) and CP[ci][0] <= t:                    # pin to the recorded contents
        _, rel, fp = CP[ci]; ci += 1; p = os.path.join(W, rel); b = open(fp, 'rb').read()
        if not os.path.exists(p) or open(p, 'rb').read() != b:
            os.makedirs(os.path.dirname(p), exist_ok=True); open(p, 'wb').write(b); notes.append(rel)
    apply(i, e)
    for rel in INJECT.get(str(i), []):                       # files made by a step the replay cannot run (a build, node)
        p = os.path.join(W, rel); os.makedirs(os.path.dirname(p), exist_ok=True); shutil.copyfile(os.path.join(TARGET, rel), p); notes.append(rel)
    if pending is None and git('status', '--porcelain'): pending = cur_msg
commit(L[-1]['t'])
# whatever the live tree holds beyond the replay (steps not recorded as text, work after the transcripts were read)
live = subprocess.run(['git', 'ls-files', '-o', '--exclude-standard', '--exclude-from=' + W + '/.gitignore'], cwd=TARGET, env=dict(os.environ, GIT_DIR=G, GIT_WORK_TREE=TARGET, GIT_INDEX_FILE=R + '/empty-index'), capture_output=True, text=True).stdout.split('\n')
for rel in filter(None, live):
    src = os.path.join(TARGET, rel); dst = os.path.join(W, rel)
    if os.path.isfile(src) and (not os.path.exists(dst) or open(src, 'rb').read() != open(dst, 'rb').read() or os.stat(src).st_mode != os.stat(dst).st_mode):
        os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst); notes.append(rel)
keep = set(filter(None, live))
for rel in filter(None, git('ls-files').split('\n')):
    if rel not in keep and rel != '.gitignore': os.remove(os.path.join(W, rel)); notes.append(rel + ' (removed)')
for rel in filter(None, git('ls-files', '-o', '--exclude-standard').split('\n')):
    if rel not in keep: os.remove(os.path.join(W, rel))
pending = ['Bring the history up to the working tree', 'Files whose last changes the transcript replay could not reproduce.']
commit(CUTOFF if CUTOFF != '9999' else subprocess.run(['date', '-u', '+%Y-%m-%dT%H:%M:%SZ'], capture_output=True, text=True).stdout.strip())
json.dump(log, open(H + '/build-log.json', 'w'))
print('commits', n_commits, 'v0 tip', v0_tip)
