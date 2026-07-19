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

import { supabase } from "./auth";

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
};

/**
 * Fecha de hoy en horario LOCAL como `YYYY-MM-DD`. No usamos `toISOString()`
 * porque devuelve UTC y desplazaría la fecha en zonas negativas (Colombia UTC-5)
 * cerca de la medianoche.
 */
export function hoyISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * PostgREST puede serializar `numeric` como string para preservar precisión.
 * Normalizamos a `number` para poder sumar/formatear sin sorpresas.
 */
export function mapCorte(raw: Record<string, unknown> | null | undefined): CorteCaja | null {
  if (!raw) return null;
  const n = (v: unknown) => (v == null ? 0 : Number(v));
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
  };
}

/** Corte del día de hoy (o null si aún no hay ventas hoy). */
export async function fetchCorteHoy(): Promise<CorteCaja | null> {
  const { data, error } = await supabase
    .from("cortes_caja")
    .select("*")
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
  const { data, error } = await supabase
    .from("cortes_caja")
    .select("*")
    .order("fecha", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[corte] No se pudo leer el historial de cortes:", error.message);
    return [];
  }
  return (data ?? []).map((r) => mapCorte(r as Record<string, unknown>)!).filter(Boolean);
}
