"use client";

import { useState } from "react";
import { useDashboard } from "./DashboardProvider";
import { processPayment } from "../lib/payments/wompi-adapter";
import {
  PaymentMethod,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
} from "../lib/payments/types";

function randomInt(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min));
}

export default function PaymentSimulator() {
  const { registerPayment } = useDashboard();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const [method, setMethod] = useState<PaymentMethod>(PaymentMethod.NEQUI);

  async function simulate() {
    setSending(true);
    setLast(null);
    try {
      const amount = randomInt(50, 500);
      // Pasa por el adaptador de Wompi (simulado): aquí se centralizarían
      // PSE, tarjetas y transferencias/Nequi contra la API real más adelante.
      const result = await processPayment(amount, method);

      registerPayment({
        id: result.transactionId,
        reference: result.reference,
        amount: result.amount,
        method: result.method,
        paymentMethod: result.method,
        status: result.status === "success" ? "SUCCESSFUL" : "REJECTED",
        createdAt: new Date().toISOString(),
      });

      const label = PAYMENT_METHOD_LABELS[result.method];
      setLast(
        result.status === "success"
          ? `✓ Pago aprobado (${label}): +$${result.amount} (${result.reference})`
          : `✕ Pago rechazado (${label}): ${result.reference}`,
      );
    } catch {
      setLast("Error al procesar el pago con Wompi.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
      {open && (
        <div className="w-72 rounded-xl border border-violet-500/30 bg-zinc-950 p-4 shadow-2xl shadow-violet-950/50 ring-1 ring-violet-500/10">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded bg-gradient-to-br from-violet-500 to-fuchsia-600 text-[10px] font-bold text-white shadow-[0_0_10px_-1px_rgba(139,92,246,0.8)]">
                W
              </span>
              <h4 className="text-sm font-semibold text-zinc-100">Panel de pruebas · Wompi</h4>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-zinc-500 transition-colors hover:text-zinc-300"
              aria-label="Cerrar panel de pruebas"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>

          <p className="mb-3 text-xs text-zinc-500">
            Elige un método de pago y simula un cobro a través de Wompi.
          </p>

          <div className="mb-3">
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Método de pago
            </span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Método de pago">
              {PAYMENT_METHODS.map((m) => {
                const active = m === method;
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={sending}
                    aria-pressed={active}
                    onClick={() => setMethod(m)}
                    className={
                      active
                        ? "rounded-md border border-violet-500/60 bg-violet-600/20 px-2.5 py-1 text-xs font-medium text-violet-200 shadow-[0_0_10px_-3px_rgba(139,92,246,0.8)] transition-colors disabled:opacity-60"
                        : "rounded-md border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-60"
                    }
                  >
                    {PAYMENT_METHOD_LABELS[m]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={sending}
              onClick={simulate}
              className="flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 py-2.5 text-sm font-medium text-white shadow-[0_0_20px_-4px_rgba(139,92,246,0.8)] transition-all hover:bg-violet-500 hover:shadow-[0_0_28px_-2px_rgba(168,85,247,0.9)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {sending ? (
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
                </svg>
              ) : (
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
              )}
              Simular Pago con Wompi
            </button>
          </div>

          {last && (
            <p className="mt-3 rounded-md bg-zinc-950/60 px-2.5 py-1.5 text-xs text-zinc-400">{last}</p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-600 text-white shadow-[0_0_25px_-2px_rgba(139,92,246,0.7)] ring-1 ring-violet-400/30 transition-all hover:bg-violet-500 hover:shadow-[0_0_35px_0px_rgba(168,85,247,0.8)]"
        aria-label="Abrir simulador de pagos Wompi"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <path d="M2 10h20" />
        </svg>
      </button>
    </div>
  );
}
