"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NewPurchase } from "./DashboardProvider";
import type { PurchaseStatus } from "../lib/demo-data";

const NEW_SUPPLIER = "__new__";

const STATUS_OPTIONS: PurchaseStatus[] = ["Pendiente", "Recibido", "Cancelado"];

type Props = {
  open: boolean;
  /** Proveedores existentes para poblar el <select> (se deriva de las órdenes). */
  suppliers: string[];
  onClose: () => void;
  /** Inyecta la nueva orden en el estado global; recibe la fila normalizada. */
  onSubmit: (order: NewPurchase) => void;
};

/**
 * Modal para crear una orden de compra. Mantiene su propio estado de formulario
 * (proveedor, insumo, unidades, costo) y delega la persistencia en `onSubmit`,
 * que conecta con `addPurchases` del DashboardProvider.
 */
export default function NewOrderForm({ open, suppliers, onClose, onSubmit }: Props) {
  // Si aún no hay proveedores, arranca en modo "nuevo proveedor".
  const [supplierChoice, setSupplierChoice] = useState(NEW_SUPPLIER);
  const [newSupplier, setNewSupplier] = useState("");
  const [items, setItems] = useState("");
  const [units, setUnits] = useState("");
  const [cost, setCost] = useState("");
  const [status, setStatus] = useState<PurchaseStatus>("Pendiente");
  const [eta, setEta] = useState("");
  const [error, setError] = useState<string | null>(null);

  const firstFieldRef = useRef<HTMLSelectElement>(null);

  // Reinicia el formulario y enfoca el primer campo cada vez que se abre.
  useEffect(() => {
    if (!open) return;
    setSupplierChoice(suppliers.length ? suppliers[0] : NEW_SUPPLIER);
    setNewSupplier("");
    setItems("");
    setUnits("");
    setCost("");
    setStatus("Pendiente");
    setEta("");
    setError(null);
    firstFieldRef.current?.focus();
  }, [open, suppliers]);

  // Cierre con la tecla Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const usingNewSupplier = supplierChoice === NEW_SUPPLIER;

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      const supplier = (usingNewSupplier ? newSupplier : supplierChoice).trim();
      const itemsValue = items.trim();

      if (!supplier) {
        setError("Indica el proveedor.");
        return;
      }
      if (!itemsValue) {
        setError("Indica el insumo o material.");
        return;
      }

      const unitsNum = Number.parseInt(units, 10);
      const costNum = Number.parseFloat(cost);

      if (!Number.isFinite(unitsNum) || unitsNum <= 0) {
        setError("Las unidades deben ser un número mayor que 0.");
        return;
      }
      if (!Number.isFinite(costNum) || costNum < 0) {
        setError("El costo debe ser un número válido.");
        return;
      }

      onSubmit({
        supplier,
        items: itemsValue,
        units: unitsNum,
        cost: costNum,
        eta: eta.trim() || "Por definir",
        status,
      });
      onClose();
    },
    [usingNewSupplier, newSupplier, supplierChoice, items, units, cost, eta, status, onSubmit, onClose],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-order-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="relative w-full max-w-md overflow-hidden rounded-xl border border-violet-500/30 bg-zinc-950 shadow-2xl shadow-violet-950/50 ring-1 ring-violet-500/10">
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-fuchsia-600/10 blur-3xl" />

        <div className="relative flex items-center justify-between border-b border-zinc-800 p-5">
          <div>
            <h3 id="new-order-title" className="text-sm font-semibold text-zinc-100">
              Nueva orden de compra
            </h3>
            <p className="mt-0.5 text-xs text-zinc-500">Registra un pedido a un proveedor</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="relative space-y-4 p-5">
          {/* Proveedor */}
          <div className="space-y-1.5">
            <label htmlFor="no-supplier" className="block text-xs font-medium text-zinc-400">
              Proveedor
            </label>
            <select
              id="no-supplier"
              ref={firstFieldRef}
              value={supplierChoice}
              onChange={(e) => setSupplierChoice(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/40"
            >
              {suppliers.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              <option value={NEW_SUPPLIER}>+ Nuevo proveedor…</option>
            </select>
            {usingNewSupplier && (
              <input
                type="text"
                value={newSupplier}
                onChange={(e) => setNewSupplier(e.target.value)}
                placeholder="Nombre del proveedor"
                className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition-colors focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/40"
              />
            )}
          </div>

          {/* Insumo */}
          <div className="space-y-1.5">
            <label htmlFor="no-items" className="block text-xs font-medium text-zinc-400">
              Insumo
            </label>
            <input
              id="no-items"
              type="text"
              value={items}
              onChange={(e) => setItems(e.target.value)}
              placeholder="Ej. Harina de trigo, empaques…"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition-colors focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/40"
            />
          </div>

          {/* Unidades + Costo */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="no-units" className="block text-xs font-medium text-zinc-400">
                Unidades
              </label>
              <input
                id="no-units"
                type="number"
                min={1}
                step={1}
                value={units}
                onChange={(e) => setUnits(e.target.value)}
                placeholder="0"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm tabular-nums text-zinc-100 placeholder:text-zinc-600 outline-none transition-colors focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/40"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="no-cost" className="block text-xs font-medium text-zinc-400">
                Costo (COP)
              </label>
              <input
                id="no-cost"
                type="number"
                min={0}
                step="any"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="0"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm tabular-nums text-zinc-100 placeholder:text-zinc-600 outline-none transition-colors focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/40"
              />
            </div>
          </div>

          {/* Entrega + Estado */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="no-eta" className="block text-xs font-medium text-zinc-400">
                Entrega <span className="text-zinc-600">(opcional)</span>
              </label>
              <input
                id="no-eta"
                type="date"
                value={eta}
                onChange={(e) => setEta(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/40 [color-scheme:dark]"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="no-status" className="block text-xs font-medium text-zinc-400">
                Estado
              </label>
              <select
                id="no-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as PurchaseStatus)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/40"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-600/20 px-3 py-2 text-xs font-medium text-violet-100 shadow-[0_0_20px_-8px_rgba(139,92,246,0.7)] transition-colors hover:bg-violet-600/30"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              Guardar orden
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
