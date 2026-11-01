"use client";

/**
 * Estado de caja del POS que debe SOBREVIVIR a la navegación: el carrito en
 * curso, los carritos puestos en espera y el cliente asociado a la venta.
 *
 * POR QUÉ EXISTE ESTE MÓDULO
 * --------------------------
 * `/dashboard/pos` es una ruta: al irse a Inventario (o a cualquier otra
 * sección) React desmonta la página y el `useState` del carrito se pierde. Para
 * el cajero eso significa rearmar la cuenta desde cero solo por consultar una
 * existencia. Aquí se espeja el estado en `sessionStorage`, así que volver al
 * POS —o incluso recargar la pestaña— restaura la cuenta intacta.
 *
 * POR QUÉ `sessionStorage` Y NO `localStorage`
 * --------------------------------------------
 * Una cuenta a medias es efímera y pertenece a ESTA sesión de caja: no debe
 * reaparecer días después en el mismo equipo ni filtrarse a otra pestaña con
 * otro cajero. `sessionStorage` muere con la pestaña, que es justo el alcance
 * que queremos.
 *
 * AISLAMIENTO MULTI-TENANT
 * ------------------------
 * La clave va SEGMENTADA por `empresa_id` (mismo patrón que el caché del
 * <DashboardProvider>): sin empresa conocida no se lee ni se escribe nada, así
 * que una cuenta nueva jamás hereda el carrito de otro tenant en el mismo
 * navegador. Además el prefijo `mi-dashboard-erp` hace que `clearSession()` la
 * purgue en cada cierre de sesión (ver `purgeDashboardCache` en auth.ts).
 */

import { getTenant } from "./auth";
import type { Cliente } from "./clientes";

// ── Tipos del carrito ────────────────────────────────────────────────────────

/**
 * Producto cobrable en el POS. Los productos reales usan UUID (string); los
 * "artículos comunes" ids negativos temporales (number). Por eso la clave es
 * `string | number`.
 */
export type Producto = {
  id: string | number;
  nombre: string;
  precio: number;
  codigo_barras: string | null;
  stock_actual: number;
  /**
   * Foto opcional del producto (URL pública del bucket `productos` de Storage).
   * null/ausente → la tarjeta pinta el placeholder de iniciales. Los "artículos
   * comunes" nunca la traen.
   */
  imagen_url?: string | null;
};

/**
 * Una línea puede ser un producto real del inventario o un "artículo común": un
 * ítem temporal (nombre + precio a mano) que NO existe en `productos` y por
 * tanto NO descuenta stock al cobrar. Se marca con `esComun`.
 */
export type LineaCarrito = Producto & { qty: number; esComun?: boolean };

/**
 * Carrito aparcado con el botón "En espera". Guarda todo lo necesario para
 * retomar la cuenta tal cual estaba, incluido el cliente que se le había
 * asociado (si se pausó una venta a crédito, al recuperarla sigue siendo suya).
 */
export type CarritoEnEspera = {
  /** Id local del ticket en espera (no viaja a la base de datos). */
  id: string;
  /** Etiqueta visible: la escribe el cajero o se deriva del nº de ticket. */
  etiqueta: string;
  /** Momento en que se aparcó (ISO), para ordenar y mostrar "hace X min". */
  pausadoEn: string;
  lineas: LineaCarrito[];
  cliente: Cliente | null;
};

// ── Persistencia en sessionStorage ───────────────────────────────────────────

/** Base de la clave; se sufija con el `empresa_id` del tenant activo. */
const POS_KEY_BASE = "mi-dashboard-erp:pos:v1";

/** Tope de carritos aparcados a la vez (evita una lista inmanejable en caja). */
export const MAX_EN_ESPERA = 12;

/** Lo que se espeja: la cuenta en curso + las aparcadas + su cliente. */
export type EstadoCaja = {
  carrito: LineaCarrito[];
  enEspera: CarritoEnEspera[];
  cliente: Cliente | null;
};

export const ESTADO_CAJA_VACIO: EstadoCaja = {
  carrito: [],
  enEspera: [],
  cliente: null,
};

/**
 * Clave del tenant activo, o `null` si aún no se conoce la empresa. Con `null`
 * NO se hidrata ni se persiste nada (aislamiento).
 */
function claveCaja(): string | null {
  const empresaId = getTenant()?.empresaId;
  return empresaId ? `${POS_KEY_BASE}:${empresaId}` : null;
}

/**
 * `Number.POSITIVE_INFINITY` (el "stock sin límite" de los artículos comunes) no
 * sobrevive a JSON: `JSON.stringify` lo escribe como `null`. Al releer, toda
 * línea común sin stock finito recupera el infinito; una línea de catálogo sin
 * stock legible cae a 0 (fail-closed: mejor avisar "sin stock" que permitir
 * sobreventa con un dato inventado).
 */
function normalizarLinea(raw: unknown): LineaCarrito | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  const id = l.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const nombre = typeof l.nombre === "string" ? l.nombre : "";
  const qty = Number(l.qty ?? 0);
  const precio = Number(l.precio ?? 0);
  if (!nombre || !Number.isFinite(qty) || qty <= 0) return null;

  const esComun = l.esComun === true;
  const stockLeido = Number(l.stock_actual ?? Number.NaN);
  const stock = Number.isFinite(stockLeido)
    ? stockLeido
    : esComun
      ? Number.POSITIVE_INFINITY
      : 0;

  return {
    id,
    nombre,
    precio: Number.isFinite(precio) ? precio : 0,
    codigo_barras: typeof l.codigo_barras === "string" ? l.codigo_barras : null,
    stock_actual: stock,
    imagen_url: typeof l.imagen_url === "string" ? l.imagen_url : null,
    qty,
    ...(esComun ? { esComun: true } : {}),
  };
}

/** Normaliza un ticket aparcado leído del espejo; `null` si quedó inservible. */
function normalizarEnEspera(raw: unknown): CarritoEnEspera | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const lineas = Array.isArray(t.lineas)
    ? t.lineas.map(normalizarLinea).filter((l): l is LineaCarrito => l !== null)
    : [];
  if (lineas.length === 0) return null; // un ticket vacío no sirve de nada
  return {
    id: typeof t.id === "string" ? t.id : `espera-${Date.now()}`,
    etiqueta: typeof t.etiqueta === "string" && t.etiqueta ? t.etiqueta : "Cuenta en espera",
    pausadoEn: typeof t.pausadoEn === "string" ? t.pausadoEn : new Date().toISOString(),
    lineas,
    cliente: (t.cliente as Cliente | null) ?? null,
  };
}

/**
 * Recupera el estado de caja espejado para la empresa activa. Devuelve el
 * estado vacío si no hay empresa resuelta, si no hay nada guardado o si el JSON
 * está corrupto: nunca lanza (el POS debe abrir pase lo que pase).
 */
export function loadEstadoCaja(): EstadoCaja {
  if (typeof window === "undefined") return ESTADO_CAJA_VACIO;
  const key = claveCaja();
  if (!key) return ESTADO_CAJA_VACIO;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return ESTADO_CAJA_VACIO;
    const saved = JSON.parse(raw) as Partial<EstadoCaja>;
    return {
      carrito: Array.isArray(saved.carrito)
        ? saved.carrito.map(normalizarLinea).filter((l): l is LineaCarrito => l !== null)
        : [],
      enEspera: Array.isArray(saved.enEspera)
        ? saved.enEspera
            .map(normalizarEnEspera)
            .filter((t): t is CarritoEnEspera => t !== null)
            .slice(0, MAX_EN_ESPERA)
        : [],
      cliente: saved.cliente ?? null,
    };
  } catch {
    return ESTADO_CAJA_VACIO;
  }
}

/**
 * Espeja el estado de caja de la empresa activa. Sin empresa resuelta no se
 * escribe nada; un estado completamente vacío BORRA la entrada en vez de dejar
 * un `{}` huérfano en la pestaña.
 */
export function saveEstadoCaja(estado: EstadoCaja): void {
  if (typeof window === "undefined") return;
  const key = claveCaja();
  if (!key) return;
  try {
    const vacio =
      estado.carrito.length === 0 && estado.enEspera.length === 0 && estado.cliente === null;
    if (vacio) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, JSON.stringify(estado));
  } catch {
    // Cuota excedida o modo privado → se pierde solo la restauración, no la venta.
  }
}

/** Etiqueta por defecto del próximo ticket en espera ("Cuenta 3"). */
export function etiquetaPorDefecto(enEspera: readonly CarritoEnEspera[]): string {
  return `Cuenta ${enEspera.length + 1}`;
}

/** "hace 2 min" / "hace 1 h" para la lista de cuentas aparcadas. */
export function haceCuanto(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "recién";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const horas = Math.floor(min / 60);
  return `hace ${horas} h`;
}
