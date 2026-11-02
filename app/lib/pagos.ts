/**
 * Pagos fraccionados / mixtos — tipos y utilidades compartidas.
 *
 * Una venta del POS puede cobrarse con VARIOS medios a la vez ("$20.000 en
 * efectivo y el resto por Nequi"). El desglose viaja como un arreglo
 * `[{metodo, monto}]` y se persiste en la columna `ventas.pagos` vía la RPC
 * `registrar_venta_mixta` (ver supabase/2026-11-pagos-mixtos.sql), que es quien
 * reparte cada monto en su bucket de `cortes_caja`.
 *
 * Este módulo es PURO (sin red ni DOM) porque lo consumen el POS, la cola
 * offline, la tirilla y la vista de factura. Las validaciones de aquí son de
 * UX: la autoridad sobre qué es un desglose válido —medios permitidos, montos
 * positivos y suma exacta— la tiene la RPC, que las vuelve a aplicar.
 */

/** Medios que SÍ entran a la caja del día (el fiado no es caja: es crédito). */
export const METODOS_CAJA = ["Efectivo", "Nequi/Daviplata", "Bold"] as const;

export type MetodoCaja = (typeof METODOS_CAJA)[number];

/** Un tramo del cobro: cuánto se pagó con un medio concreto. */
export type PagoDesglose = { metodo: MetodoCaja; monto: number };

/** Etiqueta que guarda `ventas.metodo_pago` cuando hay dos o más medios. */
export const METODO_MIXTO = "Mixto";

/** true si `valor` es uno de los medios de caja admitidos. */
export function esMetodoCaja(valor: unknown): valor is MetodoCaja {
  return typeof valor === "string" && (METODOS_CAJA as readonly string[]).includes(valor);
}

/** Suma de los montos del desglose (en pesos, sin decimales en la práctica). */
export function sumaPagos(pagos: readonly PagoDesglose[]): number {
  return pagos.reduce((s, p) => s + p.monto, 0);
}

/**
 * Normaliza lo que el usuario tecleó en el modal: descarta los medios en cero o
 * negativos, redondea a pesos y agrupa por si el mismo medio apareciera dos
 * veces (la RPC rechaza los duplicados a propósito).
 */
export function normalizarPagos(pagos: readonly PagoDesglose[]): PagoDesglose[] {
  const porMetodo = new Map<MetodoCaja, number>();
  for (const p of pagos) {
    const monto = Math.round(Number(p.monto));
    if (!Number.isFinite(monto) || monto <= 0) continue;
    porMetodo.set(p.metodo, (porMetodo.get(p.metodo) ?? 0) + monto);
  }
  // Orden estable por el catálogo (no por el de inserción): la tirilla y la
  // factura de una misma venta listan siempre los medios en el mismo orden.
  return METODOS_CAJA.flatMap((metodo) => {
    const monto = porMetodo.get(metodo);
    return monto ? [{ metodo, monto }] : [];
  });
}

/**
 * Lee el jsonb `ventas.pagos` descartando lo que no encaje. Devuelve `[]` para
 * las ventas de un solo método (donde la columna está vacía) y para cualquier
 * fila con datos corruptos: quien llama cae entonces a `metodo_pago`.
 */
export function parsearPagos(raw: unknown): PagoDesglose[] {
  if (!Array.isArray(raw)) return [];
  const pagos: PagoDesglose[] = [];
  for (const entrada of raw) {
    if (!entrada || typeof entrada !== "object") continue;
    const e = entrada as Record<string, unknown>;
    const monto = Number(e.monto ?? 0);
    if (!esMetodoCaja(e.metodo) || !Number.isFinite(monto) || monto <= 0) continue;
    pagos.push({ metodo: e.metodo, monto });
  }
  return pagos;
}

/**
 * Nombre legible del cobro para listados y mensajes: "Efectivo + Bold" cuando
 * hubo fraccionamiento, el método suelto cuando no. `respaldo` es lo que se usa
 * si el desglose viene vacío (típicamente `ventas.metodo_pago`).
 */
export function etiquetaPagos(pagos: readonly PagoDesglose[], respaldo: string): string {
  if (pagos.length === 0) return respaldo;
  if (pagos.length === 1) return pagos[0].metodo;
  return pagos.map((p) => p.metodo).join(" + ");
}

/**
 * Reparte el importe de una venta entre los tres buckets del corte. Con
 * desglose usa los montos reales; sin él atribuye TODO el total al método
 * suelto, que es como se comportaba el POS antes de los pagos mixtos.
 *
 * `clasificar` la inyecta `lib/corte.ts` (es quien sabe mapear los alias de
 * texto libre del histórico importado: "cash", "datáfono", "transferencia"…),
 * así que este módulo sigue sin depender de nada.
 */
export function repartirPorMetodo(
  pagos: readonly PagoDesglose[],
  total: number,
  metodoSuelto: string,
  clasificar: (metodo: string) => "efectivo" | "nequi" | "bold" | null,
): { efectivo: number; nequi: number; bold: number } {
  const acc = { efectivo: 0, nequi: 0, bold: 0 };
  const tramos: ReadonlyArray<{ metodo: string; monto: number }> =
    pagos.length > 0 ? pagos : [{ metodo: metodoSuelto, monto: total }];

  for (const tramo of tramos) {
    const bucket = clasificar(tramo.metodo);
    if (bucket) acc[bucket] += tramo.monto;
  }
  return acc;
}
