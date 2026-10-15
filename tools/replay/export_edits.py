"""The recorded file mutations (Write, Edit, and shell commands that may change files), in time order, for replays.
Reads hist/events.pkl; writes edits.json."""
import pickle, json, os
H = os.path.dirname(os.path.abspath(__file__))
L = pickle.load(open(H + '/../hist/events.pkl', 'rb'))
# side conversations (this replay's own session and the 'btw' fork) did no project work: their own calls are left out
SIDE = {'985053b8', 'a0b916ef'}
L = [e for e in L if not set(e.get('files', [])) <= SIDE]
KEYS = ('cd ', 'open(', '>', 'sed -i', 'cp ', 'mv ', 'rm ', 'mkdir', 'write', 'touch', 'ln ')
out = []
for e in L:
    n, i = e['name'], e['input']
    if n in ('Write', 'Edit') or (n == 'Bash' and any(k in i.get('command', '') for k in KEYS)):
        out.append(dict(t=e['t'], sess=e['sess'], src=e['id'], name=n, input={k: i[k] for k in ('file_path', 'content', 'old_string', 'new_string', 'replace_all', 'command') if k in i},
                        reset='Shell cwd was reset' in (e['result'] or '')))
json.dump(out, open(H + '/edits.json', 'w'))
print(len(out), 'edits')
