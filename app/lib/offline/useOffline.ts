/**
 * Modo Sin Internet — hook de React para el estado de conexión y la cola.
 *
 * Centraliza:
 *  - `online`: estado de red reactivo (eventos `online`/`offline`).
 *  - `pendientes` / `totalPend`: tamaño y monto de la cola local.
 *  - `sincronizar()`: drena la cola manualmente (botón del POS).
 *  - Auto-sync: al recuperar la señal (`online`), al montar y en un latido suave
 *    por si el evento `online` no llega (redes intermitentes).
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isOnline } from "./catalog";
import { contarPendientes, syncOutbox, totalPendiente, type ResultadoSync } from "./outbox";

export type UseOffline = {
  online: boolean;
  pendientes: number;
  totalPend: number;
  sincronizando: boolean;
  /** Drena la cola ahora; devuelve el resultado (o null si ya estaba corriendo). */
  sincronizar: () => Promise<ResultadoSync | null>;
  /** Recalcula contadores de la cola (tras encolar una venta, por ejemplo). */
  refresh: () => Promise<void>;
};

/** Latido de reintento (ms): drena pendientes por si se perdió el evento `online`. */
const HEARTBEAT_MS = 30_000;

export function useOffline(onSynced?: (r: ResultadoSync) => void): UseOffline {
  // Arranca en `true` para no provocar desajuste de hidratación; el efecto lo
  // corrige de inmediato en el cliente con el valor real de navigator.onLine.
  const [online, setOnline] = useState(true);
  const [pendientes, setPendientes] = useState(0);
  const [totalPend, setTotalPend] = useState(0);
  const [sincronizando, setSincronizando] = useState(false);
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;

  const refresh = useCallback(async () => {
    setPendientes(await contarPendientes());
    setTotalPend(await totalPendiente());
  }, []);

  const sincronizar = useCallback(async (): Promise<ResultadoSync | null> => {
    if (!isOnline()) {
      await refresh();
      return null;
    }
    setSincronizando(true);
    try {
      const r = await syncOutbox();
      await refresh();
      if (r.enviadas > 0) onSyncedRef.current?.(r);
      return r;
    } finally {
      setSincronizando(false);
    }
  }, [refresh]);

  useEffect(() => {
    setOnline(isOnline());
    void refresh();
    if (isOnline()) void sincronizar();

    const handleOnline = () => {
      setOnline(true);
      void sincronizar();
    };
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    const beat = window.setInterval(() => {
      if (isOnline()) void sincronizar();
      else void refresh();
    }, HEARTBEAT_MS);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.clearInterval(beat);
    };
  }, [refresh, sincronizar]);

  return { online, pendientes, totalPend, sincronizando, sincronizar, refresh };
}
