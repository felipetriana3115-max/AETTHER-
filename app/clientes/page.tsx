"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PageShell from "../components/PageShell";
import MetricCard from "../components/MetricCard";
import ClienteForm from "../components/ClienteForm";
import FiadoPanel from "../components/FiadoPanel";
import { useDashboard } from "../components/DashboardProvider";
import { formatCOP } from "../lib/data-model";
import { fetchClientes, type Cliente, type TipoMovimiento } from "../lib/clientes";
import { supabase } from "../lib/auth";

/**
 * CRM de Clientes + Sistema de Fiados (Cuentas por Cobrar).
 *
 * Fuente de verdad: tabla `public.clientes` en Supabase (aislada por RLS =
 * mi_empresa()), a diferencia de la versión anterior que solo mostraba lo cargado
 * en memoria desde Excel. El saldo pendiente de cada cliente se lee
 * DESNORMALIZADO (`clientes.saldo_pendiente`) en la misma consulta del directorio,
 * así que la lista es ligera: sin joins ni agregaciones por fila.
 *
 * Requiere la migración `supabase/2026-08-clientes-y-fiados.sql`. Si aún no se ha
 * corrido, mostramos una guía en vez de romper la pantalla.
 */

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
}

export default function ClientesPage() {
  const { businessName, showToast } = useDashboard();

  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [cargando, setCargando] = useState(true);
  const [faltaMigracion, setFaltaMigracion] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Modal de alta/edición: null = cerrado, "nuevo" = alta, objeto = edición.
  const [modal, setModal] = useState<"nuevo" | Cliente | null>(null);
  // Panel de fiados: cliente seleccionado + modo con el que se abre (registrar
  // deuda vs. registrar abono), o null si está cerrado.
  const [fiado, setFiado] = useState<{ cliente: Cliente; tipo: TipoMovimiento } | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { clientes, faltaMigracion } = await fetchClientes();
    setClientes(clientes);
    setFaltaMigracion(faltaMigracion);
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  // Alta/edición: reemplaza la fila si existía, o la agrega, sin recargar todo.
  const onSaved = useCallback((c: Cliente) => {
    setClientes((prev) => {
      const existe = prev.some((x) => x.id === c.id);
      const next = existe ? prev.map((x) => (x.id === c.id ? { ...x, ...c } : x)) : [...prev, c];
      return next.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    });
    setModal(null);
    showToast("Cliente guardado", `${c.nombre} quedó registrado en el CRM.`);
  }, [showToast]);

  // Refresca el saldo de un cliente en la lista tras un movimiento de fiado.
  const onSaldoChange = useCallback((clienteId: string, saldo: number) => {
    setClientes((prev) => prev.map((c) => (c.id === clienteId ? { ...c, saldo_pendiente: saldo } : c)));
    setFiado((prev) =>
      prev && prev.cliente.id === clienteId
        ? { ...prev, cliente: { ...prev.cliente, saldo_pendiente: saldo } }
        : prev,
    );
  }, []);

  const borrar = useCallback(
    async (c: Cliente) => {
      if (c.saldo_pendiente > 0) {
        setError(
          `No puedes eliminar a "${c.nombre}": tiene un saldo pendiente de ${formatCOP(c.saldo_pendiente)}. Registra el abono total primero.`,
        );
        return;
      }
      if (!confirm(`¿Eliminar a "${c.nombre}" del CRM? Se borrará también su historial de fiados.`)) return;
      const { error } = await supabase.from("clientes").delete().eq("id", c.id);
      if (error) {
        console.error("[Clientes] No se pudo eliminar el cliente:", error);
        setError(`No se pudo eliminar: ${error.message}`);
        return;
      }
      setError(null);
      setClientes((prev) => prev.filter((x) => x.id !== c.id));
    },
    [],
  );

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return clientes;
    return clientes.filter(
      (c) =>
        c.nombre.toLowerCase().includes(q) ||
        (c.email ?? "").toLowerCase().includes(q) ||
        (c.telefono ?? "").toLowerCase().includes(q),
    );
  }, [clientes, busqueda]);

  // Métricas del CRM (calculadas sobre las filas reales).
  const totalClientes = clientes.length;
  const totalPorCobrar = clientes.reduce((s, c) => s + c.saldo_pendiente, 0);
  const deudores = clientes.filter((c) => c.saldo_pendiente > 0).length;

  return (
    <PageShell
      title="Clientes"
      subtitle={`${businessName} · CRM y cuentas por cobrar`}
      action={
        <button
          type="button"
          onClick={() => setModal("nuevo")}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-600 px-3.5 text-sm font-semibold text-white shadow-lg shadow-violet-500/30 transition-all active:scale-[0.98]"
        >
          <span className="text-base">＋</span> Nuevo cliente
        </button>
      }
    >
      {faltaMigracion ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-6 text-sm text-amber-200">
          <p className="font-semibold">Falta activar el módulo de Clientes</p>
          <p className="mt-2 text-amber-200/80">
            Ejecuta el script <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-xs">supabase/2026-08-clientes-y-fiados.sql</code>{" "}
            en Supabase → SQL Editor para crear las tablas de clientes y fiados. Luego recarga esta página.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {error && (
            <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {/* Métricas */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <MetricCard
              label="Clientes registrados"
              value={String(totalClientes)}
              tone="violet"
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                </svg>
              }
            />
            <MetricCard
              label="Total por cobrar (fiado)"
              value={formatCOP(totalPorCobrar)}
              tone="amber"
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v20" />
                  <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              }
            />
            <MetricCard
              label="Clientes con deuda"
              value={String(deudores)}
              tone="fuchsia"
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                </svg>
              }
            />
          </section>

          {/* Buscador */}
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg">🔍</span>
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por nombre, teléfono o correo…"
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-3 pl-11 pr-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
          </div>

          {/* Tabla de clientes */}
          <div className="overflow-x-auto rounded-xl border border-violet-500/15 bg-zinc-900/50">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Cliente</th>
                  <th className="px-4 py-3 font-medium">Contacto</th>
                  <th className="px-4 py-3 text-right font-medium">Saldo pendiente</th>
                  <th className="px-4 py-3 text-right font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {cargando ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-10 text-center text-zinc-500">
                      Cargando clientes…
                    </td>
                  </tr>
                ) : filtrados.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-10 text-center text-zinc-500">
                      {busqueda
                        ? `Sin resultados para "${busqueda}".`
                        : "Aún no hay clientes. Agrega el primero con “Nuevo cliente”."}
                    </td>
                  </tr>
                ) : (
                  filtrados.map((c) => {
                    const debe = c.saldo_pendiente > 0;
                    return (
                      <tr key={c.id} className="transition-colors hover:bg-zinc-800/30">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/20 to-fuchsia-600/20 text-xs font-semibold text-violet-200 ring-1 ring-violet-500/30">
                              {initials(c.nombre) || "?"}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate font-medium text-zinc-100">{c.nombre}</p>
                              {c.direccion && <p className="truncate text-xs text-zinc-500">{c.direccion}</p>}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-zinc-400">
                          <p className="truncate">{c.telefono ?? "—"}</p>
                          {c.email && <p className="truncate text-xs text-zinc-500">{c.email}</p>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {debe ? (
                            <div className="flex flex-col items-end gap-0.5">
                              <span className="text-base font-bold text-amber-300 tabular-nums">
                                {formatCOP(c.saldo_pendiente)}
                              </span>
                              <span className="text-[11px] font-medium uppercase tracking-wide text-amber-400/60">
                                Debe
                              </span>
                            </div>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
                              ✓ Al día
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setFiado({ cliente: c, tipo: "cargo" })}
                              title="Registrar una nueva deuda / mercancía fiada"
                              className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-500/15"
                            >
                              + Fiar
                            </button>
                            <button
                              type="button"
                              onClick={() => setFiado({ cliente: c, tipo: "abono" })}
                              disabled={!debe}
                              title={debe ? "Registrar un abono o cancelar la deuda" : "Sin deuda pendiente"}
                              className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-600"
                            >
                              − Abonar
                            </button>
                            <button
                              type="button"
                              onClick={() => setModal(c)}
                              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-violet-500/50 hover:bg-violet-500/10 hover:text-violet-200"
                            >
                              Editar
                            </button>
                            <button
                              type="button"
                              onClick={() => borrar(c)}
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
        </div>
      )}

      {/* Modal de alta/edición */}
      {modal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cliente-modal-titulo"
          onClick={() => setModal(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-violet-500/25 bg-zinc-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="cliente-modal-titulo" className="mb-4 text-base font-semibold text-zinc-100">
              {modal === "nuevo" ? "Nuevo cliente" : "Editar cliente"}
            </h3>
            <ClienteForm
              cliente={modal === "nuevo" ? undefined : modal}
              onSaved={onSaved}
              onCancel={() => setModal(null)}
            />
          </div>
        </div>
      )}

      {/* Panel de fiados (cuenta por cobrar del cliente) */}
      {fiado && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={`Fiados de ${fiado.cliente.nombre}`}
          onClick={() => setFiado(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-violet-500/25 bg-zinc-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <FiadoPanel
              cliente={fiado.cliente}
              initialTipo={fiado.tipo}
              onSaldoChange={onSaldoChange}
              onClose={() => setFiado(null)}
            />
          </div>
        </div>
      )}
    </PageShell>
  );
}
