"use client";

import { useEffect, useState, type ReactNode } from "react";
import { formatCOP } from "../lib/data-model";
import { fetchVentasHoyPorMetodo, type VentasHoyPorMetodo } from "../lib/corte";
import { supabase } from "../lib/auth";

/**
 * Desglose en tiempo real de lo vendido HOY, agrupado por método de pago
 * (Efectivo · Nequi/Daviplata · Bold).
 *
 * Fuente de verdad: la tabla `public.ventas` filtrada por el rango del día local
 * (`fetchVentasHoyPorMetodo`). Se agrupa por `metodo_pago` normalizado. NO
 * depende de que exista una fila en `cortes_caja` para hoy: mientras haya ventas
 * registradas, el cuadre se muestra. Aislado por RLS + `empresa_id` de la sesión.
 *
 * Propósito: que el dueño/cajero cuadre la caja de un vistazo sin abrir la app de
 * Nequi ni el panel de Bold a revisar transacción por transacción.
 */

type Metodo = {
  label: string;
  /** Selector del subtotal agregado del día. */
  pick: (c: VentasHoyPorMetodo) => number;
  accent: string; // color del monto
  ring: string; // borde/realce de la celda
  icon: ReactNode;
};

const METODOS: Metodo[] = [
  {
    label: "Efectivo",
    pick: (c) => c.total_efectivo,
    accent: "text-emerald-300",
    ring: "border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 to-transparent",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <circle cx="12" cy="12" r="2" />
        <path d="M6 12h.01M18 12h.01" />
      </svg>
    ),
  },
  {
    label: "Nequi / Daviplata",
    pick: (c) => c.total_nequi,
    accent: "text-fuchsia-300",
    ring: "border-fuchsia-500/25 bg-gradient-to-br from-fuchsia-500/10 to-transparent",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="2" width="14" height="20" rx="2" />
        <path d="M12 18h.01" />
      </svg>
    ),
  },
  {
    label: "Bold (tarjeta)",
    pick: (c) => c.total_bold,
    accent: "text-sky-300",
    ring: "border-sky-500/25 bg-gradient-to-br from-sky-500/10 to-transparent",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M2 10h20" />
      </svg>
    ),
  },
];

export default function PaymentBreakdownCard() {
  const [ventasHoy, setVentasHoy] = useState<VentasHoyPorMetodo | null>(null);
  const [cargando, setCargando] = useState(true);

  // Carga las ventas del día en cuanto hay sesión. Igual que el resto del
  // dashboard (ver DashboardProvider), NO consultamos con sesión vacía: RLS
  // devolvería cero filas. Escuchamos onAuthStateChange para el arranque en frío
  // (INITIAL_SESSION rehidrata la sesión desde storage) y para el login.
  useEffect(() => {
    let activo = true;

    const cargar = async () => {
      const ventas = await fetchVentasHoyPorMetodo();
      if (!activo) return;
      setVentasHoy(ventas);
      setCargando(false);
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (activo && session) cargar();
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (activo && session) cargar();
    });

    return () => {
      activo = false;
      subscription.unsubscribe();
    };
  }, []);

  const numVentas = ventasHoy?.num_ventas ?? 0;

  return (
    <div className="relative overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-5">
      {/* Glow morado sutil, consistente con MetricCard */}
      <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-violet-600/10 blur-2xl" />

      <div className="relative flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-zinc-400">Ventas de hoy por método de pago</p>
          <p className="mt-1 text-xs text-zinc-500">Cuadre rápido de caja · sin revisar Nequi ni Bold transacción por transacción</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold tracking-tight text-emerald-300 tabular-nums">
            {formatCOP(ventasHoy?.total_general ?? 0)}
          </p>
          <p className="text-xs text-zinc-500">
            {numVentas} venta{numVentas === 1 ? "" : "s"} hoy
          </p>
        </div>
      </div>

      <div className="relative mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {METODOS.map((m) => (
          <div key={m.label} className={`rounded-lg border p-4 ${m.ring}`}>
            <div className="flex items-center gap-2">
              <span className={`h-4 w-4 ${m.accent}`}>{m.icon}</span>
              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">{m.label}</p>
            </div>
            <p className={`mt-2 text-xl font-semibold tracking-tight tabular-nums ${m.accent}`}>
              {cargando ? "—" : formatCOP(ventasHoy ? m.pick(ventasHoy) : 0)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
