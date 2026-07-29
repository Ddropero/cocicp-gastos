// Service Worker COCICP — cache del shell estático. NUNCA cachea la API financiera.
const CACHE = 'cocicp-v4';
const SHELL = ['/', '/index.html', '/app.html', '/login.html'];

self.addEventListener('install', e => {
  // Toda promesa dentro de waitUntil; skipWaiting encadenado tras precache
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      // Solo borra cachés PROPIOS antiguos (no ajenos del mismo origen)
      .then(ks => Promise.all(ks.filter(k => k.startsWith('cocicp-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Update controlado: la página puede pedir activar la nueva versión
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // no interceptar POST/PATCH/DELETE
  const url = new URL(req.url);

  // API financiera: SOLO red, sin cache ni fallback (offline => error explícito, sin datos rancios)
  if (url.pathname.startsWith('/api/')) return;

  const accept = req.headers.get('accept') || '';
  // HTML: network-first; cachea SOLO respuestas OK
  if (req.mode === 'navigate' || accept.includes('text/html')) {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then(c => c.put(req, copy)));
        }
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('/index.html')))
    );
    return;
  }

  // Estáticos (CSS/JS/img/fuentes): cache-first y GUARDA la respuesta si es OK
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then(c => c.put(req, copy)));
      }
      return res;
    }).catch(() => cached))
  );
});
