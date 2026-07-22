"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NewPurchase } from "./DashboardProvider";
import type { PurchaseStatus } from "../lib/data-model";
import { fetchCatalogoProductos, type ProductoCatalogo } from "../lib/resumen";

const NEW_SUPPLIER = "__new__";
/** Opción del <select> de producto que activa el alta de un insumo fuera del catálogo. */
const NEW_PRODUCT = "__new_product__";

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
 * (proveedor, producto, unidades, costo) y delega la persistencia en `onSubmit`,
 * que conecta con `addPurchases` del DashboardProvider.
 *
 * El insumo ya NO es texto libre: se elige un producto EXISTENTE del catálogo
 * (`productos`, aislado por RLS) — mapeando su código de barras/referencia — o se
 * registra uno nuevo. Ese vínculo (`productoId`/`codigoBarras`) viaja en la orden
 * para que, al recibirla, el stock impacte al producto correcto del inventario.
 */
export default function NewOrderForm({ open, suppliers, onClose, onSubmit }: Props) {
  // Si aún no hay proveedores, arranca en modo "nuevo proveedor".
  const [supplierChoice, setSupplierChoice] = useState(NEW_SUPPLIER);
  const [newSupplier, setNewSupplier] = useState("");
  // Producto: id (como string) de un producto del catálogo, o NEW_PRODUCT para alta.
  const [productChoice, setProductChoice] = useState(NEW_PRODUCT);
  const [newProduct, setNewProduct] = useState("");
  const [barcode, setBarcode] = useState("");
  const [catalog, setCatalog] = useState<ProductoCatalogo[]>([]);
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
    setProductChoice(NEW_PRODUCT);
    setNewProduct("");
    setBarcode("");
    setUnits("");
    setCost("");
    setStatus("Pendiente");
    setEta("");
    setError(null);
    firstFieldRef.current?.focus();
  }, [open, suppliers]);

  // Carga el catálogo (aislado por RLS) para el <select> de productos al abrir.
  useEffect(() => {
    if (!open) return;
    let activo = true;
    (async () => {
      const items = await fetchCatalogoProductos();
      if (!activo) return;
      setCatalog(items);
      // Por defecto sugiere el primer producto del catálogo (nudge a reutilizar);
      // si está vacío, se queda en modo "nuevo producto".
      if (items.length) setProductChoice(String(items[0].id));
    })();
    return () => {
      activo = false;
    };
  }, [open]);

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
  const usingNewProduct = productChoice === NEW_PRODUCT;

  const selectedProduct = useMemo(
    () => (usingNewProduct ? null : catalog.find((p) => String(p.id) === productChoice) ?? null),
    [usingNewProduct, catalog, productChoice],
  );

  // Al elegir un producto del catálogo, prellenamos el costo con su precio de
  // costo conocido (si aún no se ha escrito uno) para acelerar la captura.
  const handleProductChange = useCallback(
    (value: string) => {
      setProductChoice(value);
      const prod = catalog.find((p) => String(p.id) === value);
      if (prod && prod.precio_costo > 0) setCost((c) => (c.trim() ? c : String(prod.precio_costo)));
    },
    [catalog],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      const supplier = (usingNewSupplier ? newSupplier : supplierChoice).trim();
      // La descripción sale del producto elegido o del alta manual.
      const descripcion = (usingNewProduct ? newProduct : selectedProduct?.descripcion ?? "").trim();

      if (!supplier) {
        setError("Indica el proveedor.");
        return;
      }
      if (!descripcion) {
        setError("Selecciona un producto del catálogo o escribe el nombre de uno nuevo.");
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

      // Mapeo del vínculo con el catálogo: id + código de barras (real) si es un
      // producto existente; para uno nuevo, el código de barras es el que se teclee.
      const productoId = usingNewProduct ? null : selectedProduct?.id ?? null;
      const codigoBarras = usingNewProduct
        ? barcode.trim() || null
        : selectedProduct?.codigo_barras ?? null;

      onSubmit({
        supplier,
        items: descripcion,
        units: unitsNum,
        cost: costNum,
        eta: eta.trim() || "Por definir",
        status,
        productoId,
        codigoBarras,
      });
      onClose();
    },
    [
      usingNewSupplier,
      newSupplier,
      supplierChoice,
      usingNewProduct,
      newProduct,
      selectedProduct,
      barcode,
      units,
      cost,
      eta,
      status,
      onSubmit,
      onClose,
    ],
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

          {/* Producto (del catálogo de inventario) */}
          <div className="space-y-1.5">
            <label htmlFor="no-product" className="block text-xs font-medium text-zinc-400">
              Producto
            </label>
            <select
              id="no-product"
              value={productChoice}
              onChange={(e) => handleProductChange(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/40"
            >
              {catalog.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.descripcion}
                  {p.codigo_barras ? ` · ${p.codigo_barras}` : ""}
                </option>
              ))}
              <option value={NEW_PRODUCT}>+ Nuevo producto…</option>
            </select>

            {usingNewProduct ? (
              <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  type="text"
                  value={newProduct}
                  onChange={(e) => setNewProduct(e.target.value)}
                  placeholder="Nombre del producto"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition-colors focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/40"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  placeholder="Código de barras (opcional)"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition-colors focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/40"
                />
              </div>
            ) : (
              selectedProduct && (
                <p className="mt-1 text-xs text-zinc-500">
                  Ref.:{" "}
                  <span className="font-mono text-violet-300">
                    {selectedProduct.codigo_barras ?? "sin código"}
                  </span>{" "}
                  · el stock se sumará a este producto al recibir.
                </p>
              )
            )}
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
