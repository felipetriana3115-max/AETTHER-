"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PageShell from "../components/PageShell";
import { formatCOP } from "../lib/data-model";
import {
  abrirCaja,
  cerrarCaja,
  fetchCorteHoy,
  fetchMovimientosHoy,
  registrarMovimiento,
  type CierreResultado,
  type MovimientoCaja,
  type TipoMovimiento,
} from "../lib/arqueo";
import type { CorteCaja } from "../lib/corte";

/**
 * Control de Arqueo y Cierre de Caja (Caja Chica).
 *
 * Tres fases sobre la fila diaria de `cortes_caja` (compartida con el POS):
 *  1) Apertura: declarar la base inicial en efectivo del turno.
 *  2) Movimientos rápidos: entradas/salidas manuales (concepto + monto).
 *  3) Cierre ciego (Reporte Z): el cajero cuenta el efectivo en mano SIN ver el
 *     esperado; al procesar, el servidor calcula y revela sobrante/faltante.
 */

// Extrae un entero de pesos de un texto libre ("$5.000" → 5000).
function parseMonto(s: string): number {
  return Math.round(Number(s.replace(/[^\d]/g, "")));
}

// Bases sugeridas para apertura rápida (un toque).
const BASES_SUGERIDAS = [50000, 100000, 200000];

type Feedback = { tone: "error" | "ok"; msg: string } | null;

export default function CajaPage() {
  const [corte, setCorte] = useState<CorteCaja | null>(null);
  const [movimientos, setMovimientos] = useState<MovimientoCaja[]>([]);
  const [cargando, setCargando] = useState(true);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [procesando, setProcesando] = useState(false);

  // Formularios.
  const [base, setBase] = useState("");
  const [movTipo, setMovTipo] = useState<TipoMovimiento>("egreso");
  const [movMonto, setMovMonto] = useState("");
  const [movConcepto, setMovConcepto] = useState("");
  const [efectivoContado, setEfectivoContado] = useState("");

  // Resultado del cierre recién procesado (desglose autoritativo del servidor).
  const [cierreVivo, setCierreVivo] = useState<CierreResultado | null>(null);

  // Autolimpia el feedback para no dejar alertas pegadas.
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3500);
    return () => clearTimeout(t);
  }, [feedback]);

  // Carga inicial: estado de la caja + movimientos de hoy.
  useEffect(() => {
    let activo = true;
    (async () => {
      const [c, m] = await Promise.all([fetchCorteHoy(), fetchMovimientosHoy()]);
      if (!activo) return;
      setCorte(c);
      setMovimientos(m);
      setCargando(false);
    })();
    return () => {
      activo = false;
    };
  }, []);

  const ingresosHoy = useMemo(
    () => movimientos.filter((m) => m.tipo === "ingreso").reduce((s, m) => s + m.monto, 0),
    [movimientos],
  );
  const egresosHoy = useMemo(
    () => movimientos.filter((m) => m.tipo === "egreso").reduce((s, m) => s + m.monto, 0),
    [movimientos],
  );

  // Fase actual: apertura / turno abierto / cerrado.
  const cerrada = corte?.estado === "cerrada";
  const abierta = !!corte && corte.estado === "abierta" && !!corte.abierto_at;

  // Desglose a mostrar tras el cierre: el del servidor si es fresco, o
  // reconstruido desde la fila persistida al recargar (esperado = contado − dif).
  const resultado: CierreResultado | null = useMemo(() => {
    if (cierreVivo) return cierreVivo;
    if (corte && cerrada && corte.efectivo_contado != null && corte.diferencia != null) {
      return {
        corte,
        base_inicial: corte.base_inicial,
        ventas_efectivo: corte.total_efectivo,
        ingresos: ingresosHoy,
        egresos: egresosHoy,
        esperado: corte.efectivo_contado - corte.diferencia,
        efectivo_contado: corte.efectivo_contado,
        diferencia: corte.diferencia,
      };
    }
    return null;
  }, [cierreVivo, corte, cerrada, ingresosHoy, egresosHoy]);

  // ── Acciones ────────────────────────────────────────────────────────────

  const onAbrir = useCallback(
    async (montoBase: number) => {
      if (!Number.isFinite(montoBase) || montoBase < 0) {
        setFeedback({ tone: "error", msg: "Ingresa una base inicial válida." });
        return;
      }
      setProcesando(true);
      try {
        const c = await abrirCaja(montoBase);
        setCorte(c);
        setBase("");
        setCierreVivo(null);
        setFeedback({ tone: "ok", msg: `Caja abierta con base ${formatCOP(montoBase)}.` });
      } catch (e) {
        setFeedback({ tone: "error", msg: `No se pudo abrir la caja: ${(e as Error).message}` });
      } finally {
        setProcesando(false);
      }
    },
    [],
  );

  const onRegistrarMovimiento = useCallback(async () => {
    const monto = parseMonto(movMonto);
    const concepto = movConcepto.trim();
    if (!Number.isFinite(monto) || monto <= 0) {
      setFeedback({ tone: "error", msg: "El monto debe ser mayor que cero." });
      return;
    }
    if (!concepto) {
      setFeedback({ tone: "error", msg: "Escribe un concepto para el movimiento." });
      return;
    }
    setProcesando(true);
    try {
      const mov = await registrarMovimiento(movTipo, monto, concepto);
      setMovimientos((prev) => [mov, ...prev]);
      setMovMonto("");
      setMovConcepto("");
      setFeedback({
        tone: "ok",
        msg: `${movTipo === "ingreso" ? "Ingreso" : "Egreso"} registrado: ${formatCOP(monto)}.`,
      });
    } catch (e) {
      setFeedback({ tone: "error", msg: `No se pudo registrar: ${(e as Error).message}` });
    } finally {
      setProcesando(false);
    }
  }, [movTipo, movMonto, movConcepto]);

  const onCerrar = useCallback(async () => {
    const contado = parseMonto(efectivoContado);
    if (!Number.isFinite(contado) || contado < 0) {
      setFeedback({ tone: "error", msg: "Ingresa el efectivo contado en mano." });
      return;
    }
    setProcesando(true);
    try {
      const res = await cerrarCaja(contado);
      setCierreVivo(res);
      setCorte(res.corte);
      setEfectivoContado("");
      setFeedback({ tone: "ok", msg: "Cierre procesado. Revisa el resultado." });
    } catch (e) {
      setFeedback({ tone: "error", msg: `No se pudo cerrar la caja: ${(e as Error).message}` });
    } finally {
      setProcesando(false);
    }
  }, [efectivoContado]);

  const inputClass =
    "w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";

  return (
    <PageShell title="Arqueo de Caja" subtitle="Caja chica · Apertura, movimientos y cierre ciego (Reporte Z)">
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

      {cargando ? (
        <p className="py-16 text-center text-sm text-zinc-500">Cargando estado de la caja…</p>
      ) : cerrada && resultado ? (
        // ── Fase 3b: caja cerrada → resultado del arqueo ──────────────────────
        <ResultadoCierre resultado={resultado} onReabrir={() => onAbrir(resultado.base_inicial)} procesando={procesando} />
      ) : !abierta ? (
        // ── Fase 1: apertura de caja ──────────────────────────────────────────
        <section className="mx-auto max-w-md rounded-xl border border-violet-500/15 bg-zinc-900/50 p-6">
          <div className="mb-1 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/15 text-lg">🔓</span>
            <h2 className="text-base font-semibold text-zinc-100">Abrir caja</h2>
          </div>
          <p className="mb-5 text-xs text-zinc-500">
            Registra el efectivo base con el que inicias el turno. Es el punto de partida del arqueo.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              onAbrir(parseMonto(base));
            }}
            className="space-y-4"
          >
            <div>
              <label htmlFor="base" className="mb-1.5 block text-xs font-medium text-zinc-400">
                Base inicial en efectivo (COP)
              </label>
              <input
                id="base"
                inputMode="numeric"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder="Ej. 100.000"
                autoFocus
                className={inputClass}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              {BASES_SUGERIDAS.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBase(String(b))}
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-violet-500/50 hover:text-violet-200"
                >
                  {formatCOP(b)}
                </button>
              ))}
            </div>

            <button
              type="submit"
              disabled={procesando}
              className="h-12 w-full rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-600 text-sm font-semibold text-white shadow-lg shadow-violet-500/30 transition-all active:scale-[0.98] disabled:opacity-40"
            >
              {procesando ? "Abriendo…" : "Abrir caja"}
            </button>
          </form>
        </section>
      ) : (
        // ── Fase 2 + 3a: turno abierto (movimientos + cierre ciego) ───────────
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Columna izquierda: base + movimientos */}
          <div className="space-y-6 lg:col-span-2">
            {/* Resumen del turno (SIN revelar ventas ni esperado → cierre ciego) */}
            <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <ResumenCard label="Base inicial" value={formatCOP(corte!.base_inicial)} tone="violet" />
              <ResumenCard label="Ingresos manuales" value={formatCOP(ingresosHoy)} tone="emerald" />
              <ResumenCard label="Egresos manuales" value={formatCOP(egresosHoy)} tone="amber" />
              <ResumenCard label="Movimientos" value={String(movimientos.length)} tone="zinc" />
            </section>

            {/* Movimiento rápido */}
            <section className="rounded-xl border border-violet-500/15 bg-zinc-900/50 p-6">
              <h2 className="mb-4 text-sm font-semibold text-zinc-100">Movimiento rápido de efectivo</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onRegistrarMovimiento();
                }}
                className="space-y-4"
              >
                {/* Selector ingreso / egreso */}
                <div className="grid grid-cols-2 gap-2">
                  {(["egreso", "ingreso"] as TipoMovimiento[]).map((t) => {
                    const activo = movTipo === t;
                    const esIngreso = t === "ingreso";
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setMovTipo(t)}
                        className={`h-11 rounded-lg border text-sm font-semibold capitalize transition-all ${
                          activo
                            ? esIngreso
                              ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                              : "border-amber-500/50 bg-amber-500/15 text-amber-300"
                            : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        {esIngreso ? "↑ Ingreso" : "↓ Egreso"}
                      </button>
                    );
                  })}
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="sm:col-span-2">
                    <label htmlFor="mov-concepto" className="mb-1.5 block text-xs font-medium text-zinc-400">
                      Concepto
                    </label>
                    <input
                      id="mov-concepto"
                      value={movConcepto}
                      onChange={(e) => setMovConcepto(e.target.value)}
                      placeholder="Ej. Pago domiciliario, compra de insumos…"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="mov-monto" className="mb-1.5 block text-xs font-medium text-zinc-400">
                      Monto (COP)
                    </label>
                    <input
                      id="mov-monto"
                      inputMode="numeric"
                      value={movMonto}
                      onChange={(e) => setMovMonto(e.target.value)}
                      placeholder="0"
                      className={inputClass}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={procesando}
                  className="h-11 w-full rounded-lg border border-violet-500/40 bg-violet-500/10 text-sm font-semibold text-violet-200 transition-all hover:bg-violet-500/20 active:scale-[0.99] disabled:opacity-40"
                >
                  Registrar movimiento
                </button>
              </form>

              {/* Lista de movimientos del turno */}
              <div className="mt-6">
                {movimientos.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-zinc-800 py-6 text-center text-sm text-zinc-500">
                    Sin movimientos manuales en este turno.
                  </p>
                ) : (
                  <ul className="divide-y divide-zinc-800/70">
                    {movimientos.map((m) => {
                      const esIngreso = m.tipo === "ingreso";
                      return (
                        <li key={m.id} className="flex items-center justify-between gap-3 py-2.5">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <span
                              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-bold ${
                                esIngreso ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"
                              }`}
                            >
                              {esIngreso ? "↑" : "↓"}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm text-zinc-200">{m.concepto}</p>
                              <p className="text-xs text-zinc-500">
                                {new Date(m.created_at).toLocaleTimeString("es-CO", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </p>
                            </div>
                          </div>
                          <span
                            className={`shrink-0 text-sm font-semibold tabular-nums ${
                              esIngreso ? "text-emerald-300" : "text-amber-300"
                            }`}
                          >
                            {esIngreso ? "+" : "−"}
                            {formatCOP(m.monto)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>
          </div>

          {/* Columna derecha: cierre ciego */}
          <section className="flex h-fit flex-col rounded-xl border border-fuchsia-500/20 bg-zinc-900/50 p-6">
            <div className="mb-1 flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-fuchsia-500/15 text-lg">🔒</span>
              <h2 className="text-base font-semibold text-zinc-100">Cierre ciego (Reporte Z)</h2>
            </div>
            <p className="mb-5 text-xs text-zinc-500">
              Cuenta el efectivo físico que tienes en mano e ingrésalo. El sistema calculará la
              diferencia sin mostrarte el total esperado de antemano.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                onCerrar();
              }}
              className="space-y-4"
            >
              <div>
                <label htmlFor="contado" className="mb-1.5 block text-xs font-medium text-zinc-400">
                  Efectivo contado en mano (COP)
                </label>
                <input
                  id="contado"
                  inputMode="numeric"
                  value={efectivoContado}
                  onChange={(e) => setEfectivoContado(e.target.value)}
                  placeholder="0"
                  className={inputClass}
                />
              </div>

              <button
                type="submit"
                disabled={procesando}
                className="h-12 w-full rounded-lg bg-gradient-to-r from-fuchsia-500 to-purple-600 text-sm font-semibold text-white shadow-lg shadow-fuchsia-500/30 transition-all active:scale-[0.98] disabled:opacity-40"
              >
                {procesando ? "Procesando…" : "Procesar cierre"}
              </button>
            </form>

            <p className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-500">
              El conteo es a ciegas: ni las ventas en efectivo ni el total esperado se muestran hasta
              procesar el cierre.
            </p>
          </section>
        </div>
      )}
    </PageShell>
  );
}

// ── Subcomponentes ──────────────────────────────────────────────────────────

function ResumenCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "violet" | "emerald" | "amber" | "zinc";
}) {
  const tones: Record<string, string> = {
    violet: "border-violet-500/25 text-violet-300",
    emerald: "border-emerald-500/25 text-emerald-300",
    amber: "border-amber-500/25 text-amber-300",
    zinc: "border-zinc-800 text-zinc-200",
  };
  return (
    <div className={`rounded-lg border bg-zinc-950 p-4 ${tones[tone]}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function ResultadoCierre({
  resultado,
  onReabrir,
  procesando,
}: {
  resultado: CierreResultado;
  onReabrir: () => void;
  procesando: boolean;
}) {
  const { base_inicial, ventas_efectivo, ingresos, egresos, esperado, efectivo_contado, diferencia } = resultado;
  const cuadrado = diferencia === 0;
  const sobrante = diferencia > 0;
  const tone = cuadrado ? "emerald" : sobrante ? "sky" : "red";
  const toneClasses: Record<string, string> = {
    emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    sky: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    red: "border-red-500/30 bg-red-500/10 text-red-300",
  };
  const etiqueta = cuadrado ? "Caja cuadrada" : sobrante ? "Sobrante" : "Faltante";

  // Fila del desglose. Es una función que devuelve JSX (no un componente
  // anidado) para no reiniciar estado en cada render (regla static-components).
  const fila = (label: string, value: number, signo: "+" | "−") => (
    <div key={label} className="flex items-center justify-between py-2 text-sm">
      <span className="text-zinc-400">{label}</span>
      <span className="tabular-nums text-zinc-200">
        {signo === "−" ? "− " : "+ "}
        {formatCOP(value)}
      </span>
    </div>
  );

  return (
    <div className="mx-auto max-w-lg space-y-5">
      {/* Banner del resultado */}
      <div className={`rounded-xl border p-6 text-center ${toneClasses[tone]}`}>
        <p className="text-xs font-medium uppercase tracking-wide opacity-80">{etiqueta}</p>
        <p className="mt-1 text-4xl font-bold tracking-tight tabular-nums">
          {diferencia > 0 ? "+" : diferencia < 0 ? "−" : ""}
          {formatCOP(Math.abs(diferencia))}
        </p>
        <p className="mt-1 text-xs opacity-80">
          {cuadrado
            ? "El efectivo contado coincide con lo esperado."
            : sobrante
              ? "Hay más efectivo del esperado en el cajón."
              : "Falta efectivo respecto a lo esperado."}
        </p>
      </div>

      {/* Desglose revelado */}
      <div className="rounded-xl border border-violet-500/15 bg-zinc-900/50 p-6">
        <h3 className="mb-2 text-sm font-semibold text-zinc-100">Desglose del arqueo</h3>
        <div className="divide-y divide-zinc-800/70">
          {fila("Base inicial", base_inicial, "+")}
          {fila("Ventas en efectivo (POS)", ventas_efectivo, "+")}
          {fila("Ingresos manuales", ingresos, "+")}
          {fila("Egresos manuales", egresos, "−")}
          <div className="flex items-center justify-between py-2.5 text-sm font-semibold">
            <span className="text-zinc-300">Efectivo esperado</span>
            <span className="tabular-nums text-zinc-100">{formatCOP(esperado)}</span>
          </div>
          <div className="flex items-center justify-between py-2.5 text-sm font-semibold">
            <span className="text-zinc-300">Efectivo contado</span>
            <span className="tabular-nums text-zinc-100">{formatCOP(efectivo_contado)}</span>
          </div>
          <div className="flex items-center justify-between py-2.5 text-sm font-bold">
            <span className="text-zinc-100">Diferencia</span>
            <span className={`tabular-nums ${cuadrado ? "text-emerald-300" : sobrante ? "text-sky-300" : "text-red-300"}`}>
              {diferencia > 0 ? "+" : diferencia < 0 ? "−" : ""}
              {formatCOP(Math.abs(diferencia))}
            </span>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onReabrir}
        disabled={procesando}
        className="h-11 w-full rounded-lg border border-zinc-700 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40"
      >
        {procesando ? "Reabriendo…" : "Reabrir caja (recontar)"}
      </button>
    </div>
  );
}
