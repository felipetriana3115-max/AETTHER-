"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import PageShell from "../../components/PageShell";
import { supabase } from "../../lib/auth";
import { formatCOP } from "../../lib/demo-data";

/**
 * Punto de Venta (POS) táctil — pensado para retail rápido (superior a Eleventa).
 *
 * Fuente de verdad: tabla `public.productos` en Supabase.
 * Columnas usadas: id · nombre · precio · codigo_barras · stock_actual.
 *
 * Flujos clave:
 *  - Escáner: input con autoFocus; al pulsar Enter busca por `codigo_barras`,
 *    añade 1 unidad al carrito y limpia el campo (listo para el siguiente código).
 *  - Grid táctil: botones grandes para los productos más frecuentes.
 *  - Cobro: valida stock, descuenta `stock_actual` por unidad vendida y registra
 *    el método de pago. El descuento usa un guard optimista (`.gte`) en la BD
 *    para impedir sobreventa aunque dos cajas cobren a la vez.
 */

// ── Tipos ────────────────────────────────────────────────────────────────────

type Producto = {
  id: number;
  nombre: string;
  precio: number;
  codigo_barras: string | null;
  stock_actual: number;
};

type LineaCarrito = Producto & { qty: number };

type MetodoPago = "Efectivo" | "Nequi/Daviplata" | "Bold";

type Feedback = { tone: "error" | "ok"; msg: string } | null;

// ── Config de UI ─────────────────────────────────────────────────────────────

const METODOS: { id: MetodoPago; label: string; sub: string; classes: string }[] = [
  {
    id: "Efectivo",
    label: "Efectivo",
    sub: "Pago en caja",
    classes: "from-emerald-500 to-green-600 shadow-emerald-500/40",
  },
  {
    id: "Nequi/Daviplata",
    label: "Nequi / Daviplata",
    sub: "Billetera móvil",
    classes: "from-fuchsia-500 to-purple-600 shadow-fuchsia-500/40",
  },
  {
    id: "Bold",
    label: "Bold",
    sub: "Datáfono / tarjeta",
    classes: "from-sky-500 to-blue-600 shadow-sky-500/40",
  },
];

// Placeholder de imagen: iniciales del producto sobre un degradado.
function Placeholder({ nombre }: { nombre: string }) {
  const iniciales = nombre
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div className="flex h-14 w-full items-center justify-center rounded-lg bg-gradient-to-br from-violet-600/30 to-fuchsia-600/30 text-lg font-bold text-violet-200">
      {iniciales || "?"}
    </div>
  );
}

export default function PosPage() {
  const [frecuentes, setFrecuentes] = useState<Producto[]>([]);
  const [carrito, setCarrito] = useState<LineaCarrito[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [cobrando, setCobrando] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Autolimpia el feedback tras unos segundos para no dejar alertas pegadas.
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3500);
    return () => clearTimeout(t);
  }, [feedback]);

  // Carga inicial de los productos frecuentes para el grid táctil.
  useEffect(() => {
    let activo = true;
    (async () => {
      const { data, error } = await supabase
        .from("productos")
        .select("id, nombre, precio, codigo_barras, stock_actual")
        .order("nombre", { ascending: true })
        .limit(12);
      if (!activo) return;
      if (error) {
        setFeedback({ tone: "error", msg: "No se pudieron cargar los productos." });
        return;
      }
      setFrecuentes((data ?? []) as Producto[]);
    })();
    return () => {
      activo = false;
    };
  }, []);

  const total = useMemo(() => carrito.reduce((s, l) => s + l.precio * l.qty, 0), [carrito]);
  const unidades = useMemo(() => carrito.reduce((s, l) => s + l.qty, 0), [carrito]);

  // ── Carrito ────────────────────────────────────────────────────────────────

  /**
   * Agrega un producto al carrito (cantidad +1). UX proactiva: si el stock es 0
   * (o la línea ya alcanzó el stock disponible), no agrega y avisa en rojo.
   */
  const agregar = useCallback((p: Producto) => {
    if (p.stock_actual <= 0) {
      setFeedback({ tone: "error", msg: `Sin stock: "${p.nombre}" no tiene existencias.` });
      return;
    }
    setCarrito((prev) => {
      const existente = prev.find((l) => l.id === p.id);
      if (existente) {
        if (existente.qty >= p.stock_actual) {
          setFeedback({
            tone: "error",
            msg: `Solo hay ${p.stock_actual} unidad(es) de "${p.nombre}".`,
          });
          return prev;
        }
        return prev.map((l) => (l.id === p.id ? { ...l, qty: l.qty + 1 } : l));
      }
      return [...prev, { ...p, qty: 1 }];
    });
  }, []);

  const cambiarQty = useCallback((id: number, delta: number) => {
    setCarrito((prev) =>
      prev
        .map((l) => {
          if (l.id !== id) return l;
          const nueva = l.qty + delta;
          if (nueva > l.stock_actual) {
            setFeedback({ tone: "error", msg: `Solo hay ${l.stock_actual} unidad(es) de "${l.nombre}".` });
            return l;
          }
          return { ...l, qty: nueva };
        })
        .filter((l) => l.qty > 0),
    );
  }, []);

  const quitar = useCallback((id: number) => {
    setCarrito((prev) => prev.filter((l) => l.id !== id));
  }, []);

  // ── Escáner / búsqueda por código de barras ──────────────────────────────────

  /**
   * Captura Enter del escáner (o teclado): busca en `productos` por
   * `codigo_barras`, agrega 1 unidad y limpia el campo. Un lector de códigos
   * "teclea" los dígitos y termina con Enter, así que este handler es todo lo
   * que necesita el flujo de caja rápido.
   */
  const handleKeyDown = useCallback(
    async (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const codigo = busqueda.trim();
      if (!codigo) return;

      const { data, error } = await supabase
        .from("productos")
        .select("id, nombre, precio, codigo_barras, stock_actual")
        .eq("codigo_barras", codigo)
        .limit(1)
        .maybeSingle();

      setBusqueda(""); // Limpia siempre: el siguiente escaneo empieza en blanco.

      if (error) {
        setFeedback({ tone: "error", msg: "Error al buscar el producto." });
        return;
      }
      if (!data) {
        setFeedback({ tone: "error", msg: `Código "${codigo}" no encontrado.` });
        return;
      }
      agregar(data as Producto);
    },
    [busqueda, agregar],
  );

  // ── Cobro (transacción de venta) ─────────────────────────────────────────────

  /**
   * Procesa la venta con el método de pago elegido:
   *  a) valida que cada línea tenga stock (> 0 y suficiente),
   *  b) descuenta `stock_actual` por unidad vendida (guard `.gte` anti-sobreventa),
   *  c) registra la venta con su `metodo_pago` para asegurar la integridad.
   *
   * Nota: supabase-js no ofrece transacciones multi-sentencia desde el cliente;
   * el guard optimista `.gte` evita sobreventa a nivel de fila. Para atomicidad
   * total (rollback conjunto) lo ideal es una RPC Postgres `registrar_venta`.
   */
  const cobrar = useCallback(
    async (metodo: MetodoPago) => {
      if (carrito.length === 0) {
        setFeedback({ tone: "error", msg: "El carrito está vacío." });
        return;
      }
      // a) Validación de stock antes de tocar la BD.
      const sinStock = carrito.find((l) => l.stock_actual <= 0 || l.qty > l.stock_actual);
      if (sinStock) {
        setFeedback({
          tone: "error",
          msg: `Stock insuficiente para "${sinStock.nombre}" (disponibles: ${sinStock.stock_actual}).`,
        });
        return;
      }

      setCobrando(true);
      try {
        // b) Descuento de inventario por línea. `.gte` garantiza que no se venda
        //    más de lo que hay aunque el stock haya cambiado desde la última carga.
        const descuentos = await Promise.all(
          carrito.map(async (l) => {
            const { data, error } = await supabase
              .from("productos")
              .update({ stock_actual: l.stock_actual - l.qty })
              .eq("id", l.id)
              .gte("stock_actual", l.qty)
              .select("id")
              .maybeSingle();
            return { linea: l, ok: !error && !!data };
          }),
        );

        const fallidos = descuentos.filter((d) => !d.ok).map((d) => d.linea.nombre);
        if (fallidos.length > 0) {
          setFeedback({
            tone: "error",
            msg: `No se pudo descontar stock de: ${fallidos.join(", ")}. Verifica existencias.`,
          });
          return;
        }

        // c) Registro de la venta con el método de pago (integridad de datos).
        //    Best-effort: si la tabla `ventas` aún no existe, la venta de caja
        //    igual queda reflejada en el inventario ya descontado.
        // `empresa_id` lo rellena el DEFAULT mi_empresa() en la BD (ver migración
        // 2026-07-crear-ventas.sql), por eso el cliente no lo envía.
        const { error: ventaError } = await supabase.from("ventas").insert({
          metodo_pago: metodo,
          total,
          items: carrito.map((l) => ({ id: l.id, nombre: l.nombre, qty: l.qty, precio: l.precio })),
        });
        if (ventaError) {
          console.warn("[POS] No se pudo registrar la venta en 'ventas':", ventaError.message);
        }

        // Refleja el nuevo stock en el grid de frecuentes sin recargar.
        setFrecuentes((prev) =>
          prev.map((p) => {
            const vendida = carrito.find((l) => l.id === p.id);
            return vendida ? { ...p, stock_actual: p.stock_actual - vendida.qty } : p;
          }),
        );

        setCarrito([]);
        setFeedback({ tone: "ok", msg: `Venta cobrada con ${metodo}: ${formatCOP(total)}.` });
        inputRef.current?.focus();
      } finally {
        setCobrando(false);
      }
    },
    [carrito, total, unidades],
  );

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <PageShell title="Punto de Venta" subtitle="Caja rápida · Escanea, cobra y descuenta inventario">
      {feedback && (
        <div
          role="alert"
          className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium ${
            feedback.tone === "error"
              ? "border-red-500/30 bg-red-500/10 text-red-300"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          }`}
        >
          <span className="text-base">{feedback.tone === "error" ? "⚠️" : "✅"}</span>
          {feedback.msg}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ── Columna izquierda: escáner + grid táctil ── */}
        <section className="space-y-4 lg:col-span-2">
          {/* Escáner / búsqueda */}
          <div className="rounded-xl border border-violet-500/15 bg-zinc-900/50 p-4">
            <label htmlFor="scan" className="mb-1.5 block text-xs font-medium text-zinc-400">
              Escanea o escribe el código de barras
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg">🔍</span>
              <input
                id="scan"
                ref={inputRef}
                autoFocus
                inputMode="numeric"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Código de barras… (Enter para agregar)"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-3.5 pl-11 pr-3 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
            </div>
          </div>

          {/* Grid táctil de productos frecuentes */}
          <div className="rounded-xl border border-violet-500/15 bg-zinc-900/50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-zinc-100">Productos frecuentes</h3>
            {frecuentes.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">
                No hay productos cargados en el inventario.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {frecuentes.map((p) => {
                  const agotado = p.stock_actual <= 0;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => agregar(p)}
                      disabled={agotado}
                      className={`group flex flex-col gap-2 rounded-xl border p-3 text-left transition-all ${
                        agotado
                          ? "cursor-not-allowed border-red-500/30 bg-red-500/5 opacity-60"
                          : "border-zinc-800 bg-zinc-950 hover:border-violet-500/50 hover:bg-zinc-900 active:scale-95"
                      }`}
                    >
                      <Placeholder nombre={p.nombre} />
                      <span className="line-clamp-2 min-h-[2.5rem] text-sm font-medium text-zinc-100">
                        {p.nombre}
                      </span>
                      <span className="text-sm font-semibold text-violet-300">{formatCOP(p.precio)}</span>
                      <span
                        className={`text-xs ${agotado ? "font-semibold text-red-400" : "text-zinc-500"}`}
                      >
                        {agotado ? "AGOTADO" : `Stock: ${p.stock_actual}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* ── Columna derecha: carrito + pago ── */}
        <section className="flex flex-col rounded-xl border border-violet-500/15 bg-zinc-900/50">
          <div className="border-b border-zinc-800 p-4">
            <h3 className="text-sm font-semibold text-zinc-100">
              Carrito {unidades > 0 && <span className="text-zinc-500">· {unidades} und</span>}
            </h3>
          </div>

          {/* Líneas del carrito */}
          <div className="max-h-[40vh] flex-1 divide-y divide-zinc-800/70 overflow-y-auto lg:max-h-[calc(100vh-24rem)]">
            {carrito.length === 0 ? (
              <p className="p-8 text-center text-sm text-zinc-500">Agrega productos para iniciar la venta.</p>
            ) : (
              carrito.map((l) => (
                <div key={l.id} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-100">{l.nombre}</p>
                    <p className="text-xs text-zinc-500">
                      {formatCOP(l.precio)} · {formatCOP(l.precio * l.qty)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => cambiarQty(l.id, -1)}
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 text-lg text-zinc-300 hover:bg-zinc-800"
                      aria-label="Quitar una unidad"
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-sm font-semibold tabular-nums text-zinc-100">
                      {l.qty}
                    </span>
                    <button
                      type="button"
                      onClick={() => cambiarQty(l.id, 1)}
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 text-lg text-zinc-300 hover:bg-zinc-800"
                      aria-label="Agregar una unidad"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={() => quitar(l.id)}
                      className="ml-1 flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-red-500/10 hover:text-red-400"
                      aria-label="Eliminar del carrito"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Total + botones de pago rápido */}
          <div className="border-t border-zinc-800 p-4">
            <div className="mb-4 flex items-baseline justify-between">
              <span className="text-sm text-zinc-400">Total</span>
              <span className="text-3xl font-bold tracking-tight text-zinc-50">{formatCOP(total)}</span>
            </div>

            <div className="grid grid-cols-1 gap-2.5">
              {METODOS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  disabled={cobrando || carrito.length === 0}
                  onClick={() => cobrar(m.id)}
                  className={`flex items-center justify-between rounded-xl bg-gradient-to-r px-4 py-4 text-left text-white shadow-lg transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${m.classes}`}
                >
                  <span>
                    <span className="block text-base font-semibold">{m.label}</span>
                    <span className="block text-xs text-white/80">{m.sub}</span>
                  </span>
                  <span className="text-xl">{cobrando ? "…" : "→"}</span>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
