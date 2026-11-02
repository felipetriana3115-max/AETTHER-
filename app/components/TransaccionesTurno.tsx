"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatCOP } from "../lib/data-model";
import { useRolSesion } from "../lib/useRol";
import { fetchVentasDelTurno, type TicketEncontrado } from "../lib/ventas";
import VentaDetalleModal from "./VentaDetalleModal";

/**
 * Transacciones del turno — consulta y reimpresión desde el módulo de Caja.
 *
 * PARA QUÉ: el cajero necesita LOCALIZAR el ticket que le trae un cliente
 * ("el de las 3 y media, como cuarenta mil") para reimprimirlo o pedir su
 * devolución. Hasta ahora la única puerta era teclear el folio exacto en el POS,
 * así que sin la tirilla en la mano no se llegaba a la venta. Aquí se lista lo
 * cobrado HOY —solo el turno en curso, no el historial del negocio— con buscador
 * por folio, cliente, método o importe.
 *
 * QUÉ **NO** HABILITA (y es lo importante):
 *  · Es LECTURA. No hay ninguna escritura nueva: la lista sale de `ventas` vía
 *    `fetchVentasDelTurno`, acotada por RLS más el filtro explícito por el
 *    `empresa_id` de la sesión viva.
 *  · NO hay devolución directa. Al abrir una factura se reutiliza el MISMO
 *    `VentaDetalleModal` ya auditado: el empleado solo puede dejar una SOLICITUD
 *    (`solicitar_devolucion`), que no mueve stock, ni caja, ni el cajón de
 *    dinero; aprobarla sigue siendo potestad del administrador
 *    (`resolver_devolucion`, que revalida el rol en el servidor).
 *
 * CIERRE CIEGO: el arqueo oculta a propósito las ventas en efectivo y el
 * esperado hasta procesar el cierre. Por eso aquí NO se pinta ningún total
 * acumulado del turno para el empleado —solo el número de transacciones—; los
 * importes por ticket sí se muestran porque son justo el dato con el que se
 * reconoce una factura. El subtotal agregado queda reservado al administrador.
 */

type Props = {
  /** Se invoca tras una devolución EFECTIVA (el admin aprobó en el acto). */
  onDevuelta?: () => void;
};

/** Hora corta (es-CO) del ISO de `created_at`. */
function horaLegible(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
}

/** Clases del badge por estado de la venta. */
const ESTADO_CLASES: Record<string, string> = {
  Pagado: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20",
  Pendiente: "bg-amber-500/10 text-amber-300 ring-amber-500/20",
  Reembolsado: "bg-red-500/10 text-red-400 ring-red-500/20",
};

export default function TransaccionesTurno({ onDevuelta }: Props) {
  /**
   * Gatea solo el SUBTOTAL del turno (ver nota de cierre ciego). Lo que puede
   * hacerse con cada factura lo resuelve `VentaDetalleModal` por su cuenta, y en
   * última instancia las RPC de devolución.
   */
  const { esAdministrador } = useRolSesion();

  const [ventas, setVentas] = useState<TicketEncontrado[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState("");
  const [abierta, setAbierta] = useState(false);
  /** Factura abierta en el modal (null = ninguna). */
  const [seleccion, setSeleccion] = useState<TicketEncontrado | null>(null);

  const recargar = useCallback(async () => {
    const { ventas: filas, error: err } = await fetchVentasDelTurno();
    setVentas(filas);
    setError(err);
  }, []);

  useEffect(() => {
    let activo = true;
    void (async () => {
      const { ventas: filas, error: err } = await fetchVentasDelTurno();
      if (!activo) return;
      setVentas(filas);
      setError(err);
      setCargando(false);
    })();
    return () => {
      activo = false;
    };
  }, []);

  // Filtro local sobre lo ya cargado (el turno cabe de sobra en memoria): folio,
  // cliente, método e importe. Así el cajero encuentra el ticket por lo que
  // recuerde, sin tener que saber el número exacto.
  const filtradas = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return ventas;
    const digitos = q.replace(/\D/g, "");
    return ventas.filter((t) => {
      const porFolio = digitos !== "" && t.folio.replace(/\D/g, "").includes(digitos);
      const porMonto = digitos !== "" && String(Math.round(t.venta.amount)).includes(digitos);
      return (
        porFolio ||
        porMonto ||
        t.venta.customer.toLowerCase().includes(q) ||
        t.venta.method.toLowerCase().includes(q)
      );
    });
  }, [ventas, filtro]);

  /** Subtotal del turno: SOLO para el administrador (cierre ciego). */
  const totalTurno = useMemo(
    () => ventas.reduce((s, t) => s + t.venta.amount, 0),
    [ventas],
  );

  return (
    <section className="rounded-xl border border-violet-500/15 bg-zinc-900/50">
      <button
        type="button"
        onClick={() => setAbierta((v) => !v)}
        aria-expanded={abierta}
        className="flex w-full items-center justify-between gap-3 p-6 text-left"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-lg">
            🧾
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">Transacciones del turno</h2>
            <p className="truncate text-xs text-zinc-500">
              {cargando
                ? "Cargando facturas cobradas hoy…"
                : `${ventas.length} factura${ventas.length === 1 ? "" : "s"} cobrada${
                    ventas.length === 1 ? "" : "s"
                  } hoy · consulta y reimpresión`}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {/* El acumulado del turno es cifra de negocio y rompería el cierre
              ciego del cajero: solo lo ve el dueño. */}
          {esAdministrador && !cargando && ventas.length > 0 && (
            <span className="hidden text-sm font-semibold tabular-nums text-violet-300 sm:inline">
              {formatCOP(totalTurno)}
            </span>
          )}
          <svg
            className={`h-4 w-4 text-zinc-500 transition-transform ${abierta ? "rotate-180" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </button>

      {abierta && (
        <div className="border-t border-zinc-800 p-6">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={filtro}
              onChange={(e) => setFiltro(e.target.value)}
              placeholder="Buscar por folio, cliente, método o monto…"
              aria-label="Buscar una factura del turno"
              className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
            <button
              type="button"
              onClick={() => void recargar()}
              title="Volver a leer las facturas del turno"
              className="shrink-0 rounded-lg border border-zinc-700 px-3 py-2.5 text-xs font-semibold text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              ↻ Actualizar
            </button>
          </div>

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
            >
              {error}
            </p>
          )}

          {cargando ? (
            <div className="mt-4 space-y-2" aria-busy="true">
              <div className="h-12 animate-pulse rounded-lg bg-zinc-800/60" />
              <div className="h-12 animate-pulse rounded-lg bg-zinc-800/40" />
              <div className="h-12 animate-pulse rounded-lg bg-zinc-800/30" />
            </div>
          ) : ventas.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-zinc-800 py-8 text-center text-sm text-zinc-500">
              Todavía no hay facturas cobradas en este turno.
            </p>
          ) : filtradas.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-zinc-800 py-8 text-center text-sm text-zinc-500">
              Ninguna factura del turno coincide con “{filtro}”.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-zinc-800/70">
              {filtradas.map((t) => {
                const estado = t.venta.status;
                // `refunded` es opcional en `Sale` (las ventas anteriores a las
                // devoluciones parciales no lo traen): 0 cuando no hay nada.
                const reembolsado = t.venta.refunded ?? 0;
                return (
                  <li key={t.venta.id}>
                    <button
                      type="button"
                      onClick={() => setSeleccion(t)}
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-violet-500/5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs font-semibold text-violet-300">
                          {t.folio}
                        </p>
                        <p className="truncate text-[11px] text-zinc-500">
                          {horaLegible(t.venta.date)} · {t.venta.method}
                          {t.venta.customer !== "Venta POS" && ` · ${t.venta.customer}`}
                        </p>
                      </div>
                      {reembolsado > 0 && estado !== "Reembolsado" && (
                        <span className="shrink-0 text-[11px] font-medium tabular-nums text-amber-300">
                          −{formatCOP(reembolsado)}
                        </span>
                      )}
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
                          ESTADO_CLASES[estado] ?? ESTADO_CLASES.Pagado
                        }`}
                      >
                        {estado}
                      </span>
                      <span
                        className={`w-24 shrink-0 text-right text-sm font-semibold tabular-nums ${
                          estado === "Reembolsado" ? "text-zinc-500 line-through" : "text-zinc-100"
                        }`}
                      >
                        {formatCOP(t.venta.amount)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-500">
            Toca una factura para ver su desglose y reimprimir la tirilla.{" "}
            {esAdministrador
              ? "Como administrador puedes además aprobar la devolución de sus ítems en el acto."
              : "La devolución queda como solicitud pendiente de aprobación del administrador: no se mueve stock, ni caja, ni el cajón de dinero."}
          </p>
        </div>
      )}

      {/* La MISMA factura del panel de Transacciones y del POS: quien decide qué
          se puede hacer con ella es el rol (el modal lo resuelve con
          `useRolSesion`) y, en última instancia, las RPC de devolución. */}
      {seleccion && (
        <VentaDetalleModal
          key={seleccion.venta.id}
          venta={seleccion.venta}
          folio={seleccion.folio}
          onClose={() => setSeleccion(null)}
          onDevuelta={() => {
            // Solo pasa cuando el admin aprueba en el acto: ahí SÍ se movió caja
            // e inventario, así que el arqueo del día deja de estar al día.
            void recargar();
            onDevuelta?.();
          }}
          onSolicitada={() => void recargar()}
        />
      )}
    </section>
  );
}
