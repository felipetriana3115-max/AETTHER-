"use client";

import { useDashboard } from "./DashboardProvider";
import { axisScale, formatCompactCOP, formatCOP } from "../lib/data-model";

export default function SalesChart() {
  // Estado global unificado: reacciona a la carga masiva de Excel.
  const { monthlyRevenue } = useDashboard();

  const total = monthlyRevenue.reduce((sum, d) => sum + d.amount, 0);

  // Escala del eje calculada dinámicamente a partir de los datos vivos.
  const { top: MAX, ticks: TICKS } = axisScale(
    Math.max(0, ...monthlyRevenue.map((m) => m.amount)),
    4,
  );

  return (
    <div className="h-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h3 className="text-sm font-medium text-zinc-400">Tendencia de ingresos mensuales</h3>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-zinc-50">{formatCOP(total)}</p>
        </div>
        {/* Sin badge de variación: no hay métrica de crecimiento real todavía.
            Cuando exista la lógica de periodo-sobre-periodo, se reincorpora aquí. */}
      </div>

      <div className="flex gap-3">
        {/* Eje Y */}
        <div
          className="flex h-64 flex-col justify-between py-0 text-right text-[10px] tabular-nums text-zinc-600"
          aria-hidden
        >
          {TICKS.map((t) => (
            <span key={t}>{formatCompactCOP(t)}</span>
          ))}
        </div>

        {/* Área de trazado */}
        <div className="min-w-0 flex-1">
          <div className="relative h-64">
            {/* Cuadrícula recesiva */}
            <div className="absolute inset-0 flex flex-col justify-between">
              {TICKS.map((t) => (
                <div key={t} className="h-px w-full bg-zinc-800" />
              ))}
            </div>

            {/* Columnas */}
            <div className="relative flex h-64 items-end justify-between gap-2 sm:gap-4">
              {monthlyRevenue.map((d) => {
                const pct = MAX > 0 ? Math.round((d.amount / MAX) * 100) : 0;
                return (
                  <div key={d.month} className="group flex h-full flex-1 items-end justify-center">
                    <div
                      className="relative w-full max-w-[32px] rounded-t bg-violet-500 transition-colors group-hover:bg-violet-400"
                      style={{ height: `${pct}%` }}
                    >
                      {/* Tooltip */}
                      <div className="pointer-events-none absolute -top-10 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-100 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                        {formatCOP(d.amount)}
                        <span className="block text-center text-[10px] font-normal text-zinc-400">
                          {d.month}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Etiquetas del eje X */}
          <div className="mt-2 flex justify-between gap-2 sm:gap-4">
            {monthlyRevenue.map((d) => (
              <span key={d.month} className="flex-1 text-center text-xs text-zinc-500">
                {d.month}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
