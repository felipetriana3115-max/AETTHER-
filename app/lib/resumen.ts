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
 *
 * El TOTAL de ventas NO se suma en el cliente: lo calcula el servidor vía la RPC
 * `total_ventas_empresa()` (ver fetchTotalVentasEmpresa). Así todos los
 * dispositivos ven la misma cifra, sin depender de localStorage ni de pagos que
 * solo vivían en memoria de un dispositivo.
 */

import { supabase } from "./auth";
import type { InventoryItem, Sale } from "./data-model";

/** Fila cruda de `public.ventas` (solo las columnas que consumimos). */
type VentaRow = {
  id: string;
  total: number | string; // numeric puede llegar como string desde PostgREST
  metodo_pago: string;
  created_at: string; // ISO timestamptz
};

/** Fila cruda de `public.productos` (solo las columnas que consumimos). */
type ProductoRow = {
  id: number;
  descripcion: string;
  precio_venta: number | string; // numeric puede llegar como string desde PostgREST
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
 * Total EXACTO de ventas de la empresa autenticada, calculado en el servidor por
 * la RPC `total_ventas_empresa()` (SUM sobre `public.ventas`, aislada por RLS).
 *
 * Es la ÚNICA fuente de verdad del monto que muestra el dashboard: no depende de
 * localStorage ni de estado en memoria, así que es idéntico en cada dispositivo.
 * Sin sesión (o ante error) devuelve 0, nunca un número inventado en el cliente.
 */
export async function fetchTotalVentasEmpresa(): Promise<number> {
  const { data, error } = await supabase.rpc("total_ventas_empresa");

  if (error) {
    console.warn("[resumen] No se pudo leer el total de ventas:", error.message);
    return 0;
  }

  // numeric puede llegar como string desde PostgREST; normalizamos a number.
  return Number(data ?? 0);
}

/**
 * Inventario de la empresa autenticada, mapeado a `InventoryItem`. Aislado por
 * RLS. `productos` no tiene categoría ni stock mínimo, así que usamos valores
 * por defecto para las métricas de "stock bajo".
 */
export async function fetchProductosEmpresa(): Promise<InventoryItem[]> {
  const { data, error } = await supabase
    .from("productos")
    .select("id, descripcion, precio_venta, stock_actual, codigo_barras")
    .order("descripcion", { ascending: true });

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
      name: row.descripcion,
      category: "General",
      stock: row.stock_actual ?? 0,
      minStock: 10,
      price: Number(row.precio_venta ?? 0),
    };
  });
}

// ── Integración Compras ⇄ Inventario ─────────────────────────────────────────

/**
 * Producto del catálogo, tal como lo consume el selector de órdenes de compra.
 * Mantiene el `codigo_barras` REAL (sin el fallback `PRD-<id>` de InventoryItem),
 * porque al recibir la orden hay que mapear la referencia existente sin inventarla.
 */
export type ProductoCatalogo = {
  id: number;
  descripcion: string;
  codigo_barras: string | null;
  precio_costo: number;
};

/**
 * Catálogo de productos de la empresa autenticada para poblar el <select> del
 * formulario de compras. Aislado por RLS; devuelve [] sin sesión o ante error.
 */
export async function fetchCatalogoProductos(): Promise<ProductoCatalogo[]> {
  const { data, error } = await supabase
    .from("productos")
    .select("id, descripcion, codigo_barras, precio_costo")
    .order("descripcion", { ascending: true });

  if (error) {
    console.warn("[resumen] No se pudo cargar el catálogo de productos:", error.message);
    return [];
  }

  return (data ?? []).map((p) => {
    const row = p as {
      id: number;
      descripcion: string;
      codigo_barras: string | null;
      precio_costo: number | string | null;
    };
    return {
      id: row.id,
      descripcion: row.descripcion,
      codigo_barras: row.codigo_barras,
      precio_costo: Number(row.precio_costo ?? 0),
    };
  });
}

/** Datos mínimos para impactar el inventario al recibir una orden de compra. */
export type RecibirCompraInput = {
  /** Id del producto seleccionado del catálogo, o null/omitido si es nuevo. */
  productoId?: number | null;
  descripcion: string;
  codigoBarras?: string | null;
  unidades: number;
  /** Costo TOTAL de la orden (se reparte por unidad al dar de alta un producto). */
  costo: number;
};

/**
 * Suma las unidades recibidas al `stock_actual` del producto correspondiente vía
 * la RPC atómica `recibir_compra` (SECURITY DEFINER, aislada por `mi_empresa()`).
 * Si el producto no existía en el catálogo, la RPC lo crea con el stock inicial.
 * Devuelve `true` si el inventario quedó impactado, `false` si hubo error.
 */
export async function recibirCompra(input: RecibirCompraInput): Promise<boolean> {
  const { error } = await supabase.rpc("recibir_compra", {
    p_producto_id: input.productoId ?? null,
    p_descripcion: input.descripcion,
    p_codigo_barras: input.codigoBarras ?? null,
    p_unidades: input.unidades,
    p_costo: input.costo,
  });

  if (error) {
    console.error(
      "[resumen] No se pudo impactar el inventario al recibir la compra:",
      error.message,
    );
    return false;
  }
  return true;
}
