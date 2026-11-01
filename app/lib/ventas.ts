/**
 * Detalle y devolución de una venta (panel de Transacciones).
 *
 * Fuente de verdad: `public.ventas`, con el desglose de líneas en la columna
 * JSONB `items` (id · nombre · qty · precio · esComun), tal como lo escribe el
 * POS. El listado del dashboard (ver `fetchVentasEmpresa`) NO trae `items`
 * porque son muchas filas; aquí se pide SOLO la venta que el cajero abre, así
 * que la vista previa de factura no encarece la tabla.
 *
 * AISLAMIENTO: igual que el resto de lecturas, además de RLS filtramos
 * explícitamente por el `empresa_id` resuelto de la SESIÓN VIVA
 * (`getEmpresaIdActiva`). Sin empresa no se consulta y se devuelve `null`.
 * La devolución va por la RPC `registrar_devolucion`, que resuelve la empresa
 * server-side: un id de otro tenant simplemente no encuentra fila.
 */

import { supabase, getEmpresaIdActiva } from "./auth";
import type { SaleStatus } from "./data-model";

/** Línea de la venta, tal como la guardó el POS en `ventas.items`. */
export type LineaVenta = {
  nombre: string;
  qty: number;
  precio: number;
  /** Artículo suelto (no estaba en el inventario): no devuelve stock. */
  esComun: boolean;
};

/** Venta con su desglose completo, para la vista previa y la reimpresión. */
export type VentaDetalle = {
  id: string;
  total: number;
  metodo: string;
  /** ISO timestamptz tal como viene de Postgres. */
  fecha: string;
  cliente: string | null;
  canal: string | null;
  estado: SaleStatus;
  /** Folio del sistema anterior; null en las ventas del POS. */
  referencia: string | null;
  /** Momento de la devolución; null si la venta nunca se devolvió. */
  devueltaAt: string | null;
  devueltaMotivo: string | null;
  lineas: LineaVenta[];
};

/** Fila cruda de `public.ventas` en lo que consume esta vista. */
type VentaDetalleRow = {
  id: string;
  total: number | string | null;
  metodo_pago: string | null;
  created_at: string;
  items: unknown;
  cliente_nombre?: string | null;
  canal?: string | null;
  estado?: SaleStatus | null;
  referencia?: string | null;
  devuelta_at?: string | null;
  devuelta_motivo?: string | null;
};

/** Columnas que existen desde la primera migración de `ventas`. */
const DETALLE_SELECT_BASE = "id, total, metodo_pago, created_at, items";

/**
 * Columnas añadidas después (`2026-10-import-masivo-crm-ventas.sql` y
 * `2026-10-devoluciones-ventas.sql`). Mismo patrón defensivo que el resto del
 * módulo: si la migración no se ha corrido, PostgREST responde 42703 y se
 * reintenta sin ellas para que la factura siga viéndose.
 */
const DETALLE_SELECT_EXTRA =
  "cliente_nombre, canal, estado, referencia, devuelta_at, devuelta_motivo";

/** Normaliza el JSONB `items` a líneas utilizables, descartando basura. */
function parseLineas(items: unknown): LineaVenta[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const it = raw as Record<string, unknown>;
    const nombre = typeof it.nombre === "string" ? it.nombre : "";
    const qty = Number(it.qty ?? 0);
    const precio = Number(it.precio ?? 0);
    if (!nombre || !Number.isFinite(qty) || qty <= 0) return [];
    return [
      {
        nombre,
        qty,
        precio: Number.isFinite(precio) ? precio : 0,
        esComun: it.esComun === true,
      },
    ];
  });
}

/**
 * Lee una venta de la empresa activa con su desglose de líneas.
 * Devuelve `null` si no hay sesión/empresa, si la venta no es de este tenant
 * (RLS no la deja ver) o si la consulta falla.
 */
export async function fetchVentaDetalle(ventaId: string): Promise<VentaDetalle | null> {
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return null; // sin empresa resuelta no se consulta (aislamiento)

  const completo = await supabase
    .from("ventas")
    .select(`${DETALLE_SELECT_BASE}, ${DETALLE_SELECT_EXTRA}`)
    .eq("id", ventaId)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  const debeReintentar = completo.error?.code === "42703";
  if (debeReintentar) {
    console.warn(
      "[ventas] Faltan columnas nuevas en `ventas`; corre " +
        "supabase/2026-10-devoluciones-ventas.sql para el historial de devoluciones.",
    );
  }

  const { data, error } = debeReintentar
    ? await supabase
        .from("ventas")
        .select(DETALLE_SELECT_BASE)
        .eq("id", ventaId)
        .eq("empresa_id", empresaId)
        .maybeSingle()
    : completo;

  if (error) {
    console.warn("[ventas] No se pudo leer el detalle de la venta:", error.message);
    return null;
  }
  if (!data) return null;

  const row = data as VentaDetalleRow;
  return {
    id: row.id,
    total: Number(row.total ?? 0),
    metodo: row.metodo_pago ?? "No especificado",
    fecha: row.created_at,
    cliente: row.cliente_nombre ?? null,
    canal: row.canal ?? null,
    estado: row.estado ?? "Pagado",
    referencia: row.referencia ?? null,
    devueltaAt: row.devuelta_at ?? null,
    devueltaMotivo: row.devuelta_motivo ?? null,
    lineas: parseLineas(row.items),
  };
}

/** Lo que reporta el servidor tras procesar (o reconocer) una devolución. */
export type ResultadoDevolucion = {
  ok: boolean;
  /** true si la venta YA estaba devuelta: no se volvió a sumar stock. */
  duplicada: boolean;
  /** Unidades efectivamente devueltas al inventario. */
  unidades: number;
  /** Líneas de catálogo que tenía la venta. */
  lineas: number;
  /** Líneas cuyo producto ya no existe en el catálogo (no se pudo reponer). */
  sinProducto: number;
  /** Mensaje presentable si algo falló; `null` si todo fue bien. */
  error: string | null;
};

/** Traduce los fallos típicos de la RPC a algo accionable para el cajero. */
function mensajeErrorDevolucion(error: { code?: string; message: string }): string {
  if (error.code === "PGRST202" || error.code === "42883") {
    return (
      "Falta la función registrar_devolucion en la base de datos. Ejecuta " +
      "supabase/2026-10-devoluciones-ventas.sql en el SQL Editor de Supabase."
    );
  }
  // OJO con el orden: la RPC usa 42501 tanto para "falta el GRANT EXECUTE"
  // (problema de despliegue) como para sus propias reglas de negocio —rol no
  // administrador, sesión sin empresa—, que llegan con un mensaje ya legible.
  // Se distingue por el texto, no por el código (ver nota en la RPC).
  if (error.message.includes("permission denied for function")) {
    return (
      "Tu usuario no tiene permiso para procesar devoluciones. Falta el GRANT " +
      "EXECUTE de registrar_devolucion a `authenticated`."
    );
  }
  if (error.code === "42501") return error.message;
  return `No se pudo procesar la devolución: ${error.message}`;
}

/**
 * Procesa la devolución de una venta vía la RPC atómica `registrar_devolucion`:
 * el stock vuelve al inventario de ESTA empresa, la venta queda 'Reembolsado' y
 * —si el cobro fue en efectivo— se registra el egreso de caja. Todo en una sola
 * transacción del servidor; aquí nunca se escribe suelto.
 *
 * Es idempotente: repetir la llamada responde `duplicada: true` sin volver a
 * inflar el inventario.
 */
export async function registrarDevolucion(
  ventaId: string,
  motivo?: string,
): Promise<ResultadoDevolucion> {
  const vacio: ResultadoDevolucion = {
    ok: false,
    duplicada: false,
    unidades: 0,
    lineas: 0,
    sinProducto: 0,
    error: null,
  };

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

  const { data, error } = await supabase.rpc("registrar_devolucion", {
    p_venta_id: ventaId,
    p_motivo: motivo?.trim() || null,
  });

  if (error) {
    console.error("[ventas] registrar_devolucion falló:", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return { ...vacio, error: mensajeErrorDevolucion(error) };
  }

  const r = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    duplicada: r.duplicada === true,
    unidades: Number(r.unidades ?? 0),
    lineas: Number(r.lineas ?? 0),
    sinProducto: Number(r.sin_producto ?? 0),
    error: null,
  };
}
