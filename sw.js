// ═══════════════════════════════════════════════════════════════
//  AVANCE DENTAL — Service Worker v3.3
//  Estrategia: Cache-first para assets, Network-only para APIs
//  Background Sync + Auto-update support
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME = 'avancedental-v3.5';
const ASSETS_TO_CACHE = [
  './',
  // index.html NO se cachea: el SW lo sirviría en lugar de la versión nueva
  // cuando checkForUpdate intenta detectar actualizaciones. 
  // La navegación offline usa el fallback de la hoja vacía del catch.
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  // manifest.json tampoco — raramente cambia pero si cambia debe actualizarse
];

// ── Install: cachear assets locales (fuentes NO — fallan por CORS en install) ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // addAll falla si UN asset no existe — usamos add individual con catch
      return Promise.allSettled(
        ASSETS_TO_CACHE.map(url =>
          cache.add(url).catch(err =>
            console.warn('SW: no se pudo cachear', url, err.message)
          )
        )
      );
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

  // ── 1. Google Apps Script (Sheets API) → Network only, NUNCA cachear ──
  // Tampoco interceptar si falla — dejar pasar el error al cliente
  if (url.hostname === 'script.google.com') {
    // No llamar event.respondWith() → el navegador gestiona la petición solo
    return;
  }

  // ── 2. JSONBin (legacy) → Network only ──────────────────────
  if (url.hostname === 'api.jsonbin.io') {
    return; // igual, no interceptar
  }

  // ── 3. Google Fonts → Cache first con fallback silencioso ───
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          // Solo cachear si la respuesta es válida
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        }).catch(() => {
          // Sin red y sin caché de fuentes → devolver respuesta vacía válida
          // (la app funciona con fuentes del sistema como fallback)
          return new Response('', { status: 200, headers: { 'Content-Type': 'text/css' } });
        });
      })
    );
    return;
  }

  // ── 4. Solo interceptar peticiones GET de assets locales ────
  // Peticiones POST, peticiones a otros dominios → dejar pasar sin interceptar
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // ── 5. App shell y assets locales → Cache first, network fallback ──
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(res => {
        // Solo cachear respuestas válidas del mismo origen
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      }).catch(() => {
        // Sin red y sin caché:
        // — Si es navegación → devolver index.html cacheado (offline shell)
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html').then(fallback => {
            // NUNCA devolver null — si index.html no está en caché,
            // devolver una página mínima de "sin conexión"
            return fallback || new Response(
              '<html><body style="font-family:sans-serif;text-align:center;padding:40px">' +
              '<h2>Sin conexión</h2><p>Vuelve a abrir la app cuando tengas red.</p>' +
              '</body></html>',
              { status: 200, headers: { 'Content-Type': 'text/html' } }
            );
          });
        }
        // Para otros assets (imágenes, etc.) → respuesta vacía válida, nunca null
        return new Response('', { status: 408, statusText: 'Sin conexión' });
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

// ── Forzar actualización cuando el SW se instala ──────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CHECK_UPDATE') {
    // Notificar al cliente que hay una nueva versión disponible
    self.clients.matchAll().then(clients => {
      clients.forEach(client => client.postMessage({ type: 'UPDATE_AVAILABLE' }));
    });
  }
});

// ── Notificar al cliente cuando el SW toma control ────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim()).then(() => {
      // Notificar a todos los clientes que el SW está activo
      self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'SW_ACTIVATED' }));
      });
    })
  );
});
