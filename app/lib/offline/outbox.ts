/**
 * Modo Sin Internet — cola de ventas (outbox) y sincronización con Supabase.
 *
 * FLUJO OFFLINE-FIRST: cada cobro se persiste PRIMERO en la cola local (Dexie) y
 * solo después se intenta enviar a Supabase. Así una venta jamás se pierde aunque
 * no haya red o el navegador se cierre a mitad del cobro.
 *
 * SIN DUPLICADOS: cada venta lleva un `clientUuid` generado una única vez en el
 * cliente. La RPC `registrar_venta_offline` es idempotente por ese UUID (columna
 * única `client_uuid` en `ventas`): si la venta ya se registró, la función
 * devuelve la existente sin volver a descontar stock ni sumar el corte. Por eso
 * es seguro reintentar tras una respuesta perdida.
 */

import { supabase } from "../auth";
import { getDB, type ItemVenta, type VentaOutbox } from "./db";
import { isOnline } from "./catalog";

/** UUID v4 con fallback si `crypto.randomUUID` no está disponible. */
export function nuevoUuid(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback RFC-4122 v4 sobre getRandomValues.
  const b = new Uint8Array(16);
  (c ?? ({ getRandomValues: (a: Uint8Array) => a } as Crypto)).getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h
    .slice(8, 10)
    .join("")}-${h.slice(10, 16).join("")}`;
}

/** Datos mínimos para encolar una venta (los mismos que cobra el POS hoy). */
export type NuevaVenta = {
  metodo: string;
  total: number;
  items: ItemVenta[];
  /** Solo para ventas fiadas: cliente al que se carga el crédito. */
  clienteId?: string | null;
  clienteNombre?: string | null;
};

/**
 * Encola una venta en la cola local con estado `pendiente`. Devuelve el registro
 * creado (con su `clientUuid`), listo para que el POS lo muestre/sincronice.
 */
export async function enqueueVenta(v: NuevaVenta): Promise<VentaOutbox> {
  const db = getDB();
  const registro: VentaOutbox = {
    clientUuid: nuevoUuid(),
    metodo: v.metodo,
    total: v.total,
    items: v.items,
    clienteId: v.clienteId ?? null,
    clienteNombre: v.clienteNombre ?? null,
    createdAt: new Date().toISOString(),
    estado: "pendiente",
    intentos: 0,
    ultimoError: null,
    ventaId: null,
  };
  if (!db) return registro; // sin IndexedDB no persistimos, pero devolvemos el objeto
  const localId = await db.outbox.add(registro);
  return { ...registro, localId };
}

/** Ventas aún no confirmadas por el servidor (pendientes o con error previo). */
export async function getPendientes(): Promise<VentaOutbox[]> {
  const db = getDB();
  if (!db) return [];
  return db.outbox.where("estado").anyOf("pendiente", "error").sortBy("localId");
}

/** Nº de ventas pendientes de sincronizar (pendientes + con error). */
export async function contarPendientes(): Promise<number> {
  const db = getDB();
  if (!db) return 0;
  return db.outbox.where("estado").anyOf("pendiente", "error").count();
}

/**
 * Suma de los totales pendientes de CAJA (para estimar el "vendido hoy" sin red).
 * Excluye las ventas fiadas: un fiado no es efectivo recibido, así que no debe
 * inflar el corte del día ni la tarjeta de "vendido hoy" mientras espera sync.
 */
export async function totalPendiente(): Promise<number> {
  const pend = await getPendientes();
  return pend.reduce((s, v) => (v.metodo === "Fiado" ? s : s + v.total), 0);
}

export type ResultadoSync = {
  enviadas: number;
  conError: number;
  restantes: number;
  detuvoPorRed: boolean;
};

/** Corte devuelto por la RPC, para refrescar la tarjeta "Vendido hoy". */
export type CorteRpc = Record<string, unknown> | null;
let ultimoCorte: CorteRpc = null;
/** Último corte devuelto por una sincronización exitosa (o null). */
export function getUltimoCorteSync(): CorteRpc {
  return ultimoCorte;
}

// Evita sincronizaciones concurrentes (p. ej. evento `online` + botón manual).
let sincronizando = false;

/**
 * Drena la cola: envía cada venta pendiente a Supabase de forma secuencial (para
 * preservar el orden y no saturar). Idempotente vía `clientUuid`.
 *
 * - Éxito: la venta se elimina de la cola (el servidor ya la tiene).
 * - Error de red / sin sesión: se DETIENE y deja el resto pendiente para reintentar.
 * - Error de negocio (stock insuficiente al aplicar en el servidor): se marca
 *   `error` y se continúa con las demás, para no bloquear la cola.
 *
 * Si la migración idempotente aún no está aplicada (función inexistente), cae a
 * la RPC clásica `registrar_venta` para no bloquear la operación.
 */
export async function syncOutbox(): Promise<ResultadoSync> {
  const db = getDB();
  const res: ResultadoSync = { enviadas: 0, conError: 0, restantes: 0, detuvoPorRed: false };
  if (!db || !isOnline() || sincronizando) {
    res.restantes = await contarPendientes();
    res.detuvoPorRed = !isOnline();
    return res;
  }

  sincronizando = true;
  try {
    const pendientes = await db.outbox.where("estado").anyOf("pendiente", "error").sortBy("localId");
    for (const v of pendientes) {
      const enviado = await enviarUna(v);
      if (enviado.ok) {
        if (v.localId != null) await db.outbox.delete(v.localId);
        if (enviado.corte) ultimoCorte = enviado.corte;
        res.enviadas++;
      } else if (enviado.negocio) {
        // Conflicto real (p. ej. sobreventa offline): marcar y seguir con las demás.
        if (v.localId != null) {
          await db.outbox.update(v.localId, {
            estado: "error",
            intentos: v.intentos + 1,
            ultimoError: enviado.mensaje ?? "Error de negocio al sincronizar.",
          });
        }
        res.conError++;
      } else {
        // Error transitorio (red/sesión): incrementa intento y detén el drenado.
        if (v.localId != null) {
          await db.outbox.update(v.localId, {
            estado: "pendiente",
            intentos: v.intentos + 1,
            ultimoError: enviado.mensaje ?? "Error transitorio de red.",
          });
        }
        res.detuvoPorRed = true;
        break;
      }
    }
  } finally {
    sincronizando = false;
  }

  res.restantes = await contarPendientes();
  return res;
}

type EnvioResultado = {
  ok: boolean;
  /** true si el fallo es de negocio (no reintentable sin intervención). */
  negocio?: boolean;
  mensaje?: string;
  corte?: CorteRpc;
};

/** Envía una venta concreta, con fallback a la RPC clásica si hace falta. */
async function enviarUna(v: VentaOutbox): Promise<EnvioResultado> {
  // Las ventas fiadas siguen su propio camino atómico (venta + cargo al cliente,
  // sin sumar al corte de caja). No hay fallback a la RPC de caja: contarían mal
  // como efectivo y no cargarían el saldo del cliente.
  if (v.metodo === "Fiado") {
    return enviarFiado(v);
  }
  try {
    const { data, error } = await supabase.rpc("registrar_venta_offline", {
      p_client_uuid: v.clientUuid,
      p_metodo: v.metodo,
      p_total: v.total,
      p_items: v.items,
      p_created_at: v.createdAt,
    });

    if (!error) {
      const payload = (data ?? {}) as { corte?: CorteRpc };
      return { ok: true, corte: payload.corte ?? null };
    }

    // Función inexistente aún (migración sin aplicar) → RPC clásica sin idempotencia.
    if (error.code === "PGRST202" || error.code === "42883") {
      return enviarClasico(v);
    }
    // Sin empresa/sesión → transitorio (requiere re-login), no marcar como negocio.
    if (error.code === "42501") {
      return { ok: false, mensaje: "Sesión sin empresa asociada. Inicia sesión de nuevo." };
    }
    // Stock insuficiente u otra validación del servidor → conflicto de negocio.
    if (error.code === "P0001" || error.code === "22023") {
      return { ok: false, negocio: true, mensaje: error.message };
    }
    // Desconocido: trátalo como transitorio para no perder la venta.
    return { ok: false, mensaje: error.message };
  } catch (e) {
    // Excepción de red (fetch abortado) → transitorio.
    return { ok: false, mensaje: e instanceof Error ? e.message : "Fallo de red." };
  }
}

/** Camino de compatibilidad: RPC clásica cuando aún no existe la idempotente. */
async function enviarClasico(v: VentaOutbox): Promise<EnvioResultado> {
  try {
    const { data, error } = await supabase.rpc("registrar_venta", {
      p_metodo: v.metodo,
      p_total: v.total,
      p_items: v.items,
    });
    if (!error) {
      const payload = (data ?? {}) as { corte?: CorteRpc };
      return { ok: true, corte: payload.corte ?? null };
    }
    if (error.code === "P0001" || error.code === "22023") {
      return { ok: false, negocio: true, mensaje: error.message };
    }
    return { ok: false, mensaje: error.message };
  } catch (e) {
    return { ok: false, mensaje: e instanceof Error ? e.message : "Fallo de red." };
  }
}

/**
 * Envía una venta FIADA vía la RPC atómica `registrar_venta_fiado`: descuenta
 * stock, registra la venta con método 'Fiado' y carga el total al saldo del
 * cliente, todo en una transacción. No suma al corte de caja.
 *
 * A diferencia de las ventas de caja, aquí NO hay fallback a otra RPC: si la
 * migración 2026-08-fiado-desde-pos.sql aún no se aplicó (función inexistente),
 * lo tratamos como error de negocio con un mensaje claro y dejamos la venta en la
 * cola (estado `error`) para no perderla ni contarla mal como efectivo.
 */
async function enviarFiado(v: VentaOutbox): Promise<EnvioResultado> {
  if (!v.clienteId) {
    return { ok: false, negocio: true, mensaje: "Venta fiada sin cliente asociado; no se puede sincronizar." };
  }
  try {
    const { data, error } = await supabase.rpc("registrar_venta_fiado", {
      p_client_uuid: v.clientUuid,
      p_cliente_id: v.clienteId,
      p_total: v.total,
      p_items: v.items,
      p_descripcion: v.clienteNombre ? `Venta a crédito · ${v.clienteNombre}` : null,
      p_created_at: v.createdAt,
    });

    if (!error) {
      // Esta RPC no devuelve corte (el fiado no toca la caja); solo trazabilidad.
      const payload = (data ?? {}) as { corte?: CorteRpc };
      return { ok: true, corte: payload.corte ?? null };
    }

    // Función inexistente (migración sin aplicar): no reintentar en bucle, marcar
    // como negocio con guía. El fiado no se pierde: queda visible en la cola.
    if (error.code === "PGRST202" || error.code === "42883") {
      return {
        ok: false,
        negocio: true,
        mensaje:
          "Falta aplicar la migración de fiado en POS (supabase/2026-08-fiado-desde-pos.sql).",
      };
    }
    // Sin empresa/sesión → transitorio (requiere re-login).
    if (error.code === "42501") {
      return { ok: false, mensaje: "Sesión sin empresa asociada. Inicia sesión de nuevo." };
    }
    // Stock insuficiente, cliente inexistente u otra validación → conflicto de negocio.
    if (error.code === "P0001" || error.code === "22023") {
      return { ok: false, negocio: true, mensaje: error.message };
    }
    // Desconocido: transitorio para no perder la venta.
    return { ok: false, mensaje: error.message };
  } catch (e) {
    return { ok: false, mensaje: e instanceof Error ? e.message : "Fallo de red." };
  }
}
