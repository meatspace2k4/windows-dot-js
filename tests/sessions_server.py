"""tools/sessions.py, run by tests/sessions.test.mjs: a session's objects and intents as ops build it, what a joiner gets,
presence and pointers, the folder its intents are kept in, and the HTTP side end to end (the state, two people's event
streams, an op one posts reaching the other)."""
import http.client, http.server, json, os, shutil, sys, tempfile, threading
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import sessions as S

# ---- intents: by the setting they make, the last one the setting; ops without a key or of no kind refused
s = S.Session('t')
s.op('a', 'intent', {'key': 'spi:17', 'kind': 'spi', 'action': 17, 'ui': 0, 'flags': 3})
s.op('b', 'intent', {'key': 'spi:17', 'kind': 'spi', 'action': 17, 'ui': 1, 'flags': 3})
s.op('a', 'intent', {'key': 'ini:SYSTEM.INI:boot:scrnsave.exe', 'kind': 'ini', 'file': 'SYSTEM.INI', 'app': 'boot', 'name': 'SCRNSAVE.EXE', 'value': 'C:\\WINDOWS\\SYSTEM\\3DTEXT~1.SCR'})
st = s.state()
assert st['seq'] == 3 and st['intents']['spi:17']['ui'] == 1 and len(st['intents']) == 2, st
# (the session's wall clock: its start and the server's time now, ms, for every machine's clock to agree on)
assert isinstance(st['epoch'], int) and isinstance(st['now'], int) and st['epoch'] <= st['now'] <= st['epoch'] + 60000, st
assert 'disk' not in st and 'registry' not in st, 'no disk or registry kept'
for bad in [('intent', {'kind': 'spi'}), ('obj', {'v': {}}), ('disk', {'op': 'node'}), ('reg', {'op': 'set'}), ('nope', {})]:
    try: s.op('a', *bad); raise AssertionError('accepted ' + repr(bad))
    except ValueError: pass

# ---- presence: join hears the roster, a pointer moves it, leave drops the person once their last stream ends
s = S.Session('p')
q1 = s.join('c1', 'Guest'); assert q1.get_nowait() == ('people', {'people': [{'client': 'c1', 'user': 'Guest', 'x': None, 'y': None, 'cur': None}], 'seq': 0})
q2 = s.join('c2', 'Ann'); q1.get_nowait(); q2.get_nowait()
assert s.pointer('c2', 10, 20) and q1.get_nowait()[1]['people'][1] == {'client': 'c2', 'user': 'Ann', 'x': 10, 'y': 20, 'cur': None}
assert not s.pointer('nobody', 1, 1)
# (the image a pointer shows, by key, sent once with its image: kept, told to everyone, and to a joiner with the roster)
img = {'px': 0, 'py': 0, 'cpp': 1, 'row': 16, 'hx': 1, 'hy': 1, 'b64': 'AAAA'}
assert s.pointer('c2', 11, 21, {'k': 'abc', 'img': img})
ev = q1.get_nowait(); assert ev[0] == 'cursor' and ev[1] == {'k': 'abc', 'img': img}, ev
assert q1.get_nowait()[1]['people'][1]['cur'] == 'abc'
assert s.pointer('c2', 12, 22, {'k': 'abc'}) and q1.get_nowait()[0] == 'people', 'a key already kept: no image event'
q6 = s.join('c6', 'Fay'); q6.get_nowait(); assert q6.get_nowait() == ('cursor', {'k': 'abc', 'img': img})
s.leave('c6', q6); q1.get_nowait(); q1.get_nowait()   # (c6 came and went: the roster twice)
s.op('c1', 'intent', {'key': 'spi:15', 'kind': 'spi', 'action': 15, 'ui': 60, 'flags': 3})
ev = q2.get_nowait()
while ev[0] != 'op': ev = q2.get_nowait()
assert ev == ('op', {'seq': 1, 'client': 'c1', 'kind': 'intent', 'op': {'key': 'spi:15', 'kind': 'spi', 'action': 15, 'ui': 60, 'flags': 3}})
s.leave('c2', q2); assert [p['client'] for p in s.roster()] == ['c1']
# a batch in order; someone rejoining after seq 1 is replayed what came after; one further back than the log reloads
assert s.ops('c1', [{'kind': 'obj', 'op': {'id': 'A', 'v': {}}}, {'kind': 'obj', 'op': {'id': 'B', 'v': {}}}]) == 3
q3 = s.join('c3', 'Cy', since=1); q3.get_nowait()
assert [q3.get_nowait()[1]['seq'] for _ in range(2)] == [2, 3]
assert q3.get_nowait()[0] == 'cursor', 'the pointer image in use, after the changes'
keep_log = S.LOG_KEEP; S.LOG_KEEP = 1
s.op('c1', 'obj', {'id': 'C', 'v': {}})
q4 = s.join('c4', 'Di', since=1); q4.get_nowait(); assert q4.get_nowait() == ('reload', {'seq': 4})
S.LOG_KEEP = keep_log
q5 = s.join('c5', 'Ed', since=4); q5.get_nowait(); assert q5.get_nowait()[0] == 'cursor' and q5.empty(), 'up to date: nothing more'

# ---- the OS's objects: in the state by id, sent to everyone in order; one closed kept as closed (None); all gone when
# no machine runs the session, the intents kept
s = S.Session('w')
a = s.start('a', 'Bob'); assert a['world'] == {} and a['running'] is False
qa = s.join('a', 'Bob'); qb = s.join('b', 'Ann')
for q in (qa, qb):
    while not q.empty(): q.get_nowait()
s.op('a', 'obj', {'id': 'NOTEPAD.EXE#0/Notepad#0', 'v': {'x': 1}})
assert qb.get_nowait() == ('op', {'seq': 1, 'client': 'a', 'kind': 'obj', 'op': {'id': 'NOTEPAD.EXE#0/Notepad#0', 'v': {'x': 1, 'origin': 'a'}, 'gen': 0}})   # (its first appearance carries whose machine opened it)
b = s.start('b', 'Ann'); assert b['running'] is True and b['world'] == {'NOTEPAD.EXE#0/Notepad#0': {'x': 1, 'origin': 'a'}}   # (origin: whose machine opened it)
s.op('b', 'obj', {'id': 'NOTEPAD.EXE#0/Notepad#0', 'v': None}); assert s.state()['world'] == {'NOTEPAD.EXE#0/Notepad#0': None}
assert s.state()['gens'] == {'NOTEPAD.EXE#0/Notepad#0': 1}, 'a close: the next generation'
# a change made before that close (generation 0): passed over; its machine is sent the object as it is, from 'server'
for q in (qa, qb):
    while not q.empty(): q.get_nowait()
s.op('a', 'obj', {'id': 'NOTEPAD.EXE#0/Notepad#0', 'v': {'x': 9}, 'gen': 0})
assert s.state()['world'] == {'NOTEPAD.EXE#0/Notepad#0': None}
assert qa.get_nowait()[1] == {'seq': 3, 'client': 'server', 'to': 'a', 'kind': 'obj', 'op': {'id': 'NOTEPAD.EXE#0/Notepad#0', 'v': None, 'gen': 1}}
# a change is a patch, made to the object as it is: a field, a control
s2 = S.Session('p')
s2.op('a', 'obj', {'id': 'N', 'v': {'x': 1, 'ctrls': {'1:edit': ''}}}); s2.op('b', 'obj', {'id': 'N', 'v': {'ctrls': {'1:edit': 'hi'}}}); s2.op('a', 'obj', {'id': 'N', 'v': {'x': 2}})
assert s2.state()['world']['N'] == {'x': 2, 'ctrls': {'1:edit': 'hi'}, 'origin': 'a'}   # (origin: the machine that first said it exists, kept through others' patches)
# ---- a person's strokes into an object's window ('input': its events as offsets from the window, in parts): sent on
# in order, kept with the object for a machine joining (whose they were with them), the oldest let go past INPUT_KEEP
# events, gone with the object's close; one without an id or events refused
s3 = S.Session('i'); qi = s3.join('b', 'Ann')
s3.op('a', 'obj', {'id': 'MSPAINT.EXE#0/MSPaintApp#0', 'v': {'x': 1}})
s3.op('a', 'input', {'id': 'MSPAINT.EXE#0/MSPaintApp#0', 'n': 1, 'ev': [[2, 10, 10], [1, 12, 12]], 'done': False})
s3.op('a', 'input', {'id': 'MSPAINT.EXE#0/MSPaintApp#0', 'n': 1, 'ev': [[4, 14, 14]], 'done': True})
evs = [qi.get_nowait() for _ in range(4)]
assert evs[2][1]['kind'] == 'input' and evs[2][1]['op'] == {'id': 'MSPAINT.EXE#0/MSPaintApp#0', 'n': 1, 'ev': [[2, 10, 10], [1, 12, 12]], 'done': False}, evs
assert s3.state()['inputs'] == {'MSPAINT.EXE#0/MSPaintApp#0': [{'n': 1, 'ev': [[2, 10, 10], [1, 12, 12]], 'done': False, 'by': 'a'}, {'n': 1, 'ev': [[4, 14, 14]], 'done': True, 'by': 'a'}]}
keep = S.INPUT_KEEP; S.INPUT_KEEP = 2
s3.op('a', 'input', {'id': 'MSPAINT.EXE#0/MSPaintApp#0', 'n': 2, 'ev': [[2, 1, 1], [4, 1, 1]], 'done': True})
assert [p['n'] for p in s3.state()['inputs']['MSPAINT.EXE#0/MSPaintApp#0']] == [2], 'the oldest parts let go'
S.INPUT_KEEP = keep
for bad in [{'id': 'X'}, {'ev': []}, {'id': 'X', 'ev': 'no'}]:
    try: s3.op('a', 'input', bad); raise AssertionError('accepted ' + repr(bad))
    except ValueError: pass
s3.op('a', 'obj', {'id': 'MSPAINT.EXE#0/MSPaintApp#0', 'v': None}); assert s3.state()['inputs'] == {}, 'closed: its strokes are over'
# opened again after it (generation 1): a new one
s.op('a', 'obj', {'id': 'NOTEPAD.EXE#0/Notepad#0', 'v': {'x': 2}, 'gen': 1}); assert s.state()['world'] == {'NOTEPAD.EXE#0/Notepad#0': {'x': 2, 'origin': 'a'}}
s.op('b', 'intent', {'key': 'spi:17', 'kind': 'spi', 'action': 17, 'ui': 1, 'flags': 3})
s.leave('a', qa); s.leave('b', qb); assert s.state()['world'] == {} and 'spi:17' in s.state()['intents']
# a reloaded page (the same client) starting while its old stream is still open, with no one else there: its windows
# went with its restart (the Control Panel it had open was opened again at each reload)
r = S.Session('r'); qr = r.join('a', 'Bob'); r.op('a', 'obj', {'id': 'FOLDER/Control Panel#0', 'v': {'folder': {'csidl': 3}}})
st = r.start('a', 'Bob'); assert st['world'] == {} and st['running'] is False, st
qr2 = r.join('a', 'Bob'); r.leave('a', qr); assert r.people and r.state()['world'] == {}
# another machine running it: its windows stay
r.op('a', 'obj', {'id': 'N', 'v': {'x': 1}}); qo = r.join('b', 'Ann')
st = r.start('a', 'Bob'); assert st['running'] is True and st['world'] == {'N': {'x': 1, 'origin': 'a'}}, st

# ---- kept in its folder: a new server has its intents, not its objects
root = tempfile.mkdtemp()
try:
    a = S.Sessions(root); t = a.get('keep')
    t.op('a', 'intent', {'key': 'spi:20', 'kind': 'spi', 'action': 20, 'ui': 0, 'str': 'C:\\WINDOWS\\CLOUDS.BMP', 'flags': 3})
    t.op('a', 'obj', {'id': 'X', 'v': {}})
    t.save()
    st = S.Sessions(root).get('keep').state()
    assert st['intents']['spi:20']['str'] == 'C:\\WINDOWS\\CLOUDS.BMP' and st['world'] == {} and st['seq'] == 2, st
finally: shutil.rmtree(root)
for bad in ['', '../x', 'a/b', 'x' * 65]:
    try: S.Sessions().get(bad); raise AssertionError('id ' + bad)
    except ValueError: pass

# ---- HTTP: state, two people's streams, an op posted by one reaching the other
sess = S.Sessions()
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self): sess.handle(self, 'GET') or self.send_error(404)
    def do_POST(self): sess.handle(self, 'POST') or self.send_error(404)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]
def req(method, path, body=None):
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=5); c.request(method, path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
    r = c.getresponse(); return r.status, json.loads(r.read())
def stream(client, user):
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=5); c.request('GET', f'/__session/room/events?client={client}&user={user}'); r = c.getresponse()
    assert r.status == 200 and r.getheader('Content-Type') == 'text/event-stream'
    def next_event():
        ev = data = None
        while True:
            line = r.fp.readline().decode().rstrip('\n')
            if line.startswith('event: '): ev = line[7:]
            elif line.startswith('data: '): data = json.loads(line[6:])
            elif line == '' and ev: return ev, data
    return next_event
st0 = req('GET', '/__session/room/state')[1]
assert {k: v for k, v in st0.items() if k not in ('epoch', 'now')} == {'seq': 0, 'world': {}, 'gens': {}, 'intents': {}, 'inputs': {}} and st0['epoch'] <= st0['now'], st0
ann, bob = stream('c1', 'Ann'), stream('c2', 'Bob')
assert ann()[0] == 'people'
while True:
    ev, d = ann()
    if ev == 'people' and len(d['people']) == 2: break
i = {'key': 'spi:17', 'kind': 'spi', 'action': 17, 'ui': 1, 'flags': 3}
assert req('POST', '/__session/room/op', {'client': 'c2', 'kind': 'intent', 'op': i}) == (200, {'seq': 1})
while True:
    ev, d = ann()
    if ev == 'op': break
assert d == {'seq': 1, 'client': 'c2', 'kind': 'intent', 'op': i}
assert req('POST', '/__session/room/pointer', {'client': 'c1', 'x': 3, 'y': 4}) == (200, {'ok': True})
assert req('POST', '/__session/room/op', {'client': 'c2', 'kind': 'disk', 'op': {'op': 'node'}})[0] == 400
assert req('GET', '/__sessions')[1] == [{'id': 'room', 'people': 2, 'seq': 1}]
assert req('GET', '/__session/..%2Fx/state')[0] == 400
srv.shutdown()
print('sessions_server: ok')
