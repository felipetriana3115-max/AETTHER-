"use client";

import { useDashboard } from "./DashboardProvider";
import { formatCOP } from "../lib/data-model";

/** Rotación con hasta 2 decimales y sufijo "x" (p. ej. 3.2x). */
function formatRotacion(veces: number) {
  return `${veces.toLocaleString("es-CO", { maximumFractionDigits: 2 })}x`;
}

/**
 * Lectura cualitativa de la rotación, para dar contexto al número. Los umbrales
 * son orientativos (rotación anual típica de retail); ajústalos si el periodo
 * de cálculo cambia.
 */
function interpretar(veces: number): { texto: string; clase: string } {
  if (veces <= 0) return { texto: "Sin datos suficientes", clase: "text-zinc-500" };
  if (veces < 1) return { texto: "Rotación baja · stock lento", clase: "text-amber-400" };
  if (veces < 4) return { texto: "Rotación saludable", clase: "text-emerald-400" };
  return { texto: "Rotación alta · vigila el desabasto", clase: "text-sky-400" };
}

/**
 * Panel de "Rotación de Inventario" del dashboard. Reemplaza al antiguo panel de
 * transacciones simuladas (Wompi/Bold). La rotación = COGS / valor de inventario
 * a costo, calculada en el servidor (`metricas_rentabilidad_empresa`) a partir de
 * las salidas reales del POS. Todos los montos en COP.
 */
export default function RotacionPanel() {
  const { metricas } = useDashboard();
  const { rotacion, costo, valorInventarioCosto, unidadesVendidas } = metricas;

  const sinDatos = rotacion <= 0 && costo <= 0;
  const estado = interpretar(rotacion);

  return (
    <div className="flex h-full flex-col rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-400">Rotación de Inventario</h3>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 ring-1 ring-sky-500/20">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
        </span>
      </div>

      {sinDatos ? (
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800 text-zinc-500">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
              <path d="m3 8 9 5 9-5" />
            </svg>
          </span>
          <p className="text-sm text-zinc-400">Aún no hay rotación que mostrar</p>
          <p className="mt-1 text-xs text-zinc-600">Registra ventas en el POS para calcularla.</p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col">
          {/* Métrica principal */}
          <div>
            <p className="text-4xl font-semibold tracking-tight text-zinc-50 tabular-nums">
              {formatRotacion(rotacion)}
            </p>
            <p className={`mt-1 text-xs font-medium ${estado.clase}`}>{estado.texto}</p>
          </div>

          {/* Desglose que sustenta la rotación (salidas del POS vs. inventario) */}
          <dl className="mt-auto space-y-3 pt-6">
            <div className="flex items-center justify-between border-t border-zinc-800/70 pt-3">
              <dt className="text-xs text-zinc-500">Costo vendido (COGS)</dt>
              <dd className="text-sm font-semibold tabular-nums text-zinc-100">{formatCOP(costo)}</dd>
            </div>
            <div className="flex items-center justify-between border-t border-zinc-800/70 pt-3">
              <dt className="text-xs text-zinc-500">Inventario a costo</dt>
              <dd className="text-sm font-semibold tabular-nums text-zinc-100">
                {formatCOP(valorInventarioCosto)}
              </dd>
            </div>
            <div className="flex items-center justify-between border-t border-zinc-800/70 pt-3">
              <dt className="text-xs text-zinc-500">Unidades vendidas</dt>
              <dd className="text-sm font-semibold tabular-nums text-zinc-100">
                {unidadesVendidas.toLocaleString("es-CO")}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
