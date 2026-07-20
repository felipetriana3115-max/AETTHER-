"use client";

import MetricCard from "./MetricCard";
import SalesChart from "./SalesChart";
import InventoryTable from "./InventoryTable";
import ExcelImporter from "./ExcelImporter";
import TransactionsPanel from "./TransactionsPanel";
import PaymentSimulator from "./PaymentSimulator";
import { useDashboard } from "./DashboardProvider";
import { formatCOP, isLowStock } from "../lib/data-model";

export default function DashboardBody() {
  const { inventory, salesTotal } = useDashboard();

  // Métricas derivadas del estado global (reaccionan a la carga masiva).
  const stockProducts = inventory.reduce((sum, i) => sum + i.stock, 0);
  const lowStockAlerts = inventory.filter(isLowStock).length;

  const salesLabel = formatCOP(salesTotal);

  return (
    <>
      <div className="space-y-6">
        {/* Métricas clave */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Ventas Totales"
            value={salesLabel}
            tone="violet"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v20" />
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            }
          />
          <MetricCard
            label="Productos en Stock"
            value={stockProducts.toLocaleString("es-CO")}
            tone="fuchsia"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
                <path d="m3 8 9 5 9-5" />
                <path d="M12 13v8" />
              </svg>
            }
          />
          <MetricCard
            label="Alertas de Stock Bajo"
            value={String(lowStockAlerts)}
            tone="amber"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
            }
          />
          <MetricCard
            label="Margen de Ganancia Promedio"
            value="0%"
            tone="emerald"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18" />
                <path d="m19 9-5 5-4-4-3 3" />
              </svg>
            }
          />
        </section>

        {/* Gráfico + transacciones en vivo */}
        <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <SalesChart />
          </div>
          <div className="xl:col-span-1">
            <TransactionsPanel />
          </div>
        </section>

        {/* Importador de Excel */}
        <section>
          <ExcelImporter />
        </section>

        {/* Tabla de inventario */}
        <section>
          <InventoryTable />
        </section>
      </div>

      {/* Panel de pruebas flotante */}
      <PaymentSimulator />
    </>
  );
}
