/**
 * Resumen del ERP — lectura del estado real de la empresa desde Supabase.
 *
 * Fuente de verdad: tablas `public.ventas` y `public.productos`. El aislamiento
 * por empresa lo impone RLS (`empresa_id = public.mi_empresa()`), que resuelve la
 * empresa del usuario autenticado desde `public.usuarios` vía `auth.uid()`.
 *
 * DEFENSA EN PROFUNDIDAD: además de RLS, cada consulta filtra explícitamente por
 * `empresa_id` resuelto desde la SESIÓN VIVA (`getEmpresaIdActiva()`, que lee
 * `usuarios` por `auth.uid()`), no desde localStorage. Así el filtro no depende de
 * un caché que pueda quedar obsoleto y no reintroduce la fragilidad de incógnito:
 * si no hay sesión/empresa, `empresaId` es null → la consulta NO se ejecuta y se
 * devuelve vacío/0. Nunca se devuelven filas de otra empresa.
 *
 * El TOTAL de ventas NO se suma en el cliente: lo calcula el servidor vía la RPC
 * `total_ventas_empresa()` (ver fetchTotalVentasEmpresa). Así todos los
 * dispositivos ven la misma cifra, sin depender de localStorage ni de pagos que
 * solo vivían en memoria de un dispositivo.
 */

import { supabase, getEmpresaIdActiva } from "./auth";
import type {
  InventoryItem,
  Sale,
  SaleStatus,
  Customer,
  Tier,
  PurchaseOrder,
  PurchaseStatus,
} from "./data-model";
import type {
  NewPurchase,
  NewInventoryItem,
  NewCustomer,
  NewSale,
} from "../components/DashboardProvider";

/** Fila cruda de `public.ventas` (solo las columnas que consumimos). */
export type VentaRow = {
  id: string;
  total: number | string; // numeric puede llegar como string desde PostgREST
  metodo_pago: string;
  created_at: string; // ISO timestamptz
  /** Comprador; null en las ventas del POS (mostrador). Columna nueva. */
  cliente_nombre?: string | null;
  /** Canal de venta; null = POS. Columna nueva. */
  canal?: string | null;
  /** Pagado | Pendiente | Reembolsado. Columna nueva, DEFAULT 'Pagado'. */
  estado?: SaleStatus | null;
  /** Reembolsado por devoluciones parciales. Columna nueva, DEFAULT 0. */
  devuelto_total?: number | string | null;
};

/**
 * Columnas de `ventas` que alimentan una fila del historial. Exportado porque
 * la búsqueda de ticket del POS (`buscarVentaPorFolio`) tiene que leer EXACTAMENTE
 * lo mismo para que la `Sale` que abre el modal sea indistinguible de la del
 * listado de Transacciones.
 */
export const VENTAS_SELECT_COMPLETO =
  "id, total, metodo_pago, created_at, cliente_nombre, canal, estado, devuelto_total";

/**
 * Normaliza una fila de `public.ventas` al `Sale` del dashboard.
 *
 * Las ventas del POS dejan `cliente_nombre`/`canal` nulos: ahí el valor por
 * defecto describe el origen real; una venta importada trae los del archivo.
 */
export function mapVenta(row: VentaRow): Sale {
  return {
    id: row.id,
    clientId: "", // el aislamiento lo impone RLS; el cliente no lo usa
    customer: row.cliente_nombre ?? "Venta POS",
    channel: row.canal ?? "POS",
    method: row.metodo_pago,
    amount: Number(row.total ?? 0),
    status: row.estado ?? "Pagado",
    date: row.created_at,
    refunded: Number(row.devuelto_total ?? 0),
  };
}

/** Fila cruda de `public.productos` (solo las columnas que consumimos). */
type ProductoRow = {
  id: number;
  descripcion: string;
  precio_venta: number | string; // numeric puede llegar como string desde PostgREST
  stock_actual: number | null;
  stock_minimo: number | string | null;
  codigo_barras: string | null;
  fecha_vencimiento?: string | null; // date de Postgres → "YYYY-MM-DD"; opcional
};

/**
 * Ventas de la empresa autenticada, mapeadas al tipo `Sale` que consume el
 * dashboard. Aisladas por RLS. `date = created_at` (ISO) lo entiende
 * `monthIndexFromDate`, así que los ingresos mensuales se derivan solos.
 */
const VENTAS_SELECT_BASE = "id, total, metodo_pago, created_at";

/**
 * `cliente_nombre`, `canal` y `estado` son columnas nuevas
 * (`supabase/2026-10-import-masivo-crm-ventas.sql`), igual que `devuelto_total`
 * (`supabase/2026-10-devoluciones-parciales.sql`). Mismo patrón defensivo que
 * `fetchProductosEmpresa`: si la migración aún no se ha corrido, PostgREST
 * devuelve 42703 y reintentamos sin ellas para que el dashboard siga funcionando
 * con los valores por defecto del POS.
 */
export async function fetchVentasEmpresa(): Promise<Sale[]> {
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return []; // sin empresa resuelta no se consulta (aislamiento)

  // El `id` desempata a propósito: el folio visible ("Factura #00291") es la
  // POSICIÓN en esta lista, así que el orden tiene que ser total y estable. Sin
  // el desempate, dos ventas con el mismo `created_at` podrían intercambiarse
  // entre consultas y el folio dejaría de apuntar siempre al mismo ticket (lo
  // busca `buscarVentaPorFolio`, que recorre el mismo orden al revés).
  const completo = await supabase
    .from("ventas")
    .select(VENTAS_SELECT_COMPLETO)
    .eq("empresa_id", empresaId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  const debeReintentar = completo.error?.code === "42703";
  if (debeReintentar) {
    console.warn(
      "[resumen] `ventas.cliente_nombre/canal/estado/devuelto_total` no existen todavía; corre " +
        "supabase/2026-10-import-masivo-crm-ventas.sql y " +
        "supabase/2026-10-devoluciones-parciales.sql.",
    );
  }
  const { data, error } = debeReintentar
    ? await supabase
        .from("ventas")
        .select(VENTAS_SELECT_BASE)
        .eq("empresa_id", empresaId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
    : completo;

  if (error) {
    console.warn("[resumen] No se pudieron leer las ventas:", error.message);
    return [];
  }

  return ((data ?? []) as VentaRow[]).map(mapVenta);
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
  // La RPC resuelve la empresa server-side vía mi_empresa(); aun así no la
  // invocamos sin sesión/empresa (defensa en profundidad): devolvemos 0.
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return 0;

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
 * RLS. Trae el `stock_minimo` REAL de la columna (con fallback 10 si viene nulo)
 * y la `fecha_vencimiento` para las alertas de "insumos por vencer".
 *
 * `fecha_vencimiento` es una columna nueva (ver `supabase/2026-07-vencimiento-
 * insumos.sql`). Si aún no se ha corrido esa migración, PostgREST devuelve el
 * error 42703 ("columna inexistente"); en ese caso REINTENTAMOS sin la columna
 * para que la alerta primaria de STOCK siga funcionando pase lo que pase. El
 * reintento ocurre a lo sumo una vez, así que la validación sigue siendo ligera.
 */
const PRODUCTOS_SELECT_BASE = "id, descripcion, precio_venta, stock_actual, stock_minimo, codigo_barras";

export async function fetchProductosEmpresa(): Promise<InventoryItem[]> {
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return []; // sin empresa resuelta no se consulta (aislamiento)

  // 1) Intento con `fecha_vencimiento` (feature completa).
  const conVenc = await supabase
    .from("productos")
    .select(`${PRODUCTOS_SELECT_BASE}, fecha_vencimiento`)
    .eq("empresa_id", empresaId)
    .order("descripcion", { ascending: true });

  // 2) Fallback: la migración de vencimiento aún no corre → reintenta sin ella.
  const debeReintentar = conVenc.error?.code === "42703";
  if (debeReintentar) {
    console.warn(
      "[resumen] `productos.fecha_vencimiento` no existe todavía; corre " +
        "supabase/2026-07-vencimiento-insumos.sql para activar la alerta de vencimiento.",
    );
  }
  const { data, error } = debeReintentar
    ? await supabase
        .from("productos")
        .select(PRODUCTOS_SELECT_BASE)
        .eq("empresa_id", empresaId)
        .order("descripcion", { ascending: true })
    : conVenc;

  if (error) {
    console.warn("[resumen] No se pudieron leer los productos:", error.message);
    return [];
  }

  return ((data ?? []) as ProductoRow[]).map((p) => {
    const row = p;
    const minStock = row.stock_minimo != null ? Number(row.stock_minimo) : 10;
    return {
      id: row.id,
      clientId: "",
      sku: row.codigo_barras ?? `PRD-${row.id}`,
      name: row.descripcion,
      category: "General",
      stock: row.stock_actual ?? 0,
      // Umbral real del catálogo; 10 solo cuando la fila no define stock_minimo.
      minStock: Number.isFinite(minStock) ? minStock : 10,
      price: Number(row.precio_venta ?? 0),
      expiryDate: row.fecha_vencimiento ?? null,
    };
  });
}

// ── Carga masiva (Excel/CSV → Supabase) ──────────────────────────────────────
//
// ESTE es el paso que faltaba en los tres módulos: antes el importador solo
// llenaba el estado de React, así que al recargar (o al volver a disparar la
// carga del provider) la lectura del servidor reemplazaba las filas importadas y
// parecía que la base de datos "las borraba". Nunca hubo un INSERT que RLS
// pudiera rechazar.
//
// Las tres importaciones comparten el mismo contrato y las mismas garantías:
//  · Una RPC `importar_*_masivo(jsonb)` por módulo, ATÓMICA (todo el lote o
//    nada) y **SECURITY INVOKER**, así que las políticas RLS de la tabla se
//    evalúan íntegras dentro de la escritura.
//  · El `empresa_id` lo estampa el SERVIDOR vía `mi_empresa()`; no viaja en el
//    payload, de modo que un cuerpo manipulado no puede escribir en otro tenant.
//    Aquí resolvemos la empresa solo para abortar temprano con un mensaje
//    legible en vez de disparar un error de RLS opaco (defensa en profundidad,
//    mismo patrón que `ProductForm` e `insertCompras`).
//  · Idempotencia: re-importar el mismo archivo no duplica nada.

/** Resultado real de una importación, tal como lo reporta el servidor. */
export type ResultadoImport = {
  /** Filas que viajaron al servidor. */
  recibidos: number;
  /** Filas utilizables (las vacías o sin nombre se descartan). */
  validos: number;
  /** Filas creadas. */
  insertados: number;
  /**
   * Filas que ya existían: ACTUALIZADAS en productos y clientes, OMITIDAS en
   * ventas (una venta histórica es inmutable, ver la RPC).
   */
  actualizados: number;
  /** Mensaje presentable si la carga falló; `null` si todo fue bien. */
  error: string | null;
};

const IMPORT_VACIO: ResultadoImport = {
  recibidos: 0,
  validos: 0,
  insertados: 0,
  actualizados: 0,
  error: null,
};

/**
 * Tamaño de lote. Cada llamada es ATÓMICA en el servidor, así que un archivo
 * grande se parte para no acercarse al statement timeout de PostgREST ni mandar
 * un cuerpo desmesurado. 413 referencias caben en dos lotes.
 */
const IMPORT_CHUNK = 250;

/** Error de PostgREST/Postgres, en lo que nos interesa para diagnosticar. */
type ErrorRpc = { code?: string; message: string; details?: string | null; hint?: string | null };

/** Datos de un módulo importable, para no repetir el runner tres veces. */
type ModuloImport = {
  /** Nombre de la RPC en Postgres. */
  rpc: string;
  /** Migración que la crea, para guiar al usuario si falta. */
  sql: string;
  /** Qué se está guardando, en los mensajes de error ("el inventario", …). */
  que: string;
};

/**
 * Ejecuta una importación por lotes contra su RPC y agrega los conteos reales
 * que devuelve el servidor. Nunca lanza: devuelve `error` poblado para que el
 * llamador decida (el provider lo convierte en excepción y el importador lo
 * pinta). El conteo NO se estima en el cliente — es el que reporta Postgres.
 */
async function ejecutarImport(
  modulo: ModuloImport,
  items: Record<string, unknown>[],
): Promise<ResultadoImport> {
  if (items.length === 0) return { ...IMPORT_VACIO };

  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) {
    const error =
      `Tu usuario no tiene una empresa asignada, así que ${modulo.que} importado ` +
      "no se puede guardar. Cierra sesión y vuelve a entrar; si persiste, hay que " +
      "reparar tu cuenta (usuarios.empresa_id está vacío).";
    console.error(`[import] ${modulo.rpc} abortada:`, error);
    return { ...IMPORT_VACIO, recibidos: items.length, error };
  }

  const total: ResultadoImport = { ...IMPORT_VACIO };

  for (let i = 0; i < items.length; i += IMPORT_CHUNK) {
    const lote = items.slice(i, i + IMPORT_CHUNK);

    const { data, error } = await supabase.rpc(modulo.rpc, { p_items: lote });

    if (error) {
      // Fallar en voz alta: antes esto era silencioso y el toast decía "éxito"
      // aunque no se hubiera guardado una sola fila.
      console.error(
        `[import] No se pudo guardar el lote (${modulo.rpc}):`,
        { code: error.code, message: error.message, details: error.details, hint: error.hint },
        `· ¿corriste supabase/${modulo.sql}?`,
      );
      return { ...total, recibidos: items.length, error: mensajeErrorImport(error, modulo) };
    }

    const r = (data ?? {}) as Record<string, unknown>;
    total.recibidos += Number(r.recibidos ?? lote.length);
    total.validos += Number(r.validos ?? 0);
    total.insertados += Number(r.insertados ?? 0);
    // Las ventas reportan `omitidas` en vez de `actualizados` (DO NOTHING).
    total.actualizados += Number(r.actualizados ?? r.omitidas ?? 0);
  }

  return total;
}

/** Traduce los fallos típicos de la importación a algo accionable. */
function mensajeErrorImport(error: ErrorRpc, modulo: ModuloImport): string {
  // PGRST202 / 42883: la RPC no existe todavía en esta base de datos.
  if (error.code === "PGRST202" || error.code === "42883") {
    return (
      `Falta la función ${modulo.rpc} en la base de datos. Ejecuta ` +
      `supabase/${modulo.sql} en el SQL Editor de Supabase.`
    );
  }
  // 42501 / 403: falta el GRANT EXECUTE para `authenticated`.
  if (error.code === "42501" || error.message.includes("permission denied for function")) {
    return (
      `Tu usuario no tiene permiso para ejecutar la importación. Falta el ` +
      `GRANT EXECUTE de ${modulo.rpc} a \`authenticated\`.`
    );
  }
  // 42P10: no existe el índice único destino del ON CONFLICT.
  if (error.code === "42P10") {
    return `Falta el índice único que usa ${modulo.rpc}. Ejecuta supabase/${modulo.sql}.`;
  }
  // 42P01 / PGRST205: falta la tabla entera (migración base sin correr).
  if (error.code === "42P01" || error.code === "PGRST205") {
    return `Falta una tabla que necesita la importación. Ejecuta supabase/${modulo.sql}.`;
  }
  return `No se pudo guardar ${modulo.que}: ${error.message}`;
}

const MODULO_PRODUCTOS: ModuloImport = {
  rpc: "importar_productos_masivo",
  sql: "2026-10-import-masivo-productos.sql",
  que: "el inventario",
};

const MODULO_CLIENTES: ModuloImport = {
  rpc: "importar_clientes_masivo",
  sql: "2026-10-import-masivo-crm-ventas.sql",
  que: "el directorio de clientes",
};

const MODULO_VENTAS: ModuloImport = {
  rpc: "importar_ventas_masivo",
  sql: "2026-10-import-masivo-crm-ventas.sql",
  que: "el histórico de ventas",
};

/**
 * Persiste en `public.productos` el inventario importado desde Excel/CSV.
 *
 * El upsert resuelve el conflicto por `(empresa_id, codigo_barras)`: re-importar
 * el mismo archivo actualiza las referencias en lugar de duplicarlas, y deja
 * intactas las columnas que el archivo no trae (precio_costo, margen,
 * departamento, imagen, vencimiento).
 */
export async function upsertProductosImportados(
  rows: NewInventoryItem[],
): Promise<ResultadoImport> {
  return ejecutarImport(
    MODULO_PRODUCTOS,
    rows.map((r) => ({
      sku: r.sku?.trim() || null,
      nombre: r.name.trim(),
      stock: r.stock,
      min_stock: r.minStock ?? 0,
      precio: r.price,
    })),
  );
}

/**
 * Persiste en `public.clientes` el directorio importado desde Excel/CSV.
 *
 * La RPC empareja por email (clave natural) y, cuando el archivo no lo trae, por
 * nombre normalizado; actualiza los que ya existen e inserta el resto. No se
 * crea una restricción única sobre el nombre a propósito: dos homónimos en un
 * mismo negocio son legítimos y romperían el alta manual del CRM.
 *
 * `saldo_pendiente` NUNCA se toca aquí: lo gobierna la RPC `registrar_fiado`.
 */
export async function importarClientes(rows: NewCustomer[]): Promise<ResultadoImport> {
  return ejecutarImport(
    MODULO_CLIENTES,
    rows.map((r) => ({
      nombre: r.name.trim(),
      email: r.email?.trim() || null,
      telefono: r.phone?.trim() || null,
      segmento: r.tier,
      pedidos: r.orders,
      total_gastado: r.totalSpent,
    })),
  );
}

/**
 * Persiste en `public.ventas` el histórico importado desde Excel/CSV.
 *
 * Idempotente por `(empresa_id, referencia)` con ON CONFLICT DO NOTHING: una
 * venta ya importada no se reescribe. Si el archivo no trae folio, el servidor
 * deriva uno determinista del contenido (+ un sufijo de ocurrencia, para que dos
 * ventas idénticas el mismo día no se colapsen en una sola).
 */
export async function importarVentas(rows: NewSale[]): Promise<ResultadoImport> {
  // Nº de aparición de cada fila entre las IDÉNTICAS del archivo. Se calcula
  // aquí, sobre el archivo COMPLETO, y no en SQL con row_number(): la carga va
  // por lotes y la numeración se reiniciaría en cada lote, de modo que dos
  // ventas idénticas a ambos lados de un corte recibirían la misma clave
  // derivada y la segunda se perdería en el ON CONFLICT DO NOTHING.
  const vistas = new Map<string, number>();

  return ejecutarImport(
    MODULO_VENTAS,
    rows.map((r) => {
      const huella = [
        r.date ?? "",
        (r.customer ?? "").trim().toLowerCase(),
        r.amount,
        (r.method ?? "").trim().toLowerCase(),
        r.status,
      ].join("|");
      const ocurrencia = (vistas.get(huella) ?? 0) + 1;
      vistas.set(huella, ocurrencia);

      return {
        referencia: r.id?.trim() || null,
        cliente: r.customer?.trim() || null,
        canal: r.channel?.trim() || null,
        metodo: r.method?.trim() || null,
        monto: r.amount,
        estado: r.status,
        fecha: r.date || null,
        ocurrencia,
      };
    }),
  );
}

// ── Directorio de clientes para el estado del dashboard ──────────────────────

/** Fila cruda de `public.clientes` en lo que consume el dashboard. */
type ClienteResumenRow = {
  id: string;
  nombre: string;
  email: string | null;
  telefono: string | null;
  segmento?: Tier | null;
  compras_historicas?: number | string | null;
  total_gastado?: number | string | null;
};

const CLIENTES_SELECT_BASE = "id, nombre, email, telefono";

/**
 * Clientes de la empresa autenticada, mapeados al `Customer` que mantiene el
 * <DashboardProvider>. Aislado por RLS más el filtro explícito por `empresa_id`.
 *
 * `segmento`, `compras_historicas` y `total_gastado` son columnas nuevas
 * (`2026-10-import-masivo-crm-ventas.sql`); igual que en productos y ventas, si
 * la migración todavía no se ha corrido reintentamos sin ellas (42703) en vez de
 * dejar el CRM vacío. Si falta la tabla entera (CRM sin migrar) devuelve [].
 */
export async function fetchClientesEmpresa(): Promise<Customer[]> {
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return []; // sin empresa resuelta no se consulta (aislamiento)

  const completo = await supabase
    .from("clientes")
    .select(`${CLIENTES_SELECT_BASE}, segmento, compras_historicas, total_gastado`)
    .eq("empresa_id", empresaId)
    .order("nombre", { ascending: true });

  const debeReintentar = completo.error?.code === "42703";
  const { data, error } = debeReintentar
    ? await supabase
        .from("clientes")
        .select(CLIENTES_SELECT_BASE)
        .eq("empresa_id", empresaId)
        .order("nombre", { ascending: true })
    : completo;

  if (error) {
    // 42P01/PGRST205 = el CRM aún no está migrado; no es un fallo que reportar.
    if (error.code !== "42P01" && error.code !== "PGRST205") {
      console.warn("[resumen] No se pudieron leer los clientes:", error.message);
    }
    return [];
  }

  return ((data ?? []) as ClienteResumenRow[]).map((row, i) => ({
    // `Customer.id` es numérico por el modelo en memoria heredado y nadie lo
    // consume: el id REAL del CRM es el uuid de `clientes.id`, que usa /clientes.
    id: i + 1,
    clientId: "", // el aislamiento lo impone RLS; el cliente no lo usa
    name: row.nombre,
    email: row.email ?? "",
    phone: row.telefono ?? "",
    orders: Number(row.compras_historicas ?? 0),
    totalSpent: Number(row.total_gastado ?? 0),
    tier: row.segmento ?? "Bronce",
  }));
}

// ── Métricas de rentabilidad (margen real + rotación) ────────────────────────

/**
 * Margen y rotación de la empresa, calculados en el servidor por la RPC
 * `metricas_rentabilidad_empresa()` cruzando `ventas.items` con
 * `productos.precio_costo`. Es la fuente de verdad de ambas métricas del
 * dashboard: no depende de estado local, así que es idéntica en cada dispositivo.
 */
export type MetricasRentabilidad = {
  /** Ingresos de las líneas de productos del catálogo (Σ qty · precio). */
  ingresos: number;
  /** Costo de mercancía vendida — COGS (Σ qty · precio_costo). */
  costo: number;
  /** Unidades de catálogo vendidas (excluye artículos comunes). */
  unidadesVendidas: number;
  /** Valor del inventario actual a costo (Σ stock_actual · precio_costo). */
  valorInventarioCosto: number;
  /** Margen de ganancia en porcentaje, p. ej. 42.5. */
  margen: number;
  /** Rotación de inventario en veces, p. ej. 3.2. */
  rotacion: number;
};

export const METRICAS_VACIAS: MetricasRentabilidad = {
  ingresos: 0,
  costo: 0,
  unidadesVendidas: 0,
  valorInventarioCosto: 0,
  margen: 0,
  rotacion: 0,
};

/**
 * Lee las métricas de rentabilidad de la empresa autenticada vía la RPC
 * `metricas_rentabilidad_empresa()`. Aislada por RLS; sin sesión (o ante error)
 * devuelve ceros, nunca cifras inventadas en el cliente.
 */
export async function fetchMetricasRentabilidad(): Promise<MetricasRentabilidad> {
  // Igual que total_ventas_empresa: sin sesión/empresa no invocamos la RPC.
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return METRICAS_VACIAS;

  const { data, error } = await supabase.rpc("metricas_rentabilidad_empresa");

  if (error) {
    console.warn("[resumen] No se pudieron leer las métricas de rentabilidad:", error.message);
    return METRICAS_VACIAS;
  }

  // La RPC devuelve un jsonb; los numeric pueden llegar como string desde PostgREST.
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    ingresos: Number(row.ingresos ?? 0),
    costo: Number(row.costo ?? 0),
    unidadesVendidas: Number(row.unidades_vendidas ?? 0),
    valorInventarioCosto: Number(row.valor_inventario_costo ?? 0),
    margen: Number(row.margen ?? 0),
    rotacion: Number(row.rotacion ?? 0),
  };
}

// ── Integración Compras ⇄ Inventario ─────────────────────────────────────────

/**
 * Producto del catálogo, tal como lo consume el selector de órdenes de compra.
 * Mantiene el `codigo_barras` REAL (sin el fallback `PRD-<id>` de InventoryItem),
 * porque al recibir la orden hay que mapear la referencia existente sin inventarla.
 */
export type ProductoCatalogo = {
  id: string; // uuid del catálogo (public.productos.id)
  descripcion: string;
  codigo_barras: string | null;
  precio_costo: number;
};

/**
 * Catálogo de productos de la empresa autenticada para poblar el <select> del
 * formulario de compras. Aislado por RLS; devuelve [] sin sesión o ante error.
 */
export async function fetchCatalogoProductos(): Promise<ProductoCatalogo[]> {
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return []; // sin empresa resuelta no se consulta (aislamiento)

  const { data, error } = await supabase
    .from("productos")
    .select("id, descripcion, codigo_barras, precio_costo")
    .eq("empresa_id", empresaId)
    .order("descripcion", { ascending: true });

  if (error) {
    console.warn("[resumen] No se pudo cargar el catálogo de productos:", error.message);
    return [];
  }

  return (data ?? []).map((p) => {
    const row = p as {
      id: string;
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

// ── Persistencia de órdenes de compra (tabla `public.compras`) ───────────────

/** Fila cruda de `public.compras` (solo las columnas que consumimos). */
type CompraRow = {
  folio: number | string; // bigint identity → puede llegar como string desde PostgREST
  proveedor: string;
  items: string;
  unidades: number | string | null;
  costo: number | string | null; // numeric puede llegar como string
  eta: string | null;
  estado: string;
};

/**
 * Órdenes de compra de la empresa autenticada, mapeadas a `PurchaseOrder`.
 * Aisladas por RLS y, además, por filtro explícito por `empresa_id` resuelto de
 * la sesión viva (defensa en profundidad). Es la ÚNICA fuente de verdad de las
 * compras: se leen directamente de Supabase, no de localStorage, así sobreviven
 * a las recargas y son idénticas en todos los dispositivos. Sin sesión/empresa
 * (o ante error) devuelve [], nunca filas de otra empresa.
 */
export async function fetchComprasEmpresa(): Promise<PurchaseOrder[]> {
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return []; // sin empresa resuelta no se consulta (aislamiento)

  const { data, error } = await supabase
    .from("compras")
    .select("*")
    .eq("empresa_id", empresaId)
    .order("created_at", { ascending: false });

  if (error) {
    console.warn(
      "[resumen] No se pudieron leer las compras:",
      error.message,
      "· ¿corriste supabase/2026-08-crear-compras.sql?",
    );
    return [];
  }

  return ((data ?? []) as CompraRow[]).map((c) => ({
    // Folio legible para la UI (OC-0001…); estable y único por fila.
    id: `OC-${String(c.folio).padStart(4, "0")}`,
    clientId: "", // el aislamiento lo impone RLS; el cliente no lo usa
    supplier: c.proveedor,
    items: c.items,
    units: Number(c.unidades ?? 0),
    cost: Number(c.costo ?? 0),
    eta: c.eta ?? "Por definir",
    status: (c.estado as PurchaseStatus) ?? "Pendiente",
  }));
}

/**
 * Inserta una o varias órdenes de compra en `public.compras`, estampando el
 * `empresa_id` resuelto de la sesión viva (`getEmpresaIdActiva`). El aislamiento
 * lo garantiza RLS (`with check empresa_id = mi_empresa()`); enviarlo explícito
 * es defensa en profundidad. Devuelve cuántas filas se insertaron (0 si no hay
 * empresa resuelta o si la inserción falla).
 */
export async function insertCompras(rows: NewPurchase[]): Promise<number> {
  if (rows.length === 0) return 0;

  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return 0; // sin empresa resuelta no se inserta (aislamiento)

  const payload = rows.map((r) => ({
    empresa_id: empresaId,
    proveedor: r.supplier,
    items: r.items,
    unidades: r.units,
    costo: r.cost,
    eta: r.eta || "Por definir",
    estado: r.status,
    producto_id: r.productoId ?? null,
    codigo_barras: r.codigoBarras ?? null,
  }));

  const { error } = await supabase.from("compras").insert(payload);

  if (error) {
    console.error(
      "[resumen] No se pudo guardar la orden de compra:",
      error.message,
      "· ¿corriste supabase/2026-08-crear-compras.sql?",
    );
    return 0;
  }
  return rows.length;
}

/** Datos mínimos para impactar el inventario al recibir una orden de compra. */
export type RecibirCompraInput = {
  /** Id (uuid) del producto seleccionado del catálogo, o null/omitido si es nuevo. */
  productoId?: string | null;
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
