"use client";

import { useDashboard } from "../DashboardProvider";
import type { DrawerSettings, DrawerTrigger } from "../../lib/devices";
import { SecondaryButton, SelectField, ToggleRow } from "./primitives";

type Props = {
  settings: DrawerSettings;
  onPatch: (changes: Partial<DrawerSettings>) => void;
};

export default function CashDrawerConfig({ settings, onPatch }: Props) {
  const { showToast } = useDashboard();

  // El cajón se abre con un pulso ESC/POS que envía la impresora. Sin una
  // impresora USB conectada por WebUSB no podemos emitirlo desde el navegador,
  // así que la "prueba" solo confirma la configuración.
  const handleTest = () => {
    showToast(
      "Apertura de prueba",
      settings.trigger === "printer"
        ? `Se enviará el pulso ESC/POS (pin ${settings.pin}) por la impresora al cobrar.`
        : "El cajón está en modo manual: ábrelo con la llave física.",
    );
  };

  return (
    <div className="space-y-6">
      <ToggleRow
        label="Cajón activo"
        description="El cajón de dinero se acciona normalmente mediante un pulso de la impresora de tickets."
        checked={settings.enabled}
        onChange={(v) => onPatch({ enabled: v })}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField<DrawerTrigger>
          id="drawer-trigger"
          label="Accionamiento"
          value={settings.trigger}
          onChange={(v) => onPatch({ trigger: v })}
          options={[
            { value: "printer", label: "Pulso por impresora (ESC/POS)" },
            { value: "manual", label: "Manual (llave física)" },
          ]}
        />
        <SelectField<number>
          id="drawer-pin"
          label="Pin del conector (RJ11)"
          value={settings.pin}
          onChange={(v) => onPatch({ pin: (v === 1 ? 1 : 0) as 0 | 1 })}
          options={[
            { value: 0, label: "Pin 2 (m = 0)" },
            { value: 1, label: "Pin 5 (m = 1)" },
          ]}
          disabled={settings.trigger !== "printer"}
        />
      </div>

      <div className="space-y-4 border-t border-zinc-800 pt-5">
        <ToggleRow
          label="Abrir al cobrar en efectivo"
          description="Abre el cajón automáticamente cuando el método de pago es Efectivo."
          checked={settings.autoOpenOnCash}
          onChange={(v) => onPatch({ autoOpenOnCash: v })}
          disabled={settings.trigger !== "printer"}
        />
        <ToggleRow
          label="Abrir en cualquier método de pago"
          description="Incluye Nequi/Daviplata y Bold, no solo efectivo."
          checked={settings.autoOpenAllMethods}
          onChange={(v) => onPatch({ autoOpenAllMethods: v })}
          disabled={settings.trigger !== "printer"}
        />
      </div>

      <div className="flex justify-end">
        <SecondaryButton onClick={handleTest}>Probar apertura</SecondaryButton>
      </div>
    </div>
  );
}
