/**
 * Corte de caja (arqueo) — lectura desde Supabase.
 *
 * Fuente de verdad: tabla `public.cortes_caja` (una fila por empresa y día),
 * alimentada por la RPC `sumar_corte_caja` que dispara el POS en cada cobro
 * (ver migración 2026-07-corte-de-caja.sql). El aislamiento por empresa lo
 * impone RLS, no el frontend.
 *
 * Se usa en dos sitios: la tarjeta "Vendido hoy" del POS y la vista de cierre
 * de turno en Reportes. Centralizar tipo + coerción aquí evita duplicar lógica.
 */

import { supabase, getEmpresaIdActiva } from "./auth";

export type CorteCaja = {
  id: string;
  empresa_id: string;
  fecha: string; // YYYY-MM-DD
  total_general: number;
  total_efectivo: number;
  total_nequi: number;
  total_bold: number;
  num_ventas: number;
  created_at: string;
  updated_at: string;
  // Campos del turno/arqueo (migración 2026-07-arqueo-caja.sql). El POS no los
  // usa: quedan en sus DEFAULT hasta que el cajero abre/cierra caja.
  base_inicial: number;
  estado: "abierta" | "cerrada";
  abierto_at: string | null;
  efectivo_contado: number | null; // null hasta el cierre ciego
  diferencia: number | null; // + sobrante · − faltante · null si no se ha cerrado
  cerrado_at: string | null;
};

/**
 * Fecha del "día de negocio" en `America/Bogota` como `YYYY-MM-DD`. Fijamos la
 * zona horaria explícitamente (no la del dispositivo ni UTC) para que coincida
 * EXACTAMENTE con `public.hoy_negocio()` en la BD: así el arqueo filtra y
 * reinicia por el mismo día en ambos lados y no arrastra valores de la jornada
 * anterior cerca de la medianoche. El locale `en-CA` produce `YYYY-MM-DD`.
 */
export function hoyISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Rango [inicio, fin] del día de negocio de HOY en `America/Bogota`, como ISO
 * `timestamptz`. Bogotá es UTC−5 fijo (sin horario de verano), así que anclamos
 * el offset `-05:00` explícitamente: así el filtro sobre `ventas.created_at`
 * (que es `timestamptz`) cubre EXACTAMENTE la jornada local completa, sin
 * arrastrar ventas de ayer ni recortar las de la noche por culpa de UTC.
 *
 * Se usa con `.gte("created_at", inicio).lte("created_at", fin)` en vez de un
 * `.eq("created_at", hoy)` rígido (que nunca cuadra contra un timestamp).
 */
export function rangoDiaHoy(): { inicio: string; fin: string } {
  const hoy = hoyISO(); // YYYY-MM-DD en America/Bogota
  return {
    inicio: `${hoy}T00:00:00.000-05:00`,
    fin: `${hoy}T23:59:59.999-05:00`,
  };
}

/** Subtotales del día por método de pago, con la misma forma que un corte. */
export type VentasHoyPorMetodo = {
  total_general: number;
  total_efectivo: number;
  total_nequi: number;
  total_bold: number;
  num_ventas: number;
};

const VENTAS_HOY_VACIO: VentasHoyPorMetodo = {
  total_general: 0,
  total_efectivo: 0,
  total_nequi: 0,
  total_bold: 0,
  num_ventas: 0,
};

/**
 * Clasifica un `metodo_pago` de texto libre en uno de los tres buckets del
 * corte. Normaliza con `.toLowerCase()` + `.trim()` y admite variaciones/alias
 * (efectivo/cash, nequi/daviplata/transferencia, bold/tarjeta/datáfono). Un
 * método desconocido devuelve `null`: sigue sumando al total general y al conteo
 * de ventas, pero no se atribuye a ningún método concreto (no lo inventamos).
 */
function clasificarMetodo(metodoPago: string): "efectivo" | "nequi" | "bold" | null {
  const m = metodoPago.trim().toLowerCase();
  if (!m) return null;
  if (m.includes("efectivo") || m.includes("cash")) return "efectivo";
  if (m.includes("nequi") || m.includes("daviplata") || m.includes("transfer")) return "nequi";
  if (
    m.includes("bold") ||
    m.includes("tarjeta") ||
    m.includes("datafono") ||
    m.includes("datáfono") ||
    m.includes("card")
  ) {
    return "bold";
  }
  return null;
}

/**
 * Ventas de HOY agrupadas por método de pago, leídas DIRECTAMENTE de la tabla
 * `ventas` (no de `cortes_caja`). Esto hace que el desglose del dashboard y el
 * cierre de turno NO dependan de que exista una fila de corte para hoy: mientras
 * haya ventas registradas, el cuadre se muestra.
 *
 * DEFENSA EN PROFUNDIDAD: además de RLS, filtra explícitamente por la empresa de
 * la sesión viva (`getEmpresaIdActiva`) y por el rango local del día. Sin empresa
 * resuelta NO consulta → ceros (nunca ventas de otra empresa).
 */
export async function fetchVentasHoyPorMetodo(): Promise<VentasHoyPorMetodo> {
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return { ...VENTAS_HOY_VACIO };

  const { inicio, fin } = rangoDiaHoy();
  const { data, error } = await supabase
    .from("ventas")
    .select("total, metodo_pago, created_at")
    .eq("empresa_id", empresaId)
    .gte("created_at", inicio)
    .lte("created_at", fin);
  if (error) {
    console.warn("[corte] No se pudieron leer las ventas de hoy:", error.message);
    return { ...VENTAS_HOY_VACIO };
  }

  const acc: VentasHoyPorMetodo = { ...VENTAS_HOY_VACIO };
  for (const raw of (data ?? []) as { total: number | string | null; metodo_pago: string | null }[]) {
    const monto = Number(raw.total ?? 0);
    if (!Number.isFinite(monto)) continue;
    acc.total_general += monto;
    acc.num_ventas += 1;
    const bucket = clasificarMetodo(raw.metodo_pago ?? "");
    if (bucket === "efectivo") acc.total_efectivo += monto;
    else if (bucket === "nequi") acc.total_nequi += monto;
    else if (bucket === "bold") acc.total_bold += monto;
  }
  return acc;
}

/**
 * PostgREST puede serializar `numeric` como string para preservar precisión.
 * Normalizamos a `number` para poder sumar/formatear sin sorpresas.
 */
export function mapCorte(raw: Record<string, unknown> | null | undefined): CorteCaja | null {
  if (!raw) return null;
  const n = (v: unknown) => (v == null ? 0 : Number(v));
  // Nullable: distingue "aún sin cerrar" (null) de "cerrado en cero" (0).
  const nOrNull = (v: unknown) => (v == null ? null : Number(v));
  const sOrNull = (v: unknown) => (v == null ? null : String(v));
  return {
    id: String(raw.id ?? ""),
    empresa_id: String(raw.empresa_id ?? ""),
    fecha: String(raw.fecha ?? ""),
    total_general: n(raw.total_general),
    total_efectivo: n(raw.total_efectivo),
    total_nequi: n(raw.total_nequi),
    total_bold: n(raw.total_bold),
    num_ventas: n(raw.num_ventas),
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? ""),
    base_inicial: n(raw.base_inicial),
    estado: raw.estado === "cerrada" ? "cerrada" : "abierta",
    abierto_at: sOrNull(raw.abierto_at),
    efectivo_contado: nOrNull(raw.efectivo_contado),
    diferencia: nOrNull(raw.diferencia),
    cerrado_at: sOrNull(raw.cerrado_at),
  };
}

/** Corte del día de hoy (o null si aún no hay ventas hoy). */
export async function fetchCorteHoy(): Promise<CorteCaja | null> {
  // DEFENSA EN PROFUNDIDAD: además de RLS, filtramos explícitamente por la
  // empresa resuelta desde la SESIÓN VIVA (`mi_empresa()` vía getEmpresaIdActiva).
  // Sin empresa resuelta NO se consulta → null (nunca cortes de otra empresa).
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return null;

  const { data, error } = await supabase
    .from("cortes_caja")
    .select("*")
    .eq("empresa_id", empresaId)
    .eq("fecha", hoyISO())
    .maybeSingle();
  if (error) {
    console.warn("[corte] No se pudo leer el corte de hoy:", error.message);
    return null;
  }
  return mapCorte(data as Record<string, unknown> | null);
}

/** Historial de cortes recientes (más reciente primero) para el cierre de turno. */
export async function fetchCortes(limit = 30): Promise<CorteCaja[]> {
  // DEFENSA EN PROFUNDIDAD: el histórico de "Cierre de turno" de Reportes filtra
  // por la empresa de la sesión viva, no solo por RLS. Sin empresa → vacío.
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return [];

  const { data, error } = await supabase
    .from("cortes_caja")
    .select("*")
    .eq("empresa_id", empresaId)
    .order("fecha", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[corte] No se pudo leer el historial de cortes:", error.message);
    return [];
  }
  return (data ?? []).map((r) => mapCorte(r as Record<string, unknown>)!).filter(Boolean);
}
