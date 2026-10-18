"use client";

import { formatCOP } from "./data-model";
import { drawerKickBytes, type EscPosBytes, type PaperWidth } from "./devices";
import type { PrintOptions, ReceiptData, ReceiptPrinter } from "./receipt";

/**
 * Tirilla de venta como BYTES ESC/POS crudos.
 *
 * Es el camino de las terminales All-in-One (DigitalPOS) y de cualquier equipo
 * donde la impresora se maneja por WebUSB o por un puente local: aquí NO hay
 * navegador de por medio, así que el documento no se rasteriza y la secuencia
 * del cajón monedero llega intacta al firmware.
 *
 * El camino HTML (`buildReceiptHtml` en `receipt.ts`) sigue existiendo para el
 * modo "Diálogo del navegador"; ambos comparten el mismo maquetado de columnas
 * (`twoColumns`) para que la tirilla salga idéntica por las dos vías.
 */

// ── Bytes de control ─────────────────────────────────────────────────────────

const ESC = 0x1b;
const GS = 0x1d;

/** ESC @ — reinicia la impresora (limpia estilos de un trabajo anterior). */
const INIT = [ESC, 0x40];
/** ESC t 0 — tabla de caracteres PC437, la de fábrica en las térmicas chinas. */
const CODEPAGE_PC437 = [ESC, 0x74, 0x00];
/** ESC M 0 — fuente A (12×24): 48 columnas en 80 mm, 32 en 58 mm. */
const FONT_A = [ESC, 0x4d, 0x00];
const ALIGN_LEFT = [ESC, 0x61, 0x00];
const ALIGN_CENTER = [ESC, 0x61, 0x01];
const BOLD_ON = [ESC, 0x45, 0x01];
const BOLD_OFF = [ESC, 0x45, 0x00];
/** GS ! 0x01 — doble alto (el ancho se deja normal para no perder columnas). */
const TALL_ON = [GS, 0x21, 0x01];
const TALL_OFF = [GS, 0x21, 0x00];
/** GS V 66 3 — avanza 3 líneas y corta el papel (corte parcial). */
const FEED_AND_CUT = [GS, 0x56, 0x42, 0x03];
const LF = [0x0a];

// ── Codificación de texto (PC437) ────────────────────────────────────────────

/**
 * Caracteres no ASCII que PC437 sí tiene. Todo lo demás se pliega a ASCII
 * (`ASCII_FOLD`) antes que imprimir basura: una tirilla con "Cafe" se lee; una
 * con "CafÃ©" no.
 */
const PC437: Record<string, number> = {
  "á": 0xa0, "é": 0x82, "í": 0xa1, "ó": 0xa2, "ú": 0xa3,
  "ñ": 0xa4, "Ñ": 0xa5, "ü": 0x81, "Ü": 0x9a, "É": 0x90,
  "ç": 0x87, "Ç": 0x80, "¿": 0xa8, "¡": 0xad, "ª": 0xa6,
  "º": 0xa7, "°": 0xf8, "·": 0xfa, "±": 0xf1, "¢": 0x9b,
};

/** Equivalencias ASCII para lo que PC437 no cubre (mayúsculas acentuadas, …). */
const ASCII_FOLD: Record<string, string> = {
  "Á": "A", "À": "A", "Â": "A", "Ä": "A", "à": "a", "â": "a", "ä": "a",
  "Í": "I", "Ì": "I", "Î": "I", "Ï": "I", "ì": "i", "î": "i", "ï": "i",
  "Ó": "O", "Ò": "O", "Ô": "O", "Ö": "O", "ò": "o", "ô": "o", "ö": "o",
  "Ú": "U", "Ù": "U", "Û": "U", "ù": "u", "û": "u",
  "È": "E", "Ê": "E", "Ë": "E", "è": "e", "ê": "e", "ë": "e",
  // Un solo carácter para no desalinear las columnas ya calculadas.
  "…": ".", "–": "-", "—": "-", "“": '"', "”": '"', "‘": "'", "’": "'",
  "€": "E", "£": "L",
  // `Intl` mete espacios duros en "$ 45.000"; el firmware no los conoce.
  " ": " ", " ": " ", " ": " ",
};

/** Convierte una cadena a bytes PC437 (sin salto de línea). */
export function encodeText(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0x20;
    if (code >= 0x20 && code <= 0x7e) {
      out.push(code);
      continue;
    }
    const direct = PC437[ch];
    if (direct !== undefined) {
      out.push(direct);
      continue;
    }
    const folded = ASCII_FOLD[ch];
    if (folded !== undefined) {
      for (let i = 0; i < folded.length; i++) out.push(folded.charCodeAt(i));
      continue;
    }
    out.push(0x3f); // '?' — desconocido, pero conserva el ancho de columna.
  }
  return out;
}

// ── Maquetado compartido con la versión HTML ─────────────────────────────────

/**
 * Línea de dos columnas (texto a la izquierda, valor a la derecha) rellenada con
 * espacios hasta `columns`. Si el texto no cabe, se recorta con "…".
 *
 * La usan las DOS vías de impresión (HTML y ESC/POS) para que la tirilla salga
 * exactamente igual por el diálogo del navegador y por USB.
 */
export function twoColumns(left: string, right: string, columns: number): string {
  const space = Math.max(1, columns - right.length);
  const l = left.length > space ? left.slice(0, space - 1) + "…" : left.padEnd(space, " ");
  return l + right;
}

/** Parte un texto largo en líneas de `columns` respetando las palabras. */
function wrap(text: string, columns: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (!current) current = w;
    else if (current.length + 1 + w.length <= columns) current += ` ${w}`;
    else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

// ── Logo (rasterizado a 1 bit) ───────────────────────────────────────────────

/** Ancho del cabezal en puntos (203 dpi): 576 en 80 mm, 384 en 58 mm. */
function headDots(paperWidth: PaperWidth): number {
  return paperWidth === "58mm" ? 384 : 576;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo cargar el logo."));
    img.src = src;
  });
}

/**
 * Convierte el logo (data URL) en un bloque `GS v 0`: lo escala al ancho del
 * rollo, lo pasa a blanco y negro por umbral y empaqueta 8 píxeles por byte.
 *
 * Best-effort: si el canvas no está disponible o la imagen falla, devuelve `[]`
 * y la tirilla sale sin logo en vez de no salir.
 */
async function rasterLogo(dataUrl: string, paperWidth: PaperWidth): Promise<number[]> {
  // Solo data URLs: una imagen remota "contamina" el canvas y `getImageData`
  // lanza, además de añadir una espera de red a cada venta.
  if (!dataUrl.startsWith("data:") || typeof document === "undefined") return [];

  try {
    const img = await loadImage(dataUrl);
    if (!img.width || !img.height) return [];

    // Ancho máximo: 60 % del rollo (como el `max-width` del logo en HTML),
    // múltiplo de 8 porque cada byte empaqueta 8 puntos horizontales.
    const maxWidth = Math.floor((headDots(paperWidth) * 0.6) / 8) * 8;
    const scale = Math.min(1, maxWidth / img.width);
    const width = Math.max(8, Math.floor((img.width * scale) / 8) * 8);
    const height = Math.min(240, Math.max(1, Math.round(img.height * (width / img.width))));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    // Fondo blanco: los PNG con transparencia saldrían negros sin esto.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const { data } = ctx.getImageData(0, 0, width, height);
    const bytesPerRow = width / 8;
    const raster: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let b = 0; b < bytesPerRow; b++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const i = (y * width + b * 8 + bit) * 4;
          const luma = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
          // Bit a 1 = punto quemado (negro).
          if (luma < 160) byte |= 0x80 >> bit;
        }
        raster.push(byte);
      }
    }

    // GS v 0 m xL xH yL yH d1…dk — m = 0 (densidad normal).
    const header = [
      GS, 0x76, 0x30, 0x00,
      bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
      height & 0xff, (height >> 8) & 0xff,
    ];
    return header.concat(raster);
  } catch {
    return [];
  }
}

// ── Construcción de la tirilla ───────────────────────────────────────────────

/** `push` en bloque sin `...spread` (un raster grande desborda la pila). */
function pushAll(target: number[], src: ArrayLike<number>): void {
  for (let i = 0; i < src.length; i++) target.push(src[i]);
}

/**
 * Tirilla completa en ESC/POS. `opts.drawerPin` (ya resuelto por `printReceipt`)
 * antepone el pulso del cajón monedero: va al PRINCIPIO del trabajo para que el
 * cajón salte al empezar a imprimir, no al terminar.
 */
export async function buildReceiptEscPos(
  data: ReceiptData,
  printer: ReceiptPrinter,
  opts: PrintOptions = {},
): Promise<EscPosBytes> {
  const columns = printer.columns > 0 ? printer.columns : 48;
  const divider = "-".repeat(columns);
  const bytes: number[] = [];

  const raw = (chunk: number[]) => pushAll(bytes, chunk);
  const line = (text: string) => {
    pushAll(bytes, encodeText(text));
    pushAll(bytes, LF);
  };

  raw(INIT);
  raw(CODEPAGE_PC437);
  raw(FONT_A);
  raw(ALIGN_LEFT);

  // Pulso del cajón monedero (RJ11) antes de cualquier texto.
  if (opts.drawerPin != null) pushAll(bytes, drawerKickBytes(opts.drawerPin));

  if (printer.logoDataUrl) {
    const logo = await rasterLogo(printer.logoDataUrl, printer.paperWidth);
    if (logo.length) {
      raw(ALIGN_CENTER);
      pushAll(bytes, logo);
      raw(ALIGN_LEFT);
    }
  }

  // Cabecera: nombre del negocio en doble alto + identidad fiscal.
  raw(ALIGN_CENTER);
  raw(BOLD_ON);
  raw(TALL_ON);
  for (const l of wrap(data.businessName, columns)) line(l);
  raw(TALL_OFF);
  raw(BOLD_OFF);
  if (printer.nit) line(`NIT: ${printer.nit}`);
  if (printer.direccion) for (const l of wrap(printer.direccion, columns)) line(l);
  if (printer.telefono) line(`Tel: ${printer.telefono}`);
  raw(ALIGN_LEFT);

  line(divider);
  line(data.fecha);
  if (data.ventaId) line(`Venta: ${data.ventaId.slice(0, 8)}`);
  line(divider);

  for (const it of data.items) {
    line(twoColumns(`${it.qty} x ${it.nombre}`, formatCOP(it.precio * it.qty), columns));
    line(`   @ ${formatCOP(it.precio)}`);
  }

  line(divider);
  raw(BOLD_ON);
  raw(TALL_ON);
  line(twoColumns("TOTAL", formatCOP(data.total), columns));
  raw(TALL_OFF);
  raw(BOLD_OFF);
  line(divider);

  raw(BOLD_ON);
  line("PAGOS");
  raw(BOLD_OFF);
  for (const p of data.pagos) line(twoColumns(p.metodo, formatCOP(p.monto), columns));
  line(divider);

  if (printer.mensajeAgradecimiento) {
    raw(ALIGN_CENTER);
    raw(BOLD_ON);
    for (const l of wrap(printer.mensajeAgradecimiento, columns)) line(l);
    raw(BOLD_OFF);
    raw(ALIGN_LEFT);
  }

  raw(LF);
  raw(FEED_AND_CUT);
  return new Uint8Array(bytes);
}

/**
 * Trabajo mínimo que SOLO abre el cajón (botón "Abrir Cajón" del POS). No
 * imprime ni corta papel: son cinco bytes al endpoint de la impresora.
 */
export function buildDrawerKickJob(pin: 0 | 1): EscPosBytes {
  const bytes: number[] = [];
  pushAll(bytes, INIT);
  pushAll(bytes, drawerKickBytes(pin));
  return new Uint8Array(bytes);
}

/** Tirilla de prueba de conexión (dos líneas y corte), para el panel de ajustes. */
export function buildTestJob(): EscPosBytes {
  const bytes: number[] = [];
  pushAll(bytes, INIT);
  pushAll(bytes, CODEPAGE_PC437);
  pushAll(bytes, FONT_A);
  pushAll(bytes, ALIGN_CENTER);
  pushAll(bytes, BOLD_ON);
  pushAll(bytes, encodeText("AETHER ERP"));
  pushAll(bytes, LF);
  pushAll(bytes, BOLD_OFF);
  pushAll(bytes, encodeText("Conexion directa con la impresora OK"));
  pushAll(bytes, LF);
  pushAll(bytes, ALIGN_LEFT);
  pushAll(bytes, FEED_AND_CUT);
  return new Uint8Array(bytes);
}
