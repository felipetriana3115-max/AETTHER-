"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  beepEscaneo,
  iniciarEscaneoCamara,
  listarCamaras,
  mensajeErrorCamara,
  type CamaraInfo,
  type ControlesEscaneo,
} from "../lib/barcode-camera";

/**
 * Lector de códigos de barras por CÁMARA, a pantalla completa.
 *
 * Pensado para el alta rápida de productos desde un móvil o una tablet: el
 * encargado apunta al código del empaque y el campo se rellena solo, sin teclear
 * trece dígitos. En escritorio con lector USB este modal ni se abre: ahí el
 * lector teclea directamente en el input (ver `devices.ts`, modo HID).
 *
 * Es "tonto" a propósito: abre la cámara, decodifica y emite la CADENA leída por
 * `onDetectado`. No consulta Supabase, no conoce `empresa_id` y no guarda nada;
 * de eso se encarga el formulario que lo invoca, que ya pasa por RLS.
 *
 * Debe montarse solo en el navegador (`next/dynamic` con `ssr: false`): el
 * efecto de arranque toca `navigator.mediaDevices` en cuanto aparece.
 *
 * Se pinta con un PORTAL a `document.body`. No es manía: el formulario de
 * productos vive dentro del modal de inventario, cuyo fondo lleva
 * `backdrop-blur` (que convierte al div en bloque contenedor de los `fixed`
 * descendientes) y cuyo contenido tiene `overflow-y-auto` (que los recorta). Sin
 * el portal, este visor "a pantalla completa" saldría encajonado y con scroll
 * dentro de la tarjeta del modal.
 */

type Props = {
  /** Se invoca con cada código leído (ya validado por el decodificador). */
  onDetectado: (codigo: string) => void;
  /** Cierra el modal (el padre desmonta este componente). */
  onCerrar: () => void;
  /**
   * `true` = sigue leyendo tras cada código (alta en cadena). Por defecto el
   * padre cierra tras la primera lectura, que es el flujo del formulario.
   */
  continuo?: boolean;
  /** Título de la cabecera; útil si se reusa fuera del alta de productos. */
  titulo?: string;
};

type Estado = "iniciando" | "escaneando" | "error";

export default function CameraScanner({
  onDetectado,
  onCerrar,
  continuo = false,
  titulo = "Escanear código de barras",
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlesRef = useRef<ControlesEscaneo | null>(null);
  // Evita emitir dos veces el mismo código: ZXing puede resolver el mismo frame
  // más de una vez antes de que el padre nos desmonte.
  const emitidoRef = useRef(false);

  const [estado, setEstado] = useState<Estado>("iniciando");
  const [error, setError] = useState<string | null>(null);
  const [camaras, setCamaras] = useState<CamaraInfo[]>([]);
  // `undefined` = "la que elija el navegador" (trasera por defecto).
  const [camaraId, setCamaraId] = useState<string | undefined>(undefined);
  const [tieneLinterna, setTieneLinterna] = useState(false);
  const [linternaEncendida, setLinternaEncendida] = useState(false);
  // Último código leído: feedback visual inmediato antes de cerrar.
  const [ultimo, setUltimo] = useState<string | null>(null);

  // Guardamos los callbacks en refs para que el efecto que abre la cámara
  // dependa SOLO de `camaraId`. Si dependiera de las props, cada render del
  // padre reiniciaría la cámara (parpadeo y permisos repetidos).
  const onDetectadoRef = useRef(onDetectado);
  const continuoRef = useRef(continuo);
  useEffect(() => {
    onDetectadoRef.current = onDetectado;
    continuoRef.current = continuo;
  }, [onDetectado, continuo]);

  // Arranque (y reinicio al cambiar de cámara). La limpieza libera el stream:
  // sin ella el LED de la cámara se queda encendido tras cerrar el modal.
  useEffect(() => {
    let cancelado = false;
    const video = videoRef.current;
    if (!video) return;

    setEstado("iniciando");
    setError(null);
    emitidoRef.current = false;

    (async () => {
      try {
        const controles = await iniciarEscaneoCamara({
          video,
          deviceId: camaraId,
          onCodigo: (codigo) => {
            if (emitidoRef.current) return;
            if (!continuoRef.current) emitidoRef.current = true;
            beepEscaneo();
            setUltimo(codigo);
            onDetectadoRef.current(codigo);
          },
        });

        // Si el modal se cerró mientras se abría la cámara, la soltamos ya.
        if (cancelado) {
          controles.detener();
          return;
        }

        controlesRef.current = controles;
        setTieneLinterna(controles.alternarLinterna != null);
        setLinternaEncendida(false);
        setEstado("escaneando");

        // Las etiquetas de las cámaras solo existen tras conceder el permiso,
        // por eso enumeramos AHORA y no antes de arrancar.
        const disponibles = await listarCamaras();
        if (!cancelado) setCamaras(disponibles);
      } catch (e) {
        console.error("[CameraScanner] No se pudo iniciar la cámara:", e);
        if (cancelado) return;
        setError(mensajeErrorCamara(e));
        setEstado("error");
      }
    })();

    return () => {
      cancelado = true;
      controlesRef.current?.detener();
      controlesRef.current = null;
    };
  }, [camaraId]);

  // Esc cierra, como en el resto de modales de la app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCerrar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCerrar]);

  const alternarLinterna = useCallback(async () => {
    const alternar = controlesRef.current?.alternarLinterna;
    if (!alternar) return;
    const siguiente = !linternaEncendida;
    try {
      await alternar(siguiente);
      setLinternaEncendida(siguiente);
    } catch (e) {
      console.warn("[CameraScanner] La linterna no respondió:", e);
      setTieneLinterna(false);
    }
  }, [linternaEncendida]);

  const contenido = (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black/95"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cam-scan-titulo"
    >
      {/* Cabecera */}
      <header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <h2 id="cam-scan-titulo" className="text-sm font-semibold text-zinc-100">
          {titulo}
        </h2>
        <button
          type="button"
          onClick={onCerrar}
          aria-label="Cerrar el escáner"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-700 text-lg text-zinc-300 transition-colors hover:bg-zinc-800"
        >
          ✕
        </button>
      </header>

      {/* Vista previa */}
      <div className="relative flex-1 overflow-hidden bg-black">
        {/* `playsInline` + `muted` son obligatorios en iOS: sin ellos Safari
            abre el reproductor a pantalla completa en vez de dejar el vídeo
            incrustado, y el modal deja de verse. */}
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          muted
          playsInline
          autoPlay
        />

        {/* Mirilla: ayuda a encuadrar y deja claro dónde apuntar. */}
        {estado === "escaneando" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative h-32 w-[78%] max-w-sm rounded-xl border-2 border-violet-400/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]">
              <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-violet-400/70" />
            </div>
          </div>
        )}

        {estado === "iniciando" && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400">
            Abriendo la cámara…
          </p>
        )}

        {estado === "error" && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div
              role="alert"
              className="max-w-sm rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
            >
              {error}
            </div>
          </div>
        )}

        {/* Confirmación del último código leído. */}
        {ultimo && (
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-emerald-500/20 px-4 py-1.5 font-mono text-sm text-emerald-200">
            ✓ {ultimo}
          </p>
        )}
      </div>

      {/* Controles */}
      <footer className="space-y-3 border-t border-zinc-800 px-4 py-3">
        <p className="text-center text-xs text-zinc-500">
          Apunta al código de barras del producto. Se rellenará solo.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-2">
          {/* Selector de cámara: solo tiene sentido si hay más de una. */}
          {camaras.length > 1 && (
            <select
              aria-label="Cámara"
              value={camaraId ?? ""}
              onChange={(e) => setCamaraId(e.target.value || undefined)}
              className="max-w-[60%] rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 focus:border-violet-500 focus:outline-none"
            >
              <option value="">Cámara automática (trasera)</option>
              {camaras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label}
                </option>
              ))}
            </select>
          )}

          {tieneLinterna && (
            <button
              type="button"
              onClick={alternarLinterna}
              aria-pressed={linternaEncendida}
              className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                linternaEncendida
                  ? "border-amber-400/60 bg-amber-400/15 text-amber-200"
                  : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              🔦 Linterna
            </button>
          )}

          <button
            type="button"
            onClick={onCerrar}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            Cancelar
          </button>
        </div>
      </footer>
    </div>
  );

  return createPortal(contenido, document.body);
}
