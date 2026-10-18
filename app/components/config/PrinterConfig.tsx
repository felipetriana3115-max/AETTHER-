"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "../DashboardProvider";
import {
  DEFAULT_BRIDGE_URL,
  describeUsbPrinter,
  isWebUsbSupported,
  releaseUsbPrinter,
  requestUsbPrinter,
  writeToUsbPrinter,
  type PaperWidth,
  type PrinterConnection,
  type PrinterSettings,
} from "../../lib/devices";
import { buildTestJob } from "../../lib/escpos";
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
  /** Guardado explícito e inmediato en Supabase (RPC `actualizar_tirilla`). */
  onTirillaSave: () => Promise<void>;
};

export default function PrinterConfig({
  settings,
  onPatch,
  tirilla,
  onTirillaPatch,
  onTirillaSave,
}: Props) {
  const { businessName, showToast } = useDashboard();
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [savingTirilla, setSavingTirilla] = useState(false);
  // Impresora que el navegador ya tiene autorizada en ESTE equipo (puede venir
  // de una sesión anterior: el permiso WebUSB sobrevive al logout).
  const [usbDetectada, setUsbDetectada] = useState<string | null>(null);

  // La tirilla combina el formato/hardware (settings) con la identidad (tirilla).
  const previewHtml = useMemo(
    () => buildReceiptHtml(sampleReceipt(businessName), { ...settings, ...tirilla }),
    [businessName, settings, tirilla],
  );

  const refrescarUsb = useCallback(() => {
    void describeUsbPrinter().then(setUsbDetectada);
  }, []);

  useEffect(() => {
    if (settings.connection === "usb") refrescarUsb();
  }, [settings.connection, refrescarUsb]);

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
      const { label, ready } = await requestUsbPrinter();
      onPatch({ deviceLabel: label });
      refrescarUsb();
      if (ready) {
        showToast("Impresora emparejada", `${label} · lista para recibir ESC/POS.`);
      } else {
        showToast(
          "Autorizada, pero sin canal de impresión",
          `${label} no expone un endpoint USB de salida. En Windows hay que asignarle el driver WinUSB (Zadig) para que el navegador pueda escribirle.`,
        );
      }
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

  /** Dos líneas y corte: confirma que los bytes llegan al firmware. */
  const handleTestUsb = async () => {
    setTesting(true);
    try {
      await writeToUsbPrinter(buildTestJob());
      showToast("Conexión USB correcta", "La impresora recibió los bytes ESC/POS de prueba.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "No se pudo escribir en la impresora.";
      showToast("Sin respuesta de la impresora", msg);
    } finally {
      setTesting(false);
      refrescarUsb();
    }
  };

  /** Suelta la interfaz para devolverle la impresora al driver del sistema. */
  const handleReleaseUsb = async () => {
    await releaseUsbPrinter();
    showToast("Impresora liberada", "La interfaz USB queda libre para el driver del sistema.");
  };

  // Imprime la venta de ejemplo por el MISMO camino que una venta real (incluido
  // el pulso del cajón), para que la prueba valide de verdad el canal elegido.
  const handleTestPrint = async () => {
    setPrinting(true);
    try {
      const result = await printReceipt(sampleReceipt(businessName), { ...settings, ...tirilla });
      if (result.ok) {
        showToast(
          "Tirilla enviada",
          result.via === "usb"
            ? "Enviada por USB directo (ESC/POS crudo)."
            : result.via === "bridge"
              ? "Enviada al puente de impresión local."
              : "Enviada al diálogo de impresión del navegador.",
        );
      } else {
        showToast("No se pudo imprimir", result.message);
      }
    } finally {
      setPrinting(false);
    }
  };

  // Guardado explícito de la tirilla (NIT, dirección, teléfono, logo y mensaje)
  // en Supabase. El auto-guardado con debounce sigue activo; este botón fuerza el
  // guardado inmediato y confirma el éxito al usuario.
  const handleSaveTirilla = async () => {
    setSavingTirilla(true);
    try {
      await onTirillaSave();
      showToast(
        "Tirilla guardada",
        "Los datos de la tirilla se guardaron con éxito en Supabase.",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "No se pudo guardar la tirilla.";
      showToast("No se pudo guardar", msg);
    } finally {
      setSavingTirilla(false);
    }
  };

  const usbSupported = isWebUsbSupported();
  // El nombre real del dispositivo autorizado manda sobre la etiqueta guardada.
  const etiquetaUsb = usbDetectada ?? settings.deviceLabel;

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
              { value: "browser", label: "Diálogo del navegador" },
              { value: "usb", label: "USB directo (WebUSB · ESC/POS)" },
              { value: "bridge", label: "Puente de impresión local (HTTP)" },
            ]}
            hint="En terminales All-in-One usa USB directo o el puente: el diálogo del navegador rasteriza la tirilla y pierde el pulso del cajón."
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
            hint={
              settings.paperWidth === "80mm" && settings.columns === 48
                ? "80 mm / 48 columnas: cada orden lleva el pulso de apertura del cajón (RJ11)."
                : undefined
            }
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
          <div className="space-y-3 rounded-lg border border-zinc-800 bg-black/30 p-4">
            {usbSupported ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 text-xs text-zinc-400">
                    {etiquetaUsb ? (
                      <>
                        Emparejada: <span className="text-zinc-200">{etiquetaUsb}</span>
                      </>
                    ) : (
                      "Ninguna impresora USB emparejada todavía."
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <SecondaryButton onClick={handleConnectUsb} disabled={connecting}>
                      {connecting
                        ? "Emparejando…"
                        : usbDetectada
                          ? "Reconectar impresora"
                          : "Conectar impresora USB"}
                    </SecondaryButton>
                    <SecondaryButton onClick={handleTestUsb} disabled={testing}>
                      {testing ? "Probando…" : "Probar conexión"}
                    </SecondaryButton>
                    <SecondaryButton onClick={handleReleaseUsb}>Liberar</SecondaryButton>
                  </div>
                </div>
                <p className="text-[11px] leading-relaxed text-zinc-500">
                  En este modo la tirilla sale como ESC/POS crudo y <strong>no hay repliegue al
                  diálogo del navegador</strong>: si el USB se cae, el POS avisa y deja reintentar
                  en vez de abrir el PDF genérico. En Windows la impresora necesita el driver
                  WinUSB (Zadig) para que el navegador pueda reclamar su interfaz.
                </p>
              </>
            ) : (
              <p className="text-xs text-amber-300/80">
                Este navegador no soporta WebUSB. Usa Chrome o Edge sobre HTTPS, o cambia al
                “Puente de impresión local”.
              </p>
            )}
          </div>
        )}

        {settings.connection === "bridge" && (
          <div className="space-y-3 rounded-lg border border-zinc-800 bg-black/30 p-4">
            <TextField
              id="printer-bridge"
              label="URL del puente de impresión"
              value={settings.bridgeUrl}
              onChange={(v) => onPatch({ bridgeUrl: v })}
              placeholder={DEFAULT_BRIDGE_URL}
              hint="Servicio en el propio equipo que recibe los bytes ESC/POS por POST y los vuelca en la impresora."
            />
            <p className="text-[11px] leading-relaxed text-zinc-500">
              Evita por completo los permisos de WebUSB: útil cuando la All-in-One no deja
              liberar la interfaz USB. El puente recibe los bytes ESC/POS por POST
              (<code>application/octet-stream</code>) y debe responder con las cabeceras CORS
              del origen de la app; si la app va por HTTPS, además{" "}
              <code>Access-Control-Allow-Private-Network: true</code>.
            </p>
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

        {/* Guardado explícito en Supabase (además del auto-guardado con debounce). */}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <p className="mr-auto text-[11px] text-zinc-600">
            Los cambios se guardan solos, pero puedes forzar el guardado aquí.
          </p>
          <PrimaryButton onClick={handleSaveTirilla} disabled={savingTirilla}>
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
              <path d="M17 21v-8H7v8" />
              <path d="M7 3v5h8" />
            </svg>
            {savingTirilla ? "Guardando…" : "Guardar Tirilla"}
          </PrimaryButton>
        </div>
      </div>

      {/* ── Vista previa + prueba ───────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-violet-300/80">
              Vista previa de la tirilla
            </h4>
            <p className="mt-0.5 text-[11px] text-zinc-600">
              Con una venta de ejemplo. La prueba sale por el método elegido arriba, igual que
              una venta real.
            </p>
          </div>
          <PrimaryButton onClick={handleTestPrint} disabled={printing}>
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9V2h12v7" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <path d="M6 14h12v8H6z" />
            </svg>
            {printing ? "Enviando…" : "Imprimir prueba"}
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
