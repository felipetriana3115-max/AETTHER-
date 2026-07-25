"use client";

import { useState, type ReactNode } from "react";
import { useDeviceSettings, type DeviceSettings } from "../../lib/devices";
import PrinterConfig from "./PrinterConfig";
import ScannerConfig from "./ScannerConfig";
import CashDrawerConfig from "./CashDrawerConfig";
import ScaleConfig from "./ScaleConfig";

type DeviceKey = keyof DeviceSettings;

type DeviceMeta = {
  key: DeviceKey;
  title: string;
  description: string;
  icon: ReactNode;
};

// Íconos en línea (mismo estilo stroke que el resto de Configuración).
const DEVICES: DeviceMeta[] = [
  {
    key: "printer",
    title: "Impresora de Tickets",
    description: "Tirilla térmica, logo y formato",
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 9V2h12v7" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
        <path d="M6 14h12v8H6z" />
      </svg>
    ),
  },
  {
    key: "scanner",
    title: "Lector de Códigos",
    description: "Escaneo de barras en el POS",
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 5v14" />
        <path d="M7 5v14" />
        <path d="M11 5v14" />
        <path d="M15 5v14" />
        <path d="M19 5v14" />
        <path d="M21 5v14" />
      </svg>
    ),
  },
  {
    key: "drawer",
    title: "Cajón de Dinero",
    description: "Apertura automática al cobrar",
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="7" width="18" height="12" rx="2" />
        <path d="M3 12h6a2 2 0 0 0 4 0h8" />
        <path d="M9 15h6" />
      </svg>
    ),
  },
  {
    key: "scale",
    title: "Báscula",
    description: "Venta de productos por peso",
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v3" />
        <path d="M5 6h14l3 8a5 5 0 0 1-10 0" />
        <path d="M19 6l-3 8a5 5 0 0 1-10 0L5 6" />
        <path d="M8 21h8" />
        <path d="M12 6v15" />
      </svg>
    ),
  },
];

/** Estado corto que se muestra en cada tarjeta según su configuración. */
function statusLabel(key: DeviceKey, s: DeviceSettings): { text: string; active: boolean } {
  const dev = s[key];
  if (!dev.enabled) return { text: "Inactivo", active: false };
  if (key === "printer") {
    const p = s.printer;
    return { text: p.autoPrint ? "Auto-impresión" : "Activa", active: true };
  }
  return { text: "Activo", active: true };
}

export default function DevicesSection() {
  const { settings, patch, hydrated } = useDeviceSettings();
  const [open, setOpen] = useState<DeviceKey | null>(null);

  const renderPanel = (key: DeviceKey) => {
    switch (key) {
      case "printer":
        return <PrinterConfig settings={settings.printer} onPatch={(c) => patch("printer", c)} />;
      case "scanner":
        return <ScannerConfig settings={settings.scanner} onPatch={(c) => patch("scanner", c)} />;
      case "drawer":
        return <CashDrawerConfig settings={settings.drawer} onPatch={(c) => patch("drawer", c)} />;
      case "scale":
        return <ScaleConfig settings={settings.scale} onPatch={(c) => patch("scale", c)} />;
    }
  };

  return (
    <section className="relative overflow-hidden rounded-xl border border-violet-500/15 bg-zinc-900/50 p-6">
      <div className="pointer-events-none absolute -right-20 -bottom-24 h-56 w-56 rounded-full bg-fuchsia-600/10 blur-3xl" />

      <div className="relative flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-300 ring-1 ring-violet-500/20">
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8" />
            <path d="M12 17v4" />
          </svg>
        </span>
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Dispositivos</h3>
          <p className="mt-1 max-w-md text-xs text-zinc-500">
            Configura el hardware de la caja: impresora de tickets, lector de códigos, cajón de
            dinero y báscula. La configuración es local a este equipo.
          </p>
        </div>
      </div>

      {/* Grid de tarjetas */}
      <div className="relative mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {DEVICES.map((d) => {
          const status = hydrated ? statusLabel(d.key, settings) : { text: "…", active: false };
          const isOpen = open === d.key;
          return (
            <button
              key={d.key}
              type="button"
              onClick={() => setOpen(isOpen ? null : d.key)}
              aria-expanded={isOpen}
              className={`group flex items-center gap-3 rounded-xl border p-4 text-left transition-colors ${
                isOpen
                  ? "border-violet-500/40 bg-violet-600/10"
                  : "border-zinc-800 bg-zinc-900/40 hover:border-violet-500/25 hover:bg-zinc-800/40"
              }`}
            >
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 transition-colors ${
                  status.active
                    ? "bg-violet-500/15 text-violet-200 ring-violet-500/30"
                    : "bg-zinc-800/60 text-zinc-500 ring-zinc-700/60"
                }`}
              >
                {d.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-zinc-100">{d.title}</span>
                <span className="block truncate text-xs text-zinc-500">{d.description}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    status.active
                      ? "bg-emerald-500/10 text-emerald-300"
                      : "bg-zinc-700/40 text-zinc-500"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${status.active ? "bg-emerald-400" : "bg-zinc-500"}`} />
                  {status.text}
                </span>
                <svg
                  className={`h-4 w-4 text-zinc-500 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </span>
            </button>
          );
        })}
      </div>

      {/* Panel de configuración del dispositivo seleccionado */}
      {open && (
        <div className="relative mt-4 rounded-xl border border-violet-500/20 bg-black/30 p-5">
          <div className="mb-5 flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-zinc-100">
              {DEVICES.find((d) => d.key === open)?.title}
            </h4>
            <button
              type="button"
              onClick={() => setOpen(null)}
              aria-label="Cerrar configuración"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
          {renderPanel(open)}
        </div>
      )}
    </section>
  );
}
