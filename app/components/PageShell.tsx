"use client";

import { useState, type ReactNode } from "react";
import Sidebar from "./Sidebar";
import InstallButton from "./InstallButton";

type PageShellProps = {
  title: string;
  subtitle: string;
  children: ReactNode;
  /** Acción opcional a la derecha del header (botón, filtro, etc.). */
  action?: ReactNode;
};

/**
 * Estructura base de cada módulo: menú lateral fijo + barra superior + área
 * de contenido. Mantiene la estética cyberpunk (negro puro, bordes
 * violet-500/15 y glow morado) consistente en todo el ERP.
 */
export default function PageShell({ title, subtitle, children, action }: PageShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-black text-zinc-100">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />

      {/* Fondo oscuro al abrir el menú en móvil */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          aria-hidden="true"
          onClick={() => setMenuOpen(false)}
        />
      )}

      {/* Área principal */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barra superior */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-violet-500/15 bg-black/70 px-4 backdrop-blur md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            {/* Botón hamburguesa (solo móvil) */}
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Abrir menú"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 md:hidden"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h16" />
                <path d="M4 12h16" />
                <path d="M4 18h16" />
              </svg>
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-zinc-100">{title}</h1>
              <p className="truncate text-xs text-zinc-500">{subtitle}</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {action}
            <InstallButton />
            <div className="relative hidden md:block">
              <span className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </span>
              <input
                type="search"
                placeholder="Buscar…"
                className="w-56 rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-200 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
            </div>
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              aria-label="Notificaciones"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
            </button>
          </div>
        </header>

        {/* Contenido */}
        <main className="flex-1 p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
