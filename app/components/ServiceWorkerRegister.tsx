"use client";

import { useEffect } from "react";

/**
 * Registra el Service Worker (public/sw.js) que da soporte PWA / offline al
 * app-shell. Se monta una vez desde el layout raíz.
 *
 * Solo en PRODUCCIÓN: en desarrollo el SW puede cachear bundles y pelearse con
 * el Hot Reload de Next, así que se omite. El estado offline de los DATOS no
 * depende del SW (lo maneja IndexedDB/Dexie), solo la carga de la app sin red.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch((err) => console.warn("[PWA] No se pudo registrar el Service Worker:", err));
    };

    // Espera a `load` para no competir con el arranque de la app.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}
