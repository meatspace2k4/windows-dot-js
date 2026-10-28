// Keeps the installed app running with no server: every file the page loads is kept as it is loaded, and served from the
// cache from then on (each deploy's files are new ?v= URLs and a new cache).
const CACHE = 'win95-v5';

self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(caches.keys()
  .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
// The page revalidates (and is the cache's when the server is gone); every other file is the cache's first. Ranges (the
// CD image) and the server's /__ endpoints go to the network untouched.
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || r.headers.has('range') || u.origin !== location.origin || u.pathname.startsWith('/__')) return;
  const keep = res => { if (res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); } return res; };
  e.respondWith(r.mode === 'navigate' || /\/(index\.html)?$/.test(u.pathname)
    ? fetch(r, { cache: 'no-cache' }).then(keep).catch(() => caches.match(r, { ignoreSearch: true }))
    : caches.match(r).then(hit => hit || fetch(r).then(keep)));
});
