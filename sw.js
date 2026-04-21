/* ═══════════════════════════════════════════════════
   sw.js · Nuestro Hogar Común v2.0
   Estrategia:
   - Shell (HTML/CSS/JS propios) → Cache First
   - CDN externos (Supabase, Mapbox, Tailwind) → Network First con fallback
   - Imágenes → Cache First con expiración
   - API de Supabase → Network Only (datos en tiempo real)
═══════════════════════════════════════════════════ */

const CACHE_VERSION = 'hogar-comun-v2';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const IMG_CACHE     = `${CACHE_VERSION}-images`;

/* Archivos del shell que se pre-cachean al instalar */
const SHELL_ASSETS = [
  './index.html',
  './manifest.json',
];

/* CDN externos que se cachean la primera vez que se usan */
const CDN_PATTERNS = [
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net/npm/@supabase',
  'api.mapbox.com/mapbox-gl-js',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'api.dicebear.com',
];

/* Rutas de la API de Supabase — NUNCA cachear */
const NEVER_CACHE = [
  'supabase.co/rest',
  'supabase.co/auth',
  'supabase.co/storage',
  'supabase.co/realtime',
];

/* ── INSTALL ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())   // Activa inmediatamente sin esperar
  );
});

/* ── ACTIVATE ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('hogar-comun-') && k !== SHELL_CACHE && k !== IMG_CACHE)
          .map(k => caches.delete(k))   // Limpia cachés de versiones anteriores
      )
    ).then(() => self.clients.claim()) // Toma control de todas las pestañas abiertas
  );
});

/* ── FETCH ── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  /* Ignorar peticiones que no son GET */
  if (request.method !== 'GET') return;

  /* Ignorar Chrome extensions y devtools */
  if (!url.startsWith('http')) return;

  /* NUNCA cachear la API de Supabase */
  if (NEVER_CACHE.some(p => url.includes(p))) {
    event.respondWith(fetch(request));
    return;
  }

  /* Imágenes de avatares → Cache First con red como respaldo */
  if (url.includes('api.dicebear.com') || isImage(url)) {
    event.respondWith(cacheFirstWithNetwork(request, IMG_CACHE));
    return;
  }

  /* CDN externos → Network First, caché como respaldo offline */
  if (CDN_PATTERNS.some(p => url.includes(p))) {
    event.respondWith(networkFirstWithCache(request, SHELL_CACHE));
    return;
  }

  /* Shell propio (index.html, manifest.json, etc.) → Cache First */
  if (url.includes(self.location.origin) || url.startsWith('./')) {
    event.respondWith(cacheFirstWithNetwork(request, SHELL_CACHE));
    return;
  }

  /* Todo lo demás → red, sin cachear */
  event.respondWith(fetch(request).catch(() => offlineFallback(request)));
});

/* ── ESTRATEGIAS ── */

/**
 * Cache First: responde desde caché, actualiza en background.
 * Ideal para assets estáticos.
 */
async function cacheFirstWithNetwork(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    // Actualizar en background (stale-while-revalidate)
    fetch(request)
      .then(res => { if (res && res.ok) cache.put(request, res.clone()); })
      .catch(() => {});
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback(request);
  }
}

/**
 * Network First: intenta red, si falla usa caché.
 * Ideal para CDNs donde queremos la versión más fresca.
 */
async function networkFirstWithCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || offlineFallback(request);
  }
}

/**
 * Respuesta offline genérica según tipo de recurso.
 */
async function offlineFallback(request) {
  const url = request.url;

  /* Si piden el HTML principal, servir desde caché */
  if (request.destination === 'document' || url.endsWith('.html') || url.endsWith('/')) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match('./index.html');
    if (cached) return cached;
  }

  /* Imagen de placeholder SVG cuando no hay red */
  if (isImage(url)) {
    return new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect fill="#f1f5f9" width="100" height="100" rx="12"/>
        <text x="50" y="58" font-size="32" text-anchor="middle" fill="#94a3b8">📵</text>
      </svg>`,
      { headers: { 'Content-Type': 'image/svg+xml' } }
    );
  }

  /* Respuesta JSON vacía para peticiones de datos */
  if (request.destination === 'fetch' || url.includes('.json')) {
    return new Response('{"offline":true,"data":[]}', {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /* Último recurso */
  return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
}

/* ── BACKGROUND SYNC (posts pendientes) ── */
self.addEventListener('sync', event => {
  if (event.tag === 'sync-posts') {
    event.waitUntil(syncPendingPosts());
  }
});

async function syncPendingPosts() {
  /* La app guarda en IndexedDB con la clave 'pendingPosts'.
     El SW notifica a todos los clientes para que ejecuten
     su propia lógica de sync (que tiene acceso a Supabase). */
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => {
    client.postMessage({ type: 'SYNC_POSTS' });
  });
}

/* ── PUSH NOTIFICATIONS (estructura base) ── */
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try { payload = event.data.json(); }
  catch { payload = { title: 'Nuestro Hogar Común', body: event.data.text() }; }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Nuestro Hogar Común', {
      body:    payload.body    || 'Nueva actividad en tu comunidad',
      icon:    payload.icon   || './manifest.json',
      badge:   payload.badge  || './manifest.json',
      tag:     payload.tag    || 'hogar-comun',
      data:    payload.data   || {},
      actions: [
        { action: 'open',    title: 'Ver' },
        { action: 'dismiss', title: 'Cerrar' },
      ],
      vibrate: [100, 50, 100],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      /* Si la app ya está abierta, la enfoca */
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      /* Si no está abierta, la abre */
      if (self.clients.openWindow) {
        return self.clients.openWindow('./index.html');
      }
    })
  );
});

/* ── MENSAJES DESDE LA APP ── */
self.addEventListener('message', event => {
  const { type } = event.data || {};

  /* La app pide limpiar el caché (tras actualización) */
  if (type === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
    event.ports[0]?.postMessage({ ok: true });
  }

  /* La app pide forzar actualización del SW */
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ── UTILIDADES ── */
function isImage(url) {
  return /\.(jpe?g|png|gif|webp|svg|avif)(\?.*)?$/i.test(url) ||
         url.includes('dicebear.com') ||
         url.includes('storage.googleapis.com');
}
