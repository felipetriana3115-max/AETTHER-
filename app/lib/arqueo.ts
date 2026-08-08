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

import { supabase, getEmpresaIdActiva } from "./auth";
import { mapCorte, hoyISO, type CorteCaja } from "./corte";

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

/** Estado del arqueo del día: el corte (o null) + sus movimientos manuales. */
export type ArqueoHoy = { corte: CorteCaja | null; movimientos: MovimientoCaja[] };

/**
 * Lee el arqueo del día en UNA sola llamada (RPC `arqueo_hoy`). El servidor fija
 * la fecha con `hoy_negocio()` (America/Bogota), así que el filtro por día es
 * autoritativo: nunca arrastra registros de jornadas anteriores. `corte` es null
 * si aún no hay caja para hoy; `movimientos` viene del más reciente al más viejo.
 */
export async function fetchArqueoHoy(): Promise<ArqueoHoy> {
  const { data, error } = await supabase.rpc("arqueo_hoy");
  if (error) {
    console.warn("[arqueo] No se pudo leer el arqueo de hoy:", error.message);
    return { corte: null, movimientos: [] };
  }
  const p = (data ?? {}) as Record<string, unknown>;
  const movs = Array.isArray(p.movimientos) ? p.movimientos : [];
  return {
    corte: mapCorte(p.corte as Record<string, unknown> | null),
    movimientos: movs.map((r) => mapMovimiento(r as Record<string, unknown>)),
  };
}

/** Abre la caja del día declarando la base inicial en efectivo. */
export async function abrirCaja(base: number): Promise<CorteCaja | null> {
  const { data, error } = await supabase.rpc("abrir_caja", { p_base: base });
  if (error) throw error;
  return mapCorte(data as Record<string, unknown> | null);
}

/**
 * Registra un movimiento manual de efectivo.
 *
 * DEFENSA EN PROFUNDIDAD: la BD tiene DEFAULTs (`empresa_id := mi_empresa()`,
 * `fecha := hoy_negocio()`), pero NO nos apoyamos solo en ellos. Fijamos ambos
 * desde la sesión viva —igual que `fetchCorteHoy` / `fetchVentasHoyPorMetodo`—
 * por dos motivos:
 *   • Si el usuario-tenant tuviera `empresa_id` nulo, el DEFAULT resolvería a
 *     null y la fila se rechazaría (o caería fuera del filtro de RLS) → el
 *     movimiento "desaparecía" al recargar. Enviarlo explícito lo hace robusto.
 *   • `hoyISO()` (America/Bogota) coincide EXACTAMENTE con `hoy_negocio()`, así
 *     que la fila cae SIEMPRE en el mismo día de negocio que luego lee
 *     `arqueo_hoy`, sin depender de que el DEFAULT de `fecha` esté migrado.
 */
export async function registrarMovimiento(
  tipo: TipoMovimiento,
  monto: number,
  concepto: string,
): Promise<MovimientoCaja> {
  const empresa_id = await getEmpresaIdActiva();
  if (!empresa_id) {
    throw new Error("No hay una empresa asociada a la sesión. Vuelve a iniciar sesión.");
  }

  const { data, error } = await supabase
    .from("movimientos_caja")
    .insert({ tipo, monto, concepto, empresa_id, fecha: hoyISO() })
    .select()
    .single();
  if (error) {
    // Deja rastro del error crudo de Supabase (código + mensaje) para distinguir
    // RLS (42501), columna inexistente (42703), grant faltante, etc.
    console.error("[arqueo] No se pudo registrar el movimiento:", error);
    throw error;
  }
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
