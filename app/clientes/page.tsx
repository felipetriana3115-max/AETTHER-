"use client";

import PageShell from "../components/PageShell";
import MetricCard from "../components/MetricCard";
import EmptyState from "../components/EmptyState";
import { useDashboard } from "../components/DashboardProvider";
import { formatCOP, type Tier } from "../lib/demo-data";

const tierStyles: Record<Tier, string> = {
  Oro: "bg-amber-500/10 text-amber-300 ring-amber-400/30",
  Plata: "bg-zinc-400/10 text-zinc-300 ring-zinc-400/30",
  Bronce: "bg-orange-500/10 text-orange-300 ring-orange-400/30",
};

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export default function ClientesPage() {
  // Estado global unificado: reacciona a la carga masiva de Excel.
  const { customers, businessName } = useDashboard();

  const totalCustomers = customers.length;
  const goldCount = customers.filter((c) => c.tier === "Oro").length;
  const totalRevenue = customers.reduce((s, c) => s + c.totalSpent, 0);
  const avgSpent = totalCustomers > 0 ? totalRevenue / totalCustomers : 0;

  return (
    <PageShell title="Clientes" subtitle={`${businessName} · CRM y fidelización`}>
      {totalCustomers === 0 ? (
        <EmptyState message="Carga un archivo Excel con tus clientes para poblar el CRM." />
      ) : (
      <div className="space-y-6">
        {/* Métricas */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Clientes Totales"
            value={String(totalCustomers)}
            delta="+2"
            deltaGood
            deltaCaption="nuevos este mes"
            tone="violet"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              </svg>
            }
          />
          <MetricCard
            label="Clientes Oro"
            value={String(goldCount)}
            delta="+1"
            deltaGood
            deltaCaption="programa de fidelidad"
            tone="amber"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.5 3.2 14 8l5.3.8-3.8 3.7.9 5.3-4.9-2.6-4.9 2.6.9-5.3L3.7 8.8 9 8Z" />
              </svg>
            }
          />
          <MetricCard
            label="Ingresos por Clientes"
            value={formatCOP(totalRevenue)}
            delta="+14.9%"
            deltaGood
            tone="emerald"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v20" />
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            }
          />
          <MetricCard
            label="Compra Promedio"
            value={formatCOP(avgSpent)}
            delta="+3.4%"
            deltaGood
            deltaCaption="acumulado por cliente"
            tone="fuchsia"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18" />
                <path d="m19 9-5 5-4-4-3 3" />
              </svg>
            }
          />
        </section>

        {/* Directorio de tarjetas */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-100">Directorio de clientes</h3>
            <span className="text-xs text-zinc-500">{totalCustomers} contactos</span>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {customers.map((c) => (
              <article
                key={c.id}
                className="group relative overflow-hidden rounded-xl border border-violet-500/15 bg-zinc-900/50 p-5 transition-all duration-300 hover:border-violet-500/40 hover:shadow-[0_0_30px_-10px_rgba(139,92,246,0.45)]"
              >
                <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-violet-600/10 blur-2xl transition-opacity duration-300 group-hover:bg-violet-500/20" />

                <div className="relative flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/20 to-fuchsia-600/20 text-sm font-semibold text-violet-200 ring-1 ring-violet-500/30">
                      {initials(c.name)}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-zinc-100">{c.name}</p>
                      <p className="truncate text-xs text-zinc-500">{c.orders} pedidos</p>
                    </div>
                  </div>
                  <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${tierStyles[c.tier]}`}>
                    {c.tier}
                  </span>
                </div>

                <div className="relative mt-4 space-y-2 text-xs">
                  <p className="flex items-center gap-2 text-zinc-400">
                    <svg className="h-3.5 w-3.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                    </svg>
                    <span className="truncate">{c.email}</span>
                  </p>
                  <p className="flex items-center gap-2 text-zinc-400">
                    <svg className="h-3.5 w-3.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
                    </svg>
                    <span>{c.phone}</span>
                  </p>
                </div>

                <div className="relative mt-4 flex items-end justify-between border-t border-zinc-800 pt-4">
                  <div>
                    <p className="text-[11px] text-zinc-500">Compras acumuladas</p>
                    <p className="mt-0.5 text-lg font-semibold tracking-tight text-zinc-50">{formatCOP(c.totalSpent)}</p>
                  </div>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-violet-500/40 hover:text-violet-200"
                  >
                    Ver perfil
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14" />
                      <path d="m12 5 7 7-7 7" />
                    </svg>
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
      )}
    </PageShell>
  );
}
