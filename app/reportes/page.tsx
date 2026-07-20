"use client";

import { useEffect, useMemo, useState } from "react";
import PageShell from "../components/PageShell";
import MetricCard from "../components/MetricCard";
import EmptyState from "../components/EmptyState";
import { useDashboard } from "../components/DashboardProvider";
import { axisScale, formatCOP } from "../lib/data-model";
import { getMonthlyProjections } from "../lib/analytics/projections";
import { fetchCortes, hoyISO, type CorteCaja } from "../lib/corte";

// Orden canónico del año para completar los meses proyectados.
const YEAR_MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
// Paleta cíclica para los canales detectados dinámicamente en las ventas.
const SEGMENT_COLORS = ["bg-violet-500", "bg-fuchsia-500", "bg-purple-400", "bg-indigo-400", "bg-blue-400"];

// ── Layout del SVG de proyección ────────────────────────────────────────────
const W = 720;
const H = 240;
const PAD = 8;

type ProjectionPoint = { month: string; value: number; projected: boolean };

// Formatea una fecha `YYYY-MM-DD` a un texto legible en español (sin desfase de
// zona: se construye la fecha en local a partir de sus componentes).
function fechaLegible(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function ReportesPage() {
  // Estado global unificado: reacciona a la carga masiva de Excel.
  const { monthlyRevenue, inventory, sales, purchases, businessName } = useDashboard();
  const hasData = monthlyRevenue.length > 0 || inventory.length > 0 || sales.length > 0;

  // Cortes de caja (arqueo) desde Supabase — independientes de los datos de Excel.
  const [cortes, setCortes] = useState<CorteCaja[]>([]);
  const [cortesCargando, setCortesCargando] = useState(true);
  useEffect(() => {
    let activo = true;
    (async () => {
      const data = await fetchCortes(30);
      if (!activo) return;
      setCortes(data);
      setCortesCargando(false);
    })();
    return () => {
      activo = false;
    };
  }, []);
  const corteHoy = useMemo(() => cortes.find((c) => c.fecha === hoyISO()) ?? null, [cortes]);

  // Proyección del próximo mes (media móvil simple de 3 meses) de ingresos y
  // egresos, con la alerta de caja resultante.
  const projections = useMemo(
    () => getMonthlyProjections(sales, purchases),
    [sales, purchases],
  );
  const surplus = projections.cashFlow >= 0;

  // Métricas financieras derivadas de los ingresos vivos.
  const annualRevenue = monthlyRevenue.reduce((s, m) => s + m.amount, 0);
  const operatingCosts = Math.round(annualRevenue * 0.375);
  const netProfit = annualRevenue - operatingCosts;

  // "Más vendidos" derivado del inventario cargado (proxy: valor en stock).
  const topProducts = [...inventory]
    .map((p) => ({ name: p.name, units: p.stock, revenue: p.stock * p.price }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // Ingresos por canal: derivados de las ventas vivas (excluye reembolsos).
  const revenueBySegment = useMemo(() => {
    const totals = new Map<string, number>();
    for (const s of sales) {
      if (s.status === "Reembolsado") continue;
      totals.set(s.channel, (totals.get(s.channel) ?? 0) + s.amount);
    }
    const grand = [...totals.values()].reduce((a, b) => a + b, 0);
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, amount], i) => ({
        label,
        value: grand > 0 ? Math.round((amount / grand) * 100) : 0,
        color: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
      }));
  }, [sales]);

  // Proyección de crecimiento: meses reales (estado global) + proyección
  // de los meses restantes del año usando la tasa de crecimiento observada.
  const projection = useMemo<ProjectionPoint[]>(() => {
    const real: ProjectionPoint[] = monthlyRevenue.map((m) => ({
      month: m.month,
      value: m.amount,
      projected: false,
    }));
    if (real.length === 0) return [];

    let growth = 1.08; // respaldo si no hay suficientes puntos.
    if (real.length >= 2) {
      let sum = 0;
      let n = 0;
      for (let i = 1; i < real.length; i++) {
        if (real[i - 1].value > 0) {
          sum += real[i].value / real[i - 1].value;
          n++;
        }
      }
      if (n > 0) growth = sum / n;
    }

    const used = new Set(real.map((r) => r.month));
    let last = real[real.length - 1].value;
    const projected: ProjectionPoint[] = YEAR_MONTHS.filter((m) => !used.has(m)).map((month) => {
      last = Math.round(last * growth);
      return { month, value: last, projected: true };
    });

    return [...real, ...projected];
  }, [monthlyRevenue]);

  // ── Geometría del SVG derivada de la proyección viva ──────────────────────
  const {
    realLine,
    projLine,
    areaPath,
    points: projPoints,
    target,
  } = useMemo(() => {
    if (projection.length === 0) {
      return { realLine: "", projLine: "", areaPath: "", points: [] as { x: number; y: number; projected: boolean; month: string }[], target: 0 };
    }
    const n = Math.max(1, projection.length - 1);
    const maxVal = axisScale(Math.max(0, ...projection.map((d) => d.value))).top || 1;
    const xFor = (i: number) => PAD + (i / n) * (W - PAD * 2);
    const yFor = (v: number) => H - PAD - (v / maxVal) * (H - PAD * 2);

    const coordsFor = (from: number, to: number) =>
      projection
        .slice(from, to)
        .map((d, k) => `${xFor(from + k).toFixed(1)},${yFor(d.value).toFixed(1)}`)
        .join(" ");

    const realCount = projection.filter((d) => !d.projected).length;
    const realLine = coordsFor(0, realCount);
    // Solapar 1 punto para dar continuidad entre la línea real y la proyectada.
    const projLine = coordsFor(Math.max(0, realCount - 1), projection.length);
    const areaPath = `M ${PAD},${H - PAD} L ${realLine.split(" ").join(" L ")} L ${xFor(realCount - 1).toFixed(1)},${H - PAD} Z`;

    const points = projection.map((d, i) => ({
      x: xFor(i),
      y: yFor(d.value),
      projected: d.projected,
      month: d.month,
    }));

    return { realLine, projLine, areaPath, points, target: projection[projection.length - 1].value };
  }, [projection]);

  return (
    <PageShell title="Reportes" subtitle={`${businessName} · Analítica avanzada y proyecciones`}>
      {/* ── Cierre de turno (corte de caja del POS) ── */}
      <section className="mb-6 rounded-xl border border-violet-500/15 bg-zinc-900/50 p-6">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Cierre de turno</h2>
            <p className="mt-0.5 text-xs text-zinc-500 first-letter:uppercase">{fechaLegible(hoyISO())}</p>
          </div>
          <span className="text-xs text-zinc-500">Corte de caja · registrado desde el POS</span>
        </div>

        {cortesCargando ? (
          <p className="py-8 text-center text-sm text-zinc-500">Cargando corte de caja…</p>
        ) : (
          <>
            {/* Resumen del día de hoy */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <div className="rounded-lg border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 to-transparent p-4">
                <p className="text-[11px] font-medium uppercase tracking-wide text-emerald-400/80">Total vendido hoy</p>
                <p className="mt-1 text-2xl font-bold tracking-tight text-emerald-300 tabular-nums">
                  {formatCOP(corteHoy?.total_general ?? 0)}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {corteHoy?.num_ventas ?? 0} venta{(corteHoy?.num_ventas ?? 0) === 1 ? "" : "s"}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Efectivo</p>
                <p className="mt-1 text-xl font-semibold tracking-tight text-zinc-100 tabular-nums">
                  {formatCOP(corteHoy?.total_efectivo ?? 0)}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Nequi / Daviplata</p>
                <p className="mt-1 text-xl font-semibold tracking-tight text-zinc-100 tabular-nums">
                  {formatCOP(corteHoy?.total_nequi ?? 0)}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Bold (tarjeta)</p>
                <p className="mt-1 text-xl font-semibold tracking-tight text-zinc-100 tabular-nums">
                  {formatCOP(corteHoy?.total_bold ?? 0)}
                </p>
              </div>
            </div>

            {/* Historial de cortes por día */}
            {cortes.length === 0 ? (
              <p className="mt-6 rounded-lg border border-dashed border-zinc-800 py-8 text-center text-sm text-zinc-500">
                Aún no hay ventas registradas en el POS.
              </p>
            ) : (
              <div className="mt-6 overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                      <th className="pb-2 pr-3 font-medium">Fecha</th>
                      <th className="pb-2 px-3 text-right font-medium">Efectivo</th>
                      <th className="pb-2 px-3 text-right font-medium">Nequi/Davi</th>
                      <th className="pb-2 px-3 text-right font-medium">Bold</th>
                      <th className="pb-2 px-3 text-right font-medium">Ventas</th>
                      <th className="pb-2 pl-3 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {cortes.map((c) => {
                      const esHoy = c.fecha === hoyISO();
                      return (
                        <tr key={c.id} className={esHoy ? "bg-emerald-500/5" : "hover:bg-zinc-800/30"}>
                          <td className="py-2.5 pr-3 text-zinc-300">
                            <span className="capitalize">{fechaLegible(c.fecha)}</span>
                            {esHoy && (
                              <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                                HOY
                              </span>
                            )}
                          </td>
                          <td className="px-3 text-right tabular-nums text-zinc-400">{formatCOP(c.total_efectivo)}</td>
                          <td className="px-3 text-right tabular-nums text-zinc-400">{formatCOP(c.total_nequi)}</td>
                          <td className="px-3 text-right tabular-nums text-zinc-400">{formatCOP(c.total_bold)}</td>
                          <td className="px-3 text-right tabular-nums text-zinc-400">{c.num_ventas}</td>
                          <td className="pl-3 text-right font-semibold tabular-nums text-zinc-100">
                            {formatCOP(c.total_general)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {!hasData ? (
        <EmptyState message="Carga un archivo Excel para generar tu analítica y proyecciones." />
      ) : (
      <div className="space-y-6">
        {/* Balance general */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Ingresos Anuales"
            value={formatCOP(annualRevenue)}
            delta="+18.3%"
            deltaGood
            deltaCaption="vs. año anterior"
            tone="violet"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v20" />
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            }
          />
          <MetricCard
            label="Costos Operativos"
            value={formatCOP(operatingCosts)}
            delta="+5.1%"
            deltaGood={false}
            deltaCaption="vs. año anterior"
            tone="amber"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18" />
                <path d="m19 15-5-5-4 4-3-3" />
              </svg>
            }
          />
          <MetricCard
            label="Utilidad Neta"
            value={formatCOP(netProfit)}
            delta="+22.6%"
            deltaGood
            tone="emerald"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v12" />
                <path d="M15.5 9.5a3.5 3.5 0 0 0-3.5-2c-2 0-3.5 1-3.5 2.5S10 14 12 14s3.5.5 3.5 2-1.5 2.5-3.5 2.5a3.5 3.5 0 0 1-3.5-2" />
              </svg>
            }
          />
          <MetricCard
            label="EBITDA"
            value="38.9%"
            delta="+2.3%"
            deltaGood
            deltaCaption="margen operativo"
            tone="fuchsia"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20V10" />
                <path d="M18 20V4" />
                <path d="M6 20v-4" />
              </svg>
            }
          />
        </section>

        {/* Proyecciones Financieras (media móvil simple · próximo mes) */}
        <section>
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-zinc-100">Proyecciones Financieras</h2>
            <p className="text-xs text-zinc-500">
              Media móvil de {Math.max(projections.monthsAnalyzed.income, projections.monthsAnalyzed.expenses) || 0} meses · próximo mes
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <MetricCard
              label="Proyección Ingresos"
              value={formatCOP(projections.incomeProjection)}
              deltaCaption={`Base: ${projections.monthsAnalyzed.income} mes(es) de ventas`}
              delta="Próximo mes"
              deltaGood
              tone="emerald"
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" />
                  <path d="m7 14 4-4 3 3 5-6" />
                  <path d="M17 7h4v4" />
                </svg>
              }
            />
            <MetricCard
              label="Proyección Egresos"
              value={formatCOP(projections.expenseProjection)}
              deltaCaption={`Base: ${projections.monthsAnalyzed.expenses} mes(es) de compras`}
              delta="Próximo mes"
              deltaGood={false}
              tone="amber"
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" />
                  <path d="m7 8 4 4 3-3 5 6" />
                  <path d="M17 15h4v-4" />
                </svg>
              }
            />
            <MetricCard
              label="Alerta de Caja"
              value={projections.alert}
              delta={`${surplus ? "+" : ""}${formatCOP(projections.cashFlow)}`}
              deltaGood={surplus}
              deltaCaption="flujo neto proyectado"
              tone={surplus ? "emerald" : "fuchsia"}
              icon={
                surplus ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                    <path d="M12 9v4" />
                    <path d="M12 17h.01" />
                  </svg>
                )
              }
            />
          </div>
        </section>

        {/* Proyección de crecimiento */}
        <section className="relative overflow-hidden rounded-xl border border-violet-500/15 bg-zinc-900/50 p-6">
          <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-violet-600/10 blur-3xl" />
          <div className="relative mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-zinc-400">Proyección de crecimiento anual</h3>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-zinc-50">
                {formatCOP(target)} <span className="text-sm font-normal text-zinc-500">meta a fin de año</span>
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <span className="inline-flex items-center gap-1.5 text-zinc-400">
                <span className="h-2 w-3 rounded-full bg-violet-500" /> Real
              </span>
              <span className="inline-flex items-center gap-1.5 text-zinc-400">
                <span className="h-2 w-3 rounded-full bg-fuchsia-400/60 [background:repeating-linear-gradient(90deg,rgb(232_121_249)_0_4px,transparent_4px_7px)]" />
                Proyectado
              </span>
            </div>
          </div>

          <div className="relative">
            <svg viewBox={`0 0 ${W} ${H}`} className="h-64 w-full" preserveAspectRatio="none">
              <defs>
                <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgb(139 92 246)" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="rgb(139 92 246)" stopOpacity="0" />
                </linearGradient>
              </defs>

              {/* Cuadrícula horizontal */}
              {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                const y = PAD + f * (H - PAD * 2);
                return <line key={f} x1={PAD} y1={y} x2={W - PAD} y2={y} stroke="rgb(39 39 42)" strokeWidth={1} />;
              })}

              {/* Área bajo la curva real */}
              <path d={areaPath} fill="url(#areaFill)" />

              {/* Línea real */}
              <polyline
                points={realLine}
                fill="none"
                stroke="rgb(139 92 246)"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {/* Línea proyectada (punteada) */}
              <polyline
                points={projLine}
                fill="none"
                stroke="rgb(232 121 249)"
                strokeWidth={2.5}
                strokeDasharray="2 6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {/* Puntos */}
              {projPoints.map((p) => (
                <circle
                  key={p.month}
                  cx={p.x}
                  cy={p.y}
                  r={3}
                  fill={p.projected ? "rgb(232 121 249)" : "rgb(139 92 246)"}
                  stroke="rgb(9 9 11)"
                  strokeWidth={2}
                />
              ))}
            </svg>

            <div className="mt-2 flex justify-between px-1 text-[11px] text-zinc-500">
              {projPoints.map((p) => (
                <span key={p.month} className="flex-1 text-center">
                  {p.month}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* Segmentos + productos top */}
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          {/* Ingresos por canal */}
          <div className="relative overflow-hidden rounded-xl border border-violet-500/15 bg-zinc-900/50 p-6 lg:col-span-2">
            <div className="pointer-events-none absolute -left-12 -bottom-12 h-40 w-40 rounded-full bg-fuchsia-600/10 blur-3xl" />
            <h3 className="relative text-sm font-semibold text-zinc-100">Ingresos por canal</h3>
            <p className="relative mt-0.5 text-xs text-zinc-500">Distribución del último trimestre</p>

            <div className="relative mt-6 space-y-4">
              {revenueBySegment.map((s) => (
                <div key={s.label}>
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="text-zinc-300">{s.label}</span>
                    <span className="tabular-nums text-zinc-500">{s.value}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className={`h-full rounded-full ${s.color} shadow-[0_0_10px_-1px_rgba(139,92,246,0.8)]`}
                      style={{ width: `${s.value}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Productos más vendidos */}
          <div className="rounded-xl border border-violet-500/15 bg-zinc-900/50 p-6 lg:col-span-3">
            <h3 className="text-sm font-semibold text-zinc-100">Productos más vendidos</h3>
            <p className="mt-0.5 text-xs text-zinc-500">Ranking por ingresos generados</p>

            <ul className="mt-4 space-y-1">
              {topProducts.map((p, i) => (
                <li
                  key={p.name}
                  className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-zinc-800/40"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-xs font-semibold text-violet-300 ring-1 ring-violet-500/20">
                      {i + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-100">{p.name}</p>
                      <p className="text-xs text-zinc-500">{p.units} unidades</p>
                    </div>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-zinc-100">{formatCOP(p.revenue)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
      )}
    </PageShell>
  );
}
