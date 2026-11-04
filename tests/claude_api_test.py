"""tools/claude_api.py /__claude on an HTTP/1.1 server (the deployed win95_server.py's protocol): the reply's stream
ends after its last line, so a client reading to the end of it is not left waiting on a kept-open connection."""
import http.client, http.server, json, os, sys, threading, types
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

# the anthropic SDK as far as claude() uses it: a stream of one text delta, then the whole message
class _Msg:
    stop_reason, model = 'end_turn', 'claude-opus-5-5'
    usage = types.SimpleNamespace(input_tokens=3, output_tokens=1)
    content = [types.SimpleNamespace(model_dump=lambda **k: {'type': 'text', 'text': 'Hello'})]
class _Stream:
    def __enter__(s): return s
    def __exit__(s, *a): return False
    def __iter__(s): yield types.SimpleNamespace(type='content_block_delta', delta=types.SimpleNamespace(type='text_delta', text='Hello'))
    def get_final_message(s): return _Msg()
fake = types.ModuleType('anthropic')
fake.Anthropic = lambda **k: types.SimpleNamespace(beta=types.SimpleNamespace(messages=types.SimpleNamespace(stream=lambda **k: _Stream())))
for n in ('AuthenticationError', 'RateLimitError', 'APIConnectionError'): setattr(fake, n, type(n, (Exception,), {}))
fake.APIStatusError = type('APIStatusError', (Exception,), {'status_code': 0, 'message': ''})
sys.modules['anthropic'] = fake
os.environ['ANTHROPIC_API_KEY'] = 'test'
import claude_api

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def do_POST(self):
        q = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        claude_api.claude(self, q)

srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
for body in ({'messages': [{'role': 'user', 'content': 'hi'}]}, {'info': True}):
    c = http.client.HTTPConnection('127.0.0.1', srv.server_address[1], timeout=3)
    c.request('POST', '/__claude', json.dumps(body), {'Content-Type': 'application/json'})
    r = c.getresponse()
    lines = [json.loads(l) for l in r.read().decode().splitlines() if l]   # (a timeout here: the stream never ended)
    assert lines[-1]['t'] in ('done', 'info'), lines
srv.shutdown()
print('claude_api: ok')
