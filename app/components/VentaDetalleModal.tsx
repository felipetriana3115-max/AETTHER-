"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDashboard } from "./DashboardProvider";
import { formatCOP, type Sale } from "../lib/data-model";
import { loadDeviceSettings } from "../lib/devices";
import {
  fetchDisponibleDevolucion,
  pinCajonDevolucion,
  solicitarDevolucion,
  type DisponibleDevolucion,
} from "../lib/devoluciones";
import { openCashDrawer, printReceipt, type ReceiptData } from "../lib/receipt";
import { DEFAULT_TIRILLA, fetchTirilla, type TirillaConfig } from "../lib/tirilla";
import { useRolSesion } from "../lib/useRol";
import {
  fetchVentaDetalle,
  registrarDevolucion,
  type VentaDetalle,
} from "../lib/ventas";

/**
 * Factura de una transacción: vista previa, reimpresión de la tirilla y
 * devolución PARCIAL por ítem.
 *
 * El listado de Transacciones no trae el desglose de líneas (son muchas filas),
 * así que aquí se pide el detalle de ESA venta al abrirse — `ventas.items` en
 * Supabase, aislado por RLS más el filtro explícito por `empresa_id`. Mientras
 * llega se pinta la cabecera con lo que ya tenía la tabla, así que el modal
 * nunca aparece vacío.
 *
 * LA DEVOLUCIÓN NO SE ARMA AQUÍ. El cliente solo elige pares `{idx, qty}`; el
 * precio, el nombre y el tope de cada línea los impone el servidor leyendo la
 * propia venta (RPC `devolucion_disponible` / `solicitar_devolucion`, ver
 * supabase/2026-10-devoluciones-parciales.sql). Así un cliente manipulado no
 * puede inflar el reembolso ni devolver más unidades de las vendidas.
 *
 * DOS CAMINOS SEGÚN EL ROL:
 *   · Empleado  → deja una SOLICITUD pendiente. No se mueve stock, ni caja, ni
 *     el cajón de dinero: eso lo decide después el dueño.
 *   · Admin     → puede aprobar en el acto (`autoAprobar`), y solo entonces la
 *     RPC repone el stock, registra el egreso y autoriza el pulso del cajón.
 *
 * Las ventas IMPORTADAS sin desglose de líneas no se pueden devolver por ítem:
 * para ellas se conserva la devolución total del dueño (`registrar_devolucion`).
 */

/**
 * Con qué intención se abrió el modal. Los tres botones de la tabla entran por
 * aquí: así "Reimprimir" y "Devolver" siguen siendo acciones de un clic, pero
 * quien opera SIEMPRE ve antes la factura sobre la que va a actuar (crítico en
 * la devolución, que mueve dinero e inventario).
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
  /** Se invoca tras una devolución EFECTIVA para resincronizar el dashboard. */
  onDevuelta: () => void;
  /** Se invoca tras dejar una solicitud pendiente (refresca la bandeja). */
  onSolicitada?: () => void;
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
  onSolicitada,
}: Props) {
  const { businessName, showToast } = useDashboard();
  /**
   * Solicitar puede cualquiera con acceso a Ventas; APROBAR es cosa del dueño.
   * Fail-closed: hasta confirmar el rol se asume empleado, así que el botón
   * ofrece la solicitud, nunca el reembolso inmediato. El control real lo
   * impone `resolver_devolucion`, que exige empresa_admin/super_admin.
   */
  const { esAdministrador } = useRolSesion();

  const [detalle, setDetalle] = useState<VentaDetalle | null>(null);
  const [cargando, setCargando] = useState(true);
  const [tirilla, setTirilla] = useState<TirillaConfig>(DEFAULT_TIRILLA);
  const [imprimiendo, setImprimiendo] = useState(false);
  // Devolución en dos pasos: el botón abre el selector por ítem + el motivo.
  const [confirmando, setConfirmando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Topes por línea calculados por el servidor (vendido − devuelto − pendiente).
  const [disponible, setDisponible] = useState<DisponibleDevolucion | null>(null);
  const [avisoDisponible, setAvisoDisponible] = useState<string | null>(null);
  /** Cantidad elegida por posición de línea (`idx` de `ventas.items`). */
  const [cantidades, setCantidades] = useState<Record<number, number>>({});

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
   * logo) + topes devolvibles por línea. En cuanto están, se ejecuta la acción
   * con la que se abrió el modal: así "Reimprimir" y "Devolver" siguen siendo un
   * solo clic desde la tabla. El modal se remonta por cada transacción (`key` en
   * el llamador), de modo que esto corre una sola vez por factura abierta.
   */
  useEffect(() => {
    let activo = true;
    void (async () => {
      const [d, cfg, disp] = await Promise.all([
        fetchVentaDetalle(venta.id),
        fetchTirilla(),
        fetchDisponibleDevolucion(venta.id),
      ]);
      if (!activo) return;
      setDetalle(d);
      setTirilla(cfg);
      setDisponible(disp.data);
      setAvisoDisponible(disp.error);
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
        // Entrar por el botón de devolución preselecciona TODO lo devolvible:
        // el caso habitual (factura completa) queda a un clic, y restar
        // unidades es solo mover los contadores.
        setCantidades(
          Object.fromEntries(
            (disp.data?.lineas ?? [])
              .filter((l) => l.disponible > 0)
              .map((l) => [l.idx, l.disponible]),
          ),
        );
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

  // Líneas con algo todavía devolvible: son las que pueden llevar selector.
  const devolvibles = useMemo(
    () => (disponible?.lineas ?? []).filter((l) => l.disponible > 0),
    [disponible],
  );
  /** Venta con desglose: el camino normal (selección por ítem). */
  const hayDesglose = (disponible?.lineas.length ?? 0) > 0;
  const devueltoTotal = disponible?.devueltoTotal ?? 0;
  /** Importe vivo de la factura: lo máximo que aún se puede reembolsar. */
  const saldoReembolsable = Math.max(0, total - devueltoTotal);

  // Total a reembolsar según lo seleccionado, recalculado en cada cambio y
  // topado por el saldo vivo (una factura con descuento puede tener líneas que
  // sumen más de lo cobrado). El servidor aplica exactamente el mismo tope.
  const { montoSeleccionado, unidadesSeleccionadas } = useMemo(() => {
    let monto = 0;
    let uds = 0;
    for (const l of disponible?.lineas ?? []) {
      const q = cantidades[l.idx] ?? 0;
      if (q > 0) {
        monto += q * l.precio;
        uds += q;
      }
    }
    return {
      montoSeleccionado: Math.min(monto, saldoReembolsable),
      unidadesSeleccionadas: uds,
    };
  }, [cantidades, disponible, saldoReembolsable]);

  /** Fija la cantidad de una línea, siempre dentro de `[0, disponible]`. */
  const setCantidad = useCallback((idx: number, valor: number, tope: number) => {
    const q = Math.max(0, Math.min(Math.trunc(Number.isFinite(valor) ? valor : 0), tope));
    setCantidades((prev) => ({ ...prev, [idx]: q }));
  }, []);

  const seleccionarTodo = useCallback(() => {
    setCantidades(Object.fromEntries(devolvibles.map((l) => [l.idx, l.disponible])));
  }, [devolvibles]);

  const limpiarSeleccion = useCallback(() => setCantidades({}), []);

  /**
   * Envía la selección: como SOLICITUD (empleado) o aprobándola en el acto
   * (admin). El cajón SOLO se dispara cuando el servidor responde
   * `abrirCajon: true`, es decir, tras una aprobación real con salida de
   * efectivo — nunca al dejar una solicitud pendiente.
   */
  const enviarSeleccion = useCallback(async () => {
    if (!detalle || enviando) return;
    const seleccion = Object.entries(cantidades)
      .map(([idx, qty]) => ({ idx: Number(idx), qty }))
      .filter((s) => s.qty > 0);
    if (seleccion.length === 0) {
      setError("Selecciona al menos un producto y una cantidad para devolver.");
      return;
    }

    setEnviando(true);
    setError(null);
    try {
      const r = await solicitarDevolucion(detalle.id, seleccion, motivo, esAdministrador);
      if (!r.ok) {
        setError(r.error ?? "No se pudo registrar la devolución.");
        return;
      }

      if (!r.autoAprobada) {
        showToast(
          "Devolución solicitada",
          `${folio}: ${formatCOP(r.monto)} queda pendiente de aprobación del administrador. ` +
            "No se ha tocado el inventario ni la caja.",
        );
        onSolicitada?.();
        onClose();
        return;
      }

      // Aprobada en el acto por el dueño: aquí SÍ se movió stock y caja.
      const aviso =
        r.sinProducto > 0
          ? ` ${r.sinProducto} línea(s) no se pudieron reponer porque el producto ya no está en el catálogo.`
          : "";
      showToast(
        "Devolución procesada",
        `${folio}: ${formatCOP(r.monto)} reembolsado y ${r.unidades} unidad(es) devueltas al inventario.${aviso}`,
      );

      // EL CAJÓN, SOLO AHORA. Lo autoriza el servidor (`abrir_cajon`), que es
      // quien sabe si de verdad salió efectivo; el hardware es local.
      const { drawer, printer } = loadDeviceSettings();
      const pin = pinCajonDevolucion(r.abrirCajon, detalle.metodo, drawer);
      if (pin !== null) {
        const res = await openCashDrawer(pin, printer);
        if (!res.ok) showToast("El cajón no respondió", res.message);
      }

      onDevuelta();
      onSolicitada?.();
      onClose();
    } finally {
      setEnviando(false);
    }
  }, [
    detalle,
    enviando,
    cantidades,
    motivo,
    esAdministrador,
    folio,
    showToast,
    onDevuelta,
    onSolicitada,
    onClose,
  ]);

  /**
   * Devolución TOTAL por la vía antigua (`registrar_devolucion`). Solo aplica a
   * las ventas importadas que no guardan desglose de líneas: sin `items` no hay
   * nada que seleccionar, pero el dinero sí hay que devolverlo.
   */
  const devolverCompleta = useCallback(async () => {
    if (!detalle || enviando) return;
    setEnviando(true);
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
        showToast(
          "Devolución procesada",
          `${folio}: ${formatCOP(saldoReembolsable)} reembolsado.`,
        );
        const { drawer, printer } = loadDeviceSettings();
        const pin = pinCajonDevolucion(
          detalle.metodo === "Efectivo" && saldoReembolsable > 0,
          detalle.metodo,
          drawer,
        );
        if (pin !== null) {
          const res = await openCashDrawer(pin, printer);
          if (!res.ok) showToast("El cajón no respondió", res.message);
        }
      }
      onDevuelta();
      onClose();
    } finally {
      setEnviando(false);
    }
  }, [detalle, enviando, motivo, folio, saldoReembolsable, showToast, onDevuelta, onClose]);

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
            {devuelta ? (
              <span className="rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-400 ring-1 ring-inset ring-red-500/20">
                Reembolsado
              </span>
            ) : (
              devueltoTotal > 0 && (
                <span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300 ring-1 ring-inset ring-amber-500/20">
                  {formatCOP(devueltoTotal)} devuelto
                </span>
              )
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
            {devueltoTotal > 0 && !devuelta && (
              <div className="flex items-baseline justify-between">
                <dt className="text-zinc-500">Ya reembolsado</dt>
                <dd className="font-medium tabular-nums text-amber-300">
                  −{formatCOP(devueltoTotal)}
                </dd>
              </div>
            )}
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

          {/* El aviso de migración solo estorba al devolver: ver y reimprimir
              no dependen de `devolucion_disponible`. */}
          {avisoDisponible && confirmando && !cargando && (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              {avisoDisponible}
            </p>
          )}

          {error && (
            <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          {/* ── Selector de devolución parcial (segundo paso) ──────────────
              Las cantidades salen de `devolucion_disponible`: cada contador
              tope es lo que REALMENTE queda por devolver de esa línea. */}
          {confirmando && !devuelta && (
            <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-amber-200">
                  {esAdministrador ? "Devolución" : "Solicitud de devolución"}
                </p>
                {hayDesglose && devolvibles.length > 0 && (
                  <div className="flex shrink-0 gap-2 text-[11px] font-medium">
                    <button
                      type="button"
                      onClick={seleccionarTodo}
                      className="rounded-md border border-amber-500/30 px-2 py-1 text-amber-300 transition-colors hover:bg-amber-500/10"
                    >
                      Todo
                    </button>
                    <button
                      type="button"
                      onClick={limpiarSeleccion}
                      className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-400 transition-colors hover:bg-zinc-800"
                    >
                      Ninguno
                    </button>
                  </div>
                )}
              </div>

              {!hayDesglose ? (
                // Venta importada sin líneas: no hay nada que seleccionar.
                esAdministrador ? (
                  <p className="mt-1 text-xs text-amber-300/70">
                    Esta venta no guarda desglose por producto, así que solo puede devolverse
                    completa: {formatCOP(saldoReembolsable)}. No hay stock que reponer.
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-amber-300/70">
                    Esta venta no guarda desglose por producto: solo el administrador puede
                    devolverla completa.
                  </p>
                )
              ) : devolvibles.length === 0 ? (
                <p className="mt-1 text-xs text-amber-300/70">
                  No queda nada por devolver de esta factura: todas sus unidades ya se devolvieron
                  o están en una solicitud pendiente de aprobación.
                </p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-amber-300/70">
                    Marca cuántas unidades vuelven de cada producto. El tope es lo que queda
                    devolvible (ya se descontó lo devuelto antes y lo pedido en solicitudes
                    pendientes).
                  </p>
                  <ul className="mt-3 space-y-1.5">
                    {disponible?.lineas.map((l) => {
                      const q = cantidades[l.idx] ?? 0;
                      const agotada = l.disponible === 0;
                      return (
                        <li
                          key={l.idx}
                          className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${
                            agotada
                              ? "border-zinc-800 bg-zinc-950/40 opacity-60"
                              : "border-zinc-800 bg-zinc-950/60"
                          }`}
                        >
                          <input
                            type="checkbox"
                            id={`dev-chk-${l.idx}`}
                            checked={q > 0}
                            disabled={agotada || enviando}
                            onChange={(e) =>
                              setCantidad(l.idx, e.target.checked ? l.disponible : 0, l.disponible)
                            }
                            className="h-4 w-4 shrink-0 accent-amber-500 disabled:cursor-not-allowed"
                          />
                          <label
                            htmlFor={`dev-chk-${l.idx}`}
                            className="min-w-0 flex-1 cursor-pointer"
                          >
                            <span className="block truncate text-xs font-medium text-zinc-100">
                              {l.nombre}
                              {l.esComun && (
                                <span className="ml-1.5 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">
                                  común
                                </span>
                              )}
                            </span>
                            <span className="block text-[11px] tabular-nums text-zinc-500">
                              {formatCOP(l.precio)} c/u · {l.disponible} de {l.qty} devolvible
                              {l.disponible === 1 ? "" : "s"}
                              {l.pendiente > 0 && ` · ${l.pendiente} en solicitud pendiente`}
                            </span>
                          </label>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              aria-label={`Quitar una unidad de ${l.nombre}`}
                              disabled={agotada || q <= 0 || enviando}
                              onClick={() => setCantidad(l.idx, q - 1, l.disponible)}
                              className="h-7 w-7 rounded-md border border-zinc-700 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-30"
                            >
                              −
                            </button>
                            <input
                              type="number"
                              inputMode="numeric"
                              min={0}
                              max={l.disponible}
                              step={1}
                              value={q}
                              disabled={agotada || enviando}
                              aria-label={`Unidades a devolver de ${l.nombre}`}
                              onChange={(e) =>
                                setCantidad(l.idx, Number(e.target.value), l.disponible)
                              }
                              className="h-7 w-12 rounded-md border border-zinc-700 bg-zinc-950 text-center text-xs tabular-nums text-zinc-100 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-40"
                            />
                            <button
                              type="button"
                              aria-label={`Añadir una unidad de ${l.nombre}`}
                              disabled={agotada || q >= l.disponible || enviando}
                              onClick={() => setCantidad(l.idx, q + 1, l.disponible)}
                              className="h-7 w-7 rounded-md border border-zinc-700 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-30"
                            >
                              +
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  {/* Total a reembolsar: se recalcula con cada contador. */}
                  <div className="mt-3 flex items-baseline justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                    <span className="text-xs text-amber-200">
                      {unidadesSeleccionadas} unidad{unidadesSeleccionadas === 1 ? "" : "es"} a
                      devolver
                    </span>
                    <span className="text-lg font-bold tabular-nums text-amber-200">
                      {formatCOP(montoSeleccionado)}
                    </span>
                  </div>
                </>
              )}

              <label htmlFor="devolucion-motivo" className="mb-1.5 mt-3 block text-xs font-medium text-zinc-400">
                Motivo {esAdministrador ? "(opcional)" : "(se lo verá el administrador)"}
              </label>
              <input
                id="devolucion-motivo"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ej. producto defectuoso, cliente se arrepintió…"
                maxLength={140}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />

              <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                {esAdministrador
                  ? "Al aprobar, las unidades vuelven al inventario de tu empresa y, si el cobro fue en efectivo, se registra el egreso en la caja de hoy y se abre el cajón de dinero."
                  : "Queda registrada como solicitud pendiente: no se mueve el inventario, ni la caja, ni el cajón de dinero hasta que el administrador la apruebe."}
              </p>

              <div className="mt-3 flex gap-2.5">
                <button
                  type="button"
                  onClick={() => setConfirmando(false)}
                  disabled={enviando}
                  className="h-10 flex-1 rounded-lg border border-zinc-700 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40"
                >
                  Cancelar
                </button>
                {hayDesglose ? (
                  <button
                    type="button"
                    onClick={() => void enviarSeleccion()}
                    disabled={enviando || unidadesSeleccionadas === 0}
                    className="h-10 flex-1 rounded-lg bg-gradient-to-r from-red-500 to-rose-600 text-sm font-semibold text-white shadow-lg shadow-red-500/20 transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {enviando
                      ? "Procesando…"
                      : esAdministrador
                        ? `Aprobar y devolver ${formatCOP(montoSeleccionado)}`
                        : `Solicitar ${formatCOP(montoSeleccionado)}`}
                  </button>
                ) : (
                  esAdministrador && (
                    <button
                      type="button"
                      onClick={() => void devolverCompleta()}
                      disabled={enviando || saldoReembolsable <= 0}
                      className="h-10 flex-1 rounded-lg bg-gradient-to-r from-red-500 to-rose-600 text-sm font-semibold text-white shadow-lg shadow-red-500/20 transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {enviando ? "Procesando…" : "Devolver la factura completa"}
                    </button>
                  )
                )}
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
          <button
            type="button"
            onClick={() => setConfirmando(true)}
            disabled={cargando || !detalle || devuelta || confirmando}
            title={
              devuelta
                ? "Esta venta ya fue devuelta"
                : esAdministrador
                  ? "Elegir qué ítems devolver y reponer su stock"
                  : "Elegir qué ítems devolver y enviarlo a aprobación del administrador"
            }
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 py-2.5 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h11a5 5 0 0 1 0 10h-1" />
            </svg>
            {devuelta
              ? "Ya devuelta"
              : esAdministrador
                ? "Devolver ítems"
                : "Solicitar devolución"}
          </button>
        </div>
      </div>
    </div>
  );
}
