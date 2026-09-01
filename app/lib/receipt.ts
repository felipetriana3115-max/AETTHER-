"use client";

import { formatCOP } from "./data-model";
import { drawerKickString, kickDrawerViaUsb, type PrinterSettings } from "./devices";
import type { TirillaConfig } from "./tirilla";

/**
 * Lo que necesita la tirilla para imprimirse: el formato/hardware
 * (`PrinterSettings`) MÁS la identidad del negocio (`TirillaConfig`). El llamador
 * fusiona ambas fuentes (hardware desde localStorage, identidad desde Supabase).
 */
export type ReceiptPrinter = PrinterSettings & TirillaConfig;

/**
 * Generación e impresión de la tirilla térmica de venta.
 *
 * La impresión real se hace por el diálogo nativo del navegador (`window.print`)
 * sobre un iframe oculto con CSS pensado para papel térmico. Este camino funciona
 * tanto con impresoras USB como de red ya instaladas en el sistema, y es el más
 * robusto entre modelos (a diferencia de emitir ESC/POS crudo por WebUSB, que
 * depende del firmware de cada impresora).
 */

export type ReceiptItem = { nombre: string; qty: number; precio: number };
export type ReceiptPayment = { metodo: string; monto: number };

/**
 * Opciones de la impresión. `drawerPin` (0 → pin 2, 1 → pin 5) pide que el
 * documento lleve incrustado el pulso ESC/POS que abre el cajón monedero;
 * `null`/ausente imprime la tirilla sin tocar el cajón.
 */
export type PrintOptions = { drawerPin?: 0 | 1 | null };

/** Id del nodo donde se inyecta la secuencia ESC/POS del cajón. */
const KICK_ID = "esc-pos-drawer-kick";

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

  // Línea de dos columnas (texto a la izquierda, valor a la derecha) rellenada
  // con espacios hasta `columns`. Si el texto no cabe, se recorta.
  const twoCol = (left: string, right: string): string => {
    const space = Math.max(1, columns - right.length);
    const l = left.length > space ? left.slice(0, space - 1) + "…" : left.padEnd(space, " ");
    return esc(l + right);
  };

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
  // `ESC p m 25 250`. Va antes que nada para que el cajón salte al empezar a
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

/**
 * Imprime la tirilla usando un iframe oculto y el diálogo del navegador. Espera
 * a que el logo cargue antes de invocar `print()` para no imprimirlo en blanco.
 */
export function printReceipt(
  data: ReceiptData,
  printer: ReceiptPrinter,
  opts: PrintOptions = {},
): void {
  if (typeof window === "undefined") return;

  // Vía fiable para el cajón cuando la impresora está emparejada por WebUSB: los
  // bytes crudos van al firmware en paralelo al trabajo de impresión. Si no está
  // disponible, el pulso incrustado en el documento (`injectDrawerKick`) queda
  // como respaldo, así que no esperamos a esta promesa.
  if (opts.drawerPin != null) {
    void kickDrawerViaUsb(opts.drawerPin);
  }

  const html = buildReceiptHtml(data, printer, opts);
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const cleanup = () => {
    // Da tiempo al navegador a terminar el diálogo antes de retirar el iframe.
    window.setTimeout(() => iframe.remove(), 1000);
  };

  const doPrint = () => {
    const win = iframe.contentWindow;
    if (!win) {
      cleanup();
      return;
    }
    win.focus();
    win.print();
    cleanup();
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
}

/** Cómo se logró (o no) abrir el cajón; el POS lo traduce a un mensaje. */
export type DrawerResult = "usb" | "print" | "unsupported";

/**
 * Abre el cajón monedero SIN imprimir una tirilla (botón "Abrir Cajón" del POS).
 *
 * 1. Intenta el pulso crudo por WebUSB (fiable, sin diálogo de impresión).
 * 2. Si no hay impresora emparejada, lanza un trabajo de impresión mínimo que
 *    solo contiene la secuencia `ESC p m 25 250`. El papel que sale es un
 *    milímetro en blanco; requiere driver de paso directo.
 */
export async function openCashDrawer(pin: 0 | 1 = 0): Promise<DrawerResult> {
  if (typeof window === "undefined") return "unsupported";

  if (await kickDrawerViaUsb(pin)) return "usb";

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

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

  return "print";
}
