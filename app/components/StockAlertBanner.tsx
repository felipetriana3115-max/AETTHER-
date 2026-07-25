"use client";

import { useMemo, useState } from "react";
import { useDashboard } from "./DashboardProvider";
import {
  CRITICAL_STOCK_THRESHOLD,
  EXPIRY_SOON_DAYS,
  daysUntilExpiry,
  isCriticalStock,
  isExpired,
  isExpiringSoon,
  type InventoryItem,
} from "../lib/data-model";

/**
 * Alertas Inteligentes de inventario — banner flotante y prominente.
 *
 * Reutiliza el estado global (`useDashboard`) ya cargado desde Supabase, así que
 * la validación es LIGERA: son filtros en memoria sobre los productos que el
 * dashboard ya tiene, sin ninguna consulta adicional. Reacciona en tiempo real a
 * los cambios de inventario (recarga desde el servidor, importaciones, etc.).
 *
 * Dispara ante dos condiciones, en orden de urgencia:
 *   1. STOCK CRÍTICO  — productos con menos de 5 unidades (rojo).
 *   2. INSUMOS POR VENCER — vencidos o que caducan dentro de 30 días (ámbar).
 *
 * Es descartable por sesión: al cerrarlo se oculta hasta la próxima recarga.
 */

/** Cuántos nombres de producto mostramos antes de resumir el resto con "+N más". */
const MAX_NOMBRES = 4;

function AlertIcon() {
  return (
    <svg
      className="h-5 w-5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** Une nombres en un texto legible: "A, B y C" o "A, B, C +N más". */
function listarNombres(items: InventoryItem[]): string {
  const nombres = items.map((i) => i.name);
  if (nombres.length <= MAX_NOMBRES) {
    if (nombres.length <= 1) return nombres.join("");
    return `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
  }
  const visibles = nombres.slice(0, MAX_NOMBRES).join(", ");
  return `${visibles} +${nombres.length - MAX_NOMBRES} más`;
}

/** Etiqueta corta del vencimiento: "vencido", "vence hoy", "vence en N días". */
function etiquetaVencimiento(item: InventoryItem): string {
  const d = daysUntilExpiry(item);
  if (d === null) return "";
  if (d < 0) return `vencido hace ${Math.abs(d)} d`;
  if (d === 0) return "vence hoy";
  return `vence en ${d} d`;
}

export default function StockAlertBanner() {
  const { inventory } = useDashboard();
  const [dismissed, setDismissed] = useState(false);

  const { criticos, vencidos, porVencer } = useMemo(() => {
    const criticos = inventory.filter(isCriticalStock);
    const vencidos = inventory.filter((i) => isExpired(i));
    const porVencer = inventory
      .filter((i) => isExpiringSoon(i))
      // Los más próximos a vencer primero, para que el aviso sea accionable.
      .sort((a, b) => (daysUntilExpiry(a) ?? 0) - (daysUntilExpiry(b) ?? 0));
    return { criticos, vencidos, porVencer };
  }, [inventory]);

  const hayAlertas = criticos.length > 0 || vencidos.length > 0 || porVencer.length > 0;

  if (!hayAlertas || dismissed) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      className="sticky top-0 z-30 overflow-hidden rounded-xl border border-red-500/40 bg-gradient-to-r from-red-950/90 to-zinc-900/90 shadow-lg shadow-red-950/40 ring-1 ring-inset ring-red-500/10 backdrop-blur"
    >
      {/* Franja de acento roja pulsante para máxima visibilidad. */}
      <div className="absolute inset-y-0 left-0 w-1 animate-pulse bg-red-500" />

      <div className="flex flex-col gap-3 p-4 pl-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <span className="mt-0.5 text-red-400">
            <AlertIcon />
          </span>
          <div className="space-y-2 text-sm">
            <p className="font-semibold text-red-200">
              Alertas de inventario
              <span className="ml-2 rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-300">
                {criticos.length + vencidos.length + porVencer.length}
              </span>
            </p>

            {criticos.length > 0 && (
              <p className="text-red-100/90">
                <span className="font-semibold text-red-300">
                  Stock crítico ({criticos.length})
                </span>{" "}
                — menos de {CRITICAL_STOCK_THRESHOLD} unidades:{" "}
                <span className="text-red-100">{listarNombres(criticos)}</span>
              </p>
            )}

            {vencidos.length > 0 && (
              <p className="text-amber-100/90">
                <span className="font-semibold text-amber-300">
                  Insumos vencidos ({vencidos.length})
                </span>{" "}
                — retirar de inventario:{" "}
                <span className="text-amber-100">
                  {vencidos
                    .map((i) => `${i.name} (${etiquetaVencimiento(i)})`)
                    .slice(0, MAX_NOMBRES)
                    .join(", ")}
                  {vencidos.length > MAX_NOMBRES ? ` +${vencidos.length - MAX_NOMBRES} más` : ""}
                </span>
              </p>
            )}

            {porVencer.length > 0 && (
              <p className="text-amber-100/90">
                <span className="font-semibold text-amber-300">
                  Por vencer ({porVencer.length})
                </span>{" "}
                — en los próximos {EXPIRY_SOON_DAYS} días:{" "}
                <span className="text-amber-100">
                  {porVencer
                    .map((i) => `${i.name} (${etiquetaVencimiento(i)})`)
                    .slice(0, MAX_NOMBRES)
                    .join(", ")}
                  {porVencer.length > MAX_NOMBRES ? ` +${porVencer.length - MAX_NOMBRES} más` : ""}
                </span>
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Descartar alertas"
          className="self-start rounded-lg p-1.5 text-red-300/70 transition-colors hover:bg-red-500/10 hover:text-red-200"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
