"""Windows 95 sessions shared between people, as a multi-player server keeps a game's world. Nothing is streamed and no
disk is kept here: every person runs Windows in their own browser on their own C: and registry, and what a person does
goes to the others as what they did, which each machine's Windows does too:
- the OS's objects ('obj' ops, by a session-wide id): the programs running, their windows (place, size, shown state)
  and their controls' contents. A machine sets its own OS to each object's state
- intents ('intent' ops, by the setting they make: `key`): a setting a person made, as the call that made it
  (SystemParametersInfo, a settings file's line). Each machine makes the same call, and its own Windows keeps the
  setting (its own registry and INI files) and tells its own programs. The last one for a setting is the setting
A machine that joins, or comes back after missing some, is given the objects and the intents as they are.

As ~/likes's room bus: the server is the one source of truth, a person's page subscribes to the session's events
(server-sent events: a full snapshot of who is there on connecting and whenever that changes, and each change in order)
and posts its own. A session's intents are kept in its folder (state.json), written back a moment after they change,
so a restarted server has them; its objects go with the last machine running it.

Used by tools/serve.py and deploy/win95/win95_server.py:
    GET  /__sessions                       the sessions: [{ id, people, seq }]
    GET  /__session/<id>/state             the state: { seq, world, intents }
    GET  /__session/<id>/events?client=&user=   server-sent events: 'people' { people } and 'op' { seq, client, kind, op }
    POST /__session/<id>/op                { client, kind: 'obj' | 'intent', op }, or { client, ops: [...] }  ->  { seq }
    POST /__session/<id>/pointer           { client, x, y }
"""
import json, os, queue, re, threading, time

MAX_SESSIONS = 64            # (sessions kept in memory at once; more are refused)
LOG_KEEP = 20000             # (the changes kept to replay to someone who reconnects; one further behind loads the state again)


def merge(base, patch):
    """an object's state with a patch made to it, as oslogic.js merge: None closes it; a patch to nothing is the patch"""
    if patch is None: return None
    if not isinstance(base, dict) or not isinstance(patch, dict): return patch
    out = dict(base, **patch)
    if 'ctrls' in base or 'ctrls' in patch: out['ctrls'] = dict(base.get('ctrls') or {}, **(patch.get('ctrls') or {}))
    return out
ID = re.compile(r'^[A-Za-z0-9_.-]{1,64}$')


class Session:
    def __init__(self, sid, folder=None):
        self.id, self.folder, self.lock = sid, folder, threading.RLock()
        self.seq, self.people, self.subs, self.log = 0, {}, set(), []
        self.dirty, self.saver = False, None
        self.epoch = int(time.time() * 1000)   # (the session's wall clock: its start, ms; every machine's clock in the session reads it, shared.js, win32.js progTime)
        self.world = {}                        # (the OS's objects: id -> their state)
        self.gens = {}                         # (each object's generation: one more each time it is closed)
        self.intents = {}                      # (the settings made: key -> the intent that made it last)
        if folder: self.load()

    # ---- the state
    def apply(self, kind, op):
        if kind == 'obj':
            oid = op.get('id')
            if not isinstance(oid, str) or not oid: raise ValueError('an object needs an id')
            # (a patch of what changed, made to the object as it is: its fields, and each control in ctrls; None: closed,
            # kept so a machine starting it at its own start closes it too)
            self.world[oid] = merge(self.world.get(oid), op.get('v'))
        elif kind == 'intent':
            key = op.get('key')
            if not isinstance(key, str) or not key: raise ValueError('an intent needs a key')
            self.intents[key] = op
        else: raise ValueError(f'no kind {kind}')

    def start(self, client, user):
        """the state a machine starts from, and whether others' machines run the session now. With no other machine
        running it, the session's programs and windows are gone: this one's own earlier start (a reloaded page keeps its
        client, and its old stream may not have ended yet) ran them, and its restart ended them"""
        with self.lock:
            others = any(c != client for c in self.people)
            if not others: self.world, self.gens = {}, {}; self.epoch = int(time.time() * 1000)   # (a session nobody runs starts afresh: its clock too)
            return dict(self.state(), running=others)

    def state(self):
        with self.lock: return {'seq': self.seq, 'world': dict(self.world), 'gens': dict(self.gens), 'intents': dict(self.intents), 'epoch': self.epoch, 'now': int(time.time() * 1000)}

    # ---- changes, and who hears of them
    def op(self, client, kind, op):
        """a change, numbered and logged, so a machine that missed some gets them again in order. An object's change
        made in a generation before its last close (a move, or a close, of a window another machine closed meanwhile)
        is passed over: the close wins, and an object opened again after it is a new one. The machine that made it is
        sent the object as it is ('to': it, from 'server') in its place (tests/sessionmodel.test.mjs)"""
        with self.lock:
            if kind == 'obj' and isinstance(op.get('id'), str):
                oid, cur, g = op['id'], self.gens.get(op['id'], 0), op.get('gen') or 0
                if g < cur:
                    self.seq += 1
                    msg = {'seq': self.seq, 'client': 'server', 'to': client, 'kind': 'obj', 'op': {'id': oid, 'v': self.world.get(oid), 'gen': cur}}
                    self.log.append(msg); self.publish('op', msg)
                    return self.seq
                self.gens[oid] = max(cur, g + 1) if op.get('v') is None else cur
                op = dict(op, gen=self.gens[oid])
            self.apply(kind, op); self.seq += 1
            msg = {'seq': self.seq, 'client': client, 'kind': kind, 'op': op}
            self.log.append(msg)
            if len(self.log) > LOG_KEEP: del self.log[:len(self.log) - LOG_KEEP]
            self.publish('op', msg)
            if kind == 'intent': self.changed()
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
            if not self.people: self.world, self.gens = {}, {}   # (no machine runs the session now: its programs and windows are gone)
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
            os.makedirs(self.folder, exist_ok=True)
            tmp = os.path.join(self.folder, 'state.json.tmp')
            with open(tmp, 'w') as f: json.dump({'seq': self.seq, 'intents': self.intents}, f)
            os.replace(tmp, os.path.join(self.folder, 'state.json'))

    def load(self):
        p = os.path.join(self.folder, 'state.json')
        if not os.path.exists(p): return
        st = json.load(open(p))
        self.seq, self.intents = st.get('seq', 0), st.get('intents') or {}
        # (the programs and windows a session had when its server stopped are not running on anyone's machine now)
        self.world = {}


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
