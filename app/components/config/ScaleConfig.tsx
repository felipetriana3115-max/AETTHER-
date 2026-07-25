"use client";

import { useDashboard } from "../DashboardProvider";
import {
  isWebSerialSupported,
  requestSerialPort,
  type ScaleConnection,
  type ScaleSettings,
  type WeightUnit,
} from "../../lib/devices";
import { SecondaryButton, SelectField, TextField, ToggleRow } from "./primitives";

type Props = {
  settings: ScaleSettings;
  onPatch: (changes: Partial<ScaleSettings>) => void;
};

export default function ScaleConfig({ settings, onPatch }: Props) {
  const { showToast } = useDashboard();
  const serialSupported = isWebSerialSupported();

  const handleConnectSerial = async () => {
    try {
      await requestSerialPort();
      showToast("Báscula emparejada", "El puerto serial quedó autorizado para este navegador.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "No se pudo abrir el puerto serial.";
      if (!/cancel|no port selected|user gesture/i.test(msg)) showToast("Sin conexión", msg);
    }
  };

  return (
    <div className="space-y-6">
      <ToggleRow
        label="Báscula activa"
        description="Para productos vendidos por peso. Puede leerse por puerto serial o ingresarse a mano."
        checked={settings.enabled}
        onChange={(v) => onPatch({ enabled: v })}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField<ScaleConnection>
          id="scale-connection"
          label="Conexión"
          value={settings.connection}
          onChange={(v) => onPatch({ connection: v })}
          options={[
            { value: "manual", label: "Manual (ingresar peso)" },
            { value: "serial", label: "Serial / Web Serial" },
          ]}
        />
        <SelectField<WeightUnit>
          id="scale-unit"
          label="Unidad"
          value={settings.unit}
          onChange={(v) => onPatch({ unit: v })}
          options={[
            { value: "kg", label: "Kilogramos (kg)" },
            { value: "g", label: "Gramos (g)" },
            { value: "lb", label: "Libras (lb)" },
          ]}
        />
        <SelectField<number>
          id="scale-baud"
          label="Velocidad (baudios)"
          value={settings.baudRate}
          onChange={(v) => onPatch({ baudRate: v })}
          options={[
            { value: 9600, label: "9600" },
            { value: 19200, label: "19200" },
            { value: 38400, label: "38400" },
            { value: 115200, label: "115200" },
          ]}
          disabled={settings.connection !== "serial"}
        />
        <TextField
          id="scale-factor"
          label="Factor de conversión"
          value={String(settings.factor)}
          onChange={(v) => {
            const n = Number(v.replace(/[^\d.]/g, ""));
            onPatch({ factor: Number.isFinite(n) && n > 0 ? n : 1 });
          }}
          type="number"
          inputMode="numeric"
          hint="Multiplicador aplicado a la lectura cruda (déjalo en 1 si la báscula ya entrega la unidad)."
        />
      </div>

      <div className="border-t border-zinc-800 pt-5">
        <ToggleRow
          label="Solo lecturas estables"
          description="Ignora el peso hasta que la báscula lo marque como estable."
          checked={settings.stableOnly}
          onChange={(v) => onPatch({ stableOnly: v })}
          disabled={settings.connection !== "serial"}
        />
      </div>

      {settings.connection === "serial" && (
        <div className="rounded-lg border border-zinc-800 bg-black/30 p-4">
          {serialSupported ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-zinc-400">Autoriza el puerto serial de la báscula para este navegador.</p>
              <SecondaryButton onClick={handleConnectSerial}>Emparejar puerto serial</SecondaryButton>
            </div>
          ) : (
            <p className="text-xs text-amber-300/80">
              Este navegador no soporta Web Serial. Usa el modo “Manual” para ingresar el peso a mano.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
