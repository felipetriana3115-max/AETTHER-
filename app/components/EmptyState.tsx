"use client";

import type { ReactNode } from "react";

/**
 * Estado vacío consistente para cuando aún no se ha importado ningún dato.
 * Se muestra en los módulos que dependen exclusivamente de la carga de Excel.
 * Acepta `children` opcionales para renderizar acciones (p. ej. un botón).
 */
export default function EmptyState({
  title = "Aún no hay datos",
  message = "Carga un archivo Excel para ver tus productos.",
  children,
}: {
  title?: string;
  message?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-violet-500/25 bg-zinc-900/40 px-6 py-16 text-center">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/20 to-fuchsia-600/20 text-violet-300 ring-1 ring-violet-500/30">
        <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="M17 8l-5-5-5 5" />
          <path d="M12 3v12" />
        </svg>
      </span>
      <p className="text-sm font-semibold text-zinc-200">{title}</p>
      <p className="mt-1 max-w-sm text-xs text-zinc-500">{message}</p>
      {children}
    </div>
  );
}
