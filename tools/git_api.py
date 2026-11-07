"""/__git: a fixed set of git commands on the checkout tools/serve.py serves, for CLAUDE.EXE's Claude (ccd.js: its Git
tool), so the system's own code is reviewed and committed from inside it. This machine's own pages only
(claude_api.local_request), as /__src.

    {args: ['status', '--short']}   -> {out, err, code, cmd}   (or {error} when it is refused)

Allowed: status, diff, log, show, apply (only to check or count a patch: --check, --stat, --numstat, --summary), add
and commit. Every option is checked against the subcommand's own list, and anything else is refused: an option not on
it, a path outside the checkout or in .git, standard input, and so every global option (-c, -C, --git-dir,
--work-tree, --exec-path: the subcommand comes first), --output, --no-index, --amend, an editor. There is no shell: git
is run with the arguments as a list. Hooks do not run (core.hooksPath is the null device) unless the server is started
with W95_GIT_HOOKS=1; no pager, no external diff or textconv program, no editor, no credential prompt, no automatic gc;
the GIT_* variables of the server's own environment are not passed on. Asking before add and commit (the session's
permission mode) is the page's: ccd.js."""
import json, os, re, shlex, subprocess
import src_api

TIMEOUT = 60
MAX_OUT = 1 << 20

DIFF = [r'--(stat|shortstat|numstat|name-only|name-status|summary|raw|compact-summary|patch-with-stat)', r'--stat=\d+(,\d+){0,2}',
        r'--dirstat(=[\w,.]{1,40})?', r'-p', r'-u', r'--patch', r'-s', r'--no-patch', r'-U\d{1,5}', r'--unified=\d{1,5}',
        r'--(minimal|patience|histogram)', r'--diff-algorithm=(default|myers|minimal|patience|histogram)',
        r'-w', r'--ignore-all-space', r'-b', r'--ignore-space-change', r'--ignore-space-at-eol', r'--ignore-blank-lines',
        r'--ignore-cr-at-eol', r'--word-diff(=(plain|porcelain|none))?', r'-M(\d{1,3}%?)?', r'--find-renames(=\d{1,3}%?)?',
        r'--find-copies(=\d{1,3}%?)?', r'--no-renames', r'--diff-filter=[ACDMRTUXBacdmrtuxb*]{1,20}', r'-R', r'-a', r'--text',
        r'--binary', r'--full-index', r'--abbrev(=\d{1,2})?', r'--check', r'--exit-code', r'--quiet', r'--relative',
        r'--no-relative', r'-z', r'--no-prefix', r'--color=never', r'--no-color']
LOG = [r'--oneline', r'--graph', r'--decorate(=(short|full|auto|no))?', r'--no-decorate', r'--all', r'--branches', r'--tags',
       r'--remotes', r'--reverse', r'--first-parent', r'--no-merges', r'--merges', r'--follow', r'-\d{1,6}', r'-n\d{1,6}',
       r'--max-count=\d{1,6}', r'--skip=\d{1,6}', r'--(since|until|after|before)=[\w :.,+/-]{1,60}',
       r'--(author|committer|grep)=[^\n]{1,200}', r'-i', r'--regexp-ignore-case', r'-E', r'--extended-regexp',
       r'--fixed-strings', r'--all-match', r'--invert-grep', r'--(format|pretty)=[^\n]{1,500}', r'--pretty',
       r'--date=(relative|local|iso|iso-strict|rfc|short|raw|human|unix|default|format:[^\n]{1,100})', r'--abbrev-commit',
       r'--no-abbrev-commit', r'--left-right', r'--cherry-pick', r'--cherry-mark', r'--boundary', r'--source',
       r'--(topo|date|author-date)-order', r'--parents', r'--children', r'--no-walk', r'--simplify-by-decoration',
       r'--ancestry-path', r'--full-history', r'-m', r'--cc', r'--use-mailmap', r'--no-mailmap']
# the options that take the next argument as their value (or --name=value)
LOG_TAKES = {'-n', '--max-count', '--skip', '--author', '--committer', '--grep', '--since', '--until', '--after', '--before'}
COUNT = {'-n', '--max-count', '--skip'}

def need_message(seen, paths):
    if not seen & {'-m', '--message', '-F', '--file'}: raise PermissionError('git commit takes its message from -m "..." or -F <file of the checkout>: there is no editor here')
def need_paths(seen, paths):
    if not paths and not seen & {'-u', '--update', '-A', '--all'}: raise ValueError('git add: name what to add (paths), or -u / -A')
def check_only(seen, paths):
    if not seen & {'--check', '--stat', '--numstat', '--summary'}: raise PermissionError('git apply only checks or counts a patch here: add --check (or --stat, --numstat, --summary). The tree is changed with Write and Edit')
    if not paths: raise ValueError('git apply: name the patch file (a file of the checkout)')

SPEC = {
    'status': {'flags': [r'-[sbvz]{1,4}', r'--short', r'--branch', r'--long', r'--porcelain(=v[12])?', r'--show-stash', r'--verbose',
                         r'-u(no|normal|all)?', r'--untracked-files(=(no|normal|all))?', r'--ignored(=(traditional|no|matching))?',
                         r'--ignore-submodules(=(none|untracked|dirty|all))?', r'--(no-)?ahead-behind', r'--(no-)?renames',
                         r'--find-renames(=\d{1,3}%?)?', r'--no-column'], 'read': True},
    'diff': {'flags': DIFF + [r'--cached', r'--staged', r'--merge-base'], 'read': True, 'safe': ['--no-ext-diff', '--no-textconv']},
    'log': {'flags': LOG + DIFF, 'takes': LOG_TAKES, 'read': True, 'safe': ['--no-ext-diff', '--no-textconv']},
    'show': {'flags': LOG + DIFF, 'takes': LOG_TAKES, 'read': True, 'safe': ['--no-ext-diff', '--no-textconv']},
    'apply': {'flags': [r'--check', r'--stat', r'--numstat', r'--summary', r'-p\d{1,2}', r'-R', r'--reverse', r'--cached', r'--index',
                        r'-v', r'--verbose', r'--ignore-whitespace', r'--ignore-space-change', r'--whitespace=(nowarn|warn|fix|error|error-all)',
                        r'--recount', r'--allow-empty', r'--unidiff-zero', r'--inaccurate-eof', r'-z', r'-C\d{1,2}'],
              'files': True, 'final': check_only, 'read': True},
    'add': {'flags': [r'-[uANnv]{1,5}', r'--update', r'--all', r'--no-all', r'--intent-to-add', r'--dry-run', r'--verbose',
                      r'--ignore-removal', r'--no-ignore-removal', r'--renormalize', r'--refresh', r'--ignore-errors', r'--chmod=[+-]x'],
            'final': need_paths},
    'commit': {'flags': [r'-[aqsnv]{1,5}', r'--all', r'--quiet', r'--signoff', r'--no-signoff', r'--no-verify', r'--dry-run', r'--short',
                         r'--branch', r'--porcelain', r'--long', r'--only', r'-o', r'--include', r'-i', r'--allow-empty',
                         r'--cleanup=(strip|whitespace|verbatim|scissors|default)', r'--no-gpg-sign', r'--untracked-files=(no|normal|all)',
                         r'--no-status', r'--status'],
               'takes': {'-m', '--message', '-F', '--file'}, 'final': need_message},
}
WRITES = {'add', 'commit'}

def checkpath(root, x):
    """a revision or a path of the checkout's (git tells them apart): never absolute, never above the checkout, never in .git"""
    if '\n' in x or '\r' in x: raise ValueError(f'{x!r}: a line break in a path or revision')
    p = x.replace('\\', '/')
    if p.startswith('/') or re.match(r'^[A-Za-z]:', p) or p.startswith('~'): raise PermissionError(f'{x}: a path outside the checkout')
    segs = re.split(r'[/:]', p)
    if '..' in segs: raise PermissionError(f'{x}: a path outside the checkout')
    if any(s.lower() == '.git' for s in segs): raise PermissionError(f'{x}: .git is not the project\'s code')

def checkfile(root, x):
    """a file of the checkout the command reads (a patch, a commit message), as /__src resolves it (no link, no .git)"""
    checkpath(root, x)
    full = src_api.resolve(root, x)
    if not os.path.isfile(full): raise FileNotFoundError(f'{x}: no such file in the checkout')

def value(root, sub, name, v):
    if '\0' in v or len(v) > 20000: raise ValueError(f'{name}: a value with a NUL, or over 20000 characters')
    if name in COUNT and not re.fullmatch(r'\d{1,6}', v): raise ValueError(f'{name} takes a number')
    if name in ('-F', '--file'):
        if v == '-': raise PermissionError(f'{name} -: standard input is not taken')
        checkfile(root, v)
    elif name not in ('-m', '--message') and ('\n' in v or '\r' in v): raise ValueError(f'{name}: a line break in its value')

def check(root, args):
    """the git command (subcommand first) checked: (subcommand, the arguments to run it with), or PermissionError/ValueError"""
    if not isinstance(args, list) or not args or not all(isinstance(x, str) for x in args) or len(args) > 300:
        raise ValueError('args: the git command as a list of strings, its subcommand first (["status", "--short"])')
    if args[0] == 'git': args = args[1:]
    if not args: raise ValueError('args: the subcommand is missing')
    sub = args[0]
    if sub not in SPEC: raise PermissionError(f'git {sub} is not allowed here: only {", ".join(SPEC)} (no push, fetch, remote, config, checkout, reset, ... and no global options such as -c or -C)')
    sp = SPEC[sub]; takes = sp.get('takes', set()); out = []; seen = set(); paths = []; i = 1; dashdash = False
    while i < len(args):
        x = args[i]; i += 1
        if '\0' in x or len(x) > 20000: raise ValueError('an argument with a NUL, or over 20000 characters')
        if x == '-': raise PermissionError("'-' (standard input) is not taken")
        if dashdash or not x.startswith('-'):
            (checkfile if sp.get('files') else checkpath)(root, x); out.append(x); paths.append(x); continue
        if x == '--': dashdash = True; out.append(x); continue
        name = x.split('=', 1)[0]
        if name in takes:
            if '=' in x and name.startswith('--'): value(root, sub, name, x.split('=', 1)[1]); out.append(x)
            elif '=' in x: raise PermissionError(f'git {sub} {x}: give {name} its value as the next argument')
            else:
                if i >= len(args): raise ValueError(f'git {sub} {x}: its value is missing')
                v = args[i]; i += 1; value(root, sub, name, v); out += [x, v]
            seen.add(name); continue
        if not any(re.fullmatch(r, x) for r in sp['flags']): raise PermissionError(f'git {sub} {x}: that option is not allowed here')
        out.append(x); seen.add(name)
        if re.fullmatch(r'-[a-zA-Z]{2,}', x): seen.update('-' + c for c in x[1:])   # (combined short flags: -sb is -s -b)
    if sp.get('final'): sp['final'](seen, paths)
    return sub, out

def run(root, args):
    sub, rest = check(root, args)
    sp = SPEC[sub]
    hooks = os.environ.get('W95_GIT_HOOKS') == '1'
    argv = ['git', '--no-pager', '-c', 'color.ui=false', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat',
            '-c', 'gc.auto=0', '-c', 'maintenance.auto=false'] + ([] if hooks else ['-c', f'core.hooksPath={os.devnull}'])
    argv += [sub] + sp.get('safe', []) + rest
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_TERMINAL_PROMPT='0', GIT_PAGER='cat', PAGER='cat', GIT_EDITOR=':', GIT_SEQUENCE_EDITOR=':', GIT_ASKPASS='',
               GIT_NO_LAZY_FETCH='1', LC_ALL='C', LANG='C')
    if sp.get('read'): env['GIT_OPTIONAL_LOCKS'] = '0'
    try: p = subprocess.run(argv, cwd=os.path.realpath(root), env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired: raise TimeoutError(f'git {sub} took over {TIMEOUT} s and was stopped')
    except FileNotFoundError: raise FileNotFoundError('git is not installed where tools/serve.py runs')
    cut = lambda b: b[:MAX_OUT].decode('utf-8', 'replace') + ('\n... (truncated at 1 MB)' if len(b) > MAX_OUT else '')
    return {'out': cut(p.stdout), 'err': cut(p.stderr), 'code': p.returncode, 'cmd': 'git ' + ' '.join(shlex.quote(x) for x in [sub] + rest),
            'writes': sub in WRITES and '--dry-run' not in rest, 'hooks': hooks}

def handle(h, root):
    try: q = json.loads(h.rfile.read(int(h.headers.get('Content-Length', 0))) or b'{}')
    except ValueError: h.send_error(400); return
    if q.get('op') == 'check':   # (the command checked, not run: what the page asks before it asks the user)
        try: sub, rest = check(root, q.get('args')); r = {'ok': True, 'sub': sub, 'writes': sub in WRITES and '--dry-run' not in rest, 'cmd': 'git ' + ' '.join(shlex.quote(x) for x in [sub] + rest)}
        except (OSError, ValueError) as e: r = {'error': str(e.args[-1] if e.args else e)}
    else:
        try: r = run(root, q.get('args'))
        except (OSError, ValueError) as e: r = {'error': str(e.args[-1] if e.args else e)}
    b = json.dumps(r).encode()
    h.send_response(200); h.send_header('Content-Type', 'application/json'); h.send_header('Content-Length', str(len(b))); h.end_headers(); h.wfile.write(b)
