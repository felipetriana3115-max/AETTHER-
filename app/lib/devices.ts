"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Configuración de los dispositivos de caja (POS): impresora de tickets, lector
 * de códigos, cajón de dinero y báscula.
 *
 * Es configuración LOCAL a cada máquina (qué impresora hay conectada, ancho de
 * papel, puerto serial de la báscula…), por eso vive en `localStorage` y no en
 * Supabase, y por eso el logout NO la borra (ver `clearSession`): pertenece al
 * equipo, no al usuario ni al tenant.
 *
 * OJO: la IDENTIDAD del recibo (NIT, dirección, teléfono, logo, mensaje) NO va
 * aquí — pertenece al negocio, así que se guarda por tenant en `empresas` (ver
 * `tirilla.ts`). Mezclarla en este blob la borraba al cerrar sesión y la filtraba
 * entre tenants del mismo equipo.
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

/** Clave del hardware de la caja (por equipo). El logout la PRESERVA a propósito
 *  (ver `clearSession`/`purgeDashboardCache` en auth.ts). */
export const DEVICES_KEY = "mi-dashboard-erp:devices:v1";

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

/**
 * Tipos estructurales mínimos de WebUSB (no hay `@types/w3c-web-usb` en el
 * proyecto). Solo declaramos lo que usamos: emparejar la impresora y escribir
 * bytes crudos en su endpoint bulk OUT para el pulso del cajón.
 */
type UsbEndpoint = { endpointNumber: number; direction: "in" | "out"; type: string };
type UsbAlternate = { interfaceClass: number; endpoints: UsbEndpoint[] };
type UsbInterface = { interfaceNumber: number; alternate: UsbAlternate };
type UsbConfiguration = { configurationValue: number; interfaces: UsbInterface[] };
type UsbDevice = {
  productName?: string;
  manufacturerName?: string;
  opened: boolean;
  configuration: UsbConfiguration | null;
  configurations: UsbConfiguration[];
  open: () => Promise<void>;
  selectConfiguration: (value: number) => Promise<void>;
  claimInterface: (n: number) => Promise<void>;
  releaseInterface: (n: number) => Promise<void>;
  transferOut: (endpointNumber: number, data: ArrayBufferView) => Promise<{ status: string }>;
};
type UsbNavigator = Navigator & {
  usb?: {
    requestDevice: (opts: { filters: unknown[] }) => Promise<UsbDevice>;
    getDevices?: () => Promise<UsbDevice[]>;
  };
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

/**
 * El mismo pulso como cadena de caracteres, para colarlo dentro de un trabajo de
 * impresión del navegador (`String.fromCharCode(27, 112, pin, 25, 250)`).
 *
 * OJO: este camino solo dispara el cajón si la impresora está instalada en el
 * sistema con un driver de paso directo ("Generic / Text Only"): entonces los
 * caracteres llegan tal cual al firmware y este los interpreta como ESC/POS. Con
 * el driver gráfico de la POS-80C el documento se rasteriza y la secuencia se
 * pierde; para ese caso está `kickDrawerViaUsb`, que escribe los bytes crudos.
 */
export function drawerKickString(pin: 0 | 1): string {
  return String.fromCharCode(0x1b, 0x70, pin, 0x19, 0xfa);
}

/** Clase USB "Printer" (bInterfaceClass = 7). */
const USB_PRINTER_CLASS = 0x07;

/** Busca en el dispositivo la interfaz de impresora y su endpoint bulk OUT. */
function findPrinterEndpoint(device: UsbDevice) {
  for (const cfg of device.configurations ?? []) {
    for (const itf of cfg.interfaces ?? []) {
      if (itf.alternate?.interfaceClass !== USB_PRINTER_CLASS) continue;
      const out = itf.alternate.endpoints?.find((e) => e.direction === "out" && e.type === "bulk");
      if (out) {
        return {
          configurationValue: cfg.configurationValue,
          interfaceNumber: itf.interfaceNumber,
          endpointNumber: out.endpointNumber,
        };
      }
    }
  }
  return null;
}

/**
 * Envía el pulso ESC/POS por WebUSB a una impresora YA emparejada (la que se
 * autorizó en Configuración → Dispositivos → Impresora). Es la vía fiable: los
 * bytes llegan al firmware sin pasar por el driver del sistema.
 *
 * Devuelve `true` si el pulso salió; `false` si no hay WebUSB, no hay impresora
 * emparejada o el navegador no pudo reclamar la interfaz (p. ej. Windows tiene
 * el dispositivo tomado por su propio driver) — en ese caso el llamador cae al
 * camino de impresión.
 */
export async function kickDrawerViaUsb(pin: 0 | 1): Promise<boolean> {
  const nav = typeof navigator !== "undefined" ? (navigator as UsbNavigator) : null;
  if (!nav?.usb?.getDevices) return false;

  let devices: UsbDevice[];
  try {
    devices = await nav.usb.getDevices();
  } catch {
    return false;
  }

  for (const device of devices) {
    const target = findPrinterEndpoint(device);
    if (!target) continue;
    try {
      if (!device.opened) await device.open();
      if (device.configuration?.configurationValue !== target.configurationValue) {
        await device.selectConfiguration(target.configurationValue);
      }
      await device.claimInterface(target.interfaceNumber);
      try {
        await device.transferOut(target.endpointNumber, drawerKickBytes(pin));
      } finally {
        // Liberamos la interfaz para no bloquear la impresión normal del sistema.
        await device.releaseInterface(target.interfaceNumber).catch(() => {});
      }
      return true;
    } catch (e) {
      console.warn("[cajón] No se pudo enviar el pulso por WebUSB:", e);
    }
  }
  return false;
}
