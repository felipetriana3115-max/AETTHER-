"use client";

import { useState } from "react";
import PageShell from "../components/PageShell";
import MetricCard from "../components/MetricCard";
import EmptyState from "../components/EmptyState";
import { useDashboard } from "../components/DashboardProvider";
import VentaDetalleModal, { type AccionVenta } from "../components/VentaDetalleModal";
import { axisScale, formatCompactCOP, formatCOP, type Sale, type SaleStatus } from "../lib/data-model";
import { useRolSesion } from "../lib/useRol";

const statusStyles: Record<SaleStatus, string> = {
  Pagado: "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20",
  Reembolsado: "bg-red-500/10 text-red-400 ring-red-500/20",
  Pendiente: "bg-amber-500/10 text-amber-400 ring-amber-500/20",
};

/** Transacción abierta en el modal de factura, con la intención del clic. */
type VentaAbierta = { venta: Sale; folio: string; accion: AccionVenta };

/** Botón de acción por transacción (ícono + etiqueta accesible). */
function AccionBoton({
  label,
  onClick,
  tono = "neutro",
  children,
}: {
  label: string;
  onClick: () => void;
  tono?: "neutro" | "peligro";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${
        tono === "peligro"
          ? "border-red-500/30 text-red-400 hover:bg-red-500/10"
          : "border-zinc-800 text-zinc-400 hover:border-violet-500/40 hover:bg-violet-500/10 hover:text-violet-300"
      }`}
    >
      {children}
    </button>
  );
}

export default function VentasPage() {
  // Estado global unificado: reacciona a la carga masiva de Excel.
  const {
    sales: recentSales,
    monthlyRevenue,
    businessName,
    metricas,
    refreshSales,
  } = useDashboard();

  /**
   * Devolver es cosa del dueño: mueve dinero (egreso de caja) e inventario
   * sobre una venta ya cerrada. Fail-closed — el botón no aparece hasta
   * confirmar el rol. El control REAL está en la RPC `registrar_devolucion`,
   * que exige empresa_admin/super_admin; esto solo evita ofrecer un botón que
   * fallaría. Ver y reimprimir siguen disponibles para cualquier empleado con
   * permiso 'ventas'.
   */
  const { esAdministrador } = useRolSesion();

  // Factura abierta (vista previa / reimpresión / devolución). Null = cerrada.
  const [abierta, setAbierta] = useState<VentaAbierta | null>(null);

  const total = monthlyRevenue.reduce((s, m) => s + m.amount, 0);
  const paidSales = recentSales.filter((s) => s.status === "Pagado");
  const avgTicket = paidSales.length
    ? paidSales.reduce((s, x) => s + x.amount, 0) / paidSales.length
    : 0;

  // Escala del eje calculada dinámicamente a partir de los datos vivos.
  const { top: MAX, ticks: TICKS } = axisScale(
    Math.max(0, ...monthlyRevenue.map((m) => m.amount)),
    4,
  );

  return (
    <PageShell title="Ventas" subtitle={`${businessName} · Rendimiento comercial del año`}>
      {recentSales.length === 0 ? (
        <EmptyState message="Carga un archivo Excel con tus ventas para ver el rendimiento comercial." />
      ) : (
      <div className="space-y-6">
        {/* Métricas clave */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <MetricCard
            label="Ingresos Totales"
            value={formatCOP(total)}
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
            label="Ticket Promedio"
            value={formatCOP(avgTicket)}
            delta="+4.7%"
            deltaGood
            tone="fuchsia"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 9V5a2 2 0 0 1 2-2h4" />
                <path d="M2 15v4a2 2 0 0 0 2 2h4" />
                <path d="M22 9V5a2 2 0 0 0-2-2h-4" />
                <path d="M22 15v4a2 2 0 0 1-2 2h-4" />
                <path d="M7 12h10" />
              </svg>
            }
          />
          <MetricCard
            label="Margen de Ganancia"
            value={`${metricas.margen.toLocaleString("es-CO", { maximumFractionDigits: 1 })}%`}
            tone="emerald"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18" />
                <path d="m19 9-5 5-4-4-3 3" />
              </svg>
            }
          />
        </section>

        {/* Gráfico financiero */}
        <section className="relative overflow-hidden rounded-xl border border-violet-500/15 bg-zinc-900/50 p-6">
          <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-violet-600/10 blur-3xl" />
          <div className="relative mb-6 flex items-start justify-between">
            <div>
              <h3 className="text-sm font-medium text-zinc-400">Ingresos mensuales</h3>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-zinc-50">{formatCOP(total)}</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              +18.3% interanual
            </span>
          </div>

          <div className="relative flex gap-3">
            {/* Eje Y */}
            <div className="flex h-64 flex-col justify-between py-0 text-right text-[10px] tabular-nums text-zinc-600" aria-hidden>
              {TICKS.map((t) => (
                <span key={t}>{formatCompactCOP(t)}</span>
              ))}
            </div>

            {/* Área de trazado */}
            <div className="min-w-0 flex-1">
              <div className="relative h-64">
                <div className="absolute inset-0 flex flex-col justify-between">
                  {TICKS.map((t) => (
                    <div key={t} className="h-px w-full bg-zinc-800" />
                  ))}
                </div>

                <div className="relative flex h-full items-end justify-between gap-1.5 sm:gap-3">
                  {monthlyRevenue.map((d) => {
                    const pct = Math.round((d.amount / MAX) * 100);
                    return (
                      <div key={d.month} className="group flex h-full flex-1 items-end justify-center">
                        <div
                          className="relative w-full max-w-[34px] rounded-t bg-gradient-to-t from-violet-600 to-fuchsia-500 shadow-[0_0_18px_-4px_rgba(139,92,246,0.7)] transition-all group-hover:from-violet-500 group-hover:to-fuchsia-400"
                          style={{ height: `${pct}%` }}
                        >
                          <div className="pointer-events-none absolute -top-10 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-100 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                            {formatCOP(d.amount)}
                            <span className="block text-center text-[10px] font-normal text-zinc-400">{d.month}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-2 flex justify-between gap-1.5 sm:gap-3">
                {monthlyRevenue.map((d) => (
                  <span key={d.month} className="flex-1 text-center text-[11px] text-zinc-500">
                    {d.month}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Historial de transacciones */}
        <section className="rounded-xl border border-violet-500/15 bg-zinc-900/50">
          <div className="flex items-center justify-between border-b border-zinc-800 p-5">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">Transacciones recientes</h3>
              <p className="mt-0.5 text-xs text-zinc-500">Últimos movimientos de la plataforma</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              En vivo
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-5 py-3 font-medium">Referencia</th>
                  <th className="px-5 py-3 font-medium">Cliente</th>
                  <th className="px-5 py-3 font-medium">Canal</th>
                  <th className="px-5 py-3 font-medium">Método</th>
                  <th className="px-5 py-3 font-medium">Fecha</th>
                  <th className="px-5 py-3 text-right font-medium">Monto</th>
                  <th className="px-5 py-3 text-right font-medium">Estado</th>
                  <th className="px-5 py-3 text-right font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {recentSales.map((s, i) => {
                  // Folio amigable derivado SOLO de la posición en la lista (más
                  // reciente primero → el índice 0 es el número más alto). Es un
                  // formateo puramente visual: no altera el `s.id` real (UUID),
                  // que se conserva en el `title` para trazabilidad relacional.
                  const folio = `Factura #${String(recentSales.length - i).padStart(5, "0")}`;
                  return (
                  <tr key={s.id} className="transition-colors hover:bg-zinc-800/40">
                    <td className="px-5 py-3.5 font-mono text-xs font-semibold text-violet-300" title={s.id}>{folio}</td>
                    <td className="px-5 py-3.5 font-medium text-zinc-100">{s.customer}</td>
                    <td className="px-5 py-3.5 text-zinc-400">{s.channel}</td>
                    <td className="px-5 py-3.5 text-zinc-400">{s.method}</td>
                    <td className="px-5 py-3.5 text-zinc-500">{s.date}</td>
                    <td
                      className={`px-5 py-3.5 text-right font-semibold tabular-nums ${
                        s.status === "Reembolsado" ? "text-zinc-500 line-through" : "text-zinc-100"
                      }`}
                    >
                      {formatCOP(s.amount)}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${statusStyles[s.status]}`}>
                        {s.status}
                      </span>
                    </td>
                    {/* Acciones por transacción. Las tres abren la factura: la
                        de impresión dispara la tirilla al cargarla y la de
                        devolución salta directo a la confirmación, para que
                        nadie reembolse sin ver antes qué está reembolsando. */}
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <AccionBoton
                          label={`Ver factura ${folio}`}
                          onClick={() => setAbierta({ venta: s, folio, accion: "ver" })}
                        >
                          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        </AccionBoton>
                        <AccionBoton
                          label={`Reimprimir la tirilla de ${folio}`}
                          onClick={() => setAbierta({ venta: s, folio, accion: "imprimir" })}
                        >
                          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M6 9V2h12v7" />
                            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                            <path d="M6 14h12v8H6z" />
                          </svg>
                        </AccionBoton>
                        {esAdministrador && s.status !== "Reembolsado" && (
                          <AccionBoton
                            label={`Realizar la devolución de ${folio}`}
                            tono="peligro"
                            onClick={() => setAbierta({ venta: s, folio, accion: "devolver" })}
                          >
                            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                              <path d="M9 14 4 9l5-5" />
                              <path d="M4 9h11a5 5 0 0 1 0 10h-1" />
                            </svg>
                          </AccionBoton>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      )}

      {/* Factura: vista previa del desglose + reimpresión + devolución. */}
      {abierta && (
        <VentaDetalleModal
          // Remonta por transacción (y por intención): el modal carga su
          // detalle una sola vez y dispara la acción del botón pulsado.
          key={`${abierta.venta.id}:${abierta.accion}`}
          venta={abierta.venta}
          folio={abierta.folio}
          accionInicial={abierta.accion}
          onClose={() => setAbierta(null)}
          // Tras devolver, la verdad la vuelve a poner el servidor: historial,
          // total, métricas e inventario (el stock repuesto).
          onDevuelta={() => void refreshSales()}
        />
      )}
    </PageShell>
  );
}
