"use client";

import { useEffect, useState } from "react";

/**
 * Evento `beforeinstallprompt` (aún no tipado en lib.dom estándar).
 * Lo dispara Chromium/Edge cuando la PWA cumple los criterios de instalación.
 */
type BeforeInstallPromptEvent = Event & {
  readonly platforms: string[];
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

/**
 * Botón "Instalar app" para el Header del ERP.
 *
 * Captura el evento `beforeinstallprompt` (Windows/Android + Chrome/Edge) para
 * ofrecer instalación de Aether con un solo clic, sin depender del menú del
 * navegador. Se auto-oculta cuando:
 *   - la app ya corre instalada (display-mode: standalone), o
 *   - el navegador no ofrece el evento (p. ej. iOS/Safari), o
 *   - el usuario acaba de instalarla (evento `appinstalled`).
 *
 * Ligero: sin dependencias, sin estado global; solo dos listeners de ventana.
 */
export default function InstallButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Ya instalada: no tiene sentido ofrecer instalar de nuevo.
    if (window.matchMedia("(display-mode: standalone)").matches) return;

    const onPrompt = (e: Event) => {
      // Evita el mini-infobar por defecto para controlar el momento del prompt.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!deferred) return null;

  async function install() {
    if (!deferred || busy) return;
    setBusy(true);
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } finally {
      // El evento solo puede consumirse una vez; se descarta pase lo que pase.
      setDeferred(null);
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={install}
      disabled={busy}
      aria-label="Instalar Aether ERP"
      title="Instalar Aether en este dispositivo"
      className="group flex h-9 items-center gap-2 rounded-lg border border-violet-500/40 bg-gradient-to-br from-violet-600/20 to-fuchsia-600/20 px-3 text-sm font-medium text-violet-200 shadow-[0_0_18px_-6px_rgba(139,92,246,0.7)] transition-all hover:from-violet-600/30 hover:to-fuchsia-600/30 hover:text-white hover:shadow-[0_0_22px_-4px_rgba(139,92,246,0.9)] focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-60"
    >
      <svg
        className="h-4 w-4 shrink-0 transition-transform group-hover:translate-y-0.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="M7 10l5 5 5-5" />
        <path d="M12 15V3" />
      </svg>
      <span className="hidden sm:inline">{busy ? "Instalando…" : "Instalar app"}</span>
    </button>
  );
}
