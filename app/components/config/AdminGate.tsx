"use client";

import type { ReactNode } from "react";
import { useRolSesion } from "../../lib/useRol";

/**
 * Envoltura de secciones de Configuración reservadas al DUEÑO de la empresa.
 *
 * Qué resuelve: los ajustes de hardware de caja (impresora, lector, cajón,
 * báscula) y las notificaciones del negocio (reporte diario por WhatsApp) no son
 * preferencias del cajero. Un empleado que desactive la auto-impresión o cambie
 * el número de WhatsApp afecta a toda la operación, así que esas tarjetas
 * quedan fuera de su alcance.
 *
 * FAIL-CLOSED en tres estados, para no parpadear ni filtrar:
 *   · rol confirmado como admin  → se renderizan los `children`.
 *   · rol confirmado NO admin    → tarjeta de "solo el administrador".
 *   · rol aún sin resolver       → marcador neutro (nunca los `children`).
 *
 * Los `children` se pasan como elemento: mientras el gate no los renderice,
 * React NO monta el componente, así que sus hooks (lecturas a Supabase,
 * suscripciones a `localStorage`) tampoco se ejecutan para un empleado.
 *
 * RECORDATORIO DE SEGURIDAD: esto decide qué se PINTA. Los ajustes de
 * dispositivos son locales al equipo (`localStorage`) y la identidad de la
 * tirilla la protege su propia RPC + RLS por tenant. Nunca confíes solo en esta
 * capa para datos del servidor.
 */
export default function AdminGate({
  titulo,
  motivo,
  icono,
  children,
}: {
  /** Título de la sección bloqueada, tal como se vería desbloqueada. */
  titulo: string;
  /** Una línea explicando por qué está reservada al administrador. */
  motivo: string;
  /** Mismo ícono que usa la sección real, para que el hueco se reconozca. */
  icono: ReactNode;
  children: ReactNode;
}) {
  const { esAdministrador, resuelto } = useRolSesion();

  if (esAdministrador) return <>{children}</>;

  // Rol todavía en vuelo: hueco neutro del mismo alto aproximado, sin revelar
  // ni montar la sección. Evita el salto de maquetación al resolverse.
  if (!resuelto) {
    return (
      <section
        aria-busy="true"
        className="h-32 animate-pulse rounded-xl border border-violet-500/10 bg-zinc-900/40"
      />
    );
  }

  return (
    <section className="relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
      <div className="relative flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-800/60 text-zinc-500 ring-1 ring-zinc-700/60">
          {icono}
        </span>
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-400">
            {titulo}
            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              Solo administrador
            </span>
          </h3>
          <p className="mt-1 max-w-md text-xs text-zinc-600">{motivo}</p>
        </div>
      </div>
    </section>
  );
}
