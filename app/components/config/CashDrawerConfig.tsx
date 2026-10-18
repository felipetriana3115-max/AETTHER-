"use client";

import { useState } from "react";
import { useDashboard } from "../DashboardProvider";
import { loadDeviceSettings, type DrawerSettings, type DrawerTrigger } from "../../lib/devices";
import { openCashDrawer } from "../../lib/receipt";
import { SecondaryButton, SelectField, ToggleRow } from "./primitives";

type Props = {
  settings: DrawerSettings;
  onPatch: (changes: Partial<DrawerSettings>) => void;
};

export default function CashDrawerConfig({ settings, onPatch }: Props) {
  const { showToast } = useDashboard();
  const [probando, setProbando] = useState(false);

  // Apertura REAL de prueba: manda el pulso `ESC p m 50 250` por el mismo canal
  // que usará el POS (USB directo, puente local o impresora del sistema), para
  // que el cajero compruebe el cajón sin tener que cobrar una venta.
  const handleTest = async () => {
    if (settings.trigger !== "printer") {
      showToast("Cajón manual", "El cajón está en modo manual: ábrelo con la llave física.");
      return;
    }
    setProbando(true);
    try {
      const { printer } = loadDeviceSettings();
      const result = await openCashDrawer(settings.pin, printer);
      if (result.ok) {
        showToast(
          "Pulso enviado",
          result.via === "usb"
            ? `Pulso ESC/POS (pin ${settings.pin}) enviado por USB directo.`
            : result.via === "bridge"
              ? `Pulso ESC/POS (pin ${settings.pin}) enviado al puente local.`
              : `Pulso ESC/POS (pin ${settings.pin}) enviado a la impresora del sistema.`,
        );
      } else {
        showToast("El cajón no respondió", result.message);
      }
    } finally {
      setProbando(false);
    }
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

      <div className="flex items-center justify-end gap-3">
        <p className="mr-auto text-[11px] text-zinc-600">
          La prueba envía el pulso por el método configurado en Impresora.
        </p>
        <SecondaryButton onClick={handleTest} disabled={probando}>
          {probando ? "Enviando pulso…" : "Probar apertura"}
        </SecondaryButton>
      </div>
    </div>
  );
}
