"""Extract every tool call from the Win95 transcripts, deduped by id, ordered by time, with the text of its result."""
import json, glob, pickle
ev = {}; res = {}; files = {}
for f in glob.glob('/Users/johusha/.claude/projects/-Users-johusha-Win95/*.jsonl'):
    for line in open(f):
        try: d = json.loads(line)
        except Exception: continue
        m = d.get('message')
        if not isinstance(m, dict) or not isinstance(m.get('content'), list): continue
        for b in m['content']:
            if not isinstance(b, dict): continue
            if b.get('type') == 'tool_use': files.setdefault(b['id'], set()).add(f.split('/')[-1][:8])
            if b.get('type') == 'tool_use' and b['id'] not in ev:
                ev[b['id']] = dict(id=b['id'], t=d.get('timestamp', ''), name=b['name'], input=b['input'], sess=f.split('/')[-1][:8], uuid=d.get('uuid'))
            elif b.get('type') == 'tool_result':
                c = b.get('content'); txt = c if isinstance(c, str) else ''.join(x.get('text', '') for x in c if isinstance(x, dict)) if isinstance(c, list) else ''
                res.setdefault(b.get('tool_use_id'), (txt, bool(b.get('is_error'))))
L = sorted(ev.values(), key=lambda e: e['t'])
for e in L: e['result'], e['error'] = res.get(e['id'], ('', None)); e['files'] = sorted(files.get(e['id'], ()))
pickle.dump(L, open('events.pkl', 'wb'))
print(len(L))
