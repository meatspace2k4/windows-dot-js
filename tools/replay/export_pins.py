"""What the history rebuild put into the tree beyond the replayed edits, at the same points, for replays: pins.json.
- pin: a file set to Claude Code's saved copy of it (file-history backup) at that copy's time
- inject: a file made by a step the replay cannot run (npm install, a Node one-liner, a benchmark run), taken from
  the first commit that has it, right after that step"""
import json, glob, os, subprocess
LIVE = '/Users/johusha/Win95'; H = os.path.dirname(os.path.abspath(__file__))
pins = []
for f in glob.glob('/Users/johusha/.claude/projects/-Users-johusha-Win95/*.jsonl'):
    sess = os.path.basename(f)[:-6]
    for line in open(f):
        if '"file-history-snapshot"' not in line: continue
        d = json.loads(line)
        for p, b in d['snapshot']['trackedFileBackups'].items():
            if not b.get('backupFileName'): continue
            full = p if p.startswith('/') else os.path.join(LIVE, p)
            fp = f'/Users/johusha/.claude/file-history/{sess}/{b["backupFileName"]}'
            if full.startswith(LIVE + '/') and os.path.exists(fp): pins.append({'kind': 'pin', 't': b['backupTime'], 'rel': os.path.relpath(full, LIVE), 'from': fp})
pins = sorted({(p['t'], p['rel'], p['from']): p for p in pins}.values(), key=lambda p: (p['t'], p['rel'], p['from']))
# the steps that made files the replay cannot (times of those tool calls; see hist/inject.json)
INJECT = {'2026-10-14T11:17:41.455Z': ['icons/icon192.png', 'icons/icon512.png'], '2026-10-14T11:18:51.145Z': ['electron/package-lock.json'],
          '2026-10-14T11:54:53.588Z': ['bench/replay-20261014-115627.mjs', 'bench/results/20261014-115627.json']}
for t, rels in INJECT.items():
    for rel in rels:
        c = subprocess.run(['git', '-C', LIVE, 'log', '--all', '--diff-filter=A', '--reverse', '--format=%H', '--', rel], capture_output=True, text=True).stdout.split()[0]
        pins.append({'kind': 'inject', 't': t, 'rel': rel, 'commit': c})
# the saved copies are pruned by Claude Code over time: keep our own under ~/Win95-tmp-backup/pins
import shutil
for p in pins:
    if p['kind'] != 'pin': continue
    dst = os.path.expanduser('~/Win95-tmp-backup/pins/') + p['from'].split('/')[-2] + '__' + os.path.basename(p['from'])
    if not os.path.exists(dst) and os.path.exists(p['from']): os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copyfile(p['from'], dst)
    if os.path.exists(dst): p['from'] = dst
    else: p['missing'] = True
json.dump(pins, open(H + '/pins.json', 'w'), indent=0)
print(sum(p['kind'] == 'pin' for p in pins), 'pins,', sum(p['kind'] == 'inject' for p in pins), 'injects')
