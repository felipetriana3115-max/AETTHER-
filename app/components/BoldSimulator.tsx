"use client";

import { useState } from "react";
import { useDashboard } from "./DashboardProvider";
import type { NormalizedBoldPayment } from "../lib/bold";

const METHODS = ["CARD", "PSE", "NEQUI", "BANCOLOMBIA_TRANSFER"];

function randomInt(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min));
}

/** Construye un evento con la forma real de un webhook de Bold. */
function buildBoldEvent(status: "SUCCESSFUL" | "REJECTED") {
  const reference = `BOLD-${randomInt(100000, 999999)}`;
  return {
    id: crypto.randomUUID(),
    type: status === "SUCCESSFUL" ? "SALE_APPROVED" : "SALE_REJECTED",
    time: Date.now(),
    data: {
      payment_id: crypto.randomUUID(),
      amount: { total: randomInt(50, 500), currency: "USD" },
      metadata: { reference },
      payment_method: METHODS[randomInt(0, METHODS.length)],
    },
  };
}

export default function BoldSimulator() {
  const { registerPayment } = useDashboard();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [last, setLast] = useState<string | null>(null);

  async function simulate(status: "SUCCESSFUL" | "REJECTED") {
    setSending(true);
    setLast(null);
    try {
      // Se envía el pago ficticio a NUESTRA ruta de webhook, que lo valida y normaliza.
      const res = await fetch("/api/webhooks/bold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBoldEvent(status)),
      });
      const json = (await res.json()) as {
        ok: boolean;
        payment?: NormalizedBoldPayment;
        error?: string;
      };

      if (!json.ok || !json.payment) {
        setLast(`Error: ${json.error ?? "respuesta inválida"}`);
        return;
      }

      const p = json.payment;
      registerPayment({
        id: p.paymentId,
        reference: p.reference,
        amount: p.amount,
        method: p.method,
        status: p.status,
        createdAt: new Date().toISOString(),
      });

      setLast(
        p.status === "SUCCESSFUL"
          ? `✓ Pago aprobado: +$${p.amount} (${p.reference})`
          : `✕ Pago rechazado: ${p.reference}`,
      );
    } catch {
      setLast("Error de red al contactar el webhook.");
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
                B
              </span>
              <h4 className="text-sm font-semibold text-zinc-100">Panel de pruebas · Bold</h4>
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
            Envía un evento de pago al webhook <code className="text-zinc-400">/api/webhooks/bold</code>.
          </p>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={sending}
              onClick={() => simulate("SUCCESSFUL")}
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
              Simular Pago de Bold
            </button>
            <button
              type="button"
              disabled={sending}
              onClick={() => simulate("REJECTED")}
              className="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-60"
            >
              Simular pago rechazado
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
        aria-label="Abrir simulador de pagos Bold"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <path d="M2 10h20" />
        </svg>
      </button>
    </div>
  );
}
