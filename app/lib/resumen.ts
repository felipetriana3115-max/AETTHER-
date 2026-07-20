/**
 * Resumen del ERP — lectura del estado real de la empresa desde Supabase.
 *
 * Fuente de verdad: tablas `public.ventas` y `public.productos`. El aislamiento
 * por empresa lo impone RLS (`empresa_id = public.mi_empresa()`), que resuelve la
 * empresa del usuario autenticado desde `public.usuarios` vía `auth.uid()`.
 *
 * POR ESO estas consultas NO llevan `.eq('empresa_id', ...)`: añadirlo obligaría a
 * leer el tenant en el cliente (localStorage/user_metadata), justo el patrón frágil
 * que vaciaba el dashboard en incógnito. Con una sesión activa, RLS ya devuelve
 * SOLO las filas de la empresa del usuario. Sin sesión, devuelve cero filas
 * (comportamiento correcto, no un fallo).
 */

import { supabase } from "./auth";
import type { InventoryItem, Sale } from "./demo-data";

/** Fila cruda de `public.ventas` (solo las columnas que consumimos). */
type VentaRow = {
  id: string;
  total: number | string; // numeric puede llegar como string desde PostgREST
  metodo_pago: string;
  created_at: string; // ISO timestamptz
};

/** Fila cruda de `public.productos`. */
type ProductoRow = {
  id: number;
  nombre: string;
  precio: number | string;
  stock_actual: number | null;
  codigo_barras: string | null;
};

/**
 * Ventas de la empresa autenticada, mapeadas al tipo `Sale` que consume el
 * dashboard. Aisladas por RLS. `date = created_at` (ISO) lo entiende
 * `monthIndexFromDate`, así que los ingresos mensuales se derivan solos.
 */
export async function fetchVentasEmpresa(): Promise<Sale[]> {
  const { data, error } = await supabase
    .from("ventas")
    .select("id, total, metodo_pago, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.warn("[resumen] No se pudieron leer las ventas:", error.message);
    return [];
  }

  return (data ?? []).map((v) => {
    const row = v as VentaRow;
    return {
      id: row.id,
      clientId: "", // el aislamiento lo impone RLS; el cliente no lo usa
      customer: "Venta POS",
      channel: "POS",
      method: row.metodo_pago,
      amount: Number(row.total ?? 0),
      status: "Pagado" as const,
      date: row.created_at,
    };
  });
}

/**
 * Inventario de la empresa autenticada, mapeado a `InventoryItem`. Aislado por
 * RLS. `productos` no tiene categoría ni stock mínimo, así que usamos valores
 * por defecto para las métricas de "stock bajo".
 */
export async function fetchProductosEmpresa(): Promise<InventoryItem[]> {
  const { data, error } = await supabase
    .from("productos")
    .select("id, nombre, precio, stock_actual, codigo_barras")
    .order("nombre", { ascending: true });

  if (error) {
    console.warn("[resumen] No se pudieron leer los productos:", error.message);
    return [];
  }

  return (data ?? []).map((p) => {
    const row = p as ProductoRow;
    return {
      id: row.id,
      clientId: "",
      sku: row.codigo_barras ?? `PRD-${row.id}`,
      name: row.nombre,
      category: "General",
      stock: row.stock_actual ?? 0,
      minStock: 10,
      price: Number(row.precio ?? 0),
    };
  });
}
