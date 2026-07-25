"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Configuración de los dispositivos de caja (POS): impresora de tickets, lector
 * de códigos, cajón de dinero y báscula.
 *
 * Es configuración LOCAL a cada máquina (qué impresora hay conectada, ancho de
 * papel, puerto serial de la báscula…), por eso vive en `localStorage` y no en
 * Supabase — igual que `businessName` (ver DashboardProvider). Los datos de
 * identidad del recibo (NIT, dirección, logo, mensaje) también se guardan aquí
 * porque la tabla `empresas` solo tiene `nit` y añadir columnas exigiría una
 * migración; este enfoque mantiene el alcance acotado y consistente con el resto
 * de preferencias del cliente.
 */

// ── Tipos ──────────────────────────────────────────────────────────────────

export type PaperWidth = "58mm" | "80mm";
export type PrinterConnection = "browser" | "usb";
export type ScannerMode = "hid" | "serial";
export type ScanSuffix = "enter" | "tab" | "none";
export type DrawerTrigger = "printer" | "manual";
export type ScaleConnection = "serial" | "manual";
export type WeightUnit = "kg" | "g" | "lb";

/** Impresora térmica + personalización de la tirilla de venta. */
export type PrinterSettings = {
  enabled: boolean;
  /** `browser` usa el diálogo nativo de impresión; `usb` conecta por WebUSB. */
  connection: PrinterConnection;
  /** Etiqueta de la última impresora USB emparejada (solo informativa). */
  deviceLabel: string;
  paperWidth: PaperWidth;
  /** Ancho útil en caracteres (32 típico en 58mm, 48 en 80mm). */
  columns: number;
  fontFamily: string;
  fontSize: number;
  /** Imprime la tirilla automáticamente al cobrar en el POS. */
  autoPrint: boolean;
  // Identidad del recibo
  logoDataUrl: string;
  nit: string;
  direccion: string;
  telefono: string;
  mensajeAgradecimiento: string;
};

/** Lector de códigos de barras (por defecto teclado HID / "keyboard wedge"). */
export type ScannerSettings = {
  enabled: boolean;
  mode: ScannerMode;
  /** Carácter con el que el lector cierra cada código. */
  suffix: ScanSuffix;
  /** Longitud mínima para considerar válido un escaneo. */
  minLength: number;
  /** Pitido al escanear. */
  beep: boolean;
  /** Añade el producto al carrito automáticamente al escanear. */
  autoAdd: boolean;
};

/** Cajón de dinero — normalmente accionado por la impresora (pulso ESC/POS). */
export type DrawerSettings = {
  enabled: boolean;
  trigger: DrawerTrigger;
  /** Abrir automáticamente al cobrar en efectivo. */
  autoOpenOnCash: boolean;
  /** Abrir en cualquier método de pago (no solo efectivo). */
  autoOpenAllMethods: boolean;
  /** Pin del conector RJ11 del pulso ESC/POS (0 = pin 2, 1 = pin 5). */
  pin: 0 | 1;
};

/** Báscula — lectura por Web Serial o entrada manual del peso. */
export type ScaleSettings = {
  enabled: boolean;
  connection: ScaleConnection;
  unit: WeightUnit;
  baudRate: number;
  /** Factor multiplicador aplicado a la lectura cruda. */
  factor: number;
  /** Aceptar solo lecturas marcadas como estables por la báscula. */
  stableOnly: boolean;
};

export type DeviceSettings = {
  printer: PrinterSettings;
  scanner: ScannerSettings;
  drawer: DrawerSettings;
  scale: ScaleSettings;
};

// ── Valores por defecto ──────────────────────────────────────────────────────

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  printer: {
    enabled: false,
    connection: "browser",
    deviceLabel: "",
    paperWidth: "80mm",
    columns: 48,
    fontFamily: "'Courier New', ui-monospace, monospace",
    fontSize: 12,
    autoPrint: true,
    logoDataUrl: "",
    nit: "",
    direccion: "",
    telefono: "",
    mensajeAgradecimiento: "¡Gracias por tu compra!",
  },
  scanner: {
    enabled: true,
    mode: "hid",
    suffix: "enter",
    minLength: 3,
    beep: true,
    autoAdd: true,
  },
  drawer: {
    enabled: false,
    trigger: "printer",
    autoOpenOnCash: true,
    autoOpenAllMethods: false,
    pin: 0,
  },
  scale: {
    enabled: false,
    connection: "manual",
    unit: "kg",
    baudRate: 9600,
    factor: 1,
    stableOnly: true,
  },
};

// ── Persistencia (localStorage) ──────────────────────────────────────────────

const DEVICES_KEY = "mi-dashboard-erp:devices:v1";

/** Lee la configuración guardada, fusionándola con los valores por defecto. */
export function loadDeviceSettings(): DeviceSettings {
  if (typeof window === "undefined") return DEFAULT_DEVICE_SETTINGS;
  try {
    const raw = window.localStorage.getItem(DEVICES_KEY);
    if (!raw) return DEFAULT_DEVICE_SETTINGS;
    const saved = JSON.parse(raw) as Partial<DeviceSettings>;
    // Merge superficial por dispositivo: tolera versiones viejas sin campos nuevos.
    return {
      printer: { ...DEFAULT_DEVICE_SETTINGS.printer, ...saved.printer },
      scanner: { ...DEFAULT_DEVICE_SETTINGS.scanner, ...saved.scanner },
      drawer: { ...DEFAULT_DEVICE_SETTINGS.drawer, ...saved.drawer },
      scale: { ...DEFAULT_DEVICE_SETTINGS.scale, ...saved.scale },
    };
  } catch {
    return DEFAULT_DEVICE_SETTINGS;
  }
}

function saveDeviceSettings(settings: DeviceSettings): void {
  try {
    window.localStorage.setItem(DEVICES_KEY, JSON.stringify(settings));
  } catch {
    // Cuota excedida o modo privado → se ignora el guardado.
  }
}

/**
 * Hook con estado hidratado desde localStorage. Devuelve la configuración y un
 * `patch(device, cambios)` que actualiza un dispositivo sin pisar los demás.
 */
export function useDeviceSettings() {
  const [settings, setSettings] = useState<DeviceSettings>(DEFAULT_DEVICE_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setSettings(loadDeviceSettings());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveDeviceSettings(settings);
  }, [hydrated, settings]);

  const patch = useCallback(
    <K extends keyof DeviceSettings>(device: K, changes: Partial<DeviceSettings[K]>) => {
      setSettings((prev) => ({ ...prev, [device]: { ...prev[device], ...changes } }));
    },
    [],
  );

  return { settings, patch, hydrated };
}

// ── Helpers de hardware (Web APIs, con detección de soporte) ─────────────────

type UsbNavigator = Navigator & {
  usb?: { requestDevice: (opts: { filters: unknown[] }) => Promise<{ productName?: string; manufacturerName?: string }> };
};
type SerialNavigator = Navigator & {
  serial?: { requestPort: () => Promise<unknown> };
};

/** ¿El navegador expone WebUSB? (Chrome/Edge sobre HTTPS o localhost). */
export function isWebUsbSupported(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

/** ¿El navegador expone Web Serial? */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/**
 * Abre el diálogo del navegador para emparejar una impresora USB y devuelve una
 * etiqueta legible. No imprime por USB (eso exigiría ESC/POS crudo): la tirilla
 * se imprime siempre por el diálogo nativo, que funciona con la impresora ya
 * instalada en el sistema operativo.
 */
export async function requestUsbPrinter(): Promise<string> {
  const nav = navigator as UsbNavigator;
  if (!nav.usb) throw new Error("WebUSB no está disponible en este navegador.");
  const device = await nav.usb.requestDevice({ filters: [] });
  return [device.manufacturerName, device.productName].filter(Boolean).join(" ") || "Impresora USB";
}

/** Solicita un puerto serial (báscula / lector serial) y confirma el emparejado. */
export async function requestSerialPort(): Promise<void> {
  const nav = navigator as SerialNavigator;
  if (!nav.serial) throw new Error("Web Serial no está disponible en este navegador.");
  await nav.serial.requestPort();
}

/**
 * Comando ESC/POS para accionar el pulso del cajón de dinero:
 * `ESC p m t1 t2` → 0x1B 0x70 m t1 t2. `m` selecciona el pin (0 → pin 2,
 * 1 → pin 5); t1/t2 son la duración del pulso.
 */
export function drawerKickBytes(pin: 0 | 1): Uint8Array {
  return new Uint8Array([0x1b, 0x70, pin, 0x19, 0xfa]);
}
