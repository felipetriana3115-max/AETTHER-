"use client";

import { useEffect } from "react";
import { useDashboard } from "./DashboardProvider";

/**
 * Toast global de éxito (esquina inferior derecha) con estética cyberpunk
 * morado/fucsia. Se auto-descarta a los 6 s y puede cerrarse manualmente.
 */
export default function GlobalToast() {
  const { toast, dismissToast } = useDashboard();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(dismissToast, 6000);
    return () => clearTimeout(t);
  }, [toast, dismissToast]);

  if (!toast) return null;

  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] w-[min(92vw,26rem)] -translate-x-1/2 sm:left-auto sm:right-6 sm:translate-x-0">
      <div
        role="status"
        aria-live="polite"
        key={toast.id}
        className="pointer-events-auto relative overflow-hidden rounded-xl border border-fuchsia-500/40 bg-zinc-950/95 p-4 shadow-[0_0_40px_-6px_rgba(217,70,239,0.6)] ring-1 ring-violet-500/20 backdrop-blur animate-[toastIn_0.35s_ease-out]"
      >
        {/* Glow ambiental */}
        <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-fuchsia-600/20 blur-2xl" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-violet-500 via-fuchsia-500 to-violet-500" />

        <div className="relative flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-[0_0_18px_-2px_rgba(217,70,239,0.9)]">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-zinc-50">{toast.title}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{toast.message}</p>
          </div>

          <button
            type="button"
            onClick={dismissToast}
            className="shrink-0 text-zinc-500 transition-colors hover:text-zinc-200"
            aria-label="Cerrar notificación"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
