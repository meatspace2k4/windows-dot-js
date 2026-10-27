"""Windows 95 sessions shared between people, as a multi-player server keeps a game's world: each session is the OS's
persistent state (C:'s nodes and file bytes by node id, the volume's label, the registry: the same tables the page's
store and the app's keep, host-web.js and electron/store.js), the log of changes made to it, and the people in it with
their pointers. Nothing is streamed: every person runs Windows in their own browser on the session's state, sends the
changes their machine makes (the store's write-through operations) and receives everyone else's, which their page
applies to its live disk and registry. As ~/likes's room bus: the server is the one source of truth, a person's page
subscribes to the session's events (server-sent events: a full snapshot of who is there on connecting and whenever that
changes, and each change to the state in order) and posts its own changes.

Each person who joins gets a block of node ids of their own (`sidBase`), so files two people create at once never take
the same id. A session's state is kept in its folder (state.json and one file per file's bytes) and written back a
moment after it changes, so a restarted server has it.

Used by tools/serve.py and deploy/win95/win95_server.py:
    GET  /__sessions                       the sessions: [{ id, people, seq }]
    GET  /__session/<id>/state             the state: { seq, sidBase, disk: { nodes (data base64), label, serial }, registry }
    GET  /__session/<id>/events?client=&user=   server-sent events: 'people' { people } and 'op' { seq, client, kind, op }
    POST /__session/<id>/op                { client, kind: 'disk' | 'reg', op }  ->  { seq }
    POST /__session/<id>/pointer           { client, x, y }

The OS is the session's world. Besides C: and the registry, the state holds the OS's objects ('obj' ops, by a
session-wide id): the programs running, their windows (place, size, shown state) and their controls' contents. A
person's action runs once, on their own machine; what it changes in the OS is sent as the objects' new state, and
every other machine sets its own OS to match. A machine that joins, or comes back after missing some, is given the
objects as they are and changes only what differs on it.
"""
import base64, json, os, queue, re, threading, time

SID_BLOCK = 1 << 20          # (node ids each joiner gets: more files than one person makes in a session)
MAX_SESSIONS = 64            # (sessions kept in memory at once; more are refused)
MAX_BYTES = 512 << 20        # (one session's file bytes at most: a write past it is refused)
LOG_KEEP = 20000             # (the changes kept to replay to someone who reconnects; one further behind loads the state again)
ID = re.compile(r'^[A-Za-z0-9_.-]{1,64}$')


class Session:
    def __init__(self, sid, folder=None):
        self.id, self.folder, self.lock = sid, folder, threading.RLock()
        self.nodes, self.data, self.label, self.serial = {}, {}, None, None   # sid -> node row; sid -> bytearray
        self.regkeys, self.regvals = {}, {}                                    # path -> name; (path, name) -> value
        self.seq, self.next_block, self.people, self.subs, self.log = 0, 1, {}, set(), []
        self.dirty, self.saver = False, None
        self.owner = None                      # (whose session it is: their HKCU on every machine in it)
        self.world = {}                        # (the OS's objects: id -> their state)
        if folder: self.load()

    # ---- the state, as the page's store keeps it
    def apply(self, kind, op):
        if kind == 'disk':
            t = op.get('op')
            if t == 'node':
                r = {k: op[k] for k in ('sid', 'parent', 'name', 'short', 'dir', 'ord', 'attrs', 'ctime', 'mtime', 'atime') if k in op}
                self.nodes[r['sid']] = r
                if not r.get('dir'): self.data.setdefault(r['sid'], bytearray())
            elif t == 'remove':
                todo = [op['sid']]
                while todo:
                    s = todo.pop(); self.nodes.pop(s, None); self.data.pop(s, None)
                    todo += [k for k, n in self.nodes.items() if n.get('parent') == s]
            elif t == 'data':
                b = base64.b64decode(op['bytes']); off = int(op['offset'])
                buf = self.data.setdefault(op['sid'], bytearray())
                if off + len(b) > len(buf):
                    if self.bytes() + off + len(b) - len(buf) > MAX_BYTES: raise ValueError('the session is full')
                    buf.extend(bytes(off + len(b) - len(buf)))
                buf[off:off + len(b)] = b
            elif t == 'size':
                buf = self.data.setdefault(op['sid'], bytearray()); n = int(op['size'])
                if n > len(buf) and self.bytes() + n - len(buf) > MAX_BYTES: raise ValueError('the session is full')
                del buf[n:]; buf.extend(bytes(max(0, n - len(buf))))
            elif t == 'label': self.label, self.serial = op.get('label'), op.get('serial')
            else: raise ValueError(f'no disk operation {t}')
        elif kind == 'reg':
            t, path = op.get('op'), op.get('path')
            if t == 'key': self.regkeys[path] = op.get('name') or self.regkeys.get(path)
            elif t == 'set': self.regkeys.setdefault(path, None); self.regvals[(path, op['name'])] = op['value']
            elif t == 'del': self.regvals.pop((path, op['name']), None)
            elif t == 'delkey':
                inside = lambda k: k == path or k.startswith(path + '\\')
                for k in [k for k in self.regkeys if inside(k)]: del self.regkeys[k]
                for k in [k for k in self.regvals if inside(k[0])]: del self.regvals[k]
            else: raise ValueError(f'no registry operation {t}')
        elif kind == 'obj':
            oid = op.get('id')
            if not isinstance(oid, str) or not oid: raise ValueError('an object needs an id')
            self.world[oid] = op.get('v')   # (None: closed, kept so a machine starting it at its own start closes it too)
        else: raise ValueError(f'no kind {kind}')

    def bytes(self): return sum(len(b) for b in self.data.values())

    def start(self, client, user):
        """the state a machine starts from: the session as it is, and its owner (the first person to start it)"""
        with self.lock:
            if not self.owner: self.owner = user; self.changed()
            return dict(self.state(), owner=self.owner, running=bool(self.people))

    def state(self):
        with self.lock:
            nodes = [dict(n, data=base64.b64encode(bytes(self.data.get(s, b''))).decode()) if not n.get('dir') else dict(n) for s, n in self.nodes.items()]
            reg = {}
            for p, name in self.regkeys.items(): reg[p] = [name, []]
            for (p, n), v in self.regvals.items(): reg.setdefault(p, [None, []])[1].append([n, v])
            sid_base = self.next_block * SID_BLOCK; self.next_block += 1; self.changed()
            return {'seq': self.seq, 'sidBase': sid_base, 'world': dict(self.world), 'disk': {'nodes': nodes, 'label': self.label, 'serial': self.serial} if nodes else None,
                    'registry': [[p, v, name] for p, (name, v) in reg.items()] if reg else None}

    # ---- changes, and who hears of them
    def op(self, client, kind, op):
        """a change to the state, numbered and logged, so a machine that missed some gets them again in order"""
        with self.lock:
            self.apply(kind, op); self.seq += 1
            msg = {'seq': self.seq, 'client': client, 'kind': kind, 'op': op}
            self.log.append(msg)
            if len(self.log) > LOG_KEEP: del self.log[:len(self.log) - LOG_KEEP]
            self.publish('op', msg); self.changed()
            return self.seq


    def publish(self, event, data):
        for q in list(self.subs): q.put((event, data))

    def roster(self): return [{'client': c, 'user': p['user'], 'x': p.get('x'), 'y': p.get('y')} for c, p in self.people.items()]

    def join(self, client, user, since=None):
        """a person's queue of events: the roster first; with `since` (the last change they have), the changes after it,
        or 'reload' when the log no longer reaches back that far"""
        q = queue.Queue()
        with self.lock:
            p = self.people.setdefault(client, {'user': user, 'n': 0}); p['user'] = user; p['n'] += 1
            self.publish('people', {'people': self.roster(), 'seq': self.seq})   # (the others: someone came)
            self.subs.add(q); q.put(('people', {'people': self.roster(), 'seq': self.seq}))
            if since is not None and since < self.seq:
                if self.log and self.log[0]['seq'] <= since + 1:
                    for m in self.log:
                        if m['seq'] > since: q.put(('op', m))
                else: q.put(('reload', {'seq': self.seq}))
        return q

    def ops(self, client, items):
        """several changes in order, as a page sends what its machine did since its last post; the last seq"""
        seq = self.seq
        for it in items: seq = self.op(client, it.get('kind'), it.get('op') or {})
        return seq

    def leave(self, client, q):
        with self.lock:
            self.subs.discard(q); p = self.people.get(client)
            if p:
                p['n'] -= 1
                if p['n'] <= 0: del self.people[client]
            if not self.people: self.world = {}   # (no machine runs the session now: its programs and windows are gone)
            self.publish('people', {'people': self.roster(), 'seq': self.seq})

    def pointer(self, client, x, y):
        with self.lock:
            p = self.people.get(client)
            if not p: return False
            p['x'], p['y'] = int(x), int(y)
            self.publish('people', {'people': self.roster(), 'seq': self.seq})
            return True

    # ---- the folder it is kept in
    def changed(self):
        if not self.folder: return
        self.dirty = True
        if not self.saver:
            self.saver = threading.Timer(1.0, self.save); self.saver.daemon = True; self.saver.start()

    def save(self):
        with self.lock:
            self.saver = None
            if not self.dirty: return
            self.dirty = False
            os.makedirs(os.path.join(self.folder, 'data'), exist_ok=True)
            for s, b in self.data.items():
                with open(os.path.join(self.folder, 'data', str(s)), 'wb') as f: f.write(b)
            for name in os.listdir(os.path.join(self.folder, 'data')):
                if not name.isdigit() or int(name) not in self.data: os.remove(os.path.join(self.folder, 'data', name))
            st = {'seq': self.seq, 'next_block': self.next_block, 'owner': self.owner, 'world': self.world, 'nodes': list(self.nodes.values()), 'label': self.label, 'serial': self.serial,
                  'regkeys': self.regkeys, 'regvals': [[p, n, v] for (p, n), v in self.regvals.items()]}
            tmp = os.path.join(self.folder, 'state.json.tmp')
            with open(tmp, 'w') as f: json.dump(st, f)
            os.replace(tmp, os.path.join(self.folder, 'state.json'))

    def load(self):
        p = os.path.join(self.folder, 'state.json')
        if not os.path.exists(p): return
        st = json.load(open(p))
        self.seq, self.next_block, self.label, self.serial = st['seq'], st['next_block'], st['label'], st['serial']
        self.owner = st.get('owner')
        # (the programs and windows a session had when its server stopped are not running on anyone's machine now)
        self.world = {}
        self.nodes = {n['sid']: n for n in st['nodes']}
        for s, n in self.nodes.items():
            if not n.get('dir'):
                f = os.path.join(self.folder, 'data', str(s))
                self.data[s] = bytearray(open(f, 'rb').read()) if os.path.exists(f) else bytearray()
        self.regkeys = st['regkeys']; self.regvals = {(p, n): v for p, n, v in st['regvals']}


class Sessions:
    """the server's sessions, by id; kept in `root` (a folder per session) when given"""
    def __init__(self, root=None):
        self.root, self.all, self.lock = root, {}, threading.Lock()

    def get(self, sid, create=True):
        if not ID.match(sid or ''): raise ValueError('not a session id')
        with self.lock:
            s = self.all.get(sid)
            if s or not create: return s
            if len(self.all) >= MAX_SESSIONS: raise OverflowError('too many sessions')
            s = self.all[sid] = Session(sid, os.path.join(self.root, sid) if self.root else None)
            return s

    def list(self):
        with self.lock: return [{'id': s.id, 'people': len(s.people), 'seq': s.seq} for s in self.all.values()]

    # ---- the HTTP side: a handler's GET and POST for /__session... (True when it answered)
    def handle(self, h, method):
        path = h.path.split('?')[0]; qs = dict(x.split('=', 1) for x in h.path.split('?', 1)[1].split('&') if '=' in x) if '?' in h.path else {}
        unq = lambda s: __import__('urllib.parse').parse.unquote(s or '')
        if path == '/__sessions' and method == 'GET': return send(h, 200, self.list())
        m = re.match(r'^/__session/([^/]+)/(state|events|op|pointer)$', path)
        if not m: return False
        try: s = self.get(unq(m[1]))
        except (ValueError, OverflowError) as e: return send(h, 400 if isinstance(e, ValueError) else 503, {'err': str(e)})
        what = m[2]
        if method == 'GET' and what == 'state':
            if qs.get('client'): return send(h, 200, s.start(unq(qs.get('client')), unq(qs.get('user')) or 'Guest'))
            return send(h, 200, s.state())
        if method == 'GET' and what == 'events':
            since = qs.get('since'); since = int(since) if since and since.isdigit() else None
            return events(h, s, unq(qs.get('client')) or 'anon', unq(qs.get('user')) or 'Guest', since)
        if method == 'POST' and what in ('op', 'pointer'):
            n = int(h.headers.get('Content-Length') or 0)
            try: body = json.loads(h.rfile.read(n) or b'{}')
            except ValueError: return send(h, 400, {'err': 'not JSON'})
            try:
                if what == 'op' and isinstance(body.get('ops'), list): return send(h, 200, {'seq': s.ops(str(body.get('client')), body['ops'])})
                if what == 'op': return send(h, 200, {'seq': s.op(str(body.get('client')), body.get('kind'), body.get('op') or {})})
                return send(h, 200, {'ok': s.pointer(str(body.get('client')), body.get('x', 0), body.get('y', 0))})
            except (ValueError, KeyError, TypeError) as e: return send(h, 400, {'err': str(e)})
        h.send_error(405); return True


def send(h, code, obj):
    b = json.dumps(obj).encode()
    h.send_response(code); h.send_header('Content-Type', 'application/json'); h.send_header('Cache-Control', 'no-store')
    h.send_header('Content-Length', str(len(b))); h.end_headers(); h.wfile.write(b)
    return True


def events(h, s, client, user, since=None):
    """a person's stream of the session's events, held open while they are there (a comment line keeps it alive)"""
    h.send_response(200); h.send_header('Content-Type', 'text/event-stream'); h.send_header('Cache-Control', 'no-store')
    h.send_header('X-Accel-Buffering', 'no'); h.end_headers()
    q = s.join(client, user, since)
    try:
        while True:
            try: ev, data = q.get(timeout=15); h.wfile.write(f'event: {ev}\ndata: {json.dumps(data)}\n\n'.encode())
            except queue.Empty: h.wfile.write(b': alive\n\n')
            h.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, OSError): pass
    finally: s.leave(client, q)
    return True
