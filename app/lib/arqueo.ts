/**
 * Arqueo y cierre de caja (Caja Chica) — capa de datos sobre Supabase.
 *
 * Reutiliza la fila diaria de `public.cortes_caja` (la misma que alimenta el
 * POS con las ventas) ampliada con los campos del turno, más la tabla
 * `public.movimientos_caja` para las entradas/salidas manuales de efectivo.
 * Ver migración 2026-07-arqueo-caja.sql.
 *
 * El aislamiento por empresa lo impone RLS + `mi_empresa()` en las RPC; el
 * frontend nunca envía `empresa_id`. El cálculo del esperado y la diferencia
 * ocurre SOLO en la RPC `cerrar_caja` (cierre ciego): la UI no conoce el
 * efectivo de ventas ni el esperado hasta que el servidor los revela.
 */

import { supabase } from "./auth";
import { hoyISO, mapCorte, type CorteCaja } from "./corte";

export type TipoMovimiento = "ingreso" | "egreso";

export type MovimientoCaja = {
  id: string;
  empresa_id: string;
  fecha: string; // YYYY-MM-DD
  tipo: TipoMovimiento;
  monto: number;
  concepto: string;
  created_at: string;
};

/** Desglose que devuelve el cierre ciego, revelado recién al procesar. */
export type CierreResultado = {
  corte: CorteCaja | null;
  base_inicial: number;
  ventas_efectivo: number;
  ingresos: number;
  egresos: number;
  esperado: number;
  efectivo_contado: number;
  diferencia: number; // + sobrante · − faltante
};

/** Normaliza una fila de `movimientos_caja` (numeric puede venir como string). */
export function mapMovimiento(raw: Record<string, unknown>): MovimientoCaja {
  return {
    id: String(raw.id ?? ""),
    empresa_id: String(raw.empresa_id ?? ""),
    fecha: String(raw.fecha ?? ""),
    tipo: raw.tipo === "ingreso" ? "ingreso" : "egreso",
    monto: Number(raw.monto ?? 0),
    concepto: String(raw.concepto ?? ""),
    created_at: String(raw.created_at ?? ""),
  };
}

/** Estado de la caja de hoy (o null si aún no hay fila para el día). */
export async function fetchCorteHoy(): Promise<CorteCaja | null> {
  const { data, error } = await supabase
    .from("cortes_caja")
    .select("*")
    .eq("fecha", hoyISO())
    .maybeSingle();
  if (error) {
    console.warn("[arqueo] No se pudo leer la caja de hoy:", error.message);
    return null;
  }
  return mapCorte(data as Record<string, unknown> | null);
}

/** Movimientos manuales (ingresos/egresos) de hoy, más recientes primero. */
export async function fetchMovimientosHoy(): Promise<MovimientoCaja[]> {
  const { data, error } = await supabase
    .from("movimientos_caja")
    .select("*")
    .eq("fecha", hoyISO())
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("[arqueo] No se pudieron leer los movimientos de hoy:", error.message);
    return [];
  }
  return (data ?? []).map((r) => mapMovimiento(r as Record<string, unknown>));
}

/** Abre la caja del día declarando la base inicial en efectivo. */
export async function abrirCaja(base: number): Promise<CorteCaja | null> {
  const { data, error } = await supabase.rpc("abrir_caja", { p_base: base });
  if (error) throw error;
  return mapCorte(data as Record<string, unknown> | null);
}

/**
 * Registra un movimiento manual de efectivo. `empresa_id` y `fecha` los pone la
 * BD por DEFAULT (bajo RLS), así que no viajan desde el cliente.
 */
export async function registrarMovimiento(
  tipo: TipoMovimiento,
  monto: number,
  concepto: string,
): Promise<MovimientoCaja> {
  const { data, error } = await supabase
    .from("movimientos_caja")
    .insert({ tipo, monto, concepto })
    .select()
    .single();
  if (error) throw error;
  return mapMovimiento(data as Record<string, unknown>);
}

/**
 * Cierre ciego (Reporte Z): envía SOLO el efectivo contado; el servidor calcula
 * el esperado y la diferencia y devuelve el desglose para revelarlo.
 */
export async function cerrarCaja(efectivoContado: number): Promise<CierreResultado> {
  const { data, error } = await supabase.rpc("cerrar_caja", {
    p_efectivo_contado: efectivoContado,
  });
  if (error) throw error;
  const p = (data ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (v == null ? 0 : Number(v));
  return {
    corte: mapCorte(p.corte as Record<string, unknown> | null),
    base_inicial: n(p.base_inicial),
    ventas_efectivo: n(p.ventas_efectivo),
    ingresos: n(p.ingresos),
    egresos: n(p.egresos),
    esperado: n(p.esperado),
    efectivo_contado: n(p.efectivo_contado),
    diferencia: n(p.diferencia),
  };
}
