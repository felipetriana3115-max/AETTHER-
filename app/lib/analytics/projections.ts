// Proyecciones financieras del ERP.
//
// Predice el próximo mes de ingresos y egresos usando una MEDIA MÓVIL SIMPLE
// (SMA) de los últimos 3 meses con datos, y deriva una "alerta de caja"
// (Excedente / Déficit) a partir del flujo neto proyectado.
//
// Los "egresos" del negocio son las COMPRAS (app/compras): cada orden aporta su
// `cost` en el mes de su fecha estimada de entrega (`eta`), excluyendo las
// canceladas. Los ingresos se reutilizan del derivador de ventas ya existente.

import {
  deriveMonthlyRevenue,
  monthIndexFromDate,
  MONTHS,
  type Sale,
  type PurchaseOrder,
  type MonthPoint,
} from "../demo-data";

/**
 * Agrega las compras (excluyendo canceladas) por mes usando su `eta` y devuelve
 * los puntos en orden calendario, solo con los meses que tengan datos. Espeja la
 * lógica de `deriveMonthlyRevenue` para las ventas.
 */
export function deriveMonthlyExpenses(purchases: PurchaseOrder[]): MonthPoint[] {
  const totals = new Array<number>(12).fill(0);
  const seen = new Array<boolean>(12).fill(false);

  for (const p of purchases) {
    if (p.status === "Cancelado") continue;
    const idx = monthIndexFromDate(p.eta);
    if (idx === null) continue;
    totals[idx] += p.cost;
    seen[idx] = true;
  }

  const points: MonthPoint[] = [];
  for (let i = 0; i < 12; i++) {
    if (seen[i]) points.push({ month: MONTHS[i], amount: totals[i] });
  }
  return points;
}

/**
 * Media móvil simple sobre los últimos `window` puntos de la serie. Si hay menos
 * puntos que la ventana, promedia los que existan; si no hay ninguno, 0.
 */
export function simpleMovingAverage(points: MonthPoint[], window = 3): number {
  if (points.length === 0) return 0;
  const last = points.slice(-window);
  const sum = last.reduce((acc, p) => acc + p.amount, 0);
  return Math.round(sum / last.length);
}

export type CashAlert = "Excedente" | "Déficit" | "Equilibrio";

export type MonthlyProjection = {
  /** Ingresos proyectados para el próximo mes (SMA de 3 meses). */
  incomeProjection: number;
  /** Egresos proyectados para el próximo mes (SMA de 3 meses). */
  expenseProjection: number;
  /** Flujo neto proyectado: ingresos − egresos. */
  cashFlow: number;
  /** Semáforo de caja derivado del flujo neto. */
  alert: CashAlert;
  /** Cuántos meses reales alimentaron cada media móvil (máx. 3). */
  monthsAnalyzed: { income: number; expenses: number };
  /** false cuando no hay ninguna serie con datos (para pintar estados vacíos). */
  hasData: boolean;
};

/**
 * Proyecta ingresos y egresos del próximo mes con una media móvil simple de los
 * últimos 3 meses y clasifica la caja resultante en Excedente / Déficit.
 */
export function getMonthlyProjections(
  sales: Sale[],
  expenses: PurchaseOrder[],
): MonthlyProjection {
  const incomeSeries = deriveMonthlyRevenue(sales);
  const expenseSeries = deriveMonthlyExpenses(expenses);

  const incomeProjection = simpleMovingAverage(incomeSeries, 3);
  const expenseProjection = simpleMovingAverage(expenseSeries, 3);
  const cashFlow = incomeProjection - expenseProjection;

  const alert: CashAlert =
    cashFlow > 0 ? "Excedente" : cashFlow < 0 ? "Déficit" : "Equilibrio";

  return {
    incomeProjection,
    expenseProjection,
    cashFlow,
    alert,
    monthsAnalyzed: {
      income: Math.min(3, incomeSeries.length),
      expenses: Math.min(3, expenseSeries.length),
    },
    hasData: incomeSeries.length > 0 || expenseSeries.length > 0,
  };
}
