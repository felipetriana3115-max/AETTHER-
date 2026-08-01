/**
 * Modo Sin Internet — base de datos local (Dexie.js / IndexedDB).
 *
 * El POS debe seguir operando aunque se caiga la red: buscar productos, calcular
 * totales y cobrar. Para eso guardamos dos cosas en el navegador:
 *
 *  1. `productos` — un espejo del catálogo de la empresa (id, descripción, precio,
 *     código de barras, stock). Se refresca desde Supabase cuando hay conexión y
 *     alimenta la búsqueda/scanner y el grid de frecuentes estando sin red.
 *  2. `outbox`   — la COLA de ventas cobradas sin conexión (o cobradas online pero
 *     aún sin confirmar). Cada venta se persiste aquí ANTES de tocar la red, así
 *     nunca se pierde una venta aunque el navegador se cierre. La sincronización
 *     las envía a Supabase y las marca como enviadas (ver outbox.ts).
 *
 * Reutilizamos los MISMOS modelos que ya usa el POS (columnas reales de
 * `public.productos` y el payload de items de `registrar_venta`), sin duplicar
 * tipos ni introducir dependencias extra: solo Dexie sobre IndexedDB.
 *
 * NOTA: Dexie solo existe en el navegador. Este módulo se importa únicamente
 * desde componentes cliente ("use client"); no debe evaluarse en el servidor.
 */

import Dexie, { type Table } from "dexie";

/**
 * Producto cacheado localmente. Espejo de las columnas reales de
 * `public.productos` con los alias que usa el POS (`nombre`/`precio`).
 *
 * `id` es la clave primaria: en el catálogo real es un UUID (string), por eso lo
 * tipamos amplio. Los "artículos comunes" (ids negativos temporales del POS) NO
 * se cachean: no pertenecen al inventario.
 */
export type ProductoLocal = {
  id: string | number;
  nombre: string;
  precio: number;
  codigo_barras: string | null;
  stock_actual: number;
};

/** Estado de una venta en la cola de salida. */
export type EstadoOutbox = "pendiente" | "enviada" | "error";

/**
 * Línea de venta tal como la espera la RPC `registrar_venta`/`registrar_venta_offline`.
 * Es el MISMO shape que el POS ya envía hoy, así la sincronización no transforma
 * nada: reenvía el payload guardado.
 */
export type ItemVenta = {
  id: string | number;
  nombre: string;
  qty: number;
  precio: number;
  esComun: boolean;
};

/**
 * Venta encolada. `clientUuid` es la CLAVE DE IDEMPOTENCIA: se genera una sola vez
 * en el cliente y viaja al servidor para que reintentos/duplicados de red no creen
 * dos ventas (ver registrar_venta_offline en la migración 2026-08-ventas-offline).
 */
export type VentaOutbox = {
  /** Autoincremental local de Dexie (orden de la cola). */
  localId?: number;
  /** UUID generado en el cliente; único e inmutable por venta. */
  clientUuid: string;
  /**
   * Método de pago. Además de los de caja ('Efectivo'/'Nequi/Daviplata'/'Bold'),
   * puede ser 'Fiado': venta a crédito que se carga al saldo de un cliente y NO
   * entra al corte de caja como efectivo (ver registrar_venta_fiado).
   */
  metodo: string;
  total: number;
  items: ItemVenta[];
  /**
   * Cliente al que se carga el fiado. Solo aplica cuando `metodo === 'Fiado'`;
   * en las ventas de caja es null. `clienteNombre` se guarda para la tirilla sin
   * tener que reconsultar el CRM al reimprimir.
   */
  clienteId?: string | null;
  clienteNombre?: string | null;
  /** ISO del momento del cobro (hora local del dispositivo). */
  createdAt: string;
  estado: EstadoOutbox;
  /** Nº de intentos de envío fallidos (para diagnóstico/backoff simple). */
  intentos: number;
  /** Último error de sincronización, si lo hubo. */
  ultimoError?: string | null;
  /** id de la venta en Supabase una vez confirmada (para trazabilidad). */
  ventaId?: string | null;
};

/**
 * Base de datos local del POS. Un único esquema, versionado por Dexie.
 *
 * Índices:
 *  - productos: `codigo_barras` para el lookup del scanner sin conexión.
 *  - outbox: `estado` para drenar solo las pendientes; `clientUuid` único como
 *    red de seguridad contra doble-encolado del mismo cobro.
 */
class PosOfflineDB extends Dexie {
  productos!: Table<ProductoLocal, string | number>;
  outbox!: Table<VentaOutbox, number>;

  constructor() {
    super("aether-pos-offline");
    this.version(1).stores({
      productos: "id, codigo_barras",
      outbox: "++localId, &clientUuid, estado, createdAt",
    });
  }
}

/**
 * Instancia perezosa: solo se abre en el navegador. En SSR/build IndexedDB no
 * existe, así que devolvemos null y quien llame decide el fallback.
 */
let _db: PosOfflineDB | null = null;

export function getDB(): PosOfflineDB | null {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return null;
  if (!_db) _db = new PosOfflineDB();
  return _db;
}
