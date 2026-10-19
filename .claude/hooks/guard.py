#!/usr/bin/env python3
"""PreToolUse/PostToolUse guard for the Win95 checkout: rules on what the agent does, none on what the code looks like."""
import json, os, re, subprocess, sys

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


def touched(sid):
    try:
        with open(state_file(sid)) as f:
            return set(json.load(f))
    except (OSError, ValueError):
        return set()


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
    if re.search(r"--headless|Google Chrome|chromium|puppeteer|playwright|serve\.py", c):
        out('deny', 'Own browser or server. Use the built-in preview and the page already running.')
    if re.search(r"\b(pkill|killall)\b|electron/build\.sh|open\s+-a|Windows 95\.app", c):
        out('deny', 'Restarting or rebuilding the app. The person does that.')
    if re.search(r"\bgit\s+(add\s+(-A|--all|\.(\s|$)|-u)|commit\s+(-[a-zA-Z]*a\b|--all))", c):
        out('deny', 'Whole-tree staging. Stage only this session\'s own hunks.')
    if re.search(r"\bgit\s+(restore|revert|clean|stash(?!\s+(list|show)))\b", c) or \
            re.search(r"\bgit\s+reset\b.*--(hard|merge|keep)", c) or \
            re.search(r"\bgit\s+(checkout|switch)\s+(?!-b\s|-B\s|-c\s)", c):
        out('ask', 'Reverts tracked files or switches the branch of the shared checkout. Only on the person\'s request.')
    if re.search(r"\.claude/projects/[^/\s]+/memory/", c) and not re.match(r"\s*(cat|ls|grep|head|tail)\b", cmd):
        out('deny', 'Memory files are not written.')


def check_file(ti, sid):
    path = os.path.abspath(ti.get('file_path') or ti.get('notebook_path') or '')
    if re.search(r"/\.claude/projects/[^/]+/memory/", path):
        out('deny', 'Memory files are not written.')
    if not in_repo(path) or path.startswith(os.path.join(REPO, '.claude') + os.sep) or path.startswith(os.path.join(REPO, '.git') + os.sep):
        return
    rel = os.path.relpath(path, REPO)
    if git_dirty(rel) and path not in touched(sid):
        out('deny', f'{rel} holds uncommitted edits from another writer. Do not stack on them.')


def post(ti, sid):
    path = os.path.abspath(ti.get('file_path') or ti.get('notebook_path') or '')
    if in_repo(path):
        s = touched(sid)
        s.add(path)
        with open(state_file(sid), 'w') as f:
            json.dump(sorted(s), f)


def main():
    d = json.load(sys.stdin)
    tool, ti, sid = d.get('tool_name', ''), d.get('tool_input') or {}, d.get('session_id', '')
    if d.get('hook_event_name') == 'PostToolUse':
        if tool in ('Edit', 'Write', 'NotebookEdit'):
            post(ti, sid)
    elif tool == 'Bash':
        check_bash(ti.get('command', ''))
    elif tool in ('Edit', 'Write', 'NotebookEdit'):
        check_file(ti, sid)


if __name__ == '__main__':
    main()
