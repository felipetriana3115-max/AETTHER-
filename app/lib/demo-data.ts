// Modelo de datos y helpers compartidos por todos los módulos del ERP.
// Todos los montos están en PESOS COLOMBIANOS (COP).
//
// El estado vivo lo administra <DashboardProvider> y se llena EXCLUSIVAMENTE
// con lo que el usuario importa desde Excel/CSV. Aquí NO hay datos quemados:
// solo tipos compartidos y utilidades de formato/escala/derivación.

// ── Tipos compartidos ───────────────────────────────────────────────────────

export type InventoryItem = {
  id: number;
  sku: string;
  name: string;
  category: string;
  stock: number;
  minStock: number;
  price: number;
};

export type Tier = "Oro" | "Plata" | "Bronce";

export type Customer = {
  id: number;
  name: string;
  email: string;
  phone: string;
  orders: number;
  totalSpent: number;
  tier: Tier;
};

export type SaleStatus = "Pagado" | "Reembolsado" | "Pendiente";

export type Sale = {
  id: string;
  customer: string;
  channel: string;
  method: string;
  amount: number;
  status: SaleStatus;
  date: string;
};

export type PurchaseStatus = "Recibido" | "Pendiente" | "Cancelado";

export type PurchaseOrder = {
  id: string;
  supplier: string;
  items: string;
  units: number;
  cost: number;
  eta: string;
  status: PurchaseStatus;
};

export type MonthPoint = { month: string; amount: number };

// Orden canónico de los meses del año (etiquetas cortas en español).
export const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

// ── Helpers de formato (COP) ────────────────────────────────────────────────

/** Formatea un número como pesos colombianos: $ 45.000 */
export const formatCOP = (n: number) =>
  n.toLocaleString("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });

/** Notación compacta para ejes: 31,2 M · 850 k */
export const formatCompactCOP = (n: number) =>
  n.toLocaleString("es-CO", { notation: "compact", maximumFractionDigits: 1 });

/** Un producto está en "stock bajo" cuando su existencia llega o baja del mínimo. */
export function isLowStock(item: InventoryItem): boolean {
  return item.stock <= item.minStock;
}

/**
 * Calcula una escala "bonita" para un eje: redondea el tope al múltiplo 1/2/5·10ⁿ
 * superior y devuelve las marcas en orden descendente (para pintar de arriba a abajo).
 */
export function axisScale(max: number, divisions = 4): { top: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) {
    return { top: divisions, ticks: Array.from({ length: divisions + 1 }, (_, i) => divisions - i) };
  }
  const rawStep = max / divisions;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = niceNorm * mag;
  const top = step * divisions;
  const ticks = Array.from({ length: divisions + 1 }, (_, i) => top - i * step);
  return { top, ticks };
}

// ── Derivación de ingresos mensuales a partir de las ventas importadas ───────

const stripAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Intenta deducir el índice de mes (0=Ene … 11=Dic) desde una fecha en texto. */
function monthIndexFromDate(date: string): number | null {
  if (!date) return null;
  const raw = String(date).trim();
  const lower = stripAccents(raw.toLowerCase());

  // 1) Nombre de mes en español (abreviado o completo): "13 Jul · 10:42", "Julio".
  for (let i = 0; i < MONTHS.length; i++) {
    if (lower.includes(MONTHS[i].toLowerCase())) return i;
  }

  // 2) ISO: 2026-07-14
  const iso = raw.match(/^\s*\d{4}-(\d{1,2})-\d{1,2}/);
  if (iso) return Math.min(11, Math.max(0, Number.parseInt(iso[1], 10) - 1));

  // 3) dd/mm/aaaa o dd-mm-aaaa
  const dmy = raw.match(/^\s*\d{1,2}[/\-](\d{1,2})[/\-]\d{2,4}/);
  if (dmy) return Math.min(11, Math.max(0, Number.parseInt(dmy[1], 10) - 1));

  return null;
}

/**
 * Agrega las ventas (excluyendo reembolsos) por mes y devuelve los puntos en
 * orden calendario, solo con los meses que tengan datos. Si ninguna venta trae
 * fecha reconocible, devuelve [] y los gráficos quedan vacíos con gracia.
 */
export function deriveMonthlyRevenue(sales: Sale[]): MonthPoint[] {
  const totals = new Array<number>(12).fill(0);
  const seen = new Array<boolean>(12).fill(false);

  for (const s of sales) {
    if (s.status === "Reembolsado") continue;
    const idx = monthIndexFromDate(s.date);
    if (idx === null) continue;
    totals[idx] += s.amount;
    seen[idx] = true;
  }

  const points: MonthPoint[] = [];
  for (let i = 0; i < 12; i++) {
    if (seen[i]) points.push({ month: MONTHS[i], amount: totals[i] });
  }
  return points;
}

/**
 * Ingreso "titular" para la métrica de Ventas del Mes. Prioriza el mes actual;
 * si el mes actual no tiene datos (o quedó en cero), cae con gracia al último
 * mes registrado con ingresos —la tendencia histórica— en lugar de mostrar $0.
 * Solo devuelve 0 cuando no hay ninguna venta con fecha reconocible.
 */
export function headlineRevenue(points: MonthPoint[]): number {
  if (points.length === 0) return 0;

  const currentLabel = MONTHS[new Date().getMonth()];
  const current = points.find((p) => p.month === currentLabel);
  if (current && current.amount > 0) return current.amount;

  // Fallback: el último mes registrado con ingresos (recorre hacia atrás).
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].amount > 0) return points[i].amount;
  }
  return points[points.length - 1].amount;
}
