"use client";

import MetricCard from "./MetricCard";
import SalesChart from "./SalesChart";
import InventoryTable from "./InventoryTable";
import ExcelImporter from "./ExcelImporter";
import RotacionPanel from "./RotacionPanel";
import StockAlertBanner from "./StockAlertBanner";
import PaymentBreakdownCard from "./PaymentBreakdownCard";
import { useDashboard } from "./DashboardProvider";
import { formatCOP, isLowStock } from "../lib/data-model";
import { useRolSesion } from "../lib/useRol";

export default function DashboardBody() {
  const { inventory, salesTotal, metricas } = useDashboard();

  /**
   * Las cifras de dinero del negocio (ventas del día y acumuladas, margen,
   * tendencia de ingresos) son SOLO para el dueño. Un empleado con rol operativo
   * ve el panel sin finanzas: stock, alertas, rotación de unidades e inventario.
   *
   * Es una restricción de UI (fail-closed: oculta hasta confirmar que es admin).
   * El acceso real a los datos lo sigue imponiendo RLS en Postgres; aquí no se
   * relaja ninguna política.
   */
  const { esAdministrador } = useRolSesion();

  // Métricas derivadas del estado global (reaccionan a la carga masiva).
  const stockProducts = inventory.reduce((sum, i) => sum + i.stock, 0);
  const lowStockAlerts = inventory.filter(isLowStock).length;

  const salesLabel = formatCOP(salesTotal);
  // Margen REAL calculado en el servidor (ventas.items ⨝ productos.precio_costo).
  const margenLabel = `${metricas.margen.toLocaleString("es-CO", { maximumFractionDigits: 1 })}%`;

  return (
    <div className="space-y-6">
      {/* Alertas inteligentes: stock crítico e insumos por vencer (banner flotante) */}
      <StockAlertBanner />

      {/* Métricas clave */}
      <section
        className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${
          esAdministrador ? "xl:grid-cols-4" : "xl:grid-cols-2"
        }`}
      >
        {esAdministrador && (
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
        )}
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
        {esAdministrador && (
          <MetricCard
            label="Margen de Ganancia"
            value={margenLabel}
            tone="emerald"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18" />
                <path d="m19 9-5 5-4-4-3 3" />
              </svg>
            }
          />
        )}
      </section>

      {/* Desglose en tiempo real de lo vendido hoy por método de pago (cuadre de
          caja). Es la "Ventas del día": solo para el dueño. */}
      {esAdministrador && (
        <section>
          <PaymentBreakdownCard />
        </section>
      )}

      {/* Gráfico de ingresos + rotación. La rotación también se oculta al
          empleado porque su desglose expone COGS y el inventario valorado a
          COSTO (precios de compra), no solo unidades. */}
      {esAdministrador && (
        <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <SalesChart />
          </div>
          <div className="xl:col-span-1">
            <RotacionPanel />
          </div>
        </section>
      )}

      {/* Importador de Excel */}
      <section>
        <ExcelImporter />
      </section>

      {/* Tabla de inventario */}
      <section>
        <InventoryTable />
      </section>
    </div>
  );
}
