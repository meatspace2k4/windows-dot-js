// The page reads cdrom.iso beside itself, so a checkout under the project folder (a worktree) asks the server for
// .../cdrom.iso there; serve.py answered only /cdrom.iso and every CD read on such a page was a 404.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'serveiso-')), iso = join(dir, 'disc.iso');
writeFileSync(iso, Buffer.from('CD001 test image'));
const port = 20000 + Math.floor(Math.random() * 20000);
const srv = spawn('python3', [new URL('../tools/serve.py', import.meta.url).pathname, String(port), '--iso', iso], { stdio: 'ignore' });
try {
  let body = null;
  for (let i = 0; i < 50 && body === null; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { const r = await fetch(`http://127.0.0.1:${port}/.claude/worktrees/x/cdrom.iso`); body = r.status === 200 ? await r.text() : `status ${r.status}`; } catch (_) { /* not listening yet */ }
  }
  assert.equal(body, 'CD001 test image', 'cdrom.iso under a nested path is the CD image');
  const root = await fetch(`http://127.0.0.1:${port}/cdrom.iso`); assert.equal(await root.text(), 'CD001 test image', 'and at the root');
} finally { srv.kill(); }
console.log('serveiso: ok');
