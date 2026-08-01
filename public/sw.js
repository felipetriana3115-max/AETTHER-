/*
 * Aether ERP — Service Worker (PWA, modo sin conexión).
 *
 * Objetivo LIGERO: que el "app shell" (HTML de navegación + assets estáticos de
 * Next) cargue sin red, para que el POS abra offline. Los DATOS no se cachean
 * aquí: el catálogo y la cola de ventas viven en IndexedDB (Dexie), y las
 * llamadas a Supabase son de otro origen, así que este SW ni las intercepta.
 *
 * Estrategias:
 *  - Navegaciones (documentos HTML): network-first con fallback a caché, y como
 *    último recurso la última página del POS cacheada. Evita quedarse con HTML
 *    viejo cuando SÍ hay red.
 *  - Assets estáticos (/_next/static, íconos, etc.): stale-while-revalidate:
 *    respuesta instantánea desde caché y refresco en segundo plano.
 */

const VERSION = "aether-pos-v1";
const APP_SHELL = `${VERSION}-shell`;
const STATIC = `${VERSION}-static`;
const OFFLINE_URL = "/dashboard/pos";

// Precacheamos lo mínimo para poder pintar algo sin red.
const PRECACHE = [OFFLINE_URL, "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_SHELL);
      // `reload` evita cachear una versión ya obsoleta del navegador.
      await Promise.allSettled(
        PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" }))),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Limpia versiones anteriores del SW.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Solo GET del MISMO origen. Peticiones a Supabase (otro origen) y POST/PUT
  // pasan directo a la red: el modo offline de datos lo maneja IndexedDB.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navegaciones: network-first con red de seguridad.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(APP_SHELL);
          cache.put(request, fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(APP_SHELL);
          const cached = (await cache.match(request)) || (await cache.match(OFFLINE_URL));
          return (
            cached ||
            new Response("Sin conexión y sin copia en caché.", {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            })
          );
        }
      })(),
    );
    return;
  }

  // Assets estáticos: stale-while-revalidate.
  if (url.pathname.startsWith("/_next/static") || /\.(?:js|css|png|jpg|jpeg|svg|webp|ico|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC);
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res && res.status === 200) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || (await network) || new Response("", { status: 504 });
      })(),
    );
  }
});
