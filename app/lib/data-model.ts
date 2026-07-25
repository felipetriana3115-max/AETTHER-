// Modelo de datos y helpers compartidos por todos los módulos del ERP.
// Todos los montos están en PESOS COLOMBIANOS (COP).
//
// El estado vivo lo administra <DashboardProvider> y se llena EXCLUSIVAMENTE
// con lo que el usuario importa desde Excel/CSV. Aquí NO hay datos quemados:
// solo tipos compartidos y utilidades de formato/escala/derivación.

// ── Tipos compartidos ───────────────────────────────────────────────────────

export type InventoryItem = {
  id: number;
  clientId: string;
  sku: string;
  name: string;
  category: string;
  stock: number;
  minStock: number;
  price: number;
  /**
   * Fecha de caducidad (ISO `YYYY-MM-DD`) para insumos perecederos, o null si el
   * producto no vence / no la tiene registrada. Alimenta la alerta "Insumos por
   * Vencer"; la mayoría de productos de retail la dejan en null.
   */
  expiryDate?: string | null;
};

export type Tier = "Oro" | "Plata" | "Bronce";

export type Customer = {
  id: number;
  clientId: string;
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
  clientId: string;
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
  clientId: string;
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

// ── Alertas inteligentes de inventario ───────────────────────────────────────
// Reglas de negocio compartidas por el banner del dashboard y la tabla. Son
// funciones puras sobre `InventoryItem`, así que la validación es "ligera": se
// evalúa en memoria sobre los datos ya cargados desde Supabase, sin consultas
// extra.

/**
 * Umbral de STOCK CRÍTICO: menos de 5 unidades dispara la alerta roja prominente,
 * independientemente del stock mínimo configurado por producto. Es el aviso de
 * "quedan poquísimas, repón YA" que pide el negocio.
 */
export const CRITICAL_STOCK_THRESHOLD = 5;

/** Ventana (en días) para considerar un insumo "próximo a vencer". */
export const EXPIRY_SOON_DAYS = 30;

/** Existencia por debajo del umbral crítico (menos de 5 unidades). */
export function isCriticalStock(item: InventoryItem): boolean {
  return item.stock < CRITICAL_STOCK_THRESHOLD;
}

/**
 * Días que faltan para el vencimiento (negativo = ya vencido, 0 = vence hoy), o
 * null si el producto no tiene fecha de caducidad registrada. Se compara contra
 * la medianoche local para que "días" sea un conteo de calendario estable.
 */
export function daysUntilExpiry(item: InventoryItem, now: Date = new Date()): number | null {
  const raw = item.expiryDate;
  if (!raw) return null;
  // Columna `date` de Postgres → "YYYY-MM-DD"; la anclamos a medianoche local
  // para evitar que el desfase UTC reste/sume un día.
  const exp = new Date(raw.length <= 10 ? `${raw}T00:00:00` : raw);
  if (Number.isNaN(exp.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const expDay = new Date(exp.getFullYear(), exp.getMonth(), exp.getDate());
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((expDay.getTime() - today.getTime()) / MS_PER_DAY);
}

/** El insumo ya pasó su fecha de vencimiento. */
export function isExpired(item: InventoryItem, now: Date = new Date()): boolean {
  const d = daysUntilExpiry(item, now);
  return d !== null && d < 0;
}

/** El insumo vence dentro de la ventana de aviso (hoy … EXPIRY_SOON_DAYS días). */
export function isExpiringSoon(item: InventoryItem, now: Date = new Date()): boolean {
  const d = daysUntilExpiry(item, now);
  return d !== null && d >= 0 && d <= EXPIRY_SOON_DAYS;
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
export function monthIndexFromDate(date: string): number | null {
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

  // 4) Último recurso: parseo nativo a Date (ISO con hora, "August 5 2026",
  //    "2026/07/14", etc.). Se exige que la cadena traiga un año de 4 dígitos
  //    ANTES de confiar en `new Date`: de lo contrario un valor parcial o de
  //    solo-hora ("10:42") heredaría el MES ACTUAL con que Date rellena los
  //    campos faltantes, colapsando esas filas a julio (el mes de hoy).
  if (/\d{4}/.test(raw)) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.getMonth();
  }

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
