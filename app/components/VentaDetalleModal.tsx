"use client";

import { useCallback, useEffect, useState } from "react";
import { useDashboard } from "./DashboardProvider";
import { formatCOP, type Sale } from "../lib/data-model";
import { loadDeviceSettings } from "../lib/devices";
import { printReceipt, type ReceiptData } from "../lib/receipt";
import { DEFAULT_TIRILLA, fetchTirilla, type TirillaConfig } from "../lib/tirilla";
import { useRolSesion } from "../lib/useRol";
import {
  fetchVentaDetalle,
  registrarDevolucion,
  type VentaDetalle,
} from "../lib/ventas";

/**
 * Factura de una transacción: vista previa, reimpresión de la tirilla y
 * devolución.
 *
 * El listado de Transacciones no trae el desglose de líneas (son muchas filas),
 * así que aquí se pide el detalle de ESA venta al abrirse — `ventas.items` en
 * Supabase, aislado por RLS más el filtro explícito por `empresa_id`. Mientras
 * llega se pinta la cabecera con lo que ya tenía la tabla, así que el modal
 * nunca aparece vacío.
 *
 * La devolución NO se arma aquí con escrituras sueltas: va por la RPC atómica
 * `registrar_devolucion` (ver supabase/2026-10-devoluciones-ventas.sql), que
 * repone el stock del tenant, marca la venta como 'Reembolsado' y registra el
 * egreso de caja en una sola transacción.
 */

/**
 * Con qué intención se abrió el modal. Los tres botones de la tabla entran por
 * aquí: así "Reimprimir" y "Devolver" siguen siendo acciones de un clic, pero
 * el cajero SIEMPRE ve antes la factura sobre la que va a actuar (crítico en la
 * devolución, que mueve dinero e inventario).
 */
export type AccionVenta = "ver" | "imprimir" | "devolver";

type Props = {
  /** Fila del listado: pinta la cabecera al instante, sin esperar al detalle. */
  venta: Sale;
  /** Folio visible que ya calcula la tabla ("Factura #00012"). */
  folio: string;
  /** Acción a disparar en cuanto el detalle esté cargado. */
  accionInicial?: AccionVenta;
  onClose: () => void;
  /** Se invoca tras una devolución efectiva para resincronizar el dashboard. */
  onDevuelta: () => void;
};

/** Fecha legible (es-CO) a partir del ISO de `created_at`. */
function fechaLegible(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
}

export default function VentaDetalleModal({
  venta,
  folio,
  accionInicial = "ver",
  onClose,
  onDevuelta,
}: Props) {
  const { businessName, showToast } = useDashboard();
  /**
   * Solo el dueño devuelve (ver la nota en /ventas). Fail-closed: hasta
   * confirmar el rol no se ofrece la acción. El control real lo impone la RPC
   * `registrar_devolucion`, que exige empresa_admin/super_admin.
   */
  const { esAdministrador } = useRolSesion();

  const [detalle, setDetalle] = useState<VentaDetalle | null>(null);
  const [cargando, setCargando] = useState(true);
  const [tirilla, setTirilla] = useState<TirillaConfig>(DEFAULT_TIRILLA);
  const [imprimiendo, setImprimiendo] = useState(false);
  // Devolución en dos pasos: el botón abre la confirmación con el motivo.
  const [confirmando, setConfirmando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [devolviendo, setDevolviendo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Reimprime la tirilla por el canal configurado en Dispositivos.
   *
   * Recibe el detalle y la identidad del recibo como ARGUMENTOS (en vez de
   * leerlos del estado) para que la carga inicial pueda dispararla en cuanto
   * los tiene, sin esperar a un render intermedio.
   *
   * `drawerPin: null` EXPLÍCITO: una copia no debe abrir el cajón, igual que la
   * reimpresión del POS.
   */
  const imprimirCopia = useCallback(
    async (d: VentaDetalle, cfg: TirillaConfig) => {
      setImprimiendo(true);
      setError(null);
      try {
        const { printer } = loadDeviceSettings();
        const recibo: ReceiptData = {
          businessName,
          ventaId: d.id,
          // El formato de la tirilla no tiene un campo para "copia", pero sí
          // imprime esta línea de fecha: marcarla ahí evita que una reimpresión
          // se confunda con el comprobante original.
          fecha: `${fechaLegible(d.fecha)} · ${d.estado === "Reembolsado" ? "DEVUELTA" : "COPIA"}`,
          items: d.lineas.map((l) => ({ nombre: l.nombre, qty: l.qty, precio: l.precio })),
          total: d.total,
          pagos: [{ metodo: d.metodo, monto: d.total }],
        };
        const r = await printReceipt(recibo, { ...printer, ...cfg }, { drawerPin: null });
        if (r.ok) {
          showToast("Tirilla reimpresa", `${folio} salió de nuevo por la impresora.`);
        } else {
          setError(r.message);
        }
      } finally {
        setImprimiendo(false);
      }
    },
    [businessName, folio, showToast],
  );

  /**
   * Detalle de la venta + identidad de la tirilla (para reimprimir con NIT y
   * logo). En cuanto ambos están, se ejecuta la acción con la que se abrió el
   * modal: así "Reimprimir" y "Devolver" siguen siendo un solo clic desde la
   * tabla. El modal se remonta por cada transacción (`key` en el llamador), de
   * modo que esto corre una sola vez por factura abierta.
   */
  useEffect(() => {
    let activo = true;
    void (async () => {
      const [d, cfg] = await Promise.all([fetchVentaDetalle(venta.id), fetchTirilla()]);
      if (!activo) return;
      setDetalle(d);
      setTirilla(cfg);
      setCargando(false);
      if (!d) {
        setError(
          "No se pudo cargar el detalle de esta venta. Puede que ya no exista o que no pertenezca a tu empresa.",
        );
        return;
      }
      if (accionInicial === "imprimir") {
        void imprimirCopia(d, cfg);
      } else if (accionInicial === "devolver" && d.estado !== "Reembolsado") {
        setConfirmando(true);
      }
    })();
    return () => {
      activo = false;
    };
  }, [venta.id, accionInicial, imprimirCopia]);

  // Esc cierra el modal (mismo gesto que el resto de diálogos del ERP).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const devuelta = (detalle?.estado ?? venta.status) === "Reembolsado";
  const total = detalle?.total ?? venta.amount;
  const metodo = detalle?.metodo ?? venta.method;
  const lineas = detalle?.lineas ?? [];
  // Suma de las líneas: puede no cuadrar con `total` en ventas importadas, que
  // llegan sin desglose. Se muestra tal cual en vez de "corregir" el total.
  const sumaLineas = lineas.reduce((s, l) => s + l.precio * l.qty, 0);
  const unidades = lineas.reduce((s, l) => s + l.qty, 0);

  /** Procesa la devolución y resincroniza el dashboard con el servidor. */
  const confirmarDevolucion = useCallback(async () => {
    if (!detalle || devolviendo) return;
    setDevolviendo(true);
    setError(null);
    try {
      const r = await registrarDevolucion(detalle.id, motivo);
      if (!r.ok) {
        setError(r.error ?? "No se pudo procesar la devolución.");
        return;
      }
      if (r.duplicada) {
        showToast(
          "La venta ya estaba devuelta",
          "No se volvió a tocar el inventario (la operación es idempotente).",
        );
      } else {
        const aviso =
          r.sinProducto > 0
            ? ` ${r.sinProducto} línea(s) no se pudieron reponer porque el producto ya no está en el catálogo.`
            : "";
        showToast(
          "Devolución procesada",
          `${folio}: ${formatCOP(detalle.total)} reembolsado y ${r.unidades} unidad(es) devueltas al inventario.${aviso}`,
        );
      }
      onDevuelta();
      onClose();
    } finally {
      setDevolviendo(false);
    }
  }, [detalle, devolviendo, motivo, folio, showToast, onDevuelta, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="factura-titulo"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-2xl border border-violet-500/25 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabecera */}
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 p-5">
          <div className="min-w-0">
            <h3 id="factura-titulo" className="font-mono text-base font-semibold text-violet-300">
              {folio}
            </h3>
            <p className="mt-0.5 truncate text-xs text-zinc-500">
              {fechaLegible(detalle?.fecha ?? venta.date)} · {venta.customer}
              {(detalle?.canal ?? venta.channel) && ` · ${detalle?.canal ?? venta.channel}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {devuelta && (
              <span className="rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-400 ring-1 ring-inset ring-red-500/20">
                Reembolsado
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar factura"
              className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Desglose */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {cargando ? (
            <div className="space-y-2" aria-busy="true">
              <div className="h-10 animate-pulse rounded-lg bg-zinc-800/60" />
              <div className="h-10 animate-pulse rounded-lg bg-zinc-800/40" />
              <div className="h-10 animate-pulse rounded-lg bg-zinc-800/30" />
            </div>
          ) : lineas.length === 0 ? (
            <p className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-sm text-zinc-500">
              Esta venta no tiene desglose de líneas. Las ventas importadas del histórico guardan
              solo el total; el detalle por producto existe en las ventas cobradas desde el POS.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="pb-2 font-medium">Producto</th>
                  <th className="pb-2 text-center font-medium">Cant.</th>
                  <th className="pb-2 text-right font-medium">Unitario</th>
                  <th className="pb-2 text-right font-medium">Importe</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {lineas.map((l, i) => (
                  <tr key={`${l.nombre}-${i}`}>
                    <td className="py-2.5 pr-2 text-zinc-100">
                      {l.nombre}
                      {l.esComun && (
                        <span className="ml-1.5 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">
                          común
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-center tabular-nums text-zinc-300">{l.qty}</td>
                    <td className="py-2.5 text-right tabular-nums text-zinc-400">
                      {formatCOP(l.precio)}
                    </td>
                    <td className="py-2.5 text-right font-medium tabular-nums text-zinc-100">
                      {formatCOP(l.precio * l.qty)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Resumen de pago */}
          <dl className="mt-5 space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 text-sm">
            {lineas.length > 0 && (
              <div className="flex items-baseline justify-between">
                <dt className="text-zinc-500">
                  {unidades} unidad{unidades === 1 ? "" : "es"} en {lineas.length} línea
                  {lineas.length === 1 ? "" : "s"}
                </dt>
                <dd className="tabular-nums text-zinc-400">{formatCOP(sumaLineas)}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between">
              <dt className="text-zinc-500">Método de pago</dt>
              <dd className="font-medium text-zinc-200">{metodo}</dd>
            </div>
            <div className="flex items-baseline justify-between border-t border-zinc-800 pt-2">
              <dt className="text-sm font-semibold text-zinc-300">Total general</dt>
              <dd
                className={`text-2xl font-bold tabular-nums ${
                  devuelta ? "text-zinc-500 line-through" : "text-zinc-50"
                }`}
              >
                {formatCOP(total)}
              </dd>
            </div>
          </dl>

          {devuelta && detalle?.devueltaAt && (
            <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
              Devuelta el {fechaLegible(detalle.devueltaAt)}
              {detalle.devueltaMotivo && ` · ${detalle.devueltaMotivo}`}
            </p>
          )}

          {error && (
            <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          {/* Confirmación de la devolución (segundo paso). Reservada al dueño:
              el empleado no la ve ni aunque el modal se abriera con la acción. */}
          {confirmando && !devuelta && esAdministrador && (
            <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="text-sm font-medium text-amber-200">
                ¿Devolver {formatCOP(total)}?
              </p>
              <p className="mt-1 text-xs text-amber-300/70">
                Las {unidades} unidad{unidades === 1 ? "" : "es"} de catálogo vuelven al inventario
                de tu empresa y la venta queda marcada como reembolsada. Si el cobro fue en
                efectivo, se registra el egreso en la caja de hoy.
              </p>
              <label htmlFor="devolucion-motivo" className="mb-1.5 mt-3 block text-xs font-medium text-zinc-400">
                Motivo (opcional)
              </label>
              <input
                id="devolucion-motivo"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ej. producto defectuoso, cliente se arrepintió…"
                maxLength={140}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <div className="mt-3 flex gap-2.5">
                <button
                  type="button"
                  onClick={() => setConfirmando(false)}
                  disabled={devolviendo}
                  className="h-10 flex-1 rounded-lg border border-zinc-700 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void confirmarDevolucion()}
                  disabled={devolviendo}
                  className="h-10 flex-1 rounded-lg bg-gradient-to-r from-red-500 to-rose-600 text-sm font-semibold text-white shadow-lg shadow-red-500/20 transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {devolviendo ? "Procesando…" : "Confirmar devolución"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Acciones */}
        <div className="flex flex-wrap gap-2.5 border-t border-zinc-800 p-5">
          <button
            type="button"
            onClick={() => detalle && void imprimirCopia(detalle, tirilla)}
            disabled={cargando || !detalle || imprimiendo}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-zinc-700 py-2.5 text-xs font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9V2h12v7" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <path d="M6 14h12v8H6z" />
            </svg>
            {imprimiendo ? "Imprimiendo…" : "Reimprimir tirilla"}
          </button>
          {esAdministrador && (
            <button
              type="button"
              onClick={() => setConfirmando(true)}
              disabled={cargando || !detalle || devuelta || confirmando}
              title={devuelta ? "Esta venta ya fue devuelta" : "Devolver la venta y reponer el stock"}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 py-2.5 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 14 4 9l5-5" />
                <path d="M4 9h11a5 5 0 0 1 0 10h-1" />
              </svg>
              {devuelta ? "Ya devuelta" : "Realizar devolución"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
