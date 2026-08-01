"use client";

import { useCallback, useEffect, useState } from "react";
import { formatCOP } from "../lib/data-model";
import {
  fetchMovimientosFiado,
  registrarFiado,
  type Cliente,
  type MovimientoFiado,
  type TipoMovimiento,
} from "../lib/clientes";

/**
 * Panel de Fiados (Cuenta por Cobrar) de UN cliente.
 *
 * Muestra el saldo pendiente en tiempo real y el libro de movimientos (cargos =
 * mercancía fiada, abonos = pagos), y permite registrar nuevos movimientos vía la
 * RPC atómica `registrar_fiado`. Tras cada movimiento avisa al padre con el saldo
 * nuevo (`onSaldoChange`) para que el directorio se actualice sin recargar todo.
 */

type Props = {
  cliente: Cliente;
  /** Notifica al directorio el saldo nuevo tras registrar un movimiento. */
  onSaldoChange?: (clienteId: string, saldo: number) => void;
  onClose?: () => void;
};

const INPUT =
  "w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";

/** Formatea la fecha ISO del movimiento a algo legible en es-CO. */
function fecha(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
}

export default function FiadoPanel({ cliente, onSaldoChange, onClose }: Props) {
  const [saldo, setSaldo] = useState(cliente.saldo_pendiente);
  const [movimientos, setMovimientos] = useState<MovimientoFiado[]>([]);
  const [cargando, setCargando] = useState(true);
  const [tipo, setTipo] = useState<TipoMovimiento>("cargo");
  const [monto, setMonto] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    const movs = await fetchMovimientosFiado(cliente.id);
    setMovimientos(movs);
    setCargando(false);
  }, [cliente.id]);

  useEffect(() => {
    setSaldo(cliente.saldo_pendiente);
    cargar();
  }, [cliente.id, cliente.saldo_pendiente, cargar]);

  const registrar = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      // Aceptamos "$ 10.000" / "10000" quedándonos solo con los dígitos.
      const valor = Math.round(Number(monto.replace(/[^\d]/g, "")));
      if (!Number.isFinite(valor) || valor <= 0) {
        setError("El monto debe ser mayor que cero.");
        return;
      }
      if (tipo === "abono" && valor > saldo) {
        setError(`El abono (${formatCOP(valor)}) supera el saldo pendiente (${formatCOP(saldo)}).`);
        return;
      }

      setGuardando(true);
      try {
        const res = await registrarFiado({
          clienteId: cliente.id,
          tipo,
          monto: valor,
          descripcion: descripcion.trim() || null,
        });
        if (!res.ok) {
          setError(`No se pudo registrar: ${res.error}`);
          return;
        }
        setSaldo(res.saldoPendiente);
        onSaldoChange?.(cliente.id, res.saldoPendiente);
        setMonto("");
        setDescripcion("");
        await cargar();
      } finally {
        setGuardando(false);
      }
    },
    [monto, tipo, saldo, cliente.id, descripcion, onSaldoChange, cargar],
  );

  return (
    <div className="space-y-5">
      {/* Encabezado: cliente + saldo grande */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-zinc-100">{cliente.nombre}</h3>
          {cliente.telefono && <p className="text-xs text-zinc-500">{cliente.telefono}</p>}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="shrink-0 rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Saldo pendiente */}
      <div
        className={`rounded-xl border p-4 ${
          saldo > 0
            ? "border-amber-500/30 bg-amber-500/10"
            : "border-emerald-500/30 bg-emerald-500/10"
        }`}
      >
        <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
          Saldo pendiente
        </p>
        <p
          className={`mt-0.5 text-3xl font-bold tracking-tight tabular-nums ${
            saldo > 0 ? "text-amber-300" : "text-emerald-300"
          }`}
        >
          {formatCOP(saldo)}
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          {saldo > 0 ? "Este cliente tiene mercancía fiada por pagar." : "El cliente está al día."}
        </p>
      </div>

      {/* Registrar movimiento (cargo/abono) */}
      <form onSubmit={registrar} className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        {error && (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        {/* Selector de tipo (dos botones grandes) */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setTipo("cargo")}
            className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
              tipo === "cargo"
                ? "border-amber-500/50 bg-amber-500/15 text-amber-200"
                : "border-zinc-800 text-zinc-400 hover:bg-zinc-800/50"
            }`}
          >
            + Fiar (cargo)
          </button>
          <button
            type="button"
            onClick={() => setTipo("abono")}
            className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
              tipo === "abono"
                ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200"
                : "border-zinc-800 text-zinc-400 hover:bg-zinc-800/50"
            }`}
          >
            − Abonar (pago)
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="fp-monto" className="mb-1.5 block text-xs font-medium text-zinc-400">
              Monto (COP)
            </label>
            <input
              id="fp-monto"
              inputMode="numeric"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              placeholder="0"
              className={INPUT}
            />
          </div>
          <div>
            <label htmlFor="fp-desc" className="mb-1.5 block text-xs font-medium text-zinc-400">
              Concepto (opcional)
            </label>
            <input
              id="fp-desc"
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              placeholder={tipo === "cargo" ? "Ej. 2 arrobas de arroz" : "Ej. abono parcial"}
              className={INPUT}
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={guardando}
          className="h-11 w-full rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-600 text-sm font-semibold text-white shadow-lg shadow-violet-500/30 transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {guardando
            ? "Registrando…"
            : tipo === "cargo"
              ? "Registrar fiado"
              : "Registrar abono"}
        </button>
      </form>

      {/* Historial de movimientos */}
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Movimientos
        </h4>
        <div className="max-h-64 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/60 divide-y divide-zinc-800/70">
          {cargando ? (
            <p className="p-6 text-center text-sm text-zinc-500">Cargando movimientos…</p>
          ) : movimientos.length === 0 ? (
            <p className="p-6 text-center text-sm text-zinc-500">
              Aún no hay movimientos. Registra el primer fiado arriba.
            </p>
          ) : (
            movimientos.map((m) => {
              const esCargo = m.tipo === "cargo";
              return (
                <div key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          esCargo
                            ? "bg-amber-500/15 text-amber-300"
                            : "bg-emerald-500/15 text-emerald-300"
                        }`}
                      >
                        {esCargo ? "Fiado" : "Abono"}
                      </span>
                      <span className="truncate text-zinc-400">{m.descripcion ?? "—"}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-600">{fecha(m.created_at)}</p>
                  </div>
                  <span
                    className={`shrink-0 font-semibold tabular-nums ${
                      esCargo ? "text-amber-300" : "text-emerald-300"
                    }`}
                  >
                    {esCargo ? "+" : "−"}
                    {formatCOP(m.monto)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
