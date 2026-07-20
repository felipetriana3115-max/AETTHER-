"use client";

import { useMemo, useState } from "react";
import { formatCOP, isLowStock, type InventoryItem } from "../lib/data-model";
import { useDashboard } from "./DashboardProvider";

type SortKey = "name" | "category" | "stock" | "price";
type SortDir = "asc" | "desc";

function StatusBadge({ low }: { low: boolean }) {
  if (low) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-400 ring-1 ring-inset ring-red-500/20">
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        </svg>
        Stock bajo
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
      En stock
    </span>
  );
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <svg
      className={`h-3.5 w-3.5 transition-colors ${active ? "text-violet-400" : "text-zinc-600"} ${
        active && dir === "desc" ? "rotate-180" : ""
      }`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m18 15-6-6-6 6" />
    </svg>
  );
}

export default function InventoryTable() {
  const { inventory } = useDashboard();
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = inventory.filter(
      (item) =>
        item.name.toLowerCase().includes(q) || item.category.toLowerCase().includes(q),
    );

    const sorted = [...filtered].sort((a, b) => {
      let cmp: number;
      if (sortKey === "stock" || sortKey === "price") {
        cmp = a[sortKey] - b[sortKey];
      } else {
        cmp = a[sortKey].localeCompare(b[sortKey], "es");
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [inventory, query, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const columns: { key: SortKey; label: string; align: "left" | "right" }[] = [
    { key: "name", label: "Producto", align: "left" },
    { key: "category", label: "Categoría", align: "left" },
    { key: "stock", label: "Stock actual", align: "right" },
    { key: "price", label: "Precio", align: "right" },
  ];

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
      {/* Encabezado del panel */}
      <div className="flex flex-col gap-3 border-b border-zinc-800 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Control de Inventario</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            {rows.length} de {inventory.length} productos
          </p>
        </div>

        <div className="relative sm:w-64">
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
            placeholder="Buscar producto o categoría…"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-2 pl-9 pr-3 text-sm text-zinc-200 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
          />
        </div>
      </div>

      {/* Tabla */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-500">
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={`px-5 py-3 font-medium ${col.align === "right" ? "text-right" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className={`inline-flex items-center gap-1 transition-colors hover:text-zinc-300 ${
                      col.align === "right" ? "flex-row-reverse" : ""
                    } ${sortKey === col.key ? "text-zinc-300" : ""}`}
                  >
                    {col.label}
                    <SortIcon active={sortKey === col.key} dir={sortDir} />
                  </button>
                </th>
              ))}
              <th scope="col" className="px-5 py-3 text-right font-medium">
                Estado
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {rows.map((item: InventoryItem) => {
              const low = isLowStock(item);
              return (
                <tr key={item.id} className="transition-colors hover:bg-zinc-800/40">
                  <td className="px-5 py-3.5 font-medium text-zinc-100">{item.name}</td>
                  <td className="px-5 py-3.5 text-zinc-400">{item.category}</td>
                  <td
                    className={`px-5 py-3.5 text-right tabular-nums ${
                      low ? "font-semibold text-red-400" : "text-zinc-300"
                    }`}
                  >
                    {item.stock}
                  </td>
                  <td className="px-5 py-3.5 text-right tabular-nums text-zinc-300">
                    {formatCOP(item.price)}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <StatusBadge low={low} />
                  </td>
                </tr>
              );
            })}

            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-sm text-zinc-500">
                  {inventory.length === 0
                    ? "Carga un archivo Excel para ver tus productos."
                    : `No se encontraron productos para “${query}”.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
