"use client";

import { useDashboard } from "./DashboardProvider";
import { formatCOP } from "../lib/data-model";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "../lib/payments/types";

// Etiquetas de los métodos "legacy" de Bold, para transacciones previas que
// solo traían `method` como texto libre (sin el `paymentMethod` tipado).
const METHOD_LABELS: Record<string, string> = {
  CARD: "Tarjeta",
  PSE: "PSE",
  NEQUI: "Nequi",
  BANCOLOMBIA_TRANSFER: "Transferencia",
};

/** Etiqueta del método a mostrar: prioriza el `paymentMethod` de Wompi. */
function methodLabel(paymentMethod: PaymentMethod | undefined, method: string) {
  if (paymentMethod) return PAYMENT_METHOD_LABELS[paymentMethod];
  return METHOD_LABELS[method] ?? method;
}

function time(iso: string) {
  return new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
}

export default function TransactionsPanel() {
  const { transactions } = useDashboard();

  return (
    <div className="flex h-full flex-col rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-400">Transacciones recientes</h3>
        <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          Bold · en vivo
        </span>
      </div>

      {transactions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800 text-zinc-500">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <path d="M2 10h20" />
            </svg>
          </span>
          <p className="text-sm text-zinc-400">Aún no hay pagos registrados</p>
          <p className="mt-1 text-xs text-zinc-600">Usa el simulador de Bold para generar uno.</p>
        </div>
      ) : (
        <ul className="-mr-2 flex-1 space-y-2 overflow-y-auto pr-2">
          {transactions.map((tx) => {
            const ok = tx.status === "SUCCESSFUL";
            return (
              <li
                key={tx.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                      ok ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                    }`}
                  >
                    {ok ? (
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    )}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-zinc-100">{tx.reference}</p>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">
                        <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="5" width="20" height="14" rx="2" />
                          <path d="M2 10h20" />
                        </svg>
                        {methodLabel(tx.paymentMethod, tx.method)}
                      </span>
                    </div>
                    <p className="truncate text-xs text-zinc-500">{time(tx.createdAt)}</p>
                  </div>
                </div>
                <span
                  className={`shrink-0 text-sm font-semibold tabular-nums ${
                    ok ? "text-zinc-100" : "text-zinc-500 line-through"
                  }`}
                >
                  {formatCOP(tx.amount)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
