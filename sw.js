// ═══════════════════════════════════════════════════════════════
//  AVANCE DENTAL — Service Worker v2.0
//  Estrategia: Cache-first para assets, Network-first para API
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME = 'avancedental-v2';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap',
];

// ── Install: cachear todos los assets ───────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn('SW: algunos assets no se pudieron cachear:', err);
      });
    })
  );
  self.skipWaiting();
});

// ── Activate: limpiar caches antiguos ───────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: estrategia según tipo de request ──────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // JSONBin API → Network only (datos en tiempo real, no cachear)
  if (url.hostname === 'api.jsonbin.io') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: 'Sin conexión' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Google Fonts → Cache first
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        return res;
      }).catch(() => cached))
    );
    return;
  }

  // App shell y assets locales → Cache first, network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        // Cachear respuestas válidas
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      }).catch(() => {
        // Offline fallback: devolver el index.html cacheado
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// ── Background sync (para cuando vuelve la conexión) ─────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-inventory') {
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'SYNC_NOW' }));
      })
    );
  }
});
