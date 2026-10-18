"use client";

import { formatCOP } from "./data-model";
import {
  UsbPrinterError,
  drawerKickString,
  kickDrawerViaUsb,
  writeToUsbPrinter,
  type EscPosBytes,
  type PrinterConnection,
  type PrinterSettings,
} from "./devices";
import { buildDrawerKickJob, buildReceiptEscPos, twoColumns } from "./escpos";
import type { TirillaConfig } from "./tirilla";

/**
 * Lo que necesita la tirilla para imprimirse: el formato/hardware
 * (`PrinterSettings`) MÁS la identidad del negocio (`TirillaConfig`). El llamador
 * fusiona ambas fuentes (hardware desde localStorage, identidad desde Supabase).
 */
export type ReceiptPrinter = PrinterSettings & TirillaConfig;

/**
 * Generación e impresión de la tirilla térmica de venta. Hay tres caminos, según
 * `printer.connection`:
 *
 * - `browser`: diálogo nativo (`window.print`) sobre un iframe oculto. Funciona
 *   con cualquier impresora instalada en el sistema, pero el documento se
 *   rasteriza: el pulso del cajón solo sobrevive con driver de paso directo.
 * - `usb`: ESC/POS crudo por WebUSB (ver `escpos.ts` + `writeToUsbPrinter`). Es
 *   el camino de las All-in-One POS.
 * - `bridge`: los mismos bytes ESC/POS por HTTP a un puente local.
 *
 * IMPORTANTE: los modos `usb` y `bridge` NO caen a `window.print()` cuando algo
 * falla. Ese repliegue era justo el síntoma reportado en las All-in-One —abría
 * el PDF del navegador y se perdían la tirilla y el cajón—, así que ahora el
 * fallo se devuelve al llamador para que pida reconectar el USB.
 */

export type ReceiptItem = { nombre: string; qty: number; precio: number };
export type ReceiptPayment = { metodo: string; monto: number };

/**
 * Opciones de la impresión. `drawerPin` es de TRES estados:
 *
 * - `0` / `1`: abre el cajón por ese pin del RJ11 (0 → pin 2, 1 → pin 5).
 * - `null`: NO abrir el cajón (p. ej. al reimprimir una copia).
 * - ausente (`undefined`): decide `resolveDrawerPin` — toda orden de 80 mm /
 *   48 columnas lleva el pulso.
 */
export type PrintOptions = { drawerPin?: 0 | 1 | null };

/** Canal por el que salió (o debía salir) el trabajo de impresión. */
export type PrintChannel = PrinterConnection;

/**
 * Desenlace de una impresión. En caso de fallo `recoverable` marca si reintentar
 * tiene sentido (reconectar el cable / volver a autorizar la impresora) frente a
 * un "este navegador no puede", que requiere cambiar de método.
 */
export type PrintResult =
  | { ok: true; via: PrintChannel }
  | { ok: false; via: PrintChannel; message: string; recoverable: boolean };

/** Id del nodo donde se inyecta la secuencia ESC/POS del cajón. */
const KICK_ID = "esc-pos-drawer-kick";

/** Tiempo máximo de espera del puente de impresión local. */
const BRIDGE_TIMEOUT_MS = 8000;

/**
 * Pin del cajón para este trabajo. Un `drawerPin` explícito (incluido `null`)
 * manda siempre; si el llamador no dice nada, toda orden de 80 mm / 48 columnas
 * lleva incrustado el pulso RJ11, que es el formato de caja estándar.
 */
export function resolveDrawerPin(printer: ReceiptPrinter, opts: PrintOptions): 0 | 1 | null {
  if (opts.drawerPin !== undefined) return opts.drawerPin;
  return printer.paperWidth === "80mm" && printer.columns === 48 ? 0 : null;
}

/**
 * El pulso NO puede viajar en el string HTML: el parser del navegador convierte
 * el byte NUL (`m = 0`) en U+FFFD y rompería la secuencia. Por eso el HTML solo
 * lleva un nodo marcador vacío y aquí escribimos los caracteres por DOM, que sí
 * los admite tal cual.
 */
function injectDrawerKick(doc: Document | undefined, pin: 0 | 1 | null | undefined): void {
  if (!doc || pin == null) return;
  const slot = doc.getElementById(KICK_ID);
  if (slot) slot.textContent = drawerKickString(pin);
}

export type ReceiptData = {
  businessName: string;
  ventaId?: string;
  /** Fecha ya formateada (el llamador la construye con `new Date()`). */
  fecha: string;
  items: ReceiptItem[];
  total: number;
  /** Desglose por método de pago (Efectivo, Nequi, Bold…). */
  pagos: ReceiptPayment[];
};

/** Escapa texto para insertarlo con seguridad en el HTML del recibo. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Construye el HTML completo de la tirilla. `columns` marca el ancho útil en
 * caracteres para alinear las columnas con fuente monoespaciada.
 */
export function buildReceiptHtml(
  data: ReceiptData,
  printer: ReceiptPrinter,
  opts: PrintOptions = {},
): string {
  const { columns, paperWidth, fontFamily, fontSize } = printer;
  // Ancho físico útil aproximado del rollo (se descuentan los márgenes).
  const bodyWidth = paperWidth === "58mm" ? "48mm" : "72mm";

  const divider = "-".repeat(columns);

  // Mismo maquetado que la vía ESC/POS (`twoColumns`), solo que escapado.
  const twoCol = (left: string, right: string): string => esc(twoColumns(left, right, columns));

  const itemsHtml = data.items
    .map((it) => {
      const importe = formatCOP(it.precio * it.qty);
      const linea = twoCol(`${it.qty} x ${it.nombre}`, importe);
      const detalle = esc(`   @ ${formatCOP(it.precio)}`);
      return `<div class="line">${linea}</div><div class="line dim">${detalle}</div>`;
    })
    .join("");

  const pagosHtml = data.pagos
    .map((p) => `<div class="line">${twoCol(p.metodo, formatCOP(p.monto))}</div>`)
    .join("");

  const logoHtml = printer.logoDataUrl
    ? `<div class="logo"><img src="${esc(printer.logoDataUrl)}" alt="Logo" /></div>`
    : "";

  const nitHtml = printer.nit ? `<div class="line center">NIT: ${esc(printer.nit)}</div>` : "";
  const dirHtml = printer.direccion ? `<div class="line center">${esc(printer.direccion)}</div>` : "";
  const telHtml = printer.telefono ? `<div class="line center">Tel: ${esc(printer.telefono)}</div>` : "";
  const ventaHtml = data.ventaId
    ? `<div class="line dim">Venta: ${esc(data.ventaId.slice(0, 8))}</div>`
    : "";
  const graciasHtml = printer.mensajeAgradecimiento
    ? `<div class="line center strong">${esc(printer.mensajeAgradecimiento)}</div>`
    : "";

  // Cabecera del documento: nodo (vacío aquí) que `printReceipt` rellena con
  // `ESC p m 50 250`. Va antes que nada para que el cajón salte al empezar a
  // imprimir, no al terminar.
  const kickHtml = opts.drawerPin == null ? "" : `<span id="${KICK_ID}" class="kick"></span>`;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<style>
  @page { size: ${paperWidth} auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body {
    width: ${bodyWidth};
    padding: 4mm 2mm;
    font-family: ${fontFamily};
    font-size: ${fontSize}px;
    line-height: 1.35;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .line { white-space: pre; font-variant-numeric: tabular-nums; }
  .center { text-align: center; white-space: normal; }
  .strong { font-weight: 700; }
  .dim { color: #444; }
  .name { font-size: ${fontSize + 3}px; font-weight: 700; text-align: center; margin: 2px 0; }
  .total { font-size: ${fontSize + 4}px; font-weight: 700; }
  .logo { text-align: center; margin-bottom: 4px; }
  .logo img { max-width: 60%; max-height: 90px; object-fit: contain; }
  .sep { margin: 4px 0; }
  /* Pulso del cajón: debe existir en el flujo (un display:none lo borraría del
     trabajo de impresión), pero no debe verse ni ocupar papel. */
  .kick { font-size: 1px; line-height: 0; color: #fff; white-space: pre; }
</style>
</head>
<body>
  ${kickHtml}
  ${logoHtml}
  <div class="name">${esc(data.businessName)}</div>
  ${nitHtml}
  ${dirHtml}
  ${telHtml}
  <div class="line sep">${divider}</div>
  <div class="line">${esc(data.fecha)}</div>
  ${ventaHtml}
  <div class="line sep">${divider}</div>
  ${itemsHtml}
  <div class="line sep">${divider}</div>
  <div class="line total">${twoCol("TOTAL", formatCOP(data.total))}</div>
  <div class="line sep">${divider}</div>
  <div class="line strong">PAGOS</div>
  ${pagosHtml}
  <div class="line sep">${divider}</div>
  ${graciasHtml}
</body>
</html>`;
}

// ── Canales de salida ────────────────────────────────────────────────────────

/** Inserta un iframe oculto fuera de pantalla y devuelve su elemento. */
function createHiddenFrame(): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  return iframe;
}

/**
 * Impresión por el diálogo nativo. Espera a que el logo cargue antes de invocar
 * `print()` para no imprimirlo en blanco.
 */
function printViaBrowser(
  data: ReceiptData,
  printer: ReceiptPrinter,
  opts: PrintOptions,
): Promise<PrintResult> {
  return new Promise((resolve) => {
    // Vía fiable para el cajón cuando la impresora está emparejada por WebUSB:
    // los bytes crudos van al firmware en paralelo al trabajo de impresión. Si no
    // está disponible, el pulso incrustado en el documento (`injectDrawerKick`)
    // queda como respaldo, así que no esperamos a esta promesa. Se suelta la
    // interfaz al terminar: aquí imprime el driver del sistema y necesita el
    // dispositivo libre.
    if (opts.drawerPin != null) {
      void kickDrawerViaUsb(opts.drawerPin, { release: true });
    }

    const html = buildReceiptHtml(data, printer, opts);
    const iframe = createHiddenFrame();

    const cleanup = () => {
      // Da tiempo al navegador a terminar el diálogo antes de retirar el iframe.
      window.setTimeout(() => iframe.remove(), 1000);
    };

    const doPrint = () => {
      const win = iframe.contentWindow;
      if (!win) {
        cleanup();
        resolve({
          ok: false,
          via: "browser",
          message: "El navegador bloqueó la ventana de impresión.",
          recoverable: true,
        });
        return;
      }
      win.focus();
      win.print();
      cleanup();
      resolve({ ok: true, via: "browser" });
    };

    iframe.onload = () => {
      const doc = iframe.contentWindow?.document;
      injectDrawerKick(doc, opts.drawerPin);
      const img = doc?.querySelector("img");
      // Si hay logo y aún no cargó, esperamos su onload/onerror; si no, imprimimos ya.
      if (img && !img.complete) {
        img.addEventListener("load", doPrint, { once: true });
        img.addEventListener("error", doPrint, { once: true });
      } else {
        doPrint();
      }
    };

    iframe.srcdoc = html;
  });
}

/** Mensaje de usuario para un fallo del driver USB. */
function usbMessage(error: unknown): string {
  if (error instanceof UsbPrinterError) return error.message;
  const detail = error instanceof Error ? error.message : String(error);
  return `No se pudo hablar con la impresora USB (${detail}).`;
}

/** Un fallo de USB es recuperable salvo que el navegador no soporte WebUSB. */
function usbRecoverable(error: unknown): boolean {
  return !(error instanceof UsbPrinterError && error.kind === "unsupported");
}

/** POST de los bytes ESC/POS al puente local, con tope de espera. */
async function sendToBridge(url: string, payload: EscPosBytes): Promise<void> {
  const target = url.trim();
  if (!target) throw new Error("Falta la URL del puente de impresión local.");

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: payload,
      signal: controller.signal,
      // El puente corre en el propio equipo y no comparte sesión con la app.
      credentials: "omit",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`el puente respondió ${res.status}`);
  } finally {
    window.clearTimeout(timer);
  }
}

function bridgeMessage(error: unknown, url: string): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return `El puente de impresión (${url}) no respondió a tiempo.`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `No se pudo enviar la tirilla al puente de impresión (${detail}).`;
}

// ── API pública ──────────────────────────────────────────────────────────────

/**
 * Imprime la tirilla por el canal configurado en Dispositivos → Impresora.
 *
 * Devuelve siempre un `PrintResult`: en `usb`/`bridge` un fallo NO abre el
 * diálogo del navegador, se reporta para que la interfaz avise y ofrezca
 * reintentar.
 */
export async function printReceipt(
  data: ReceiptData,
  printer: ReceiptPrinter,
  opts: PrintOptions = {},
): Promise<PrintResult> {
  const via: PrintChannel = printer.connection;
  if (typeof window === "undefined") {
    return { ok: false, via, message: "Sin navegador: no hay impresión.", recoverable: false };
  }

  // Pin resuelto una sola vez: las tres vías deben coincidir en si abren o no el
  // cajón para esta misma venta.
  const resolved: PrintOptions = { drawerPin: resolveDrawerPin(printer, opts) };

  if (via === "usb") {
    try {
      const payload = await buildReceiptEscPos(data, printer, resolved);
      // `release: false` implícito: la conexión se conserva entre tirillas.
      await writeToUsbPrinter(payload);
      return { ok: true, via };
    } catch (e) {
      console.error("[tirilla] Impresión USB fallida (sin repliegue a window.print):", e);
      return { ok: false, via, message: usbMessage(e), recoverable: usbRecoverable(e) };
    }
  }

  if (via === "bridge") {
    try {
      const payload = await buildReceiptEscPos(data, printer, resolved);
      await sendToBridge(printer.bridgeUrl, payload);
      return { ok: true, via };
    } catch (e) {
      console.error("[tirilla] Puente de impresión fallido:", e);
      return { ok: false, via, message: bridgeMessage(e, printer.bridgeUrl), recoverable: true };
    }
  }

  return printViaBrowser(data, printer, resolved);
}

/**
 * Lo que `openCashDrawer` necesita saber de la impresora: por dónde hablarle.
 * `PrinterSettings` encaja tal cual (se le pasa `devices.printer`).
 */
export type DrawerChannel = { connection: PrinterConnection; bridgeUrl: string };

/** Cómo se logró (o no) abrir el cajón; el POS lo traduce a un mensaje. */
export type DrawerOutcome =
  | { ok: true; via: "usb" | "bridge" | "print" }
  | { ok: false; message: string; recoverable: boolean };

/**
 * Abre el cajón monedero SIN imprimir una tirilla (botón "Abrir Cajón" del POS).
 *
 * - `usb` / `bridge`: cinco bytes (`ESC p m 50 250`) al endpoint de la impresora.
 *   Si falla, se informa — NUNCA se lanza un trabajo de impresión del navegador.
 * - `browser`: intenta primero el pulso crudo por WebUSB y, si no hay impresora
 *   emparejada, imprime un documento mínimo que solo contiene la secuencia. El
 *   papel que sale es un milímetro en blanco; requiere driver de paso directo.
 */
export async function openCashDrawer(
  pin: 0 | 1 = 0,
  printer: DrawerChannel = { connection: "browser", bridgeUrl: "" },
): Promise<DrawerOutcome> {
  if (typeof window === "undefined") {
    return { ok: false, message: "Sin navegador: no hay cajón.", recoverable: false };
  }

  if (printer.connection === "usb") {
    try {
      await writeToUsbPrinter(buildDrawerKickJob(pin));
      return { ok: true, via: "usb" };
    } catch (e) {
      return { ok: false, message: usbMessage(e), recoverable: usbRecoverable(e) };
    }
  }

  if (printer.connection === "bridge") {
    try {
      await sendToBridge(printer.bridgeUrl, buildDrawerKickJob(pin));
      return { ok: true, via: "bridge" };
    } catch (e) {
      return { ok: false, message: bridgeMessage(e, printer.bridgeUrl), recoverable: true };
    }
  }

  if (await kickDrawerViaUsb(pin, { release: true })) return { ok: true, via: "usb" };

  const iframe = createHiddenFrame();

  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (win) {
      injectDrawerKick(win.document, pin);
      win.focus();
      win.print();
    }
    window.setTimeout(() => iframe.remove(), 1000);
  };

  iframe.srcdoc = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<style>
  @page { size: 80mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .kick { font-size: 1px; line-height: 0; color: #fff; white-space: pre; }
</style>
</head>
<body><span id="${KICK_ID}" class="kick"></span></body>
</html>`;

  return { ok: true, via: "print" };
}
