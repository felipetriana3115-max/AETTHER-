// Servicio (mock) de reportes ejecutivos por WhatsApp.
//
// `generateDailySummary` arma el texto en formato Markdown que se "enviaría"
// al cierre del día: resumen de ventas, método de pago predominante y alerta de
// inventario. No hace ninguna llamada de red — solo genera el mensaje; el envío
// real se simula en app/lib/cron/daily-report-mock.ts.

import { formatCOP, isLowStock, type Sale, type InventoryItem } from "../demo-data";

export type DailySummaryOptions = {
  /** Inventario vivo para calcular la alerta de stock bajo. Opcional. */
  inventory?: InventoryItem[];
  /** Nombre del negocio para encabezar el reporte. */
  businessName?: string;
};

/**
 * Devuelve un resumen diario en Markdown (compatible con WhatsApp: *negrita*,
 * _cursiva_) a partir de las ventas del día. Los reembolsos se excluyen de los
 * totales. Si se pasa `inventory`, agrega una alerta de stock bajo.
 */
export function generateDailySummary(
  sales: Sale[],
  options: DailySummaryOptions = {},
): string {
  const { inventory = [], businessName = "tu negocio" } = options;

  // ── Resumen de ventas (excluye reembolsos) ────────────────────────────────
  const valid = sales.filter((s) => s.status !== "Reembolsado");
  const totalSales = valid.reduce((acc, s) => acc + s.amount, 0);
  const orderCount = valid.length;
  const avgTicket = orderCount > 0 ? Math.round(totalSales / orderCount) : 0;

  // ── Método de pago predominante ───────────────────────────────────────────
  const byMethod = new Map<string, number>();
  for (const s of valid) {
    const key = s.method?.trim() || "Desconocido";
    byMethod.set(key, (byMethod.get(key) ?? 0) + 1);
  }
  const topMethod = [...byMethod.entries()].sort((a, b) => b[1] - a[1])[0];
  const methodLine = topMethod
    ? `${topMethod[0]} · ${topMethod[1]} de ${orderCount} ventas`
    : "Sin ventas registradas";

  // ── Alerta de inventario ──────────────────────────────────────────────────
  const lowStock = inventory.filter(isLowStock);
  const shown = lowStock.slice(0, 3).map((i) => i.name).join(", ");
  const inventoryLine =
    inventory.length === 0
      ? "ℹ️ Sin inventario cargado."
      : lowStock.length === 0
        ? "✅ Inventario sin alertas de stock."
        : `⚠️ *${lowStock.length}* producto(s) en stock bajo: ${shown}${lowStock.length > 3 ? "…" : ""}`;

  return [
    `*📊 Resumen diario · ${businessName}*`,
    "",
    "*🧾 Ventas del día*",
    `• Total: *${formatCOP(totalSales)}*`,
    `• Transacciones: ${orderCount}`,
    `• Ticket promedio: ${formatCOP(avgTicket)}`,
    "",
    "*💳 Método predominante*",
    `• ${methodLine}`,
    "",
    "*📦 Inventario*",
    `• ${inventoryLine}`,
    "",
    "_Reporte automático generado por Aether ERP._",
  ].join("\n");
}
