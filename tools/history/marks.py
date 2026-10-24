"""Message markers for commit grouping: genuine user messages and assistant text, deduped, by time."""
import json, glob, pickle, re
seen = set(); M = []
# messages only in this side session or the 'btw' fork are not part of the work's history
where = {}
for f in glob.glob('/Users/johusha/.claude/projects/-Users-johusha-Win95/*.jsonl'):
    for line in open(f):
        u = re.search(r'"uuid":"([^"]+)"', line)
        if u: where.setdefault(u.group(1), set()).add(f.split('/')[-1][:8])
SIDE = {'985053b8', 'a0b916ef'}
for f in glob.glob('/Users/johusha/.claude/projects/-Users-johusha-Win95/*.jsonl'):
    for line in open(f):
        try: d = json.loads(line)
        except Exception: continue
        u = d.get('uuid'); m = d.get('message')
        if not u or u in seen or not isinstance(m, dict): continue
        seen.add(u); t = d.get('timestamp', '')
        if where.get(u, set()) <= SIDE: continue
        c = m.get('content')
        if d.get('type') == 'user' and not d.get('isMeta') and not d.get('isCompactSummary'):
            txt = c if isinstance(c, str) else ' '.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text') if isinstance(c, list) else ''
            if txt and not txt.lstrip().startswith(('<', '[Request interrupted', 'This session is being continued', '[SYSTEM')): M.append((t, 'user', txt.strip()))
        elif d.get('type') == 'assistant' and isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get('type') == 'text' and b['text'].strip(): M.append((t, 'asst', b['text'].strip()))
M.sort(); pickle.dump(M, open('marks.pkl', 'wb')); print(len(M), sum(1 for x in M if x[1] == 'user'))
