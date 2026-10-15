"""Every recorded interaction with the running shell, as replay steps, in time order.
Reads hist/events.pkl (all tool calls of the Win95 transcripts). Writes steps.json."""
import pickle, json, re, shlex, sys, os
H = os.path.dirname(os.path.abspath(__file__))
L = pickle.load(open(H + '/../hist/events.pkl', 'rb'))
# side conversations (this replay's own session and the 'btw' fork) did no project work: their own calls are left out
SIDE = {'985053b8', 'a0b916ef'}
L = [e for e in L if not set(e.get('files', [])) <= SIDE]
EXPR_SCRIPTS = {'ev.mjs', 'ev2.mjs', 'edrive.mjs', 'shot.mjs', 'err.mjs'}      # argv[2] is an expression run in the page
steps, skipped = [], {}
TABRX = re.compile(r'Executed on tabId: ([\w-]+)')
def tab_of(e, inp=None):
    # the browser tab a call ran in: its tabId, else the one its result names; per session lineage (forks share tabs)
    t = (inp or {}).get('tabId') or e['input'].get('tabId') or (TABRX.search(e['result'] or '') or [None, None])[1]
    f = set(e.get('files') or [e['sess']])
    lin = 'c289926e' if 'c289926e' in f else '13370d9c' if f & {'13370d9c', '2305d7fe'} else 'a9a557c2'
    return f'{lin}:{t}' if t else None
def add(e, **s): steps.append(dict(t=e['t'], sess=e['sess'], src=e['id'], recorded=(e['result'] or '')[:4000], tab=s.pop('tab', None) or tab_of(e), **s))
def browser(e, name, inp):
    a = inp.get('action')
    if name == 'javascript_tool': add(e, kind='eval', target='preview', code=inp.get('text', ''))
    elif name in ('navigate', 'preview_start'):
        u = inp.get('url') or ''
        if u in ('back', 'forward'): add(e, kind='history', target='preview', go=u)
        elif u or inp.get('name'): add(e, kind='navigate', target='preview', url=u or 'http://localhost:8095/')
    elif name == 'resize_window': add(e, kind='viewport', target='preview', preset=inp.get('preset'), width=inp.get('width'), height=inp.get('height'))
    elif name == 'computer':
        if a in ('left_click', 'right_click', 'double_click', 'triple_click', 'hover', 'left_click_drag', 'scroll', 'type', 'key', 'wait', 'screenshot'):
            add(e, kind='input', target='preview', action=a, **{k: v for k, v in inp.items() if k in ('coordinate', 'start_coordinate', 'text', 'modifiers', 'scroll_direction', 'scroll_amount', 'duration', 'repeat', 'ref')})
        else: skipped[name + ':' + str(a)] = skipped.get(name + ':' + str(a), 0) + 1
    else: skipped[name] = skipped.get(name, 0) + 1
FRAME = re.compile(r'coordinate frame:? \(?(\d+)x(\d+)')
# the page's own size, wherever the session printed it: win95.screen(), [innerWidth, innerHeight, dpr, ...], W/H, cssW/cssH
SIZES = [re.compile(r'\\?"width\\?":\s*(\d{3,4}),\s*\\?"height\\?":\s*(\d{3,4})'), re.compile(r'\[\s*(\d{3,4}),\s*(\d{3,4}),\s*[123],'),
         re.compile(r'\\?"(?:W|cssW)\\?":\s*(\d{3,4})(?:,\s*\\?"(?:H|cssH)\\?":\s*(\d{3,4}))?')]
def frames(e, text):
    # the pane's size as the session saw it: each screenshot names the coordinate frame later clicks use
    for m in FRAME.finditer(text or ''): add(e, kind='frame', target='preview', fw=int(m.group(1)), fh=int(m.group(2)))
    for rx in SIZES:
        for m in rx.finditer(text or ''): add(e, kind='screen', target='preview', cw=int(m.group(1)), ch=int(m.group(2)) if m.lastindex > 1 and m.group(2) else None)
for e in L:
    n, inp = e['name'], e['input']
    if n.startswith('mcp__Claude_Browser__'):
        name = n.split('__')[-1]
        if name == 'browser_batch':
            # the batch's result is one part per action, each starting with its tag ([javascript_tool:...], [computer:...])
            res = e['result'] or ''
            parts = [p for p in re.split(r'(?=\[(?:javascript_tool|computer|navigate|find|read_page|form_input|get_page_text|read_console_messages|resize_window|tabs_\w+|preview_\w+|read_network_requests)[:\]])', res) if p.strip()]
            # a batch stops at an action that fails ("actions[k] (...) failed: ... (k completed, n remaining)"): the
            # actions after it never ran, and that action's result is the failure
            fail = re.search(r'actions\[(\d+)\] \(([^)]*)\) failed: (.*?)(?:\s*\(\d+ completed, \d+ remaining\))?\s*$', res, re.S)
            acts = inp.get('actions', [])
            if fail:
                # a failed eval ran (and threw); any other failed action did not run at all
                fk = int(fail.group(1)); ran = fail.group(2).startswith('javascript_tool') and 'javascript_tool failed:' in fail.group(3); acts = acts[:fk + (1 if ran else 0)]
                parts = [p for p in re.split(r'(?=\[(?:javascript_tool|computer|navigate|find|read_page|form_input|get_page_text|read_console_messages|resize_window|tabs_\w+|preview_\w+|read_network_requests)[:\]])', res[:fail.start()]) if p.strip()][:fk] + ['[failed] ' + fail.group(3).strip()]
            if fail: frames(e, fail.group(3))
            for k, it in enumerate(acts):
                part = parts[k] if k < len(parts) and len(parts) == len(acts) else res
                before = len(steps); browser(e, it.get('name', ''), it.get('input', {}))
                for st in steps[before:]: st['recorded'] = part[:4000]
                frames(e, part)
        else: browser(e, name, inp); frames(e, e['result'])
    elif n == 'Bash':
        cmd = inp.get('command', '')
        for m in re.finditer(r'(?:^|[;&|\n(]\s*|timeout \d+ )node\s+((?:"[^"]*"|\'[^\']*\'|[^\s;&|]+)(?:\s+(?:"(?:[^"\\]|\\.)*"|\'[^\']*\'|[^\s;&|<>]+))*)', cmd):
            try: argv = shlex.split(m.group(1))
            except ValueError: skipped['node:unparsed'] = skipped.get('node:unparsed', 0) + 1; continue
            script = os.path.basename(argv[0]) if argv else ''
            if script in EXPR_SCRIPTS and len(argv) > 1: add(e, kind='eval', target='electron', code=argv[1])
            elif script == 'listen.mjs': add(e, kind='eval', target='electron', code=argv[2] if len(argv) > 2 else 'undefined', listen_ms=int(argv[1]) if len(argv) > 1 and argv[1].isdigit() else 3000)
            elif script == 'eshot.mjs': add(e, kind='input', target='electron', action='screenshot')
            elif script == 'one.mjs': add(e, kind='bench-steps', target='electron', names=argv[1:])
            elif argv[0].startswith('bench/') or '/Win95/bench/' in argv[0]: add(e, kind='node', target='electron', script='bench/' + script, args=argv[1:])
            else: skipped['node ' + script] = skipped.get('node ' + script, 0) + 1
import datetime
TS = lambda t: datetime.datetime.fromisoformat(t[:19]).timestamp()
sizes = [st for st in steps if st['kind'] == 'screen' and st['target'] == 'preview' and 300 <= st['cw'] <= 1100 and not st['sess'] in ()]
out, last = [], None
for st in steps:
    if st['kind'] == 'screen': continue
    if st['kind'] == 'frame':
        if last and (last['fw'], last['fh']) == (st['fw'], st['fh']): continue
        last = st; out.append(st)
    else: out.append(st)
steps = out
frames = [st for st in steps if st['kind'] == 'frame']
for i, st in enumerate(frames):
    end = frames[i + 1]['t'] if i + 1 < len(frames) else '9999'
    inside = [z for z in sizes if (st['t'] <= z['t'] or i == 0) and z['t'] < end and z['ch'] and abs(z['cw'] / z['ch'] - st['fw'] / st['fh']) < 0.03]
    if inside: st['cw'], st['ch'] = inside[0]['cw'], inside[0]['ch']; continue
    # no size printed in this period: an earlier period of the same pane shape (the pane went back to a size it had),
    # else the nearest printed width; the height in proportion
    same = [f for f in frames[:i] if f['fw'] == st['fw'] and abs(f['fh'] - st['fh']) <= 3 and 'cw' in f]
    near = min(sizes, key=lambda z: abs(TS(z['t']) - TS(st['t']))) if sizes else None
    cw = same[-1]['cw'] if same else near['cw'] if near else st['fw']
    st['cw'], st['ch'] = cw, round(st['fh'] * cw / st['fw'])
json.dump(steps, open(H + '/steps.json', 'w'))
from collections import Counter
print(len(steps), Counter((s['kind'], s['target']) for s in steps).most_common())
print('skipped', skipped)
