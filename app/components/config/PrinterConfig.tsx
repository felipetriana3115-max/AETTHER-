"use client";

import { useMemo, useRef, useState } from "react";
import { useDashboard } from "../DashboardProvider";
import {
  isWebUsbSupported,
  requestUsbPrinter,
  type PaperWidth,
  type PrinterConnection,
  type PrinterSettings,
} from "../../lib/devices";
import type { TirillaConfig } from "../../lib/tirilla";
import { buildReceiptHtml, printReceipt, type ReceiptData } from "../../lib/receipt";
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  TextAreaField,
  TextField,
  ToggleRow,
} from "./primitives";

/** Venta de ejemplo para la vista previa y la impresión de prueba. */
function sampleReceipt(businessName: string): ReceiptData {
  return {
    businessName,
    ventaId: "demo1234",
    fecha: "2026-07-25 14:30",
    items: [
      { nombre: "Café molido 500g", qty: 1, precio: 18000 },
      { nombre: "Pan artesanal", qty: 2, precio: 4500 },
    ],
    total: 27000,
    pagos: [
      { metodo: "Efectivo", monto: 20000 },
      { metodo: "Nequi/Daviplata", monto: 7000 },
    ],
  };
}

type Props = {
  /** Hardware de la impresora (local al equipo, en localStorage). */
  settings: PrinterSettings;
  onPatch: (changes: Partial<PrinterSettings>) => void;
  /** Identidad del recibo (por tenant, en Supabase). */
  tirilla: TirillaConfig;
  onTirillaPatch: (changes: Partial<TirillaConfig>) => void;
};

export default function PrinterConfig({ settings, onPatch, tirilla, onTirillaPatch }: Props) {
  const { businessName, showToast } = useDashboard();
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [connecting, setConnecting] = useState(false);

  // La tirilla combina el formato/hardware (settings) con la identidad (tirilla).
  const previewHtml = useMemo(
    () => buildReceiptHtml(sampleReceipt(businessName), { ...settings, ...tirilla }),
    [businessName, settings, tirilla],
  );

  const handleLogo = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 500 * 1024) {
      showToast("Logo muy pesado", "Usa una imagen de máximo 500 KB para la tirilla.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onTirillaPatch({ logoDataUrl: String(reader.result ?? "") });
    reader.readAsDataURL(file);
  };

  const handleConnectUsb = async () => {
    setConnecting(true);
    try {
      const label = await requestUsbPrinter();
      onPatch({ deviceLabel: label });
      showToast("Impresora emparejada", label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "No se pudo emparejar la impresora.";
      // Cancelar el diálogo del navegador también lanza; no lo tratamos como error ruidoso.
      if (!/cancel|no device selected|user gesture/i.test(msg)) {
        showToast("Sin conexión", msg);
      }
    } finally {
      setConnecting(false);
    }
  };

  const usbSupported = isWebUsbSupported();

  return (
    <div className="space-y-8">
      {/* ── Hardware ────────────────────────────────────────────────── */}
      <div className="space-y-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-violet-300/80">
          Configuración de hardware
        </h4>

        <ToggleRow
          label="Impresora activa"
          description="Habilita la impresión de tirillas desde el POS."
          checked={settings.enabled}
          onChange={(v) => onPatch({ enabled: v })}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField<PrinterConnection>
            id="printer-connection"
            label="Método de impresión"
            value={settings.connection}
            onChange={(v) => onPatch({ connection: v })}
            options={[
              { value: "browser", label: "Diálogo del navegador (recomendado)" },
              { value: "usb", label: "USB directo (WebUSB)" },
            ]}
            hint="El diálogo del navegador usa la impresora instalada en el sistema."
          />
          <SelectField<PaperWidth>
            id="printer-paper"
            label="Ancho de papel"
            value={settings.paperWidth}
            onChange={(v) =>
              onPatch({ paperWidth: v, columns: v === "58mm" ? 32 : 48 })
            }
            options={[
              { value: "58mm", label: "58 mm (rollo estrecho)" },
              { value: "80mm", label: "80 mm (rollo estándar)" },
            ]}
          />
          <SelectField<number>
            id="printer-columns"
            label="Columnas (ancho útil)"
            value={settings.columns}
            onChange={(v) => onPatch({ columns: v })}
            options={[
              { value: 32, label: "32 caracteres" },
              { value: 42, label: "42 caracteres" },
              { value: 48, label: "48 caracteres" },
            ]}
          />
          <SelectField<number>
            id="printer-fontsize"
            label="Tamaño de fuente"
            value={settings.fontSize}
            onChange={(v) => onPatch({ fontSize: v })}
            options={[
              { value: 11, label: "Pequeña (11 px)" },
              { value: 12, label: "Normal (12 px)" },
              { value: 14, label: "Grande (14 px)" },
            ]}
          />
          <SelectField<string>
            id="printer-font"
            label="Fuente"
            value={settings.fontFamily}
            onChange={(v) => onPatch({ fontFamily: v })}
            options={[
              { value: "'Courier New', ui-monospace, monospace", label: "Monoespaciada (Courier)" },
              { value: "ui-monospace, 'Cascadia Mono', monospace", label: "Monoespaciada (sistema)" },
              { value: "Arial, Helvetica, sans-serif", label: "Sans-serif (Arial)" },
            ]}
          />
        </div>

        {settings.connection === "usb" && (
          <div className="rounded-lg border border-zinc-800 bg-black/30 p-4">
            {usbSupported ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 text-xs text-zinc-400">
                  {settings.deviceLabel ? (
                    <>
                      Emparejada: <span className="text-zinc-200">{settings.deviceLabel}</span>
                    </>
                  ) : (
                    "Ninguna impresora USB emparejada todavía."
                  )}
                </div>
                <SecondaryButton onClick={handleConnectUsb} disabled={connecting}>
                  {connecting ? "Emparejando…" : "Conectar impresora USB"}
                </SecondaryButton>
              </div>
            ) : (
              <p className="text-xs text-amber-300/80">
                Este navegador no soporta WebUSB. Usa el método “Diálogo del navegador”, que
                imprime con la impresora instalada en el sistema.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Tirilla personalizable ──────────────────────────────────── */}
      <div className="space-y-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-violet-300/80">
          Tirilla de venta
        </h4>

        <ToggleRow
          label="Imprimir automáticamente al cobrar"
          description="Al confirmar la venta en el POS se envía la tirilla a la impresora."
          checked={settings.autoPrint}
          onChange={(v) => onPatch({ autoPrint: v })}
        />

        {/* Logo */}
        <div>
          <p className="mb-1.5 text-xs font-medium text-zinc-400">Logo del negocio</p>
          <div className="flex items-center gap-4">
            <div
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-white bg-contain bg-center bg-no-repeat"
              style={tirilla.logoDataUrl ? { backgroundImage: `url(${tirilla.logoDataUrl})` } : undefined}
            >
              {!tirilla.logoDataUrl && <span className="text-[10px] text-zinc-500">Sin logo</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              <SecondaryButton onClick={() => logoInputRef.current?.click()}>
                {tirilla.logoDataUrl ? "Cambiar logo" : "Subir logo"}
              </SecondaryButton>
              {tirilla.logoDataUrl && (
                <SecondaryButton onClick={() => onTirillaPatch({ logoDataUrl: "" })}>Quitar</SecondaryButton>
              )}
            </div>
            <input
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => handleLogo(e.target.files?.[0])}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-zinc-600">PNG/JPG, máximo 500 KB. Se imprime centrado arriba.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="printer-nit"
            label="NIT"
            value={tirilla.nit}
            onChange={(v) => onTirillaPatch({ nit: v })}
            placeholder="900.123.456-7"
          />
          <TextField
            id="printer-tel"
            label="Teléfono (opcional)"
            value={tirilla.telefono}
            onChange={(v) => onTirillaPatch({ telefono: v })}
            placeholder="+57 300 000 0000"
            type="tel"
            inputMode="tel"
          />
        </div>

        <TextField
          id="printer-direccion"
          label="Dirección"
          value={tirilla.direccion}
          onChange={(v) => onTirillaPatch({ direccion: v })}
          placeholder="Cra 10 #20-30, Bogotá"
        />

        <TextAreaField
          id="printer-gracias"
          label="Mensaje de agradecimiento"
          value={tirilla.mensajeAgradecimiento}
          onChange={(v) => onTirillaPatch({ mensajeAgradecimiento: v })}
          placeholder="¡Gracias por tu compra!"
          hint="Aparece al pie de cada tirilla."
        />
      </div>

      {/* ── Vista previa + prueba ───────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-violet-300/80">
              Vista previa de la tirilla
            </h4>
            <p className="mt-0.5 text-[11px] text-zinc-600">Con una venta de ejemplo.</p>
          </div>
          <PrimaryButton onClick={() => printReceipt(sampleReceipt(businessName), { ...settings, ...tirilla })}>
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9V2h12v7" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <path d="M6 14h12v8H6z" />
            </svg>
            Imprimir prueba
          </PrimaryButton>
        </div>

        <div className="flex justify-center rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <iframe
            title="Vista previa de la tirilla"
            srcDoc={previewHtml}
            className="h-80 w-[280px] rounded bg-white"
          />
        </div>
      </div>
    </div>
  );
}
