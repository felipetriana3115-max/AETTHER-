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
  if (!db) {
    // Sin IndexedDB (navegador embebido tipo WhatsApp/Instagram, modo privado o
    // almacenamiento bloqueado) NO podemos persistir la venta NI encolarla para
    // sincronizar. Antes devolvíamos el registro como si se hubiera guardado; como
    // `syncOutbox`/`contarPendientes` también salen en vacío sin DB, la barra
    // mostraba "Todo sincronizado" mientras el cobro se perdía en silencio (nunca
    // llegaba a Supabase). Fallar de forma explícita hace que el POS avise en vez
    // de tragarse la venta.
    throw new Error(
      "El almacenamiento local no está disponible (¿navegador en modo privado o embebido?); la venta no se pudo guardar.",
    );
  }
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
  /**
   * true si el drenado se detuvo porque la sesión NO resuelve empresa
   * (`mi_empresa()` nulo → la RPC lanza 42501). No es un fallo de red ni de
   * negocio: hay que re-loguear o reparar el usuario (usuarios.empresa_id vacío).
   */
  sinEmpresa: boolean;
  /** Motivo de la última parada/rechazo, para mostrarlo en la UI (o null). */
  mensaje: string | null;
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
  const res: ResultadoSync = {
    enviadas: 0,
    conError: 0,
    restantes: 0,
    detuvoPorRed: false,
    sinEmpresa: false,
    mensaje: null,
  };
  if (!db || !isOnline() || sincronizando) {
    res.restantes = await contarPendientes();
    res.detuvoPorRed = !isOnline();
    return res;
  }

  sincronizando = true;
  try {
    // GATE DE SESIÓN — evita el falso "sesión sin empresa" en arranque en frío.
    // `syncOutbox` se dispara al montar el POS y en el evento `online`, y puede
    // ejecutarse ANTES de que supabase-js rehidrate la sesión desde el storage.
    // Sin sesión cargada, la RPC viaja como `anon`: como `registrar_venta_offline`
    // solo tiene GRANT a `authenticated`, el servidor la rechaza con 42501, el
    // MISMO código que usamos para "empresa nula". Además, sin `auth.uid()`,
    // `mi_empresa()` evaluaría a nulo.
    //
    // Usamos `getSession()` (NO `getUser()`) a propósito: supabase-js firma cada
    // RPC leyendo el `access_token` de `getSession()` (ver `_getAccessToken`), y si
    // no hay sesión cae a la anon key. `getUser()` hace un round-trip de red a
    // /auth/v1/user para VALIDAR el token, pero NO es la fuente que autentica la
    // petición: podía devolver un usuario y aun así la RPC salir como `anon` si la
    // sesión no estaba adjunta. Al puertear el gate a la MISMA `getSession()` que
    // usa la RPC, garantizamos que si seguimos adelante hay un token que viajará
    // realmente con la petición (y `getSession()` rehidrata + refresca si expiró).
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      // Sesión aún no disponible (o sin login): NO es un fallo de empresa. Salimos
      // sin error para que el latido/evento `online` reintente cuando la sesión
      // esté lista, en vez de mostrar el mensaje alarmante de "sesión sin empresa".
      res.restantes = await contarPendientes();
      return res;
    }

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
        res.mensaje = enviado.mensaje ?? "Error de negocio al sincronizar.";
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
        // Distinguimos "sesión sin empresa" (dato roto / re-login) de una caída de
        // red pura, para que la UI muestre el mensaje accionable correcto.
        if (enviado.sinEmpresa) res.sinEmpresa = true;
        res.mensaje = enviado.mensaje ?? "Error transitorio de red.";
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
  /** true si la RPC rechazó por sesión sin empresa (42501): re-login / reparar usuario. */
  sinEmpresa?: boolean;
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
      const payload = (data ?? {}) as {
        corte?: CorteRpc;
        duplicada?: boolean;
        venta_id?: string;
      };
      // GUARDA ANTI-FALSO-ÉXITO. En el PRIMER envío de una venta recién cobrada
      // (`intentos === 0`) el servidor tiene que INSERTARLA, así que debe responder
      // `duplicada: false` con un `venta_id`. Como cada cobro genera un `clientUuid`
      // único e irrepetible (y Dexie impide re-encolarlo), es IMPOSIBLE que una
      // venta nueva ya exista en el servidor en su primer envío.
      //
      // Si aun así responde `duplicada: true` (o sin `venta_id`) en el primer
      // intento, la fila NO se creó: casi siempre es la función `registrar_venta_offline`
      // desplegada en una versión vieja/rota cuyo cortocircuito de idempotencia no
      // filtra por `client_uuid` y confunde la venta con una de las ya existentes.
      // Antes devolvíamos `ok:true` y la cola la borraba → "Todo sincronizado" con la
      // venta perdida. Ahora la tratamos como problema para NO marcarla como subida.
      if (v.intentos === 0 && (payload.duplicada === true || !payload.venta_id)) {
        return {
          ok: false,
          negocio: true,
          mensaje:
            "El servidor marcó la venta como ya registrada en su primer envío (no se insertó ninguna fila). " +
            "Re-aplica supabase/2026-08-arqueo-diario.sql: la función registrar_venta_offline desplegada está " +
            "desactualizada.",
        };
      }
      return { ok: true, corte: payload.corte ?? null };
    }

    // Función inexistente aún (migración sin aplicar) → RPC clásica sin idempotencia.
    if (error.code === "PGRST202" || error.code === "42883") {
      return enviarClasico(v);
    }
    // Sin empresa/sesión → transitorio (requiere re-login), no marcar como negocio.
    if (error.code === "42501") {
      return {
        ok: false,
        sinEmpresa: true,
        mensaje: "Tu sesión no tiene una empresa asociada, por eso no se pueden subir las ventas.",
      };
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
      return {
        ok: false,
        sinEmpresa: true,
        mensaje: "Tu sesión no tiene una empresa asociada, por eso no se pueden subir las ventas.",
      };
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
