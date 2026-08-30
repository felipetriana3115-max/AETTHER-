"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getEmpresaIdActiva, supabase } from "./auth";

/**
 * Identidad de la tirilla de venta (NIT, dirección, teléfono, logo y mensaje de
 * agradecimiento).
 *
 * A diferencia del hardware de la caja (ver `devices.ts`), estos datos pertenecen
 * al NEGOCIO, no al equipo: por eso se guardan en la fila del tenant en Supabase
 * (`empresas`, acotado por `mi_empresa()` vía la RPC `actualizar_tirilla`) y NO en
 * localStorage. Así sobreviven al cierre de sesión y siguen al negocio entre
 * equipos. Se cachean además en un localStorage SEGMENTADO POR EMPRESA solo para
 * que el POS pueda imprimir la identidad sin depender de la red; ese caché es
 * datos del tenant y el logout lo purga (se rehidrata desde Supabase al entrar).
 */

export type TirillaConfig = {
  logoDataUrl: string;
  nit: string;
  direccion: string;
  telefono: string;
  mensajeAgradecimiento: string;
};

export const DEFAULT_TIRILLA: TirillaConfig = {
  logoDataUrl: "",
  nit: "",
  direccion: "",
  telefono: "",
  mensajeAgradecimiento: "¡Gracias por tu compra!",
};

// Caché de conveniencia, SEGMENTADO por empresa (igual que businessName). Comparte
// el prefijo `mi-dashboard-erp` para que el logout lo purgue como dato del tenant.
const CACHE_BASE = "mi-dashboard-erp:tirilla:v1";
const cacheKey = (empresaId: string) => `${CACHE_BASE}:${empresaId}`;

type EmpresaTirillaRow = {
  nit: string | null;
  direccion: string | null;
  telefono: string | null;
  logo_url: string | null;
  mensaje_recibo: string | null;
};

/** Mapea una fila de `empresas` a la config, aplicando los valores por defecto. */
function rowToConfig(row: EmpresaTirillaRow): TirillaConfig {
  return {
    logoDataUrl: row.logo_url ?? "",
    nit: row.nit ?? "",
    direccion: row.direccion ?? "",
    telefono: row.telefono ?? "",
    mensajeAgradecimiento: row.mensaje_recibo ?? DEFAULT_TIRILLA.mensajeAgradecimiento,
  };
}

/** Lee el caché local (por empresa). Sin empresa o sin caché → defaults. */
export function loadTirillaCache(empresaId: string | null): TirillaConfig {
  if (!empresaId || typeof window === "undefined") return DEFAULT_TIRILLA;
  try {
    const raw = window.localStorage.getItem(cacheKey(empresaId));
    if (!raw) return DEFAULT_TIRILLA;
    return { ...DEFAULT_TIRILLA, ...(JSON.parse(raw) as Partial<TirillaConfig>) };
  } catch {
    return DEFAULT_TIRILLA;
  }
}

function saveTirillaCache(empresaId: string, cfg: TirillaConfig): void {
  try {
    window.localStorage.setItem(cacheKey(empresaId), JSON.stringify(cfg));
  } catch {
    // Cuota excedida o modo privado → el POS caerá a defaults; no es crítico.
  }
}

/**
 * Trae la identidad de la tirilla desde Supabase (fuente de verdad) y refresca el
 * caché local. Si no hay empresa o la lectura falla, cae al caché (o defaults).
 */
export async function fetchTirilla(): Promise<TirillaConfig> {
  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) return DEFAULT_TIRILLA;
  const { data, error } = await supabase
    .from("empresas")
    .select("nit, direccion, telefono, logo_url, mensaje_recibo")
    .eq("id", empresaId)
    .maybeSingle();
  if (error || !data) {
    // Sin red o RLS negó la lectura → usa lo último cacheado para este tenant.
    return loadTirillaCache(empresaId);
  }
  const cfg = rowToConfig(data as EmpresaTirillaRow);
  saveTirillaCache(empresaId, cfg);
  return cfg;
}

/**
 * Persiste la identidad en la fila del tenant vía la RPC `actualizar_tirilla`
 * (acotada a `mi_empresa()`), y actualiza el caché local. Lanza si el guardado
 * en el servidor falla, para que la UI pueda avisar.
 */
export async function saveTirilla(cfg: TirillaConfig): Promise<void> {
  const { error } = await supabase.rpc("actualizar_tirilla", {
    p_nit: cfg.nit,
    p_direccion: cfg.direccion,
    p_telefono: cfg.telefono,
    p_logo_url: cfg.logoDataUrl,
    p_mensaje_recibo: cfg.mensajeAgradecimiento,
  });
  if (error) throw error;
  const empresaId = await getEmpresaIdActiva();
  if (empresaId) saveTirillaCache(empresaId, cfg);
}

/**
 * Hook con la identidad de la tirilla hidratada desde Supabase. Devuelve la
 * config, un `patch(cambios)` que actualiza al instante en pantalla y guarda en el
 * servidor con debounce (agrupa ráfagas de tecleo), y `hydrated`. `onError` se
 * invoca si un guardado falla.
 */
export function useTirilla(onError?: (message: string) => void) {
  const [tirilla, setTirilla] = useState<TirillaConfig>(DEFAULT_TIRILLA);
  const [hydrated, setHydrated] = useState(false);

  // Guardado con debounce: el último estado pendiente + su temporizador.
  const pending = useRef<TirillaConfig | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mantiene el último `onError` sin re-crear `flush` (que no depende de él).
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    let alive = true;
    void fetchTirilla().then((cfg) => {
      if (alive) {
        setTirilla(cfg);
        setHydrated(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const cfg = pending.current;
    if (!cfg) return;
    pending.current = null;
    void saveTirilla(cfg).catch((e) => {
      const msg = e instanceof Error ? e.message : "No se pudo guardar la tirilla.";
      onErrorRef.current?.(msg);
    });
  }, []);

  const patch = useCallback(
    (changes: Partial<TirillaConfig>) => {
      setTirilla((prev) => {
        const next = { ...prev, ...changes };
        pending.current = next;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, 800);
        return next;
      });
    },
    [flush],
  );

  // Al desmontar, guarda cualquier cambio pendiente (p. ej. si el usuario navega
  // fuera antes de que venza el debounce) para no perder lo último tecleado.
  useEffect(() => () => flush(), [flush]);

  return { tirilla, patch, hydrated };
}
