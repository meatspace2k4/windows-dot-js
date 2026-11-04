"""/__src: the project's own files, the checkout tools/serve.py serves, for CLAUDE.EXE's Claude (ccd.js: the file tools'
SRC:\\ paths), so the system's own code is changed from inside it. This machine's own pages only (claude_api.local_request).

    {op: 'read', path}            -> {text, mtime}
    {op: 'stat', path}            -> {exists, isDir, size, mtime}
    {op: 'write', path, text}     -> {ok: true}   (its folders made)
    {op: 'list', path}            -> {files: [{path, size, mtime}]}   (under path, newest first)

Paths are relative to the checkout, with / or \\. Refused: a path outside it; .git and the folders the project keeps no
code in; a symbolic link anywhere on the path (the generated bundles a worktree links to are another checkout's, and a
write through a link lands in what it points at); a file over 4 MB is not read."""
import json, os

SKIP = {'.git', 'node_modules', '.sessions', '__pycache__', '.staging'}
MAX = 4 << 20

def resolve(root, rel):
    root = os.path.realpath(root)
    parts = [x for x in str(rel or '').replace('\\', '/').split('/') if x and x != '.']
    if '..' in parts: raise PermissionError('outside the project')
    if parts and parts[0] in SKIP: raise PermissionError(f'{parts[0]} is not the project\'s code')
    full = root
    for x in parts:
        full = os.path.join(full, x)
        if os.path.islink(full): raise PermissionError(f'{"/".join(parts)} goes through a symbolic link (a generated file): not the project\'s own')
    return full

def op(root, q):
    o, path = q.get('op'), q.get('path', '')
    full = resolve(root, path)
    if o == 'stat':
        if not os.path.exists(full): return {'exists': False}
        s = os.stat(full); return {'exists': True, 'isDir': os.path.isdir(full), 'size': s.st_size, 'mtime': int(s.st_mtime * 1000)}
    if o == 'read':
        if not os.path.isfile(full): raise FileNotFoundError('File does not exist.')
        if os.path.getsize(full) > MAX: raise ValueError(f'{path} is over 4 MB')
        with open(full, 'rb') as f: b = f.read()
        if b'\0' in b[:8192]: raise ValueError(f'{path} is not a text file')
        return {'text': b.decode('utf-8', 'replace'), 'mtime': int(os.path.getmtime(full) * 1000)}
    if o == 'write':
        if not isinstance(q.get('text'), str): raise ValueError('text: the file\'s contents')
        if os.path.isdir(full): raise IsADirectoryError(f'{path} is a folder')
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, 'w', encoding='utf-8', newline='') as f: f.write(q['text'])
        return {'ok': True}
    if o == 'list':
        if not os.path.isdir(full): raise NotADirectoryError(f'{path or "."} is not a folder')
        rootr = os.path.realpath(root); out = []
        for d, dirs, files in os.walk(full):
            dirs[:] = [x for x in dirs if x not in SKIP and not os.path.islink(os.path.join(d, x))]
            for n in files:
                p = os.path.join(d, n)
                if os.path.islink(p): continue
                s = os.stat(p); out.append({'path': os.path.relpath(p, rootr).replace(os.sep, '/'), 'size': s.st_size, 'mtime': int(s.st_mtime * 1000)})
                if len(out) >= 20000: break
        out.sort(key=lambda e: -e['mtime'])
        return {'files': out}
    raise ValueError(f'unknown op {o}')

def handle(h, root):
    try: q = json.loads(h.rfile.read(int(h.headers.get('Content-Length', 0))) or b'{}')
    except ValueError: h.send_error(400); return
    try: r = op(root, q)
    except (OSError, ValueError) as e: r = {'error': str(e.args[-1] if e.args else e)}
    b = json.dumps(r).encode()
    h.send_response(200); h.send_header('Content-Type', 'application/json'); h.send_header('Content-Length', str(len(b))); h.end_headers(); h.wfile.write(b)
