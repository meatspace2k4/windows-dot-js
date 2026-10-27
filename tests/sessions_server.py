"""tools/sessions.py, run by tests/sessions.test.mjs: a session's state as ops build it, what a joiner gets, each joiner's
own block of node ids, presence and pointers, the folder it is kept in, the size cap, and the HTTP side end to end
(the state, two people's event streams, an op one posts reaching the other)."""
import base64, http.client, http.server, json, os, shutil, sys, tempfile, threading, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import sessions as S

b64 = lambda b: base64.b64encode(b).decode()

# ---- state from ops: a folder, a file in it with bytes, resized; the registry; removal takes the subtree
s = S.Session('t')
s.op('a', 'disk', {'op': 'node', 'sid': 0, 'parent': -1, 'name': '', 'dir': True})
s.op('a', 'disk', {'op': 'node', 'sid': 5, 'parent': 0, 'name': 'DOCS', 'short': 'DOCS', 'dir': True, 'ord': 1})
s.op('a', 'disk', {'op': 'node', 'sid': 6, 'parent': 5, 'name': 'a.txt', 'short': 'A.TXT', 'dir': False, 'ord': 2})
s.op('a', 'disk', {'op': 'data', 'sid': 6, 'offset': 0, 'bytes': b64(b'hello world')})
s.op('a', 'disk', {'op': 'data', 'sid': 6, 'offset': 6, 'bytes': b64(b'there')})
s.op('a', 'disk', {'op': 'size', 'sid': 6, 'size': 11})
s.op('b', 'reg', {'op': 'set', 'path': 'hkcu\\x', 'name': 'v', 'value': {'type': 1, 'data': b64(b'1\0')}})
s.op('b', 'reg', {'op': 'key', 'path': 'hkcu\\x', 'name': 'X'})
st = s.state()
assert st['seq'] == 8
f = next(n for n in st['disk']['nodes'] if n['sid'] == 6)
assert base64.b64decode(f['data']) == b'hello there', f
assert st['registry'] == [['hkcu\\x', [['v', {'type': 1, 'data': b64(b'1\0')}]], 'X']], st['registry']
# each joiner its own block of node ids
assert s.state()['sidBase'] == st['sidBase'] + S.SID_BLOCK
s.op('a', 'disk', {'op': 'remove', 'sid': 5})
assert [n['sid'] for n in s.state()['disk']['nodes']] == [0]
s.op('b', 'reg', {'op': 'delkey', 'path': 'hkcu\\x'})
assert s.state()['registry'] is None
for bad in [('disk', {'op': 'nope'}), ('nope', {})]:
    try: s.op('a', *bad); raise AssertionError('accepted ' + repr(bad))
    except ValueError: pass

# ---- presence: join hears the roster, a pointer moves it, leave drops the person once their last stream ends
s = S.Session('p')
q1 = s.join('c1', 'Guest'); assert q1.get_nowait() == ('people', {'people': [{'client': 'c1', 'user': 'Guest', 'x': None, 'y': None, 'host': True}], 'seq': 0})
q2 = s.join('c2', 'Ann'); q1.get_nowait(); q2.get_nowait()
assert s.pointer('c2', 10, 20) and q1.get_nowait()[1]['people'][1] == {'client': 'c2', 'user': 'Ann', 'x': 10, 'y': 20, 'host': False}
assert not s.pointer('nobody', 1, 1)
s.op('c1', 'disk', {'op': 'label', 'label': 'W95', 'serial': 7})
ev = q2.get_nowait()
while ev[0] != 'op': ev = q2.get_nowait()
assert ev == ('op', {'seq': 1, 'client': 'c1', 'kind': 'disk', 'op': {'op': 'label', 'label': 'W95', 'serial': 7}})
s.leave('c2', q2); assert [p['client'] for p in s.roster()] == ['c1']
# a batch in order; someone rejoining after seq 1 is replayed what came after; one further back than the log reloads
assert s.ops('c1', [{'kind': 'reg', 'op': {'op': 'key', 'path': 'hkcu\\a'}}, {'kind': 'reg', 'op': {'op': 'key', 'path': 'hkcu\\b'}}]) == 3
q3 = s.join('c3', 'Cy', since=1); q3.get_nowait()
assert [q3.get_nowait()[1]['seq'] for _ in range(2)] == [2, 3]
keep_log = S.LOG_KEEP; S.LOG_KEEP = 1
s.op('c1', 'reg', {'op': 'key', 'path': 'hkcu\\c'})
q4 = s.join('c4', 'Di', since=1); q4.get_nowait(); assert q4.get_nowait() == ('reload', {'seq': 4})
S.LOG_KEEP = keep_log
q5 = s.join('c5', 'Ed', since=4); q5.get_nowait(); assert q5.empty(), 'up to date: nothing more'

# ---- the machines kept aligned: input numbered and logged with the changes but no state; the host the first one here,
# then the next; its view (and only its) sent on, and given to a joiner; the session's screen the first one asked for
s = S.Session('m')
qa = s.join('a', 'Ann'); qb = s.join('b', 'Bob')
for q in (qa, qb):
    while not q.empty(): q.get_nowait()
assert s.host() == 'a'
assert s.op('b', 'input', {'t': 'down', 'x': 1, 'y': 2}) == 1 and s.state()['disk'] is None and not s.dirty
assert qa.get_nowait() == ('op', {'seq': 1, 'client': 'b', 'kind': 'input', 'op': {'t': 'down', 'x': 1, 'y': 2}})
assert qb.get_nowait()[0] == 'op', 'its own input too, in order'
assert not s.set_view('b', [{'title': 'X'}], 1), 'not the host'
assert s.set_view('a', [{'title': 'A'}], 1) and qb.get_nowait() == ('view', {'client': 'a', 'seq': 1, 'view': [{'title': 'A'}]})
qc = s.join('c', 'Cy', since=1); assert [qc.get_nowait()[0] for _ in range(2)] == ['people', 'view']
s.leave('a', qa); assert s.host() == 'b' and s.roster()[0] == {'client': 'b', 'user': 'Bob', 'x': None, 'y': None, 'host': True}
assert s.set_screen(800, 600) == {'w': 800, 'h': 600} and s.set_screen(1024, 768) == {'w': 800, 'h': 600}
assert s.state()['screen'] == {'w': 800, 'h': 600} and s.state()['host'] == 'b'
assert S.Session('z').set_screen(100, 5000) == {'w': 640, 'h': 960}

# ---- kept in its folder: a new server has it
root = tempfile.mkdtemp()
try:
    a = S.Sessions(root); t = a.get('keep')
    t.op('a', 'disk', {'op': 'node', 'sid': 9, 'parent': 0, 'name': 'k', 'dir': False})
    t.op('a', 'disk', {'op': 'data', 'sid': 9, 'offset': 0, 'bytes': b64(b'kept')})
    t.op('a', 'reg', {'op': 'set', 'path': 'hklm\\y', 'name': 'n', 'value': {'type': 4, 'data': b64(b'\1\0\0\0')}})
    assert t.state()['sidBase'] == S.SID_BLOCK
    t.save()
    b = S.Sessions(root).get('keep'); st = b.state()
    assert base64.b64decode(next(n for n in st['disk']['nodes'] if n['sid'] == 9)['data']) == b'kept'
    assert st['seq'] == 3 and st['registry'][0][0] == 'hklm\\y'
    assert st['sidBase'] > S.SID_BLOCK, 'blocks go on from where the last server left them'
finally: shutil.rmtree(root)

# ---- the cap: bytes past it refused; bad ids refused
S.MAX_BYTES, keep = 16, S.MAX_BYTES
try:
    s = S.Session('cap'); s.op('a', 'disk', {'op': 'node', 'sid': 1, 'parent': 0, 'name': 'f', 'dir': False})
    try: s.op('a', 'disk', {'op': 'data', 'sid': 1, 'offset': 0, 'bytes': b64(b'x' * 32)}); raise AssertionError('over the cap')
    except ValueError: pass
finally: S.MAX_BYTES = keep
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
assert req('GET', '/__session/room/state')[1]['disk'] is None
ann, bob = stream('c1', 'Ann'), stream('c2', 'Bob')
assert ann()[0] == 'people'
while True:
    ev, d = ann()
    if ev == 'people' and len(d['people']) == 2: break
assert req('POST', '/__session/room/op', {'client': 'c2', 'kind': 'reg', 'op': {'op': 'key', 'path': 'hkcu\\z'}}) == (200, {'seq': 1})
while True:
    ev, d = ann()
    if ev == 'op': break
assert d == {'seq': 1, 'client': 'c2', 'kind': 'reg', 'op': {'op': 'key', 'path': 'hkcu\\z'}}
assert req('POST', '/__session/room/pointer', {'client': 'c1', 'x': 3, 'y': 4}) == (200, {'ok': True})
assert req('POST', '/__session/room/op', {'client': 'c2', 'kind': 'disk', 'op': {'op': 'bad'}})[0] == 400
assert req('GET', '/__sessions')[1] == [{'id': 'room', 'people': 2, 'seq': 1}]
assert req('GET', '/__session/..%2Fx/state')[0] == 400
srv.shutdown()
print('sessions_server: ok')
