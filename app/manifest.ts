import type { MetadataRoute } from "next";

/**
 * Web App Manifest (soporte nativo del App Router de Next 16).
 *
 * Convierte Aether ERP en una PWA instalable: al añadirla a la pantalla de
 * inicio se abre en modo `standalone` (sin barra del navegador), ideal para el
 * cajero en tablet/móvil. El arranque apunta directo al Punto de Venta, que es
 * la pantalla pensada para operar SIN conexión (catálogo + cola de ventas en
 * IndexedDB; ver app/lib/offline).
 *
 * Los íconos 192/512 + maskable se generan a partir de public/logo-aether.png.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Aether ERP — Punto de Venta",
    short_name: "Aether POS",
    description:
      "ERP con Punto de Venta que funciona sin conexión: cobra, busca productos y sincroniza al volver la red.",
    start_url: "/dashboard/pos",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#09090b",
    theme_color: "#7c3aed",
    lang: "es-CO",
    categories: ["business", "productivity", "shopping"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
