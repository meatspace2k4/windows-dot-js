#!/usr/bin/env python3
"""PreToolUse/PostToolUse guard for the Win95 checkout: rules on what the agent does, none on what the code looks like."""
import json, os, re, subprocess, sys, time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATE = os.path.join(REPO, '.git', 'claude-guard')
TMP = ('/tmp/', '/private/tmp/', '/dev/', '/var/folders/')


def out(decision, reason):
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': decision,
                                             'permissionDecisionReason': reason}}))
    sys.exit(0)


def in_repo(p):
    p = os.path.abspath(os.path.expanduser(p))
    return p == REPO or p.startswith(REPO + os.sep)


def tmp_path(p):
    p = p.strip('\'"')
    return p.startswith(TMP) or 'scratchpad' in p or p == '-'


def state_file(sid):
    os.makedirs(STATE, exist_ok=True)
    return os.path.join(STATE, re.sub(r'[^\w-]', '_', sid or 'none') + '.json')


def load(sid):
    try:
        with open(state_file(sid)) as f:
            s = json.load(f)
        return s if isinstance(s, dict) else {'files': s, 'edit': 0, 'test': 0}
    except (OSError, ValueError):
        return {'files': [], 'edit': 0, 'test': 0}


def save(sid, s):
    with open(state_file(sid), 'w') as f:
        json.dump(s, f)


def touched(sid):
    return set(load(sid)['files'])


TRANSCRIPTS = os.path.expanduser('~/.claude/projects/' + re.sub(r'[^\w-]', '-', REPO))


def live(n, s, within):
    """a session still at work: one this guard has seen call a tool within the last minutes ('seen', main). A
    transcript's time is no sign of it: a rewound conversation, or the one a fork was taken from, has its file
    written without doing anything, and its edits were taken for a live writer's (a session whose transcript is gone
    is gone)"""
    if not os.path.exists(os.path.join(TRANSCRIPTS, n[:-5] + '.jsonl')):
        return False
    return time.time() - s.get('seen', s.get('edit', 0)) < within


def other_writer(sid, path, within=3 * 60):
    """another session at work that edited path (its state names the file, and it is live): a file's uncommitted edits
    from a writer that is gone, or from the person, are not another writer's"""
    try:
        names = os.listdir(STATE)
    except OSError:
        return False
    mine = os.path.basename(state_file(sid))
    for n in names:
        if n == mine or not n.endswith('.json'):
            continue
        try:
            with open(os.path.join(STATE, n)) as f:
                s = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(s, dict) and path in s.get('files', []) and live(n, s, within):
            return True
    return False


def untested(sid):
    s = load(sid)
    return s['edit'] > s['test'] and any(git_dirty(os.path.relpath(p, REPO)) for p in s['files'])


def git_dirty(path):
    r = subprocess.run(['git', '-C', REPO, 'status', '--porcelain', '--', path], capture_output=True, text=True)
    return bool(r.stdout.strip())


def check_bash(cmd):
    c = ' '.join(cmd.split())
    if re.search(r"\b(sed|perl)\b[^|;&]*\s-[a-zA-Z]*i", c):
        out('deny', 'In-place edit from the shell. Use the Edit tool.')
    bare = ' '.join(re.sub(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", "''", re.sub(r"<<-?\s*'?(\w+)'?.*?\n\1\b", ' ', cmd, flags=re.S)).split())
    for m in re.finditer(r"(?<![0-9&>])>>?\s*([^\s;&|()]+)", bare):
        if not tmp_path(m.group(1)):
            out('deny', f'Shell redirect writes {m.group(1)}. Use the Edit or Write tool.')
    for m in re.finditer(r"\btee\s+(?:-a\s+)?([^\s;&|]+)", bare):
        if not tmp_path(m.group(1)):
            out('deny', f'tee writes {m.group(1)}. Use the Edit or Write tool.')
    for m in re.finditer(r"(?<!git )\b(cp|mv|install|truncate)\s+([^;&|]+)", bare):
        args = [a for a in m.group(2).split() if not a.startswith('-')]
        if args and not tmp_path(args[-1]):
            out('deny', f'{m.group(1)} writes {args[-1]}. Use the Edit or Write tool.')
    if re.search(r"\b(git\s+apply|patch)\b", bare):
        out('deny', 'Patching from the shell. Use the Edit tool.')
    if re.search(r"\b(python3?|node|ruby|perl)\b", c) and re.search(
            r"writeFileSync|appendFileSync|renameSync|unlinkSync|copyFileSync|rmSync|fs\.write|fs\.promises|"
            r"write_text|write_bytes|shutil\.|os\.(remove|rename|replace|unlink)|open\([^)]*['\"][wax+]", c) \
            and not re.search(r"/tmp/|scratchpad", c):
        out('deny', 'A script that writes files. Use the Edit or Write tool.')
    if re.search(r"--headless|Contents/MacOS/(Google Chrome|Chromium)|\b(puppeteer|playwright)\b|\bpython3?\s+(-\S+\s+)*\S*serve\.py|tests/machine/run", c):
        out('deny', 'Own browser or server. Use the built-in preview and the page already running.')
    if re.search(r"\b(pkill|killall)\b|electron/build\.sh|open\s+-a|Windows 95\.app", c):
        out('deny', 'Restarting or rebuilding the app. The person does that.')
    if re.search(r"\bgit\s+(add\s+(-A|--all|\.(\s|$)|-u)|commit\s+(-[a-zA-Z]*a\b|--all))", c):
        out('deny', 'Whole-tree staging. Stage only this session\'s own hunks.')
    if re.search(r"\bgit\s+(commit|push)\b", c) and untested(SID):
        out('deny', 'Files edited since the last passing node tests/ run. Run the tests on this change first.')
    if re.search(r"\bgit\s+(restore|revert|clean|stash(?!\s+(list|show)))\b", c) or \
            re.search(r"\bgit\s+reset\b.*--(hard|merge|keep)", c) or \
            re.search(r"\bgit\s+(checkout|switch)\s+(?!-b\s|-B\s|-c\s)", c):
        out('ask', 'Reverts tracked files or switches the branch of the shared checkout. Only on the person\'s request.')
    if re.search(r"\.claude/projects/[^/\s]+/memory/", c) and not re.match(r"\s*(cat|ls|grep|head|tail)\b", cmd):
        out('deny', 'Memory files are not written.')


def check_url(ti):
    m = re.match(r"\s*(?:https?://)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::(\d+))?", ti.get('url') or '')
    if not m:
        return
    try:
        with open(os.path.join(REPO, '.claude', 'launch.json')) as f:
            ports = {str(c.get('port')) for c in json.load(f).get('configurations', [])}
    except (OSError, ValueError):
        return
    if (m.group(2) or '80') not in ports:
        out('deny', f'Port {m.group(2)} is not the preview from .claude/launch.json ({", ".join(sorted(ports))}). Test on the page that serves this checkout.')


def check_file(ti, sid):
    path = os.path.abspath(ti.get('file_path') or ti.get('notebook_path') or '')
    if re.search(r"/\.claude/projects/[^/]+/memory/", path):
        out('deny', 'Memory files are not written.')
    if not in_repo(path) or path.startswith(os.path.join(REPO, '.claude') + os.sep) or path.startswith(os.path.join(REPO, '.git') + os.sep):
        return
    rel = os.path.relpath(path, REPO)
    if git_dirty(rel) and path not in touched(sid) and other_writer(sid, path):
        out('deny', f'{rel} holds uncommitted edits from another writer. Do not stack on them.')


def post(tool, ti, sid):
    s = load(sid)
    if tool == 'Bash':
        if re.match(r"\s*(cd\s+\S+\s*&&\s*)?node\s+(--test\s+)?tests/\S+", ti.get('command', '')):
            s['test'] = time.time()
    else:
        path = os.path.abspath(ti.get('file_path') or ti.get('notebook_path') or '')
        if not in_repo(path) or path.startswith(os.path.join(REPO, '.claude') + os.sep):
            return
        s['files'] = sorted(set(s['files']) | {path})
        s['edit'] = time.time()
    save(sid, s)


def last_tool(path):
    """the name of the last tool the assistant called since the person's last prompt, or None"""
    last = None
    try:
        with open(path) as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                c = (e.get('message') or {}).get('content')
                if e.get('type') == 'user' and not e.get('isMeta') and (isinstance(c, str) or (
                        isinstance(c, list) and any(isinstance(x, dict) and x.get('type') == 'text' for x in c)
                        and not any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in c))):
                    last = None
                elif e.get('type') == 'assistant' and isinstance(c, list):
                    for x in c:
                        if isinstance(x, dict) and x.get('type') == 'tool_use':
                            last = x.get('name')
    except (OSError, TypeError):
        return 'AskUserQuestion'
    return last


SID = ''


def main():
    global SID
    d = json.load(sys.stdin)
    tool, ti, sid = d.get('tool_name', ''), d.get('tool_input') or {}, d.get('session_id', '')
    SID = sid
    ev = d.get('hook_event_name')
    if sid and ev == 'PreToolUse':   # (this session at work: other sessions' live(); at most every few seconds)
        s = load(sid)
        if time.time() - s.get('seen', 0) > 5:
            s['seen'] = time.time(); save(sid, s)
    if ev == 'Stop':
        if untested(sid):
            print(json.dumps({'decision': 'block', 'reason': 'Files edited since the last passing node tests/ run. Run the tests on this change before ending the turn.'}))
        elif last_tool(d.get('transcript_path')) != 'AskUserQuestion':
            print(json.dumps({'decision': 'block', 'reason': 'A turn ends only on a blocker raised with AskUserQuestion. Not for updates, summaries or reports. Keep working.'}))
        return
    if ev == 'PostToolUse':
        if tool in ('Bash', 'Edit', 'Write', 'NotebookEdit'):
            post(tool, ti, sid)
    elif tool == 'Bash':
        check_bash(ti.get('command', ''))
    elif tool in ('Edit', 'Write', 'NotebookEdit'):
        check_file(ti, sid)
    elif tool.startswith('mcp__Claude_Browser__'):
        for t in ([a.get('input') or {} for a in ti.get('actions') or []] if tool.endswith('browser_batch') else [ti]):
            check_url(t)


if __name__ == '__main__':
    main()
