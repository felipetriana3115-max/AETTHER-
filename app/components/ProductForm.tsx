"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, getEmpresaIdActiva } from "../lib/auth";
import { ACCEPT_IMAGEN, subirImagenProducto, validarImagen } from "../lib/productos";

/**
 * Alta/edición de productos (inspirado en Eleventa).
 *
 * Fuente de verdad: tabla `public.productos` en Supabase. El aislamiento por
 * empresa lo impone RLS (`empresa_id = public.mi_empresa()`).
 *
 * En el ALTA enviamos `empresa_id` EXPLÍCITO (resuelto por `getEmpresaIdActiva()`)
 * en vez de confiar en el DEFAULT del servidor: así el payload deja de depender
 * del contexto y podemos verificar/loguear que el ID viaja correcto antes del
 * INSERT. Si el helper devuelve `null` (usuario sin empresa), abortamos con un
 * mensaje claro en vez de disparar un RLS opaco. Mismo patrón que `ventas`/POS.
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
  /** Fecha de caducidad (ISO `YYYY-MM-DD`) para insumos perecederos; null si no aplica. */
  fecha_vencimiento: string | null;
  /**
   * URL pública de la foto del producto en el bucket `productos` de Storage.
   * Opcional: `null`/ausente = sin imagen y el POS pinta el placeholder de
   * iniciales. Es `?` porque las lecturas antiguas (o previas a la migración
   * `2026-08-imagen-productos.sql`) no traen la columna.
   */
  imagen_url?: string | null;
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
  fecha_vencimiento: string;
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
    fecha_vencimiento: p?.fecha_vencimiento ?? "",
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
  // Imagen opcional. `imagenFile` es la selección nueva (aún sin subir);
  // `imagenUrl` la que ya tiene la fila (null = sin imagen / se quitó).
  const [imagenFile, setImagenFile] = useState<File | null>(null);
  const [imagenUrl, setImagenUrl] = useState<string | null>(producto?.imagen_url ?? null);
  const [previewLocal, setPreviewLocal] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Si cambia el producto (p. ej. el padre reusa el form para editar otro),
  // resincronizamos el estado con esa fila.
  useEffect(() => {
    setForm(toFormState(producto));
    setVentaManual(producto != null);
    setImagenFile(null);
    setImagenUrl(producto?.imagen_url ?? null);
    if (fileRef.current) fileRef.current.value = "";
  }, [producto]);

  // Previsualización del archivo recién elegido (sin subirlo). El object URL se
  // libera al cambiar de archivo o al desmontar para no filtrar memoria.
  useEffect(() => {
    if (!imagenFile) {
      setPreviewLocal(null);
      return;
    }
    const url = URL.createObjectURL(imagenFile);
    setPreviewLocal(url);
    return () => URL.revokeObjectURL(url);
  }, [imagenFile]);

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

  // Selección de imagen: validamos tipo/tamaño en el navegador antes de gastar
  // red (Storage impone los mismos límites en servidor).
  const seleccionarImagen = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) {
      setImagenFile(null);
      return;
    }
    const invalido = validarImagen(file);
    if (invalido) {
      setError(invalido);
      setImagenFile(null);
      e.target.value = "";
      return;
    }
    setError(null);
    setImagenFile(file);
  }, []);

  /** Deja el producto sin imagen (descarta la selección y la URL guardada). */
  const quitarImagen = useCallback(() => {
    setImagenFile(null);
    setImagenUrl(null);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  const guardar = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

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

      // Campos comunes a alta y edición. Los precios/stocks vacíos van como 0 o
      // null según la columna sea NOT NULL.
      const base = {
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
        // Vacío → null (producto que no vence). Alimenta la alerta de vencimiento.
        fecha_vencimiento: form.fecha_vencimiento.trim() || null,
      };

      setGuardando(true);
      try {
        // Imagen opcional: si hay archivo nuevo lo subimos ahora y usamos su URL
        // pública; si no, conservamos la que ya tenía la fila (o null si nunca
        // tuvo imagen o el usuario la quitó).
        let urlImagen = imagenUrl;
        if (imagenFile) {
          try {
            urlImagen = await subirImagenProducto(imagenFile);
          } catch (err) {
            setError(err instanceof Error ? err.message : "No se pudo subir la imagen.");
            return;
          }
        }
        const conImagen = { ...base, imagen_url: urlImagen };

        let query;
        if (editando) {
          // Edición: RLS acota por `id` a la empresa del usuario; no reescribimos
          // `empresa_id` (no debe cambiar de dueño).
          query = supabase.from("productos").update(conImagen).eq("id", producto!.id);
        } else {
          // Alta: adjuntamos `empresa_id` EXPLÍCITO en vez de confiar en el DEFAULT
          // del servidor. Si no hay empresa resoluble, no tiene sentido intentar el
          // INSERT: el `with check` lo rechazaría con un RLS opaco.
          const empresaId = await getEmpresaIdActiva();
          const payload = { ...conImagen, empresa_id: empresaId };

          // Diagnóstico: así se ve exactamente qué viaja al servidor. Si
          // `empresa_id` sale `null`, el problema es el dato del usuario
          // (usuarios.empresa_id nulo), NO la política ni el formulario.
          console.log("[ProductForm] Payload INSERT productos →", payload);

          if (!empresaId) {
            setError(
              "Tu usuario no tiene una empresa asignada, así que no se puede crear " +
                "el producto. Cierra sesión y vuelve a entrar; si persiste, hay que " +
                "reparar tu cuenta (usuarios.empresa_id está vacío).",
            );
            setGuardando(false);
            return;
          }

          query = supabase.from("productos").insert(payload);
        }

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
        if (!editando) {
          setForm(toFormState()); // limpia para cargar el siguiente
          setImagenFile(null);
          setImagenUrl(null);
          if (fileRef.current) fileRef.current.value = "";
        } else {
          // Tras editar, la URL subida pasa a ser la "actual" de la fila.
          setImagenFile(null);
          setImagenUrl(urlImagen);
          if (fileRef.current) fileRef.current.value = "";
        }
      } finally {
        setGuardando(false);
      }
    },
    [form, editando, producto, onSaved, imagenFile, imagenUrl],
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

      {/* Fecha de vencimiento (para insumos perecederos → alerta de vencimiento) */}
      <div>
        <label htmlFor="pf-vencimiento" className={LABEL}>
          Fecha de vencimiento
        </label>
        <input
          id="pf-vencimiento"
          type="date"
          value={form.fecha_vencimiento}
          onChange={set("fecha_vencimiento")}
          className={INPUT}
        />
        <p className="mt-1 text-xs text-zinc-500">
          Opcional. Solo para insumos perecederos; dispara la alerta de vencimiento.
        </p>
      </div>

      {/* Imagen del producto (opcional). Si no se elige nada, el POS pinta el
          placeholder de iniciales. */}
      <div>
        <label htmlFor="pf-imagen" className={LABEL}>
          Imagen del producto
        </label>
        <div className="flex items-start gap-3">
          {/* Previsualización: el archivo recién elegido o la imagen ya guardada. */}
          {previewLocal || imagenUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- URL remota de
            // Storage / blob local: no pasa por el optimizador de next/image.
            <img
              src={previewLocal ?? imagenUrl ?? ""}
              alt="Previsualización del producto"
              className="h-20 w-20 shrink-0 rounded-lg border border-zinc-800 object-cover"
            />
          ) : (
            <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg border border-dashed border-zinc-800 bg-zinc-950 text-2xl text-zinc-600">
              🖼️
            </div>
          )}
          <div className="min-w-0 flex-1">
            <input
              id="pf-imagen"
              ref={fileRef}
              type="file"
              accept={ACCEPT_IMAGEN}
              onChange={seleccionarImagen}
              className="w-full cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-400 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-violet-500/15 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-violet-300 hover:file:bg-violet-500/25"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Opcional. PNG o JPG, máximo 2 MB. Sin imagen se muestran las iniciales.
            </p>
            {(previewLocal || imagenUrl) && (
              <button
                type="button"
                onClick={quitarImagen}
                className="mt-1.5 text-xs text-zinc-400 hover:text-red-300"
              >
                Quitar imagen
              </button>
            )}
          </div>
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
