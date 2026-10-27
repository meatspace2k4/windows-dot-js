// The server's shared sessions (tools/sessions.py): run in Python by tests/sessions_server.py
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const r = spawnSync('python3', [new URL('./sessions_server.py', import.meta.url).pathname], { encoding: 'utf8', timeout: 60000 });
assert.equal(r.status, 0, r.stderr || r.stdout);
assert.match(r.stdout, /sessions_server: ok/);
console.log('sessions: ok');
