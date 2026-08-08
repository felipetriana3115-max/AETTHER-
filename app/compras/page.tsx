"use client";

import { useMemo, useState } from "react";
import PageShell from "../components/PageShell";
import MetricCard from "../components/MetricCard";
import EmptyState from "../components/EmptyState";
import ExcelImporter from "../components/ExcelImporter";
import NewOrderForm from "../components/NewOrderForm";
import { useDashboard, type NewPurchase } from "../components/DashboardProvider";
import { formatCOP, type PurchaseStatus } from "../lib/data-model";
import { recibirCompra } from "../lib/resumen";

const statusStyles: Record<PurchaseStatus, string> = {
  Recibido: "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20",
  Pendiente: "bg-amber-500/10 text-amber-400 ring-amber-500/20",
  Cancelado: "bg-red-500/10 text-red-400 ring-red-500/20",
};

const statusDot: Record<PurchaseStatus, string> = {
  Recibido: "bg-emerald-400",
  Pendiente: "bg-amber-400",
  Cancelado: "bg-red-400",
};

export default function ComprasPage() {
  // Estado global unificado: reacciona a la carga masiva de Excel/CSV.
  const { purchases: orders, addPurchases, showToast, businessName } = useDashboard();

  // Apertura del modal de creación manual de órdenes.
  const [formOpen, setFormOpen] = useState(false);

  // Proveedores existentes para el <select> del formulario (únicos, sin "—").
  const suppliers = useMemo(
    () =>
      Array.from(
        new Set(orders.map((o) => o.supplier).filter((s) => s && s !== "—")),
      ).sort((a, b) => a.localeCompare(b, "es")),
    [orders],
  );

  const activeOrders = orders.filter((o) => o.status !== "Cancelado");
  const totalCost = activeOrders.reduce((s, o) => s + o.cost, 0);
  const pending = orders.filter((o) => o.status === "Pendiente").length;
  const received = orders.filter((o) => o.status === "Recibido").length;
  const activeSuppliers = new Set(
    activeOrders.map((o) => o.supplier).filter((s) => s && s !== "—"),
  ).size;

  // Persiste la orden manual en Supabase (`public.compras`) vía `addPurchases`, que
  // inserta y RELEE la tabla para refrescar el estado con la verdad de la BD; así
  // la orden sobrevive a las recargas. Si la orden nace en estado "Recibido",
  // impacta además el inventario de forma atómica vía la RPC `recibir_compra`
  // (suma el stock al producto o lo crea si no existe).
  const handleCreateOrder = async (order: NewPurchase) => {
    const guardadas = await addPurchases([order]);

    if (guardadas === 0) {
      showToast(
        "No se pudo guardar",
        `La orden para ${order.supplier} no se persistió. Revisa tu conexión o la migración de compras.`,
      );
      return;
    }

    if (order.status !== "Recibido") {
      showToast("Orden creada", `Nueva orden para ${order.supplier} registrada.`);
      return;
    }

    const ok = await recibirCompra({
      productoId: order.productoId ?? null,
      descripcion: order.items,
      codigoBarras: order.codigoBarras ?? null,
      unidades: order.units,
      costo: order.cost,
    });

    showToast(
      ok ? "Orden recibida" : "Orden creada",
      ok
        ? `+${order.units} uds. de ${order.items} sumadas al inventario.`
        : `Orden para ${order.supplier} registrada, pero no se pudo impactar el stock.`,
    );
  };

  return (
    <PageShell title="Compras" subtitle={`${businessName} · Abastecimiento y proveedores`}>
      <NewOrderForm
        open={formOpen}
        suppliers={suppliers}
        onClose={() => setFormOpen(false)}
        onSubmit={handleCreateOrder}
      />

      <div className="space-y-6">
        {/* Carga de archivos de órdenes de compra */}
        <ExcelImporter />

        {orders.length === 0 ? (
          <EmptyState message="Carga un archivo Excel o CSV con tus órdenes de compra, o crea una orden manualmente con “+ Nueva orden”.">
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-600/15 px-3 py-2 text-xs font-medium text-violet-200 shadow-[0_0_20px_-8px_rgba(139,92,246,0.7)] transition-colors hover:bg-violet-600/25"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              Nueva orden
            </button>
          </EmptyState>
        ) : (
      <>
        {/* Métricas */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Costo de Adquisición"
            value={formatCOP(totalCost)}
            delta="+6.2%"
            deltaGood={false}
            deltaCaption="vs. mes anterior"
            tone="violet"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="7" width="20" height="14" rx="2" />
                <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
              </svg>
            }
          />
          <MetricCard
            label="Órdenes Pendientes"
            value={String(pending)}
            delta="+1"
            deltaGood={false}
            deltaCaption="por recibir"
            tone="amber"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            }
          />
          <MetricCard
            label="Órdenes Recibidas"
            value={String(received)}
            delta="+3"
            deltaGood
            deltaCaption="este mes"
            tone="emerald"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <path d="m9 11 3 3L22 4" />
              </svg>
            }
          />
          <MetricCard
            label="Proveedores Activos"
            value={String(activeSuppliers)}
            delta="+1"
            deltaGood
            deltaCaption="nuevo este trimestre"
            tone="fuchsia"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 21h18" />
                <path d="M5 21V7l8-4v18" />
                <path d="M19 21V11l-6-4" />
              </svg>
            }
          />
        </section>

        {/* Registro de órdenes */}
        <section className="rounded-xl border border-violet-500/15 bg-zinc-900/50">
          <div className="flex items-center justify-between border-b border-zinc-800 p-5">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">Órdenes de compra</h3>
              <p className="mt-0.5 text-xs text-zinc-500">Registro de pedidos a proveedores</p>
            </div>
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-600/15 px-3 py-2 text-xs font-medium text-violet-200 shadow-[0_0_20px_-8px_rgba(139,92,246,0.7)] transition-colors hover:bg-violet-600/25"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              Nueva orden
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-5 py-3 font-medium">Orden</th>
                  <th className="px-5 py-3 font-medium">Proveedor</th>
                  <th className="px-5 py-3 font-medium">Insumos</th>
                  <th className="px-5 py-3 text-right font-medium">Unidades</th>
                  <th className="px-5 py-3 text-right font-medium">Costo</th>
                  <th className="px-5 py-3 font-medium">Entrega</th>
                  <th className="px-5 py-3 text-right font-medium">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {orders.map((o) => (
                  <tr key={o.id} className="transition-colors hover:bg-zinc-800/40">
                    <td className="px-5 py-3.5 font-mono text-xs text-violet-300">{o.id}</td>
                    <td className="px-5 py-3.5 font-medium text-zinc-100">{o.supplier}</td>
                    <td className="px-5 py-3.5 text-zinc-400">{o.items}</td>
                    <td className="px-5 py-3.5 text-right tabular-nums text-zinc-300">{o.units}</td>
                    <td
                      className={`px-5 py-3.5 text-right font-semibold tabular-nums ${
                        o.status === "Cancelado" ? "text-zinc-500 line-through" : "text-zinc-100"
                      }`}
                    >
                      {formatCOP(o.cost)}
                    </td>
                    <td className="px-5 py-3.5 text-zinc-500">{o.eta}</td>
                    <td className="px-5 py-3.5 text-right">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${statusStyles[o.status]}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${statusDot[o.status]}`} />
                        {o.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </>
        )}
      </div>
    </PageShell>
  );
}
