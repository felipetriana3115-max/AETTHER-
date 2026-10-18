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
export type PrinterConnection = "browser" | "usb" | "bridge";
export type ScannerMode = "hid" | "serial";
export type ScanSuffix = "enter" | "tab" | "none";
export type DrawerTrigger = "printer" | "manual";
export type ScaleConnection = "serial" | "manual";
export type WeightUnit = "kg" | "g" | "lb";

/** Impresora térmica + personalización de la tirilla de venta. */
export type PrinterSettings = {
  enabled: boolean;
  /**
   * `browser` usa el diálogo nativo de impresión; `usb` envía ESC/POS crudo por
   * WebUSB; `bridge` lo envía por HTTP a un puente local (`bridgeUrl`).
   */
  connection: PrinterConnection;
  /** Etiqueta de la última impresora USB emparejada (solo informativa). */
  deviceLabel: string;
  /** Endpoint del puente de impresión local (solo en `connection: "bridge"`). */
  bridgeUrl: string;
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

/** Puerto clásico de impresión cruda; el puente local escucha ahí por defecto. */
export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:9100/print";

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  printer: {
    enabled: false,
    connection: "browser",
    deviceLabel: "",
    bridgeUrl: DEFAULT_BRIDGE_URL,
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
 * proyecto). Solo declaramos lo que usamos: emparejar la impresora, reclamar su
 * interfaz y escribir bytes crudos en su endpoint bulk OUT.
 */
type UsbEndpoint = { endpointNumber: number; direction: "in" | "out"; type: string };
type UsbAlternate = { interfaceClass: number; endpoints: UsbEndpoint[] };
type UsbInterface = { interfaceNumber: number; alternate: UsbAlternate };
type UsbConfiguration = { configurationValue: number; interfaces: UsbInterface[] };
type UsbOutResult = { status: "ok" | "stall" | "babble"; bytesWritten?: number };
type UsbDevice = {
  productName?: string;
  manufacturerName?: string;
  opened: boolean;
  configuration: UsbConfiguration | null;
  configurations: UsbConfiguration[];
  open: () => Promise<void>;
  close: () => Promise<void>;
  selectConfiguration: (value: number) => Promise<void>;
  claimInterface: (n: number) => Promise<void>;
  releaseInterface: (n: number) => Promise<void>;
  clearHalt: (direction: "in" | "out", endpointNumber: number) => Promise<void>;
  transferOut: (endpointNumber: number, data: BufferSource) => Promise<UsbOutResult>;
};
type UsbNavigator = Navigator & {
  usb?: {
    requestDevice: (opts: { filters: unknown[] }) => Promise<UsbDevice>;
    getDevices?: () => Promise<UsbDevice[]>;
    addEventListener?: (type: string, listener: () => void) => void;
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

/** Solicita un puerto serial (báscula / lector serial) y confirma el emparejado. */
export async function requestSerialPort(): Promise<void> {
  const nav = navigator as SerialNavigator;
  if (!nav.serial) throw new Error("Web Serial no está disponible en este navegador.");
  await nav.serial.requestPort();
}

/**
 * Bytes de un trabajo ESC/POS. El parámetro de `Uint8Array` es explícito porque
 * tanto `transferOut` (WebUSB) como `fetch` exigen una vista sobre un
 * `ArrayBuffer` propio, nunca sobre un `SharedArrayBuffer`.
 */
export type EscPosBytes = Uint8Array<ArrayBuffer>;

/**
 * Comando ESC/POS para accionar el pulso del cajón de dinero:
 * `ESC p m t1 t2` → 0x1B 0x70 m t1 t2. `m` selecciona el pin (0 → pin 2,
 * 1 → pin 5); t1/t2 son la duración del pulso en unidades de 2 ms.
 *
 * t1 = 0x32 (50 → 100 ms de pulso): las All-in-One con solenoide de 24 V no
 * siempre destraban con los 50 ms del valor anterior.
 */
export function drawerKickBytes(pin: 0 | 1): EscPosBytes {
  return new Uint8Array([0x1b, 0x70, pin, 0x32, 0xfa]);
}

/**
 * El mismo pulso como cadena de caracteres, para colarlo dentro de un trabajo de
 * impresión del navegador (`String.fromCharCode(27, 112, pin, 50, 250)`).
 *
 * OJO: este camino solo dispara el cajón si la impresora está instalada en el
 * sistema con un driver de paso directo ("Generic / Text Only"): entonces los
 * caracteres llegan tal cual al firmware y este los interpreta como ESC/POS. Con
 * el driver gráfico de la POS-80C el documento se rasteriza y la secuencia se
 * pierde; para ese caso está `kickDrawerViaUsb`, que escribe los bytes crudos.
 */
export function drawerKickString(pin: 0 | 1): string {
  return String.fromCharCode(0x1b, 0x70, pin, 0x32, 0xfa);
}

// ── Driver WebUSB de la impresora ────────────────────────────────────────────

/** Clase USB "Printer" (bInterfaceClass = 7). */
const USB_PRINTER_CLASS = 0x07;
/** Clase "Vendor specific": la declaran muchas térmicas integradas (GP-L80160). */
const USB_VENDOR_CLASS = 0xff;
/** Tamaño de bloque de escritura: los endpoints bulk se atragantan con más. */
const USB_CHUNK = 4096;

/** Por qué no se pudo imprimir por USB; el llamador lo traduce a un aviso. */
export type UsbPrinterFailure = "unsupported" | "no-device" | "no-endpoint" | "claim" | "transfer";

/** Error del driver USB con la causa ya clasificada (nunca cae a `window.print`). */
export class UsbPrinterError extends Error {
  readonly kind: UsbPrinterFailure;

  constructor(kind: UsbPrinterFailure, message: string) {
    super(message);
    this.name = "UsbPrinterError";
    this.kind = kind;
  }
}

/** Impresora reclamada y lista para recibir bytes. */
type PrinterLink = {
  device: UsbDevice;
  interfaceNumber: number;
  endpointNumber: number;
};

/**
 * Conexión viva con la impresora. Se mantiene reclamada entre trabajos: en las
 * terminales All-in-One, soltar y volver a reclamar la interfaz en cada venta es
 * justo lo que hacía perder el claim y abortar la impresión.
 */
let link: PrinterLink | null = null;
/** Reconexión en vuelo: evita que dos ventas simultáneas abran dos veces. */
let linking: Promise<PrinterLink> | null = null;
let eventsBound = false;

function usbNavigator(): UsbNavigator["usb"] | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as UsbNavigator).usb ?? null;
}

/** Invalida la conexión cacheada cuando el sistema desconecta el dispositivo. */
function bindUsbEvents(): void {
  const usb = usbNavigator();
  if (eventsBound || !usb?.addEventListener) return;
  eventsBound = true;
  usb.addEventListener("disconnect", () => {
    link = null;
  });
  usb.addEventListener("connect", () => {
    link = null;
  });
}

/**
 * Busca la interfaz imprimible y su endpoint bulk OUT. Prioriza la clase 7
 * (impresora), pero acepta también la clase "vendor specific": las térmicas
 * integradas de las All-in-One suelen presentarse así, y exigir la clase 7 era
 * una de las razones por las que la plataforma "no encontraba" la impresora.
 */
function findPrinterEndpoint(device: UsbDevice) {
  const match = (wanted: number) => {
    for (const cfg of device.configurations ?? []) {
      for (const itf of cfg.interfaces ?? []) {
        if (itf.alternate?.interfaceClass !== wanted) continue;
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
  };
  return match(USB_PRINTER_CLASS) ?? match(USB_VENDOR_CLASS);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reclama la interfaz con reintentos: tras un trabajo anterior (o al despertar
 * la pantalla) el sistema puede tenerla tomada unos cientos de milisegundos.
 */
async function claimWithRetry(device: UsbDevice, interfaceNumber: number): Promise<void> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await device.claimInterface(interfaceNumber);
      return;
    } catch (e) {
      last = e;
      await wait(150 * (attempt + 1));
    }
  }
  const detail = last instanceof Error ? last.message : String(last);
  throw new UsbPrinterError(
    "claim",
    `El sistema no soltó la interfaz USB de la impresora (${detail}). Cierra la cola de impresión de Windows o vuelve a conectar el cable.`,
  );
}

/** Abre, configura y reclama la primera impresora autorizada que sirva. */
async function openLink(): Promise<PrinterLink> {
  const usb = usbNavigator();
  if (!usb?.getDevices) {
    throw new UsbPrinterError(
      "unsupported",
      "Este navegador no expone WebUSB. Usa Chrome o Edge sobre HTTPS, o el puente de impresión local.",
    );
  }
  bindUsbEvents();

  const devices = await usb.getDevices();
  if (!devices.length) {
    throw new UsbPrinterError(
      "no-device",
      "No hay ninguna impresora USB autorizada en este equipo. Abre Configuración → Dispositivos → Impresora y pulsa “Conectar impresora USB”.",
    );
  }

  let last: unknown = null;
  for (const device of devices) {
    const target = findPrinterEndpoint(device);
    if (!target) continue;
    try {
      if (!device.opened) await device.open();
      if (device.configuration?.configurationValue !== target.configurationValue) {
        await device.selectConfiguration(target.configurationValue);
      }
      await claimWithRetry(device, target.interfaceNumber);
      return {
        device,
        interfaceNumber: target.interfaceNumber,
        endpointNumber: target.endpointNumber,
      };
    } catch (e) {
      last = e;
      console.warn("[impresora USB] No se pudo reclamar el dispositivo:", e);
    }
  }

  if (last instanceof UsbPrinterError) throw last;
  if (last) {
    const detail = last instanceof Error ? last.message : String(last);
    throw new UsbPrinterError("claim", `No se pudo abrir la impresora USB (${detail}).`);
  }
  throw new UsbPrinterError(
    "no-endpoint",
    "La impresora autorizada no expone un endpoint de impresión. En Windows necesita el driver WinUSB (Zadig) para hablar por WebUSB.",
  );
}

/** Conexión viva, abriéndola si hace falta (una sola a la vez). */
async function ensureLink(): Promise<PrinterLink> {
  if (link) return link;
  if (!linking) {
    linking = openLink()
      .then((l) => {
        link = l;
        return l;
      })
      .finally(() => {
        linking = null;
      });
  }
  return linking;
}

/** Suelta la conexión cacheada (tras un fallo, o al volver al modo navegador). */
export async function releaseUsbPrinter(): Promise<void> {
  const current = link;
  link = null;
  if (!current) return;
  try {
    await current.device.releaseInterface(current.interfaceNumber);
  } catch {
    // El dispositivo ya pudo desaparecer; nada que soltar.
  }
  try {
    if (current.device.opened) await current.device.close();
  } catch {
    // Idem.
  }
}

/** Escribe el trabajo en bloques, reintentando una vez si el endpoint se atasca. */
async function transferAll(current: PrinterLink, payload: EscPosBytes): Promise<void> {
  for (let offset = 0; offset < payload.length; offset += USB_CHUNK) {
    const chunk = payload.subarray(offset, offset + USB_CHUNK);
    let result = await current.device.transferOut(current.endpointNumber, chunk);
    if (result.status === "stall") {
      // Endpoint atascado: se limpia el halt y se reenvía el mismo bloque.
      await current.device.clearHalt("out", current.endpointNumber);
      result = await current.device.transferOut(current.endpointNumber, chunk);
    }
    if (result.status !== "ok") {
      throw new UsbPrinterError(
        "transfer",
        `La impresora rechazó los datos (estado "${result.status}").`,
      );
    }
  }
}

/**
 * Envía bytes ESC/POS crudos a la impresora emparejada.
 *
 * Si el `transferOut` falla (claim perdido, suspensión del hub USB de la
 * All-in-One…) NO se cae al diálogo del navegador: se suelta la conexión, se
 * reconecta y se reintenta UNA vez. Si tampoco así, lanza `UsbPrinterError`
 * para que la interfaz pida reconectar el USB.
 */
export async function writeToUsbPrinter(payload: EscPosBytes): Promise<void> {
  let current = await ensureLink();
  try {
    await transferAll(current, payload);
    return;
  } catch (first) {
    console.warn("[impresora USB] Fallo de escritura; reconectando:", first);
    await releaseUsbPrinter();
  }

  // Segundo (y último) intento con una conexión nueva.
  current = await ensureLink();
  try {
    await transferAll(current, payload);
  } catch (second) {
    await releaseUsbPrinter();
    if (second instanceof UsbPrinterError) throw second;
    const detail = second instanceof Error ? second.message : String(second);
    throw new UsbPrinterError("transfer", `No se pudo escribir en la impresora USB (${detail}).`);
  }
}

/** Etiqueta legible del dispositivo, o `null` si no hay ninguno autorizado. */
export async function describeUsbPrinter(): Promise<string | null> {
  const usb = usbNavigator();
  if (!usb?.getDevices) return null;
  try {
    const devices = await usb.getDevices();
    const device = devices.find((d) => findPrinterEndpoint(d)) ?? devices[0];
    if (!device) return null;
    return (
      [device.manufacturerName, device.productName].filter(Boolean).join(" ") || "Impresora USB"
    );
  } catch {
    return null;
  }
}

/** Resultado del emparejado: `ready` es falso si el dispositivo no sabe imprimir. */
export type UsbPairing = { label: string; ready: boolean };

/**
 * Abre el diálogo del navegador para emparejar (autorizar) una impresora USB y
 * deja la conexión lista para imprimir.
 *
 * Los filtros van vacíos a propósito: las térmicas integradas de las All-in-One
 * declaran VID/PID propios y clases no estándar, así que filtrar por clase 7
 * dejaba el diálogo en blanco. Tras elegir se comprueba que haya endpoint de
 * salida y se reporta en `ready`.
 */
export async function requestUsbPrinter(): Promise<UsbPairing> {
  const usb = usbNavigator();
  if (!usb) throw new Error("WebUSB no está disponible en este navegador.");
  const device = await usb.requestDevice({ filters: [] });
  bindUsbEvents();

  const label =
    [device.manufacturerName, device.productName].filter(Boolean).join(" ") || "Impresora USB";
  if (!findPrinterEndpoint(device)) return { label, ready: false };

  // Conectamos ya para que la primera venta no pague el coste del claim.
  await releaseUsbPrinter();
  try {
    await ensureLink();
    return { label, ready: true };
  } catch {
    return { label, ready: false };
  }
}

/**
 * Envía el pulso ESC/POS por WebUSB a una impresora YA emparejada.
 *
 * Devuelve `true` si el pulso salió; `false` si no hay WebUSB, no hay impresora
 * emparejada o el navegador no pudo reclamar la interfaz. `release` (por defecto
 * `true`) suelta la interfaz al terminar: es lo correcto en modo "navegador",
 * donde la impresión la hace el driver del sistema y necesita el dispositivo
 * libre. En modo USB directo el llamador pasa `release: false` para conservar la
 * conexión entre tirillas.
 */
export async function kickDrawerViaUsb(
  pin: 0 | 1,
  opts: { release?: boolean } = {},
): Promise<boolean> {
  const { release = true } = opts;
  try {
    await writeToUsbPrinter(drawerKickBytes(pin));
    return true;
  } catch (e) {
    console.warn("[cajón] No se pudo enviar el pulso por WebUSB:", e);
    return false;
  } finally {
    if (release) await releaseUsbPrinter();
  }
}
