"use client";

import { useDashboard } from "../DashboardProvider";
import {
  isWebSerialSupported,
  requestSerialPort,
  type ScannerMode,
  type ScannerSettings,
  type ScanSuffix,
} from "../../lib/devices";
import { SecondaryButton, SelectField, TextField, ToggleRow } from "./primitives";

type Props = {
  settings: ScannerSettings;
  onPatch: (changes: Partial<ScannerSettings>) => void;
};

export default function ScannerConfig({ settings, onPatch }: Props) {
  const { showToast } = useDashboard();
  const serialSupported = isWebSerialSupported();

  const handleConnectSerial = async () => {
    try {
      await requestSerialPort();
      showToast("Lector emparejado", "El puerto serial quedó autorizado para este navegador.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "No se pudo abrir el puerto serial.";
      if (!/cancel|no port selected|user gesture/i.test(msg)) showToast("Sin conexión", msg);
    }
  };

  return (
    <div className="space-y-6">
      <ToggleRow
        label="Lector activo"
        description="La mayoría de lectores funcionan como teclado (HID): escriben el código y pulsan Enter."
        checked={settings.enabled}
        onChange={(v) => onPatch({ enabled: v })}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField<ScannerMode>
          id="scanner-mode"
          label="Modo de entrada"
          value={settings.mode}
          onChange={(v) => onPatch({ mode: v })}
          options={[
            { value: "hid", label: "Teclado HID (plug & play)" },
            { value: "serial", label: "Serial / Web Serial" },
          ]}
        />
        <SelectField<ScanSuffix>
          id="scanner-suffix"
          label="Sufijo del lector"
          value={settings.suffix}
          onChange={(v) => onPatch({ suffix: v })}
          options={[
            { value: "enter", label: "Enter (recomendado)" },
            { value: "tab", label: "Tab" },
            { value: "none", label: "Ninguno" },
          ]}
          hint="Carácter con el que el lector cierra cada código."
        />
        <TextField
          id="scanner-minlen"
          label="Longitud mínima del código"
          value={String(settings.minLength)}
          onChange={(v) => onPatch({ minLength: Math.max(1, Number(v.replace(/\D/g, "")) || 1) })}
          type="number"
          inputMode="numeric"
        />
      </div>

      <div className="space-y-4 border-t border-zinc-800 pt-5">
        <ToggleRow
          label="Añadir al carrito automáticamente"
          description="Al escanear un producto existente se agrega sin confirmar."
          checked={settings.autoAdd}
          onChange={(v) => onPatch({ autoAdd: v })}
        />
        <ToggleRow
          label="Sonido al escanear"
          description="Pitido corto de confirmación por cada lectura válida."
          checked={settings.beep}
          onChange={(v) => onPatch({ beep: v })}
        />
      </div>

      {settings.mode === "serial" && (
        <div className="rounded-lg border border-zinc-800 bg-black/30 p-4">
          {serialSupported ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-zinc-400">Autoriza el puerto serial del lector para este navegador.</p>
              <SecondaryButton onClick={handleConnectSerial}>Emparejar puerto serial</SecondaryButton>
            </div>
          ) : (
            <p className="text-xs text-amber-300/80">
              Este navegador no soporta Web Serial. Usa el modo “Teclado HID”, compatible con casi
              cualquier lector.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
