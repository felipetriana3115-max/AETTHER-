"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/auth";

/**
 * Alta/edición de productos (inspirado en Eleventa).
 *
 * Fuente de verdad: tabla `public.productos` en Supabase. El aislamiento por
 * empresa lo impone RLS (`empresa_id = public.mi_empresa()`), así que este
 * formulario NUNCA envía `empresa_id`: lo rellena el DEFAULT del servidor y el
 * `with check` de la política lo valida. Mismo patrón que `ventas` y el POS.
 *
 * `precio_venta` se sugiere solo a partir de `precio_costo` y `margen_ganancia`
 * (precio_venta = costo × (1 + margen/100)), pero queda editable: si el cajero lo
 * cambia a mano, respetamos su valor y dejamos de recalcularlo automáticamente.
 */

// ── Tipos ──────────────────────────────────────────────────────────────────

export type TipoProducto = "unidad" | "granel" | "kit";

/** Fila de `public.productos` tal como la consumimos aquí (id = bigint → number). */
export type Producto = {
  id: number;
  codigo_barras: string | null;
  descripcion: string;
  tipo: TipoProducto;
  precio_costo: number;
  margen_ganancia: number;
  precio_venta: number;
  precio_mayoreo: number | null;
  departamento_id: number | null;
  stock_actual: number;
  stock_minimo: number;
  stock_maximo: number | null;
};

type Departamento = { id: number; nombre: string };

type Props = {
  /** Si viene, el formulario está en modo edición; si no, en modo alta. */
  producto?: Producto;
  /** Se invoca tras guardar con éxito (para refrescar la tabla del padre). */
  onSaved?: (p: Producto) => void;
  /** Se invoca al cancelar (cerrar el modal/panel del padre). */
  onCancel?: () => void;
};

// ── Estado del formulario ────────────────────────────────────────────────────
// Todo como string: los inputs numéricos son controlados y validamos al guardar.
type FormState = {
  codigo_barras: string;
  descripcion: string;
  tipo: TipoProducto;
  precio_costo: string;
  margen_ganancia: string;
  precio_venta: string;
  precio_mayoreo: string;
  departamento_id: string;
  stock_actual: string;
  stock_minimo: string;
  stock_maximo: string;
};

const TIPOS: { id: TipoProducto; label: string }[] = [
  { id: "unidad", label: "Por unidad" },
  { id: "granel", label: "A granel" },
  { id: "kit", label: "Kit / paquete" },
];

/** Clase reutilizable para inputs/selects (CSS simple, tema oscuro del proyecto). */
const INPUT =
  "w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";
const LABEL = "mb-1.5 block text-xs font-medium text-zinc-400";

/** Convierte una fila de la BD al estado del formulario (números → string). */
function toFormState(p?: Producto): FormState {
  return {
    codigo_barras: p?.codigo_barras ?? "",
    descripcion: p?.descripcion ?? "",
    tipo: p?.tipo ?? "unidad",
    precio_costo: p ? String(p.precio_costo) : "",
    margen_ganancia: p ? String(p.margen_ganancia) : "",
    precio_venta: p ? String(p.precio_venta) : "",
    precio_mayoreo: p?.precio_mayoreo != null ? String(p.precio_mayoreo) : "",
    departamento_id: p?.departamento_id != null ? String(p.departamento_id) : "",
    stock_actual: p ? String(p.stock_actual) : "",
    stock_minimo: p ? String(p.stock_minimo) : "",
    stock_maximo: p?.stock_maximo != null ? String(p.stock_maximo) : "",
  };
}

/** Número o `null` si el campo viene vacío (para columnas opcionales). */
function toNumberOrNull(v: string): number | null {
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export default function ProductForm({ producto, onSaved, onCancel }: Props) {
  const editando = producto != null;
  const [form, setForm] = useState<FormState>(() => toFormState(producto));
  const [departamentos, setDepartamentos] = useState<Departamento[]>([]);
  // Si el usuario edita `precio_venta` a mano, dejamos de auto-calcularlo.
  const [ventaManual, setVentaManual] = useState<boolean>(editando);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Si cambia el producto (p. ej. el padre reusa el form para editar otro),
  // resincronizamos el estado con esa fila.
  useEffect(() => {
    setForm(toFormState(producto));
    setVentaManual(producto != null);
  }, [producto]);

  // Carga de departamentos para el selector. RLS ya los aísla por empresa.
  useEffect(() => {
    let activo = true;
    (async () => {
      const { data, error } = await supabase
        .from("departamentos")
        .select("id, nombre")
        .order("nombre", { ascending: true });
      if (!activo) return;
      if (error) {
        console.warn("[ProductForm] No se pudieron cargar los departamentos:", error.message);
        return;
      }
      setDepartamentos((data ?? []) as Departamento[]);
    })();
    return () => {
      activo = false;
    };
  }, []);

  // Precio de venta sugerido: costo × (1 + margen/100), redondeado a peso.
  const ventaSugerida = useMemo(() => {
    const costo = Number(form.precio_costo);
    const margen = Number(form.margen_ganancia);
    if (!Number.isFinite(costo) || !Number.isFinite(margen) || costo <= 0) return null;
    return Math.round(costo * (1 + margen / 100));
  }, [form.precio_costo, form.margen_ganancia]);

  // Mientras el usuario no toque `precio_venta`, lo mantenemos sincronizado con
  // la sugerencia (costo/margen). Si ya lo editó (ventaManual), no lo pisamos.
  useEffect(() => {
    if (ventaManual || ventaSugerida == null) return;
    setForm((f) => ({ ...f, precio_venta: String(ventaSugerida) }));
  }, [ventaSugerida, ventaManual]);

  const set = useCallback(
    (campo: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = e.target.value;
      if (campo === "precio_venta") setVentaManual(true);
      setForm((f) => ({ ...f, [campo]: value }));
    },
    [],
  );

  const guardar = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      // 1. Obtenemos el usuario activo
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // 2. Buscamos el ID de empresa real en la tabla 'usuarios'
    const { data: profile } = await supabase
      .from("usuarios")
      .select("empresa_id")
      .eq("id", user.id)
      .single();

    if (!profile?.empresa_id) {
      setError("Error: No se pudo identificar tu empresa.");
      return;
    }
      const descripcion = form.descripcion.trim();
      if (!descripcion) {
        setError("La descripción es obligatoria.");
        return;
      }
      const precioVenta = Number(form.precio_venta);
      if (!Number.isFinite(precioVenta) || precioVenta <= 0) {
        setError("El precio de venta debe ser mayor que cero.");
        return;
      }

      // Payload SIN empresa_id: lo estampa el DEFAULT mi_empresa() y lo valida RLS.
      // Los precios/stocks vacíos van como 0 o null según la columna sea NOT NULL.
      const payload = {
        codigo_barras: form.codigo_barras.trim() || null,
        descripcion,
        tipo: form.tipo,
        precio_costo: Number(form.precio_costo) || 0,
        margen_ganancia: Number(form.margen_ganancia) || 0,
        precio_venta: precioVenta,
        precio_mayoreo: toNumberOrNull(form.precio_mayoreo),
        departamento_id: toNumberOrNull(form.departamento_id),
        stock_actual: Number(form.stock_actual) || 0,
        stock_minimo: Number(form.stock_minimo) || 0,
        stock_maximo: toNumberOrNull(form.stock_maximo),
      empresa_id: profile.empresa_id
};
      setGuardando(true); //
      try {
        // Alta = insert; edición = update acotado por id (RLS lo acota a la empresa).
        const query = editando
          ? supabase.from("productos").update(payload).eq("id", producto!.id)
          : supabase.from("productos").insert(payload);

        const { data, error } = await query.select().single();

        if (error) {
          console.error("[ProductForm] No se pudo guardar el producto:", error);
          // 23505 = violación de índice único (codigo_barras repetido en la empresa).
          setError(
            error.code === "23505"
              ? "Ya existe un producto con ese código de barras en tu empresa."
              : `No se pudo guardar: ${error.message}`,
          );
          return;
        }

        onSaved?.(data as Producto);
        if (!editando) setForm(toFormState()); // limpia para cargar el siguiente
      } finally {
        setGuardando(false);
      }
    },
    [form, editando, producto, onSaved],
  );

  return (
    <form onSubmit={guardar} className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300"
        >
          {error}
        </div>
      )}

      {/* Descripción + código de barras */}
      <div>
        <label htmlFor="pf-descripcion" className={LABEL}>
          Descripción *
        </label>
        <input
          id="pf-descripcion"
          value={form.descripcion}
          onChange={set("descripcion")}
          placeholder="Ej. Coca-Cola 400ml"
          className={INPUT}
          autoFocus
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="pf-codigo" className={LABEL}>
            Código de barras
          </label>
          <input
            id="pf-codigo"
            inputMode="numeric"
            value={form.codigo_barras}
            onChange={set("codigo_barras")}
            placeholder="7702001234567"
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="pf-tipo" className={LABEL}>
            Tipo
          </label>
          <select id="pf-tipo" value={form.tipo} onChange={set("tipo")} className={INPUT}>
            {TIPOS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Departamento */}
      <div>
        <label htmlFor="pf-departamento" className={LABEL}>
          Departamento
        </label>
        <select
          id="pf-departamento"
          value={form.departamento_id}
          onChange={set("departamento_id")}
          className={INPUT}
        >
          <option value="">— Sin departamento —</option>
          {departamentos.map((d) => (
            <option key={d.id} value={d.id}>
              {d.nombre}
            </option>
          ))}
        </select>
      </div>

      {/* Precios */}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label htmlFor="pf-costo" className={LABEL}>
            Precio costo
          </label>
          <input
            id="pf-costo"
            inputMode="decimal"
            value={form.precio_costo}
            onChange={set("precio_costo")}
            placeholder="0"
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="pf-margen" className={LABEL}>
            Margen %
          </label>
          <input
            id="pf-margen"
            inputMode="decimal"
            value={form.margen_ganancia}
            onChange={set("margen_ganancia")}
            placeholder="0"
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="pf-venta" className={LABEL}>
            Precio venta *
          </label>
          <input
            id="pf-venta"
            inputMode="decimal"
            value={form.precio_venta}
            onChange={set("precio_venta")}
            placeholder="0"
            className={INPUT}
          />
        </div>
      </div>

      {/* Ayuda: sugerencia de venta cuando aún no la editaron a mano */}
      {ventaSugerida != null && ventaManual && Number(form.precio_venta) !== ventaSugerida && (
        <button
          type="button"
          onClick={() => {
            setVentaManual(false);
            setForm((f) => ({ ...f, precio_venta: String(ventaSugerida) }));
          }}
          className="text-xs text-violet-400 hover:text-violet-300"
        >
          Usar precio sugerido por margen: {ventaSugerida}
        </button>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="pf-mayoreo" className={LABEL}>
            Precio mayoreo
          </label>
          <input
            id="pf-mayoreo"
            inputMode="decimal"
            value={form.precio_mayoreo}
            onChange={set("precio_mayoreo")}
            placeholder="Opcional"
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="pf-stock" className={LABEL}>
            Stock actual
          </label>
          <input
            id="pf-stock"
            inputMode="decimal"
            value={form.stock_actual}
            onChange={set("stock_actual")}
            placeholder="0"
            className={INPUT}
          />
        </div>
      </div>

      {/* Stock mínimo / máximo (para alertas de reposición) */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="pf-stock-min" className={LABEL}>
            Stock mínimo
          </label>
          <input
            id="pf-stock-min"
            inputMode="decimal"
            value={form.stock_minimo}
            onChange={set("stock_minimo")}
            placeholder="0"
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="pf-stock-max" className={LABEL}>
            Stock máximo
          </label>
          <input
            id="pf-stock-max"
            inputMode="decimal"
            value={form.stock_maximo}
            onChange={set("stock_maximo")}
            placeholder="Opcional"
            className={INPUT}
          />
        </div>
      </div>

      {/* Acciones */}
      <div className="flex gap-2.5 pt-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="h-11 flex-1 rounded-lg border border-zinc-700 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            Cancelar
          </button>
        )}
        <button
          type="submit"
          disabled={guardando}
          className="h-11 flex-1 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-600 text-sm font-semibold text-white shadow-lg shadow-violet-500/30 transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {guardando ? "Guardando…" : editando ? "Guardar cambios" : "Agregar producto"}
        </button>
      </div>
    </form>
  );
}
