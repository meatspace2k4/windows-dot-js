// Keeps the installed app running with no server: every file is cached on install.
const CACHE = 'win95-v5';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon192.png', 'icons/icon512.png',
  'assets.js', 'assets-shell.js', 'cdrom.js', 'floppy.js', 'fs.js', 'savers.js', 'saver-runtime.js', 'win32.js', 'gl.js', 'shell32.js', 'system.js', 'claude-exe.js', 'claude-app.js', 'ne16.js', 'vmm.js', 'sound.js', 'lan.js', 'parallel.js', 'lanhost.js', 'netfs.js', 'dyn.js', 'ccd.js', 'session-file.js', 'session-dll.js', 'host-web.js', 'win95.js', 'bridge.js', 'worker.js'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys()
  .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
// network first so edits show while the dev server runs (revalidated, never a stale HTTP-cache copy); the cache when
// it doesn't
self.addEventListener('fetch', e => e.respondWith(fetch(e.request, { cache: 'no-cache' })
  .then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
  .catch(() => caches.match(e.request, { ignoreSearch: true }))));
