"""How a replay's eval results compare with what the session recorded. compare.py RUN_DIR [N]"""
import json, sys, re
run = sys.argv[1]; show = int(sys.argv[2]) if len(sys.argv) > 2 else 15
steps = {}
for s in json.load(open('steps.json')):
    if s['kind'] == 'eval': steps.setdefault(s['t'], []).append(s)
def recorded(s):
    r = s['recorded'].split('\n\nTab Context')[0]
    r = re.sub(r'^\[javascript_tool:javascript_exec\]\s*', '', r).strip()
    m = re.match(r'\[failed\] javascript_tool failed: (.*?)(?:\n\s+at |$)', r, re.S)
    if m: return m.group(1).strip()
    try: return json.loads(r)
    except Exception: return r
norm = lambda v: json.dumps(json.loads(v), sort_keys=True) if isinstance(v, str) and v[:1] in '{[' and v[-1:] in '}]' and not v.startswith('[javascript') else json.dumps(v, sort_keys=True)
same = diff = 0; out = []; seen = {}
for l in open(run + '/results.jsonl'):
    d = json.loads(l)
    if d.get('kind') != 'eval': continue
    k = seen.get(d['t'], 0); seen[d['t']] = k + 1
    cands = steps.get(d['t'], []); s = cands[k] if k < len(cands) else None
    if not s: continue
    want = recorded(s); got = d.get('value', d.get('exception', d.get('error')))
    try: ok = norm(want) == norm(got)
    except Exception: ok = str(want) == str(got)
    if ok: same += 1
    else: diff += 1; out.append((d['n'], d['t'][11:19], str(want)[:110], str(got)[:110]))
print(f'{same} same, {diff} different')
for o in out[:show]: print(o[0], o[1], '\n   want', o[2], '\n   got ', o[3])
