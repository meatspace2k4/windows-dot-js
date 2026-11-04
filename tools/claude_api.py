"""The Claude window server side (ccd.js): /__claude and /__fetch, shared by serve.py and the deployed win95_server.py."""
import json, os, re

# /__claude: the Win95 Claude window's prompts to the Claude API (ccd.js), streamed back as one JSON object per line. The
# API key stays here: ANTHROPIC_API_KEY, or the first line of ~/.config/win95/anthropic-api-key, read at each request; a
# key not scoped to a workspace names one in ANTHROPIC_WORKSPACE_ID or ~/.config/win95/anthropic-workspace-id.
# Answered only for a page of this machine (a loopback client, a localhost Host, an Origin of that host when one is sent)
# asking with JSON, which a page of any other site can't send here without a CORS preflight this server never answers
KEY_FILE = os.path.expanduser('~/.config/win95/anthropic-api-key')
WORKSPACE_FILE = os.path.expanduser('~/.config/win95/anthropic-workspace-id')
MODELS = {'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'}
EFFORTS = {'low', 'medium', 'high', 'xhigh', 'max'}
SYSTEM = ('You are Claude, talking with the user through the Claude desktop app recreated inside Windows 95. '
          'Answer in plain text: the window shows no Markdown.')
TOOLS_NOTE = (' You have the Claude desktop app\'s own tools (the ccd_* tools), acting on this Windows 95 system: its sessions, '
              'their task lists and next-step box, the sidebar, panes, windows, settings and folders. Use them when the user asks '
              'for something they do; a tool the app would ask the user about shows a message box, and its result says what they chose. '
              'Read, Write, Edit, Glob and Grep are Claude Code\'s file tools, on the C: drive and on SRC:\\, the project\'s own code '
              '(this Windows 95\'s scripts, where the page\'s server serves the checkout); Bash runs MS-DOS commands; JavaScript runs '
              'in the page, with the scripting API (win95.*) and win95.reloadScript to load changed code without a restart.')
def setting(env, path):
    if os.environ.get(env): return os.environ[env]
    try:
        with open(path) as f: return f.readline().strip() or None
    except OSError: return None
api_key = lambda: setting('ANTHROPIC_API_KEY', KEY_FILE)
workspace_id = lambda: setting('ANTHROPIC_WORKSPACE_ID', WORKSPACE_FILE)
def local_request(h):
    host = (h.headers.get('Host') or '').rsplit(':', 1)[0].strip('[]').lower()
    origin = h.headers.get('Origin')
    return (h.client_address[0] in ('127.0.0.1', '::1') and (host in ('localhost', '127.0.0.1', '::1') or host.endswith('.localhost'))
            and (origin is None or re.sub(r'^https?://', '', origin).rsplit(':', 1)[0].strip('[]').lower() == host)
            and (h.headers.get('Content-Type') or '').startswith('application/json'))
def site_request(h):
    """the site's own page on any host (the public one too): JSON, from an Origin of the Host asked, as no other site's page can send"""
    host = (h.headers.get('Host') or '').rsplit(':', 1)[0].strip('[]').lower()
    origin = h.headers.get('Origin')
    return ((origin is None or re.sub(r'^https?://', '', origin).rsplit(':', 1)[0].strip('[]').lower() == host)
            and (h.headers.get('Content-Type') or '').startswith('application/json'))
TOOL_NAME = re.compile(r'^[a-zA-Z0-9_-]{1,64}$')
def tools_of(q):
    """the page's tools (the Claude app's own, ccd.js), checked: a name, a description and an object schema each"""
    out = []
    for t in (q.get('tools') or [])[:128]:
        if isinstance(t, dict) and TOOL_NAME.match(str(t.get('name', ''))) and isinstance(t.get('input_schema'), dict) and t['input_schema'].get('type') == 'object':
            out.append({'name': t['name'], 'description': str(t.get('description', ''))[:2000], 'input_schema': t['input_schema']})
    return out
def content_of(c):
    """a message's content: text, or its blocks as the API gave them (thinking and tool use passed back unchanged)"""
    return c if isinstance(c, list) and all(isinstance(b, dict) and b.get('type') for b in c) else str(c)
def claude(h, q):
    import anthropic   # (only this endpoint needs it)
    line = lambda o: (h.wfile.write((json.dumps(o) + '\n').encode()), h.wfile.flush())
    msgs = [{'role': m['role'], 'content': content_of(m['content'])} for m in q.get('messages', []) if m.get('role') in ('user', 'assistant') and m.get('content')]
    tools = tools_of(q)
    model = q.get('model') if q.get('model') in MODELS else 'claude-opus-5-5'
    effort = q.get('effort') if q.get('effort') in EFFORTS else 'medium'
    # (no length and no chunking: the stream ends with the connection, which an HTTP/1.1 server would otherwise keep open)
    h.send_response(200); h.send_header('Content-Type', 'application/x-ndjson'); h.send_header('Cache-Control', 'no-store'); h.send_header('Connection', 'close'); h.end_headers()
    h.close_connection = True
    key = api_key()
    if q.get('info'): line({'t': 'info', 'key': bool(key), 'workspace': bool(workspace_id())}); return   # (the account menu: whether there is a key and a workspace, never either)
    if not key: line({'t': 'error', 'e': f'No API key: set ANTHROPIC_API_KEY or put the key in {KEY_FILE}'}); return
    try:
        ws = workspace_id()
        client = anthropic.Anthropic(api_key=key, default_headers={'anthropic-workspace-id': ws} if ws else None)
        # a refusal is answered by another model the server picks (server-side fallback), not ended
        extra = {'tools': tools} if tools else {}
        with client.beta.messages.stream(model=model, max_tokens=64000, system=SYSTEM + (TOOLS_NOTE if tools else ''), messages=msgs,
                                         thinking={'type': 'adaptive', 'display': 'summarized'}, output_config={'effort': effort},
                                         betas=['server-side-fallback-2026-07-01'], extra_body={'fallbacks': 'default'}, **extra) as stream:
            for ev in stream:
                if ev.type == 'content_block_delta' and ev.delta.type == 'text_delta': line({'t': 'text', 'd': ev.delta.text})
                elif ev.type == 'content_block_delta' and ev.delta.type == 'thinking_delta': line({'t': 'thinking', 'd': ev.delta.thinking})
            m = stream.get_final_message()
        # the whole message, for the next request of a tool loop (its blocks go back as they came)
        line({'t': 'done', 'stop': m.stop_reason, 'model': m.model, 'in': m.usage.input_tokens, 'out': m.usage.output_tokens,
              'content': [b.model_dump(exclude_none=True) for b in m.content]})
    except anthropic.AuthenticationError: line({'t': 'error', 'e': 'The API key was refused (401)'})
    except anthropic.RateLimitError: line({'t': 'error', 'e': 'Rate limited (429): try again shortly'})
    except anthropic.APIStatusError as e: line({'t': 'error', 'e': f'API error {e.status_code}: {e.message}'})
    except anthropic.APIConnectionError: line({'t': 'error', 'e': 'Could not reach the Claude API'})
    except (BrokenPipeError, ConnectionResetError): pass   # (the page went away)

def page_text(html_s, base):
    """a web page as the Claude program's Browser pane shows it: its title, its text in lines, its links numbered"""
    import html.parser, urllib.parse
    class P(html.parser.HTMLParser):
        def __init__(s): super().__init__(convert_charrefs=True); s.out, s.title, s.links, s.skip, s.intitle, s.href, s.pre = [], '', [], 0, False, None, 0
        def handle_starttag(s, t, a):
            if t == 'pre': s.pre += 1
            if t in ('script', 'style', 'noscript', 'svg', 'template'): s.skip += 1
            elif t == 'title': s.intitle = True
            elif t == 'a': s.href = dict(a).get('href')
            if t in ('p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer', 'pre', 'blockquote', 'dl', 'dt', 'dd', 'ul', 'ol', 'table', 'hr'): s.out.append('\n')
            if t == 'li': s.out.append('* ')
        def handle_endtag(s, t):
            if t == 'pre' and s.pre: s.pre -= 1
            if t in ('script', 'style', 'noscript', 'svg', 'template') and s.skip: s.skip -= 1
            elif t == 'title': s.intitle = False
            elif t == 'a' and s.href:
                if len(s.links) < 300: s.links.append(urllib.parse.urljoin(base, s.href)); s.out.append(f' [{len(s.links)}]')
                s.href = None
            if t in ('p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'dl', 'dt', 'dd', 'ul', 'ol', 'table'): s.out.append('\n')
        def handle_data(s, d):
            if s.skip: return
            if s.intitle: s.title += d; return
            s.out.append(d.replace('\n', '\x00').replace(' ', '\x01') if s.pre else re.sub(r'\s+', ' ', d))   # (a browser's whitespace: runs of it one space, but in <pre>)
    p = P(); p.feed(html_s)
    text = re.sub(r'[ \t\r\f\v]+', ' ', ''.join(p.out)); text = re.sub(r' *\n[ \n]*', '\n\n', text).replace('\x00', '\n').replace('\x01', ' ').strip()
    return {'title': p.title.strip(), 'text': text[:200000], 'links': p.links}
def fetch_page(h, q):
    import urllib.request, urllib.error
    url = str(q.get('url', '')).strip()
    if not re.match(r'^https?://', url, re.I): url = 'https://' + url if url and '://' not in url else url
    if not re.match(r'^https?://[^/\s]+', url, re.I): r = {'error': 'Only http and https addresses.'}
    else:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/4.0 (compatible; Windows 95; Claude)'})
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read(2 << 20); ctype = resp.headers.get('Content-Type', ''); final = resp.geturl()
            cs = (re.search(r'charset=([\w-]+)', ctype) or [None, 'utf-8'])[1]
            s = body.decode(cs, 'replace')
            r = {'url': final, **(page_text(s, final) if 'html' in ctype or s.lstrip()[:1] == '<' else {'title': final, 'text': s[:200000], 'links': []})}
        except urllib.error.HTTPError as e: r = {'error': f'HTTP {e.code} {e.reason}'}
        except Exception as e: r = {'error': str(e)[:200]}
    b = json.dumps(r).encode()
    h.send_response(200); h.send_header('Content-Type', 'application/json'); h.send_header('Cache-Control', 'no-store'); h.send_header('Content-Length', str(len(b))); h.end_headers(); h.wfile.write(b)
