"use client";

import { useEffect, useMemo, useState } from "react";
import PageShell from "../components/PageShell";
import { useDashboard } from "../components/DashboardProvider";
import demoClient from "../../config/demoClient.json";
import { generateDailySummary } from "../lib/notifications/whatsapp-service";
import { runDailyReportMock } from "../lib/cron/daily-report-mock";

/** Clave de localStorage para las preferencias de notificaciones. */
const SETTINGS_KEY = "mi-dashboard-erp:settings:v1";

type NotificationSettings = {
  dailyReportEnabled: boolean;
  whatsappPhone: string;
};

const DEFAULT_SETTINGS: NotificationSettings = {
  dailyReportEnabled: false,
  whatsappPhone: "",
};

export default function ConfiguracionPage() {
  const { sales, inventory, showToast } = useDashboard();

  const [settings, setSettings] = useState<NotificationSettings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  // ── Persistencia en localStorage ──────────────────────────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
    } catch {
      // Ignorar JSON corrupto o localStorage inaccesible.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Cuota excedida o modo privado → se ignora el guardado.
    }
  }, [hydrated, settings]);

  // Validación mínima del teléfono: 7–15 dígitos (ignora +, espacios y guiones).
  const phoneDigits = settings.whatsappPhone.replace(/[^\d]/g, "");
  const phoneValid = phoneDigits.length >= 7 && phoneDigits.length <= 15;

  // Preview del reporte que se enviaría, con los datos vivos del dashboard.
  const preview = useMemo(
    () =>
      generateDailySummary(sales, {
        inventory,
        businessName: demoClient.businessName,
      }),
    [sales, inventory],
  );

  const canSend = settings.dailyReportEnabled && phoneValid;

  const handleSendTest = () => {
    if (!canSend) return;
    runDailyReportMock(sales, settings.whatsappPhone, {
      inventory,
      businessName: demoClient.businessName,
    });
    showToast(
      "Reporte de prueba enviado",
      `Se simuló el envío del resumen diario a ${settings.whatsappPhone}.`,
    );
  };

  return (
    <PageShell
      title="Configuración"
      subtitle={`${demoClient.businessName} · Preferencias y automatizaciones`}
    >
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Reporte diario por WhatsApp */}
        <section className="relative overflow-hidden rounded-xl border border-violet-500/15 bg-zinc-900/50 p-6">
          <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-violet-600/10 blur-3xl" />

          <div className="relative flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-300 ring-1 ring-violet-500/20">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
                </svg>
              </span>
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">
                  Recibir reporte diario vía WhatsApp
                </h3>
                <p className="mt-1 max-w-md text-xs text-zinc-500">
                  Al cierre del día se enviará un resumen automático con las ventas,
                  el método de pago predominante y las alertas de inventario.
                </p>
              </div>
            </div>

            {/* Toggle */}
            <button
              type="button"
              role="switch"
              aria-checked={settings.dailyReportEnabled}
              aria-label="Activar reporte diario por WhatsApp"
              onClick={() =>
                setSettings((s) => ({ ...s, dailyReportEnabled: !s.dailyReportEnabled }))
              }
              className={`relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-2 focus:ring-offset-zinc-900 ${
                settings.dailyReportEnabled
                  ? "bg-violet-600 shadow-[0_0_16px_-3px_rgba(139,92,246,0.9)]"
                  : "bg-zinc-700"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.dailyReportEnabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* Campo de teléfono */}
          <div className="relative mt-6">
            <label
              htmlFor="whatsapp-phone"
              className="mb-1.5 block text-xs font-medium text-zinc-400"
            >
              Número de WhatsApp
            </label>
            <input
              id="whatsapp-phone"
              type="tel"
              inputMode="tel"
              placeholder="+57 300 000 0000"
              value={settings.whatsappPhone}
              disabled={!settings.dailyReportEnabled}
              onChange={(e) =>
                setSettings((s) => ({ ...s, whatsappPhone: e.target.value }))
              }
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 transition-colors focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
            />
            {settings.dailyReportEnabled && settings.whatsappPhone !== "" && !phoneValid && (
              <p className="mt-1.5 text-xs text-red-400">
                Ingresa un número válido (7 a 15 dígitos, con indicativo del país).
              </p>
            )}
            <p className="mt-1.5 text-[11px] text-zinc-600">
              Incluye el indicativo del país. Ej.: +57 para Colombia.
            </p>
          </div>
        </section>

        {/* Vista previa del reporte */}
        <section className="rounded-xl border border-violet-500/15 bg-zinc-900/50 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">
                Vista previa del reporte
              </h3>
              <p className="mt-0.5 text-xs text-zinc-500">
                Generado con los datos vivos del dashboard.
              </p>
            </div>
            <button
              type="button"
              onClick={handleSendTest}
              disabled={!canSend}
              className="inline-flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-600/15 px-3 py-2 text-xs font-medium text-violet-200 shadow-[0_0_20px_-8px_rgba(139,92,246,0.7)] transition-colors hover:bg-violet-600/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-violet-600/15"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
              Enviar reporte de prueba
            </button>
          </div>

          <pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-black/50 p-4 font-mono text-xs leading-relaxed text-zinc-300">
            {preview}
          </pre>
          {!canSend && (
            <p className="mt-2 text-[11px] text-zinc-600">
              Activa el reporte y agrega un número válido para habilitar el envío de prueba.
            </p>
          )}
        </section>
      </div>
    </PageShell>
  );
}
