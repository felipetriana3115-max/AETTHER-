"use client";

/**
 * Escaneo de códigos de barras con la CÁMARA del dispositivo (móvil/tablet).
 *
 * Complementa —no reemplaza— al lector USB: ese sigue siendo un "keyboard
 * wedge" que teclea el código y cierra con Enter (ver `devices.ts` →
 * `ScannerSettings.mode: "hid"`), así que en escritorio basta un input enfocado.
 * En un teléfono no hay lector físico, y ahí entra esta ruta: `getUserMedia` +
 * decodificación por software de los formatos 1D de retail.
 *
 * DECODIFICADOR: ZXing (`@zxing/browser`), cargado SIEMPRE con `import()`
 * dinámico. Son ~300 KB que no tienen por qué viajar en el bundle de quien
 * nunca abre la cámara; al pedirlos bajo demanda el chunk se descarga la primera
 * vez y luego lo sirve el Service Worker (`/_next/static` va por
 * stale-while-revalidate), así que la segunda apertura funciona incluso sin red.
 *
 * NO toca Supabase ni sabe nada de `empresa_id`: devuelve una CADENA con el
 * código leído. Quien la recibe decide qué hacer (rellenar un formulario,
 * buscar el producto…), y el aislamiento por empresa lo siguen imponiendo RLS y
 * los helpers de siempre.
 */

import type { IScannerControls } from "@zxing/browser";
import { loadDeviceSettings } from "./devices";

/** Cámara disponible, ya normalizada para pintarla en un selector. */
export type CamaraInfo = {
  deviceId: string;
  /** Etiqueta legible; el navegador solo la expone tras conceder el permiso. */
  label: string;
};

/** Mando del escaneo en curso. Siempre hay que llamar a `detener()` al cerrar. */
export type ControlesEscaneo = {
  /** Corta el bucle de decodificación y libera la cámara (apaga el LED). */
  detener: () => void;
  /**
   * Enciende/apaga la linterna. `null` cuando el dispositivo o el navegador no
   * la exponen (escritorio, iOS Safari…), para que la UI oculte el botón.
   */
  alternarLinterna: ((encendida: boolean) => Promise<void>) | null;
};

type OpcionesEscaneo = {
  /** Elemento donde se pinta la vista previa de la cámara. */
  video: HTMLVideoElement;
  /** Cámara concreta a usar; sin ella se pide la trasera (`environment`). */
  deviceId?: string;
  /** Se invoca con cada código leído y validado. */
  onCodigo: (codigo: string) => void;
};

/**
 * Formatos que buscamos. Restringirlos NO es cosmético: cada formato extra es
 * otra pasada del decodificador sobre cada frame, así que limitarnos a los de
 * retail (EAN/UPC) más los industriales habituales hace el escaneo notablemente
 * más rápido y reduce las lecturas falsas.
 */
const FORMATOS = [
  "EAN_13",
  "EAN_8",
  "UPC_A",
  "UPC_E",
  "CODE_128",
  "CODE_39",
  "ITF",
  "CODABAR",
  // QR por conveniencia: algunos proveedores etiquetan así su referencia.
  "QR_CODE",
] as const;

/**
 * ¿Puede este navegador abrir la cámara?
 *
 * Solo llamable en el cliente. `isSecureContext` entra en la cuenta porque
 * `getUserMedia` no existe fuera de HTTPS/localhost: sin esta comprobación, en
 * una LAN por http el botón aparecería y fallaría con un error críptico.
 */
export function soportaCamara(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if (!window.isSecureContext) return false;
  return typeof navigator.mediaDevices?.getUserMedia === "function";
}

/**
 * Cámaras de vídeo disponibles.
 *
 * Útil para el selector "cambiar de cámara" en equipos con varias (frontal /
 * trasera / gran angular). Las etiquetas vienen vacías mientras no se haya
 * concedido el permiso, así que conviene llamarla DESPUÉS de iniciar el escaneo.
 */
export async function listarCamaras(): Promise<CamaraInfo[]> {
  if (!soportaCamara() || typeof navigator.mediaDevices.enumerateDevices !== "function") return [];
  try {
    const dispositivos = await navigator.mediaDevices.enumerateDevices();
    return dispositivos
      .filter((d) => d.kind === "videoinput")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Cámara ${i + 1}` }));
  } catch {
    return [];
  }
}

/**
 * Restricciones de la cámara.
 *
 * Sin `deviceId` pedimos la trasera con `ideal` (no `exact`): en un portátil que
 * solo tiene webcam frontal, `exact: "environment"` haría fallar la apertura en
 * vez de caer en la única cámara disponible. La resolución alta también es
 * deliberada: un EAN-13 impreso pequeño no se resuelve a 640×480.
 */
function restricciones(deviceId?: string): MediaStreamConstraints {
  return {
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
    audio: false,
  };
}

/**
 * Arranca el escaneo continuo sobre `video` y llama a `onCodigo` por cada
 * lectura válida.
 *
 * El bucle NO se detiene solo: sigue leyendo hasta que se llama a `detener()`.
 * Así quien consume decide si cierra tras el primer código (alta de producto) o
 * si encadena lecturas. Los errores "no encontré nada en este frame" son el caso
 * normal entre lecturas y se ignoran; los de apertura de cámara se propagan como
 * rechazo de esta promesa (ver `mensajeErrorCamara`).
 */
export async function iniciarEscaneoCamara({
  video,
  deviceId,
  onCodigo,
}: OpcionesEscaneo): Promise<ControlesEscaneo> {
  if (!soportaCamara()) {
    throw new Error("Este navegador no puede abrir la cámara.");
  }

  // Carga perezosa del decodificador: ver cabecera del archivo.
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
    import("@zxing/browser"),
    import("@zxing/library"),
  ]);

  const hints = new Map<number, unknown>();
  hints.set(
    DecodeHintType.POSSIBLE_FORMATS,
    FORMATOS.map((f) => BarcodeFormat[f]),
  );

  const lector = new BrowserMultiFormatReader(hints, {
    // Un intento cada ~120 ms: suficientemente fluido para que el cajero vea
    // respuesta inmediata y suficientemente espaciado para no freír la CPU (ni
    // la batería) de un móvil de gama baja.
    delayBetweenScanAttempts: 120,
    delayBetweenScanSuccess: 400,
  });

  const minimo = loadDeviceSettings().scanner.minLength;

  let controles: IScannerControls;
  try {
    controles = await lector.decodeFromConstraints(restricciones(deviceId), video, (resultado) => {
      if (!resultado) return; // frame sin código: el caso normal, no es un error.
      const codigo = resultado.getText().trim();
      // Reusamos la longitud mínima configurada para el lector físico: filtra
      // lecturas basura sin volver a inventar un umbral aquí.
      if (codigo.length < minimo) return;
      onCodigo(codigo);
    });
  } catch (e) {
    // Si `decodeFromConstraints` falla a medias puede dejar la pista abierta.
    try {
      const flujo = video.srcObject;
      if (flujo instanceof MediaStream) flujo.getTracks().forEach((t) => t.stop());
    } catch {
      // ignoramos: ya estamos propagando el error de apertura.
    }
    throw e;
  }

  const linterna = controles.switchTorch;

  return {
    detener: () => {
      try {
        controles.stop();
      } catch {
        // `stop()` es idempotente en la práctica; si ya se liberó, no pasa nada.
      }
    },
    // ZXing solo define `switchTorch` cuando la pista de vídeo la soporta.
    alternarLinterna: linterna ? (encendida: boolean) => linterna(encendida) : null,
  };
}

/**
 * Traduce el error de apertura de cámara a algo accionable para el cajero.
 *
 * Los `DOMException.name` de `getUserMedia` están estandarizados, así que
 * discriminamos por ahí en vez de por el texto (que cambia entre navegadores e
 * idiomas).
 */
export function mensajeErrorCamara(err: unknown): string {
  const nombre = err instanceof DOMException ? err.name : "";
  switch (nombre) {
    case "NotAllowedError":
    case "SecurityError":
      return (
        "No diste permiso para usar la cámara. Ábrelo desde el candado de la " +
        "barra de direcciones y vuelve a intentarlo."
      );
    case "NotFoundError":
    case "OverconstrainedError":
      return "No se encontró ninguna cámara en este dispositivo.";
    case "NotReadableError":
      return "Otra aplicación está usando la cámara. Ciérrala e inténtalo de nuevo.";
    case "AbortError":
      return "La cámara se cerró inesperadamente. Inténtalo de nuevo.";
    default:
      if (!soportaCamara()) {
        return (
          "Para usar la cámara la app debe abrirse por HTTPS (o en localhost). " +
          "Mientras tanto puedes escribir el código a mano o usar el lector USB."
        );
      }
      return err instanceof Error ? err.message : "No se pudo abrir la cámara.";
  }
}

/**
 * Pitido corto de confirmación, respetando `ScannerSettings.beep`.
 *
 * Se sintetiza con WebAudio en vez de cargar un `.mp3`: son ~10 líneas, no
 * añade un asset que cachear y suena igual sin red. En móvil añadimos una
 * vibración breve porque el altavoz suele ir silenciado en un mostrador.
 */
export function beepEscaneo(): void {
  if (typeof window === "undefined") return;
  if (!loadDeviceSettings().scanner.beep) return;

  try {
    navigator.vibrate?.(60);
  } catch {
    // La vibración es un extra; que falle no debe romper el escaneo.
  }

  try {
    const Ctx = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 1760; // La6: agudo y corto, el "bip" clásico de caja.
    // Rampa a cero para que no suene un "clic" al cortar la onda de golpe.
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    // Liberamos el contexto al terminar: abrir uno por escaneo sin cerrarlos
    // agota el límite del navegador tras unas decenas de lecturas.
    osc.onended = () => void ctx.close().catch(() => {});
  } catch {
    // Sin audio disponible seguimos: el feedback visual ya cubre el escaneo.
  }
}
