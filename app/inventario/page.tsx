"use client";

import { useMemo, useState } from "react";
import PageShell from "../components/PageShell";
import EmptyState from "../components/EmptyState";
import { useDashboard } from "../components/DashboardProvider";
import { formatCOP, isLowStock, type InventoryItem } from "../lib/data-model";

const isLow = (p: InventoryItem) => isLowStock(p);

export default function InventarioPage() {
  // Estado global unificado: reacciona a la carga masiva de Excel.
  const { inventory: products, businessName } = useDashboard();
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q),
    );
  }, [products, query]);

  const totalUnits = products.reduce((s, p) => s + p.stock, 0);
  const lowCount = products.filter(isLow).length;
  const invValue = products.reduce((s, p) => s + p.stock * p.price, 0);

  return (
    <PageShell title="Inventario" subtitle={`${businessName} · Control de existencias`}>
      {products.length === 0 ? (
        <EmptyState message="Carga un archivo Excel para ver tus productos." />
      ) : (
      <div className="space-y-6">
        {/* Resumen rápido */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Referencias (SKU)", value: String(products.length), tone: "violet" },
            { label: "Unidades en stock", value: totalUnits.toLocaleString("es-CO"), tone: "fuchsia" },
            { label: "Alertas de stock bajo", value: String(lowCount), tone: "amber" },
            { label: "Valor del inventario", value: formatCOP(invValue), tone: "emerald" },
          ].map((c) => (
            <div
              key={c.label}
              className="relative overflow-hidden rounded-xl border border-violet-500/15 bg-zinc-900/50 p-5"
            >
              <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-violet-600/10 blur-2xl" />
              <p className="relative text-xs font-medium text-zinc-400">{c.label}</p>
              <p className="relative mt-2 text-2xl font-semibold tracking-tight text-zinc-50">{c.value}</p>
            </div>
          ))}
        </section>

        {/* Tabla de productos */}
        <section className="rounded-xl border border-violet-500/15 bg-zinc-900/50">
          <div className="flex flex-col gap-3 border-b border-zinc-800 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">Catálogo de productos</h3>
              <p className="mt-0.5 text-xs text-zinc-500">
                {rows.length} de {products.length} productos
              </p>
            </div>

            <div className="relative sm:w-72">
              <span className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar por SKU, nombre o categoría…"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-2 pl-9 pr-3 text-sm text-zinc-200 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-5 py-3 font-medium">SKU</th>
                  <th className="px-5 py-3 font-medium">Nombre</th>
                  <th className="px-5 py-3 font-medium">Categoría</th>
                  <th className="px-5 py-3 text-right font-medium">Stock actual</th>
                  <th className="px-5 py-3 text-center font-medium">Estado</th>
                  <th className="px-5 py-3 text-right font-medium">Precio</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {rows.map((p) => {
                  const low = isLow(p);
                  return (
                    <tr key={p.sku} className="transition-colors hover:bg-zinc-800/40">
                      <td className="px-5 py-3.5 font-mono text-xs text-violet-300">{p.sku}</td>
                      <td className="px-5 py-3.5 font-medium text-zinc-100">{p.name}</td>
                      <td className="px-5 py-3.5 text-zinc-400">{p.category}</td>
                      <td className={`px-5 py-3.5 text-right tabular-nums ${low ? "font-semibold text-red-400" : "text-zinc-300"}`}>
                        {p.stock}
                      </td>
                      <td className="px-5 py-3.5 text-center">
                        {low ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-400 ring-1 ring-inset ring-red-500/20">
                            <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                            Stock bajo
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            En stock
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-right tabular-nums text-zinc-300">{formatCOP(p.price)}</td>
                    </tr>
                  );
                })}

                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-10 text-center text-sm text-zinc-500">
                      No se encontraron productos para “{query}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      )}
    </PageShell>
  );
}
