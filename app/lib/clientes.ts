/**
 * CRM de Clientes + Sistema de Fiados — acceso a datos (Supabase).
 *
 * Fuente de verdad: tablas `public.clientes` y `public.fiados`. El aislamiento por
 * empresa lo impone RLS (`empresa_id = public.mi_empresa()`) y, como DEFENSA EN
 * PROFUNDIDAD, cada lectura filtra además por el `empresa_id` de la sesión VIVA
 * (`getEmpresaIdActiva()`); sin empresa resuelta NO se consulta y se devuelve
 * vacío. Mismo patrón que `resumen.ts`/`corte.ts`.
 *
 * El SALDO PENDIENTE de cada cliente se lee DESNORMALIZADO de
 * `clientes.saldo_pendiente` (lo mantiene la RPC `registrar_fiado`), por lo que el
 * directorio se puebla con una sola consulta ligera, sin agregaciones ni joins.
 *
 * Requiere la migración `supabase/2026-08-clientes-y-fiados.sql`. Si aún no se ha
 * corrido, las tablas no existen: las lecturas detectan ese caso y devuelven un
 * estado vacío marcado (`falta_migracion`) para que la UI muestre una guía en vez
 * de romperse. Ver [[schema-migration-workflow]].
 */

import { supabase, getEmpresaIdActiva } from "./auth";

/** Cliente del CRM, tal como lo consume el directorio. */
export type Cliente = {
  id: string;
  nombre: string;
  email: string | null;
  telefono: string | null;
  direccion: string | null;
  notas: string | null;
  /** Cuánto debe el cliente HOY (fiado). 0 = al día. */
  saldo_pendiente: number;
  created_at: string;
};

/** Tipo de movimiento del libro de fiados. */
export type TipoMovimiento = "cargo" | "abono";

/** Movimiento del libro de cuentas por cobrar de un cliente. */
export type MovimientoFiado = {
  id: string;
  cliente_id: string;
  tipo: TipoMovimiento;
  monto: number;
  descripcion: string | null;
  venta_id: string | null;
  created_at: string;
};

/** Fila cruda de `public.clientes` (numeric puede llegar como string). */
type ClienteRow = {
  id: string;
  nombre: string;
  email: string | null;
  telefono: string | null;
  direccion: string | null;
  notas: string | null;
  saldo_pendiente: number | string | null;
  created_at: string;
};

/**
 * Códigos que indican que la migración de clientes/fiados aún NO se ha corrido:
 *  - 42P01: tabla inexistente (Postgres).
 *  - PGRST205: PostgREST no encuentra la tabla en el esquema expuesto.
 */
function esFaltaDeMigracion(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

/** Normaliza una fila cruda de cliente al tipo del CRM. */
function mapCliente(row: ClienteRow): Cliente {
  return {
    id: row.id,
    nombre: row.nombre,
    email: row.email,
    telefono: row.telefono,
    direccion: row.direccion,
    notas: row.notas,
    saldo_pendiente: Number(row.saldo_pendiente ?? 0),
    created_at: row.created_at,
  };
}

export type FetchClientesResult = {
  clientes: Cliente[];
  /** true si la migración 2026-08-clientes-y-fiados.sql todavía no se ha corrido. */
  faltaMigracion: boolean;
};

/**
 * Directorio de clientes de la empresa autenticada, en orden alfabético. Aislado
 * por RLS. Si la tabla aún no existe, devuelve `faltaMigracion: true` (no un error)
 * para que la UI guíe a correr el SQL.
 */
export async function fetchClientes(): Promise<FetchClientesResult> {
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return { clientes: [], faltaMigracion: false }; // sin empresa → vacío (aislamiento)

  const { data, error } = await supabase
    .from("clientes")
    .select("id, nombre, email, telefono, direccion, notas, saldo_pendiente, created_at")
    .eq("empresa_id", empresaId)
    .order("nombre", { ascending: true });

  if (error) {
    if (esFaltaDeMigracion(error.code)) {
      console.warn(
        "[clientes] La tabla `clientes` no existe todavía; corre " +
          "supabase/2026-08-clientes-y-fiados.sql en Supabase para activar el CRM.",
      );
      return { clientes: [], faltaMigracion: true };
    }
    console.warn("[clientes] No se pudieron leer los clientes:", error.message);
    return { clientes: [], faltaMigracion: false };
  }

  return { clientes: (data ?? []).map((r) => mapCliente(r as ClienteRow)), faltaMigracion: false };
}

/**
 * Libro de movimientos (cargos y abonos) de UN cliente, del más reciente al más
 * antiguo. Aislado por RLS; devuelve [] sin sesión o ante error.
 */
export async function fetchMovimientosFiado(clienteId: string): Promise<MovimientoFiado[]> {
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return []; // sin empresa → vacío (aislamiento)

  const { data, error } = await supabase
    .from("fiados")
    .select("id, cliente_id, tipo, monto, descripcion, venta_id, created_at")
    .eq("empresa_id", empresaId)
    .eq("cliente_id", clienteId)
    .order("created_at", { ascending: false });

  if (error) {
    console.warn("[clientes] No se pudo leer el libro de fiados:", error.message);
    return [];
  }

  return (data ?? []).map((r) => {
    const row = r as {
      id: string;
      cliente_id: string;
      tipo: TipoMovimiento;
      monto: number | string;
      descripcion: string | null;
      venta_id: string | null;
      created_at: string;
    };
    return {
      id: row.id,
      cliente_id: row.cliente_id,
      tipo: row.tipo,
      monto: Number(row.monto ?? 0),
      descripcion: row.descripcion,
      venta_id: row.venta_id,
      created_at: row.created_at,
    };
  });
}

export type RegistrarFiadoInput = {
  clienteId: string;
  tipo: TipoMovimiento;
  /** Monto en COP, siempre positivo. */
  monto: number;
  descripcion?: string | null;
  /** Venta que originó el fiado (opcional, para enlazar desde POS/ventas). */
  ventaId?: string | null;
};

export type RegistrarFiadoResult =
  | { ok: true; saldoPendiente: number; movimientoId: string }
  | { ok: false; error: string };

/**
 * Registra un movimiento de fiado (cargo = fiar mercancía, abono = pago) vía la
 * RPC atómica `registrar_fiado`, que inserta el movimiento y actualiza
 * `clientes.saldo_pendiente` en la misma transacción. Devuelve el saldo nuevo para
 * refrescar la UI sin volver a consultar.
 */
export async function registrarFiado(input: RegistrarFiadoInput): Promise<RegistrarFiadoResult> {
  const { data, error } = await supabase.rpc("registrar_fiado", {
    p_cliente_id: input.clienteId,
    p_tipo: input.tipo,
    p_monto: input.monto,
    p_descripcion: input.descripcion ?? null,
    p_venta_id: input.ventaId ?? null,
  });

  if (error) {
    console.error("[clientes] No se pudo registrar el movimiento de fiado:", error.message);
    return { ok: false, error: error.message };
  }

  const row = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    saldoPendiente: Number(row.saldo_pendiente ?? 0),
    movimientoId: String(row.movimiento_id ?? ""),
  };
}
