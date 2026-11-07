/**
 * Modo Sin Internet — catálogo de productos con fallback local.
 *
 * Estrategia "online-first con red de seguridad":
 *  - Con conexión, la fuente de verdad sigue siendo Supabase (RLS aísla por
 *    empresa). Cada lectura refresca de paso el espejo local en Dexie.
 *  - Sin conexión, se responde desde Dexie con el último catálogo cacheado.
 *
 * Así el scanner y el grid de frecuentes del POS funcionan igual con o sin red,
 * sin duplicar la lógica de consulta en cada componente.
 */

import { supabase, getEmpresaIdActiva } from "../auth";
import { getDB, type ProductoLocal } from "./db";

/** ¿Hay conexión de red? En SSR asumimos que sí (no hay `navigator`). */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

/**
 * Columnas reales de `public.productos` con los alias que usa el POS.
 *
 * `imagen_url` requiere la migración `2026-08-imagen-productos.sql`; sin ella
 * PostgREST responde 42703 y el catálogo no cargaría.
 */
const SELECT_PRODUCTO =
  "id, nombre:descripcion, precio:precio_venta, codigo_barras, stock_actual, imagen_url";

/**
 * Nombre de la columna de borrado lógico de `public.productos`
 * (`2026-11-soft-delete-productos.sql`): NULL = producto vivo.
 *
 * TODAS las lecturas del catálogo filtran `deleted_at is null`, que es justo el
 * predicado del índice único PARCIAL `productos_empresa_codigo_barras_vivos_uniq`.
 * Sin este filtro un producto archivado sigue "existiendo" para la app: el POS lo
 * ofrecería y —el bug que esto cierra— la validación de duplicados del alta
 * bloquearía reutilizar su código de barras, aunque el INSERT sí lo permitiría.
 *
 * Nota: no filtramos en el espejo de Dexie, que no guarda la columna; basta con
 * no cachear nunca una fila archivada (ver `cacheCatalogo`/`findByBarcode`).
 */
const COL_BORRADO = "deleted_at";

/** Normaliza una fila de PostgREST (numeric puede llegar como string). */
function normalizar(row: Record<string, unknown>): ProductoLocal {
  return {
    id: row.id as string | number,
    nombre: String(row.nombre ?? ""),
    precio: Number(row.precio ?? 0),
    codigo_barras: (row.codigo_barras as string | null) ?? null,
    stock_actual: Number(row.stock_actual ?? 0),
    // Cadena vacía → null: para la UI "sin imagen" es un solo caso.
    imagen_url: (row.imagen_url as string | null) || null,
  };
}

/**
 * Descarga el catálogo completo de la empresa y lo guarda en Dexie para uso sin
 * conexión. Se llama al abrir el POS cuando hay red. Reemplaza el espejo local
 * por completo para no dejar productos fantasma que ya no existen.
 *
 * Devuelve el nº de productos cacheados, o -1 si no se pudo (sin red / error).
 */
export async function cacheCatalogo(): Promise<number> {
  const db = getDB();
  if (!db || !isOnline()) return -1;

  // DEFENSA EN PROFUNDIDAD: además de RLS, filtramos por la empresa de la sesión
  // viva para no cachear jamás productos de otro tenant en el espejo local.
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return -1;

  const { data, error } = await supabase
    .from("productos")
    .select(SELECT_PRODUCTO)
    .eq("empresa_id", empresaId)
    .is(COL_BORRADO, null) // solo catálogo vivo: los archivados no se espejan
    .order("descripcion", { ascending: true });

  if (error || !data) {
    console.warn("[offline] No se pudo cachear el catálogo:", error?.message);
    return -1;
  }

  const productos = (data as Record<string, unknown>[]).map(normalizar);
  await db.transaction("rw", db.productos, async () => {
    await db.productos.clear();
    await db.productos.bulkPut(productos);
  });
  return productos.length;
}

/**
 * Busca un producto VIVO por código de barras EXACTO. Con red consulta Supabase
 * (y cachea el resultado); sin red o ante error de red, cae al espejo local.
 * Devuelve null si no existe en ninguno.
 *
 * Un producto con `deleted_at` no cuenta como existente: su código vuelve a
 * estar libre, así que esto devuelve null y el alta puede reutilizarlo.
 */
export async function findByBarcode(codigo: string): Promise<ProductoLocal | null> {
  const valor = codigo.trim();
  if (!valor) return null;
  const db = getDB();

  // Solo consultamos online si hay empresa resuelta; sin ella caemos al espejo
  // local (aislamiento: nunca leemos productos de otro tenant desde el servidor).
  const empresaId = isOnline() ? await getEmpresaIdActiva() : null;
  if (empresaId) {
    try {
      const { data, error } = await supabase
        .from("productos")
        .select(SELECT_PRODUCTO)
        .eq("empresa_id", empresaId)
        .eq("codigo_barras", valor)
        .is(COL_BORRADO, null) // un archivado NO ocupa el código
        .limit(1)
        .maybeSingle();
      if (!error) {
        // El servidor manda: si no hay fila viva, el código está libre. No se
        // consulta el espejo local, que puede traer una copia previa al archivado
        // (sería el falso "ya existe" que bloqueaba el alta).
        if (!data) {
          if (db) await db.productos.where("codigo_barras").equals(valor).delete();
          return null;
        }
        const prod = normalizar(data as Record<string, unknown>);
        if (db) await db.productos.put(prod); // mantiene el espejo fresco
        return prod;
      }
      // error de consulta → intentamos el fallback local antes de rendirnos.
    } catch {
      // caída de red pese a navigator.onLine → fallback local.
    }
  }

  if (!db) return null;
  return (await db.productos.where("codigo_barras").equals(valor).first()) ?? null;
}

/**
 * Productos para el grid táctil de "frecuentes". Con red, los primeros N por
 * nombre desde Supabase; sin red, desde el espejo local.
 */
export async function getFrecuentes(limit = 12): Promise<ProductoLocal[]> {
  const db = getDB();

  // Igual que findByBarcode: sin empresa resuelta no consultamos online.
  const empresaId = isOnline() ? await getEmpresaIdActiva() : null;
  if (empresaId) {
    try {
      const { data, error } = await supabase
        .from("productos")
        .select(SELECT_PRODUCTO)
        .eq("empresa_id", empresaId)
        .is(COL_BORRADO, null) // el grid del POS no ofrece productos archivados
        .order("descripcion", { ascending: true })
        .limit(limit);
      if (!error && data) {
        return (data as Record<string, unknown>[]).map(normalizar);
      }
    } catch {
      // fallback local abajo.
    }
  }

  if (!db) return [];
  return db.productos.orderBy("id").limit(limit).toArray();
}

/**
 * Descuenta stock en el espejo local tras un cobro sin conexión, para que el
 * grid y las validaciones locales reflejen el inventario disponible mientras no
 * haya red. El servidor es la fuente de verdad al sincronizar.
 */
export async function descontarStockLocal(
  items: { id: string | number; qty: number; esComun: boolean }[],
): Promise<void> {
  const db = getDB();
  if (!db) return;
  await db.transaction("rw", db.productos, async () => {
    for (const it of items) {
      if (it.esComun) continue;
      const prod = await db.productos.get(it.id);
      if (prod) {
        await db.productos.put({ ...prod, stock_actual: prod.stock_actual - it.qty });
      }
    }
  });
}
