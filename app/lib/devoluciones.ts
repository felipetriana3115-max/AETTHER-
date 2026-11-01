/**
 * Devoluciones parciales con circuito de solicitud → aprobación.
 *
 * Reemplaza el "todo o nada" de `registrarDevolucion` (ver `ventas.ts`, que se
 * conserva para las ventas importadas sin desglose de líneas):
 *
 *   · Cualquier miembro del tenant SOLICITA una devolución eligiendo ítems y
 *     cantidades (`solicitar_devolucion`). No se mueve stock, ni caja, ni el
 *     estado de la venta: solo queda una fila 'pendiente'.
 *   · SOLO el administrador la resuelve (`resolver_devolucion`). Aprobar repone
 *     el stock, acumula lo devuelto en la venta y registra el egreso de caja si
 *     el cobro fue en efectivo. Rechazar no altera nada.
 *
 * EL CAJÓN DE DINERO lo decide el SERVIDOR: `resolver_devolucion` responde
 * `abrir_cajon: true` únicamente cuando la aprobación sacó efectivo de verdad.
 * Aquí solo traducimos ese booleano al pulso ESC/POS (`pinCajonDevolucion`).
 *
 * AISLAMIENTO: todo pasa por RPC SECURITY DEFINER que resuelven la empresa con
 * `public.mi_empresa()`; la empresa NUNCA viaja en el payload. El listado lee
 * `public.devoluciones`, cuya policy de SELECT ya está acotada al tenant, y
 * además filtramos por el `empresa_id` de la sesión viva (defensa en
 * profundidad, igual que el resto del módulo de ventas).
 *
 * Ver supabase/2026-10-devoluciones-parciales.sql.
 */

import { supabase, getEmpresaIdActiva } from "./auth";
import type { DrawerSettings } from "./devices";

// ── Tipos ────────────────────────────────────────────────────────────────────

/** Línea de una venta con cuánto queda realmente devolvible de ella. */
export type LineaDevolvible = {
  /** Posición dentro de `ventas.items`: es la clave que entiende el servidor. */
  idx: number;
  /** UUID del producto de catálogo; null/negativo en artículos comunes. */
  id: string | null;
  nombre: string;
  precio: number;
  /** Artículo suelto: no descontó stock, así que tampoco lo repone. */
  esComun: boolean;
  /** Unidades vendidas en esta línea. */
  qty: number;
  /** Unidades ya devueltas y aprobadas. */
  devuelta: number;
  /** Unidades comprometidas por solicitudes aún sin resolver. */
  pendiente: number;
  /** Tope del selector de cantidad: `qty - devuelta - pendiente`. */
  disponible: number;
};

/** Estado devolvible de una venta completa. */
export type DisponibleDevolucion = {
  ventaId: string;
  estado: string;
  metodo: string;
  total: number;
  devueltoTotal: number;
  lineas: LineaDevolvible[];
};

/** Ítem tal como quedó congelado en la solicitud (precio del momento de la venta). */
export type ItemSolicitud = {
  idx: number;
  id: string | null;
  nombre: string;
  qty: number;
  precio: number;
  esComun: boolean;
};

export type EstadoSolicitud = "pendiente" | "aprobada" | "rechazada";

/** Solicitud de devolución, con lo mínimo de la venta para pintarla sin otro viaje. */
export type SolicitudDevolucion = {
  id: string;
  ventaId: string;
  estado: EstadoSolicitud;
  items: ItemSolicitud[];
  monto: number;
  motivo: string | null;
  /** Método del cobro ORIGINAL: decide si la aprobación saca efectivo. */
  metodo: string;
  /** Nombre o correo de quien la pidió (congelado por el servidor). */
  solicitante: string;
  solicitadaAt: string;
  resueltaAt: string | null;
  resolucionNota: string | null;
  unidadesRepuestas: number | null;
  sinProducto: number | null;
  /** Total de la factura original (contexto para el admin). */
  ventaTotal: number;
  /** ISO de `ventas.created_at`. */
  ventaFecha: string | null;
};

/** Par que viaja al servidor. Nada más: el precio lo pone la base de datos. */
export type SeleccionDevolucion = { idx: number; qty: number };

/** Desenlace de una solicitud (o de su aprobación inmediata por el dueño). */
export type ResultadoSolicitud = {
  ok: boolean;
  solicitudId: string | null;
  /** true si el admin la creó ya aprobada (atajo de un solo paso). */
  autoAprobada: boolean;
  estado: EstadoSolicitud | null;
  monto: number;
  unidades: number;
  sinProducto: number;
  /** Lo dice el servidor: solo true si la aprobación sacó efectivo. */
  abrirCajon: boolean;
  error: string | null;
};

/** Desenlace de aprobar o rechazar una solicitud. */
export type ResultadoResolucion = {
  ok: boolean;
  estado: EstadoSolicitud | null;
  /** true si la solicitud ya estaba resuelta: no se volvió a tocar nada. */
  duplicada: boolean;
  monto: number;
  unidades: number;
  sinProducto: number;
  /** La venta quedó completamente reembolsada con esta aprobación. */
  ventaCompleta: boolean;
  abrirCajon: boolean;
  /** Mensaje informativo del servidor (p. ej. la venta ya estaba devuelta). */
  aviso: string | null;
  error: string | null;
};

// ── Errores ──────────────────────────────────────────────────────────────────

const FALTA_MIGRACION =
  "Falta el módulo de devoluciones parciales en la base de datos. Ejecuta " +
  "supabase/2026-10-devoluciones-parciales.sql en el SQL Editor de Supabase.";

/** Traduce los fallos típicos de las RPC a algo accionable para el mostrador. */
function mensajeError(error: { code?: string; message: string }, accion: string): string {
  if (error.code === "PGRST202" || error.code === "42883" || error.code === "42P01") {
    return FALTA_MIGRACION;
  }
  // OJO con el orden: 42501 cubre tanto "falta el GRANT EXECUTE" (despliegue)
  // como las reglas de negocio de la RPC —no eres admin, sesión sin empresa—,
  // que ya llegan con un mensaje legible. Se distingue por el texto.
  if (error.message.includes("permission denied for function")) {
    return (
      "Tu usuario no tiene permiso para esta operación. Falta el GRANT EXECUTE " +
      "de las funciones de devolución a `authenticated`."
    );
  }
  // P0001 / 42501 / 22023 son los `raise exception` de las propias RPC: su
  // texto está escrito para leerse tal cual (topes de cantidad, rol, etc.).
  if (error.code === "P0001" || error.code === "42501" || error.code === "22023") {
    return error.message;
  }
  return `No se pudo ${accion}: ${error.message}`;
}

// ── Normalizadores ───────────────────────────────────────────────────────────

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function parseItems(raw: unknown): ItemSolicitud[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const it = entry as Record<string, unknown>;
    const qty = num(it.qty);
    if (qty <= 0) return [];
    return [
      {
        idx: num(it.idx),
        id: typeof it.id === "string" ? it.id : null,
        nombre: typeof it.nombre === "string" && it.nombre ? it.nombre : "Artículo",
        qty,
        precio: num(it.precio),
        esComun: it.esComun === true,
      },
    ];
  });
}

function parseEstado(raw: unknown): EstadoSolicitud | null {
  return raw === "pendiente" || raw === "aprobada" || raw === "rechazada" ? raw : null;
}

// ── Lectura: cuánto se puede devolver de una venta ───────────────────────────

/**
 * Líneas devolvibles de una venta de la empresa activa, con el tope exacto de
 * cada selector (vendido − ya devuelto − reservado por solicitudes pendientes).
 * Ese cálculo vive en el servidor a propósito: dos cajeros no pueden pedir por
 * separado las mismas unidades.
 */
export async function fetchDisponibleDevolucion(
  ventaId: string,
): Promise<{ data: DisponibleDevolucion | null; error: string | null }> {
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) {
    return {
      data: null,
      error:
        "Tu sesión no tiene una empresa asociada. Cierra sesión y vuelve a entrar.",
    };
  }

  const { data, error } = await supabase.rpc("devolucion_disponible", {
    p_venta_id: ventaId,
  });

  if (error) {
    console.warn("[devoluciones] devolucion_disponible falló:", error);
    return { data: null, error: mensajeError(error, "consultar la devolución") };
  }

  const r = (data ?? {}) as Record<string, unknown>;
  const lineasRaw = Array.isArray(r.lineas) ? r.lineas : [];

  return {
    data: {
      ventaId: typeof r.venta_id === "string" ? r.venta_id : ventaId,
      estado: typeof r.estado === "string" ? r.estado : "Pagado",
      metodo: typeof r.metodo === "string" ? r.metodo : "No especificado",
      total: num(r.total),
      devueltoTotal: num(r.devuelto_total),
      lineas: lineasRaw.map((entry) => {
        const l = (entry ?? {}) as Record<string, unknown>;
        return {
          idx: num(l.idx),
          id: typeof l.id === "string" ? l.id : null,
          nombre: typeof l.nombre === "string" && l.nombre ? l.nombre : "Artículo",
          precio: num(l.precio),
          esComun: l.esComun === true,
          qty: num(l.qty),
          devuelta: num(l.devuelta),
          pendiente: num(l.pendiente),
          disponible: Math.max(0, num(l.disponible)),
        };
      }),
    },
    error: null,
  };
}

// ── Escritura: solicitar ─────────────────────────────────────────────────────

/**
 * Registra una solicitud de devolución parcial.
 *
 * Solo se envían pares `{idx, qty}`: nombre, precio y tope los lee el servidor
 * de `ventas.items`, así que un cliente manipulado no puede inflar el importe
 * ni devolver más de lo vendido.
 *
 * `autoAprobar` es el atajo del dueño (pedir y aprobar en la MISMA transacción).
 * Si lo manda un empleado, la RPC lo rechaza con 42501 y la solicitud entera se
 * revierte: nunca queda una fila a medias.
 */
export async function solicitarDevolucion(
  ventaId: string,
  seleccion: readonly SeleccionDevolucion[],
  motivo?: string,
  autoAprobar = false,
): Promise<ResultadoSolicitud> {
  const vacio: ResultadoSolicitud = {
    ok: false,
    solicitudId: null,
    autoAprobada: false,
    estado: null,
    monto: 0,
    unidades: 0,
    sinProducto: 0,
    abrirCajon: false,
    error: null,
  };

  const items = seleccion
    .filter((s) => Number.isFinite(s.qty) && s.qty > 0)
    .map((s) => ({ idx: Math.trunc(s.idx), qty: Math.trunc(s.qty) }));

  if (items.length === 0) {
    return { ...vacio, error: "Selecciona al menos un producto y una cantidad para devolver." };
  }

  // Defensa en profundidad: sin empresa resuelta no se invoca la RPC (el
  // servidor lo rechazaría igual, pero así el mensaje es legible).
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) {
    return {
      ...vacio,
      error:
        "Tu sesión no tiene una empresa asociada, así que no se puede devolver la venta. " +
        "Cierra sesión y vuelve a entrar.",
    };
  }

  const { data, error } = await supabase.rpc("solicitar_devolucion", {
    p_venta_id: ventaId,
    p_items: items,
    p_motivo: motivo?.trim() || null,
    p_auto_aprobar: autoAprobar,
  });

  if (error) {
    console.error("[devoluciones] solicitar_devolucion falló:", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return { ...vacio, error: mensajeError(error, "registrar la devolución") };
  }

  const r = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    solicitudId: typeof r.solicitud_id === "string" ? r.solicitud_id : null,
    autoAprobada: r.auto_aprobada === true,
    estado: parseEstado(r.estado),
    monto: num(r.monto),
    unidades: num(r.unidades),
    sinProducto: num(r.sin_producto),
    abrirCajon: r.abrir_cajon === true,
    error: null,
  };
}

// ── Lectura: bandeja de solicitudes ──────────────────────────────────────────

/** Fila cruda de `public.devoluciones` con la venta embebida por PostgREST. */
type SolicitudRow = {
  id: string;
  venta_id: string;
  estado: string;
  items: unknown;
  monto: number | string | null;
  motivo: string | null;
  metodo_pago: string | null;
  solicitante: string | null;
  solicitada_at: string;
  resuelta_at: string | null;
  resolucion_nota: string | null;
  unidades_repuestas: number | null;
  sin_producto: number | null;
  ventas?: { total: number | string | null; created_at: string } | null;
};

const SOLICITUD_SELECT =
  "id, venta_id, estado, items, monto, motivo, metodo_pago, solicitante, " +
  "solicitada_at, resuelta_at, resolucion_nota, unidades_repuestas, sin_producto, " +
  "ventas(total, created_at)";

/**
 * Solicitudes de devolución de la empresa activa, las pendientes primero.
 *
 * La RLS de `public.devoluciones` ya acota al tenant; el `.eq("empresa_id", …)`
 * es la segunda barrera (mismo patrón que el resto del módulo). Si la tabla aún
 * no existe se devuelve una lista vacía con el aviso de la migración, para que
 * el panel de Transacciones siga funcionando.
 */
export async function fetchSolicitudesDevolucion(
  limite = 50,
): Promise<{ data: SolicitudDevolucion[]; error: string | null }> {
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return { data: [], error: null };

  const { data, error } = await supabase
    .from("devoluciones")
    .select(SOLICITUD_SELECT)
    .eq("empresa_id", empresaId)
    // 'pendiente' < 'aprobada'… no sirve alfabéticamente: se ordena por fecha y
    // el componente separa las pendientes, que son las accionables.
    .order("solicitada_at", { ascending: false })
    .limit(limite);

  if (error) {
    // 42P01 (tabla ausente) / PGRST205 (no está en el esquema cacheado):
    // la migración no se ha corrido todavía.
    const faltaTabla = error.code === "42P01" || error.code === "PGRST205";
    if (!faltaTabla) {
      console.warn("[devoluciones] No se pudieron leer las solicitudes:", error.message);
    }
    return { data: [], error: faltaTabla ? FALTA_MIGRACION : error.message };
  }

  const filas = (data ?? []) as unknown as SolicitudRow[];
  return {
    data: filas.flatMap((row) => {
      const estado = parseEstado(row.estado);
      if (!estado) return [];
      return [
        {
          id: row.id,
          ventaId: row.venta_id,
          estado,
          items: parseItems(row.items),
          monto: num(row.monto),
          motivo: row.motivo,
          metodo: row.metodo_pago ?? "No especificado",
          solicitante: row.solicitante ?? "Usuario",
          solicitadaAt: row.solicitada_at,
          resueltaAt: row.resuelta_at,
          resolucionNota: row.resolucion_nota,
          unidadesRepuestas: row.unidades_repuestas,
          sinProducto: row.sin_producto,
          ventaTotal: num(row.ventas?.total),
          ventaFecha: row.ventas?.created_at ?? null,
        },
      ];
    }),
    error: null,
  };
}

// ── Escritura: resolver ──────────────────────────────────────────────────────

/**
 * Aprueba o rechaza una solicitud. Reservada al administrador: la RPC vuelve a
 * comprobar el rol server-side (es SECURITY DEFINER, el gateo de React no basta).
 *
 * Aprobar es atómico: stock + acumulado de la venta + egreso de caja en una sola
 * transacción. Rechazar no toca absolutamente nada.
 */
export async function resolverDevolucion(
  solicitudId: string,
  aprobar: boolean,
  nota?: string,
): Promise<ResultadoResolucion> {
  const vacio: ResultadoResolucion = {
    ok: false,
    estado: null,
    duplicada: false,
    monto: 0,
    unidades: 0,
    sinProducto: 0,
    ventaCompleta: false,
    abrirCajon: false,
    aviso: null,
    error: null,
  };

  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) {
    return {
      ...vacio,
      error:
        "Tu sesión no tiene una empresa asociada, así que no se puede resolver la devolución. " +
        "Cierra sesión y vuelve a entrar.",
    };
  }

  const { data, error } = await supabase.rpc("resolver_devolucion", {
    p_solicitud_id: solicitudId,
    p_aprobar: aprobar,
    p_nota: nota?.trim() || null,
  });

  if (error) {
    console.error("[devoluciones] resolver_devolucion falló:", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return { ...vacio, error: mensajeError(error, "resolver la devolución") };
  }

  const r = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    estado: parseEstado(r.estado),
    duplicada: r.duplicada === true,
    monto: num(r.monto),
    unidades: num(r.unidades),
    sinProducto: num(r.sin_producto),
    ventaCompleta: r.venta_completa === true,
    // El servidor es quien decide; el cliente solo obedece.
    abrirCajon: r.abrir_cajon === true,
    aviso: typeof r.aviso === "string" ? r.aviso : null,
    error: null,
  };
}

// ── Cajón de dinero ──────────────────────────────────────────────────────────

/**
 * Pin del pulso ESC/POS para la salida de efectivo de una devolución APROBADA,
 * o `null` si el cajón no debe moverse.
 *
 * Espejo de `pinCajonPara` del POS, con el mismo criterio invertido: si sale
 * dinero físico del cajón, el cajero necesita abrirlo sí o sí, así que el pulso
 * va aunque los interruptores de Dispositivos estén apagados (en un equipo sin
 * cajón conectado el pulso es inocuo: la impresora lo ignora). Para el resto de
 * métodos manda la configuración; en Fiado nunca se abre, porque no hubo billete.
 *
 * `abrirCajon` lo decide el SERVIDOR (`resolver_devolucion`); esta función solo
 * traduce esa orden al hardware local, que es configuración por equipo y nunca
 * depende del tenant.
 */
export function pinCajonDevolucion(
  abrirCajon: boolean,
  metodo: string,
  drawer: DrawerSettings,
): 0 | 1 | null {
  if (!abrirCajon) return null;
  if (metodo === "Efectivo") return drawer.pin;
  if (!drawer.enabled || drawer.trigger !== "printer" || metodo === "Fiado") return null;
  return drawer.autoOpenAllMethods ? drawer.pin : null;
}
