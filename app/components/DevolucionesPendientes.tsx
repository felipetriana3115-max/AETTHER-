"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDashboard } from "./DashboardProvider";
import { formatCOP } from "../lib/data-model";
import { loadDeviceSettings } from "../lib/devices";
import {
  fetchSolicitudesDevolucion,
  pinCajonDevolucion,
  resolverDevolucion,
  type SolicitudDevolucion,
} from "../lib/devoluciones";
import { openCashDrawer } from "../lib/receipt";
import { useRolSesion } from "../lib/useRol";

/**
 * Bandeja de devoluciones solicitadas desde el mostrador.
 *
 * El empleado la ve en SOLO LECTURA (para saber en qué quedó lo que pidió); el
 * administrador obtiene los botones de Aprobar / Rechazar. Ese gateo es de
 * interfaz: el control real lo impone `resolver_devolucion`, que exige
 * empresa_admin/super_admin dentro de la propia RPC (es SECURITY DEFINER, así
 * que un empleado con la anon key podría invocarla si el chequeo viviera solo
 * en React). Ver supabase/2026-10-devoluciones-parciales.sql.
 *
 * EL CAJÓN DE DINERO SE ABRE AQUÍ, Y SOLO AQUÍ: al APROBAR, si el servidor
 * responde `abrir_cajon` —cobro original en efectivo con monto > 0— se manda el
 * pulso ESC/POS. Un rechazo no dispara nada: la caja queda cerrada y ni el
 * stock ni la venta se tocan.
 */

type Props = {
  /** Cambia para forzar una recarga (p. ej. tras crear una solicitud). */
  recargarToken?: number;
  /** Se invoca tras una aprobación efectiva: resincroniza ventas e inventario. */
  onResuelta: () => void;
};

const ESTADO_ESTILO: Record<SolicitudDevolucion["estado"], string> = {
  pendiente: "bg-amber-500/10 text-amber-300 ring-amber-500/20",
  aprobada: "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20",
  rechazada: "bg-zinc-500/10 text-zinc-400 ring-zinc-500/20",
};

function fechaCorta(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
}

/** Detalle de los ítems pedidos, tal como los congeló el servidor. */
function ItemsSolicitados({ solicitud }: { solicitud: SolicitudDevolucion }) {
  if (solicitud.items.length === 0) {
    return <p className="text-xs text-zinc-500">Sin desglose de ítems.</p>;
  }
  return (
    <ul className="space-y-1">
      {solicitud.items.map((it) => (
        <li
          key={it.idx}
          className="flex items-baseline justify-between gap-3 text-xs tabular-nums"
        >
          <span className="min-w-0 truncate text-zinc-300">
            <span className="font-semibold text-zinc-100">{it.qty}×</span> {it.nombre}
            {it.esComun && (
              <span className="ml-1.5 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">
                común
              </span>
            )}
          </span>
          <span className="shrink-0 text-zinc-400">{formatCOP(it.precio * it.qty)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function DevolucionesPendientes({ recargarToken = 0, onResuelta }: Props) {
  const { showToast } = useDashboard();
  /**
   * Fail-closed: hasta confirmar el rol no se pintan Aprobar/Rechazar, así que
   * un empleado nunca ve botones que la RPC rechazaría.
   */
  const { esAdministrador } = useRolSesion();

  const [solicitudes, setSolicitudes] = useState<SolicitudDevolucion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Id de la solicitud que está resolviéndose (bloquea sus dos botones). */
  const [enCurso, setEnCurso] = useState<string | null>(null);
  /** Nota del administrador por solicitud (motivo del rechazo / visto bueno). */
  const [notas, setNotas] = useState<Record<string, string>>({});
  const [verResueltas, setVerResueltas] = useState(false);

  const recargar = useCallback(async () => {
    const { data, error: err } = await fetchSolicitudesDevolucion();
    setSolicitudes(data);
    setAviso(err);
    setCargando(false);
  }, []);

  useEffect(() => {
    let activo = true;
    void (async () => {
      const { data, error: err } = await fetchSolicitudesDevolucion();
      if (!activo) return;
      setSolicitudes(data);
      setAviso(err);
      setCargando(false);
    })();
    return () => {
      activo = false;
    };
  }, [recargarToken]);

  const pendientes = useMemo(
    () => solicitudes.filter((s) => s.estado === "pendiente"),
    [solicitudes],
  );
  const resueltas = useMemo(
    () => solicitudes.filter((s) => s.estado !== "pendiente"),
    [solicitudes],
  );

  /**
   * Aprueba o rechaza. El cajón solo se mueve en la rama de aprobación y solo
   * si el SERVIDOR lo autoriza: `abrirCajon` viene de `resolver_devolucion`,
   * que es quien sabe si el cobro original fue en efectivo.
   */
  const resolver = useCallback(
    async (solicitud: SolicitudDevolucion, aprobar: boolean) => {
      if (enCurso) return;
      setEnCurso(solicitud.id);
      setError(null);
      try {
        const r = await resolverDevolucion(solicitud.id, aprobar, notas[solicitud.id]);
        if (!r.ok) {
          setError(r.error ?? "No se pudo resolver la devolución.");
          return;
        }

        if (r.duplicada) {
          showToast(
            "Esta solicitud ya estaba resuelta",
            "Otro administrador se adelantó; no se volvió a tocar el inventario.",
          );
        } else if (!aprobar || r.estado === "rechazada") {
          showToast(
            "Devolución rechazada",
            r.aviso ??
              "No se modificó el inventario, ni la caja, ni el cajón de dinero.",
          );
        } else {
          const extra =
            r.sinProducto > 0
              ? ` ${r.sinProducto} línea(s) no se pudieron reponer: el producto ya no está en el catálogo.`
              : "";
          showToast(
            "Devolución aprobada",
            `${formatCOP(r.monto)} reembolsado y ${r.unidades} unidad(es) de vuelta al inventario.` +
              `${r.ventaCompleta ? " La factura queda totalmente reembolsada." : ""}${extra}`,
          );

          // ── EL CAJÓN, ÚNICAMENTE AQUÍ ──────────────────────────────────
          // Aprobación + salida real de efectivo. El hardware es local (ajustes
          // por equipo en Dispositivos), la decisión es del servidor.
          const { drawer, printer } = loadDeviceSettings();
          const pin = pinCajonDevolucion(r.abrirCajon, solicitud.metodo, drawer);
          if (pin !== null) {
            const res = await openCashDrawer(pin, printer);
            if (!res.ok) showToast("El cajón no respondió", res.message);
          }
        }

        // La verdad la vuelve a poner el servidor: bandeja + ventas + stock.
        await recargar();
        if (aprobar && !r.duplicada && r.estado === "aprobada") onResuelta();
      } finally {
        setEnCurso(null);
      }
    },
    [enCurso, notas, showToast, recargar, onResuelta],
  );

  // Sin solicitudes y sin incidencias: la sección no estorba el panel.
  if (!cargando && solicitudes.length === 0 && !aviso) return null;

  return (
    <section className="rounded-xl border border-amber-500/20 bg-zinc-900/50">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 p-5">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            Devoluciones pendientes
            {pendientes.length > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/20 px-1.5 text-xs font-bold text-amber-300">
                {pendientes.length}
              </span>
            )}
          </h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            {esAdministrador
              ? "Solicitudes del mostrador a la espera de tu visto bueno. Nada se mueve hasta que apruebes."
              : "Tus solicitudes y las de tus compañeros. Solo el administrador puede aprobarlas."}
          </p>
        </div>
        {resueltas.length > 0 && (
          <button
            type="button"
            onClick={() => setVerResueltas((v) => !v)}
            className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            {verResueltas ? "Ocultar resueltas" : `Ver resueltas (${resueltas.length})`}
          </button>
        )}
      </div>

      <div className="space-y-3 p-5">
        {cargando ? (
          <div className="space-y-2" aria-busy="true">
            <div className="h-16 animate-pulse rounded-lg bg-zinc-800/60" />
            <div className="h-16 animate-pulse rounded-lg bg-zinc-800/30" />
          </div>
        ) : (
          <>
            {aviso && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                {aviso}
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
              >
                {error}
              </p>
            )}

            {pendientes.length === 0 && !aviso && (
              <p className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-4 text-center text-xs text-zinc-500">
                No hay devoluciones esperando aprobación.
              </p>
            )}

            {[...pendientes, ...(verResueltas ? resueltas : [])].map((s) => {
              const ocupado = enCurso === s.id;
              const saleEfectivo = s.metodo === "Efectivo" && s.monto > 0;
              return (
                <article
                  key={s.id}
                  className={`rounded-xl border p-4 ${
                    s.estado === "pendiente"
                      ? "border-amber-500/25 bg-amber-500/[0.03]"
                      : "border-zinc-800 bg-zinc-950/40"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-100">
                        {formatCOP(s.monto)}
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${ESTADO_ESTILO[s.estado]}`}
                        >
                          {s.estado}
                        </span>
                        <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
                          {s.metodo}
                        </span>
                      </p>
                      <p className="mt-1 text-xs text-zinc-500">
                        Solicitada por{" "}
                        <span className="font-medium text-zinc-300">{s.solicitante}</span> ·{" "}
                        {fechaCorta(s.solicitadaAt)}
                      </p>
                      <p
                        className="mt-0.5 font-mono text-[11px] text-zinc-600"
                        title={`Venta ${s.ventaId}`}
                      >
                        Venta {s.ventaId.slice(0, 8)} · total {formatCOP(s.ventaTotal)}
                        {s.ventaFecha ? ` · ${fechaCorta(s.ventaFecha)}` : ""}
                      </p>
                    </div>
                    {s.estado === "pendiente" && saleEfectivo && (
                      <span
                        className="shrink-0 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-300"
                        title="Al aprobar se registrará el egreso en la caja de hoy y se abrirá el cajón de dinero."
                      >
                        Abre el cajón al aprobar
                      </span>
                    )}
                  </div>

                  <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                    <ItemsSolicitados solicitud={s} />
                  </div>

                  {s.motivo && (
                    <p className="mt-2 text-xs text-zinc-400">
                      <span className="text-zinc-500">Motivo:</span> {s.motivo}
                    </p>
                  )}

                  {s.estado !== "pendiente" && (
                    <p className="mt-2 text-xs text-zinc-500">
                      Resuelta el {fechaCorta(s.resueltaAt)}
                      {s.resolucionNota && ` · ${s.resolucionNota}`}
                      {s.estado === "aprobada" &&
                        s.unidadesRepuestas != null &&
                        ` · ${s.unidadesRepuestas} unidad(es) repuestas`}
                    </p>
                  )}

                  {s.estado === "pendiente" && esAdministrador && (
                    <div className="mt-3 space-y-2.5">
                      <input
                        value={notas[s.id] ?? ""}
                        onChange={(e) =>
                          setNotas((prev) => ({ ...prev, [s.id]: e.target.value }))
                        }
                        placeholder="Nota de la resolución (opcional)"
                        maxLength={140}
                        aria-label="Nota de la resolución"
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      />
                      <div className="flex gap-2.5">
                        <button
                          type="button"
                          onClick={() => void resolver(s, false)}
                          disabled={ocupado}
                          className="h-9 flex-1 rounded-lg border border-zinc-700 text-xs font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {ocupado ? "…" : "Rechazar"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void resolver(s, true)}
                          disabled={ocupado}
                          className="h-9 flex-1 rounded-lg bg-gradient-to-r from-emerald-500 to-green-600 text-xs font-semibold text-white shadow-lg shadow-emerald-500/20 transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {ocupado ? "Procesando…" : "Aprobar y reembolsar"}
                        </button>
                      </div>
                    </div>
                  )}

                  {s.estado === "pendiente" && !esAdministrador && (
                    <p className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-[11px] text-zinc-500">
                      A la espera de que el administrador la apruebe. El inventario, la caja y el
                      cajón de dinero siguen intactos.
                    </p>
                  )}
                </article>
              );
            })}
          </>
        )}
      </div>
    </section>
  );
}
