"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PageShell from "../components/PageShell";
import ProductForm, { type Producto } from "../components/ProductForm";
import { supabase, getEmpresaIdActiva } from "../lib/auth";
import { formatCOP } from "../lib/data-model";

/**
 * Gestión de inventario y catálogo (inspirado en Eleventa).
 *
 * Fuente de verdad: tabla `public.productos` (aislada por RLS = mi_empresa()).
 * - Tabla con búsqueda en tiempo real por `codigo_barras` o `descripcion`.
 * - Alta/edición vía <ProductForm> en un modal (mismo patrón que el POS).
 * - "Stock bajo" se calcula con la columna real `stock_minimo`.
 */

/** Fila de la tabla: producto + nombre del departamento embebido por PostgREST. */
type ProductoRow = Producto & { departamentos: { nombre: string } | null };

const SELECT =
  "id, codigo_barras, descripcion, tipo, precio_costo, margen_ganancia, precio_venta, precio_mayoreo, departamento_id, stock_actual, stock_minimo, stock_maximo, departamentos(nombre)";

export default function InventarioPage() {
  const [productos, setProductos] = useState<ProductoRow[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Modal: null = cerrado; "nuevo" = alta; objeto = edición de esa fila.
  const [modal, setModal] = useState<"nuevo" | ProductoRow | null>(null);

  // Carga (o recarga) el catálogo completo. RLS ya lo aísla por empresa.
  const cargar = useCallback(async () => {
    setCargando(true);
    // Defensa en profundidad: además de RLS, filtramos explícitamente por la
    // empresa de la sesión viva. Sin empresa resuelta no se consulta y la tabla
    // queda vacía (nunca se muestran productos de otra empresa).
    const empresaId = await getEmpresaIdActiva();
    if (!empresaId) {
      setProductos([]);
      setError(null);
      setCargando(false);
      return;
    }
    const { data, error } = await supabase
      .from("productos")
      .select("*")
      .eq("empresa_id", empresaId)
      .order("descripcion", { ascending: true });
    if (error) {
      console.error("[Inventario] No se pudo cargar el catálogo:", error);
      setError("No se pudieron cargar los productos.");
    } else {
      setError(null);
      setProductos((data ?? []) as unknown as ProductoRow[]);
    }
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  // Borra un producto (RLS lo acota a la empresa del usuario).
  const borrar = useCallback(
    async (p: ProductoRow) => {
      if (!confirm(`¿Eliminar "${p.descripcion}" del catálogo?`)) return;
      const { error } = await supabase.from("productos").delete().eq("id", p.id);
      if (error) {
        console.error("[Inventario] No se pudo eliminar el producto:", error);
        setError(`No se pudo eliminar: ${error.message}`);
        return;
      }
      cargar();
    },
    [cargar],
  );

  // Búsqueda en tiempo real: filtra por código de barras o descripción.
  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return productos;
    return productos.filter(
      (p) =>
        p.descripcion.toLowerCase().includes(q) ||
        (p.codigo_barras ?? "").toLowerCase().includes(q),
    );
  }, [productos, busqueda]);

  // Métricas rápidas del catálogo (calculadas sobre las filas reales).
  const totalUnidades = productos.reduce((s, p) => s + p.stock_actual, 0);
  const stockBajo = productos.filter((p) => p.stock_actual <= p.stock_minimo).length;
  const valorInventario = productos.reduce((s, p) => s + p.stock_actual * p.precio_venta, 0);

  // Tras guardar en el modal, recargamos el catálogo y lo cerramos.
  const onSaved = useCallback(() => {
    setModal(null);
    cargar();
  }, [cargar]);

  return (
    <PageShell
      title="Inventario"
      subtitle="Catálogo de productos · precios y existencias"
      action={
        <button
          type="button"
          onClick={() => setModal("nuevo")}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-600 px-3.5 text-sm font-semibold text-white shadow-lg shadow-violet-500/30 transition-all active:scale-[0.98]"
        >
          <span className="text-base">＋</span> Agregar producto
        </button>
      }
    >
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
        >
          {error}
        </div>
      )}

      {/* Resumen rápido */}
      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Referencias", value: String(productos.length) },
          { label: "Unidades en stock", value: totalUnidades.toLocaleString("es-CO") },
          { label: "Alertas de stock bajo", value: String(stockBajo) },
          { label: "Valor del inventario", value: formatCOP(valorInventario) },
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

      {/* Buscador en tiempo real */}
      <div className="relative mb-4">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg">🔍</span>
        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar por código de barras o descripción…"
          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-3 pl-11 pr-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
        />
      </div>

      {/* Tabla de productos */}
      <div className="overflow-x-auto rounded-xl border border-violet-500/15 bg-zinc-900/50">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3 font-medium">Descripción</th>
              <th className="px-4 py-3 font-medium">Código</th>
              <th className="px-4 py-3 font-medium">Departamento</th>
              <th className="px-4 py-3 text-right font-medium">Precio venta</th>
              <th className="px-4 py-3 text-right font-medium">Stock</th>
              <th className="px-4 py-3 text-right font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {cargando ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-zinc-500">
                  Cargando catálogo…
                </td>
              </tr>
            ) : filtrados.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-zinc-500">
                  {busqueda
                    ? `Sin resultados para "${busqueda}".`
                    : "No hay productos. Agrega el primero con el botón de arriba."}
                </td>
              </tr>
            ) : (
              filtrados.map((p) => {
                const bajo = p.stock_actual <= p.stock_minimo;
                return (
                  <tr key={p.id} className="transition-colors hover:bg-zinc-800/30">
                    <td className="px-4 py-3 font-medium text-zinc-100">{p.descripcion}</td>
                    <td className="px-4 py-3 font-mono text-xs text-violet-300">
                      {p.codigo_barras ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-zinc-400">{p.departamentos?.nombre ?? "—"}</td>
                    <td className="px-4 py-3 text-right font-semibold text-violet-300 tabular-nums">
                      {formatCOP(p.precio_venta)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums ${
                        bajo ? "font-semibold text-red-400" : "text-zinc-300"
                      }`}
                    >
                      {p.stock_actual}
                      {bajo && <span className="ml-1 text-[10px] uppercase">bajo</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setModal(p)}
                          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-violet-500/50 hover:bg-violet-500/10 hover:text-violet-200"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          onClick={() => borrar(p)}
                          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-300"
                        >
                          Eliminar
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Modal de alta/edición */}
      {modal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="inv-modal-titulo"
          onClick={() => setModal(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-violet-500/25 bg-zinc-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="inv-modal-titulo" className="mb-4 text-base font-semibold text-zinc-100">
              {modal === "nuevo" ? "Nuevo producto" : "Editar producto"}
            </h3>
            <ProductForm
              producto={modal === "nuevo" ? undefined : modal}
              onSaved={onSaved}
              onCancel={() => setModal(null)}
            />
          </div>
        </div>
      )}
    </PageShell>
  );
}