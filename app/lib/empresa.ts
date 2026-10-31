import { getEmpresaIdActiva, getEmpresaIdActivaConReintentos, supabase } from "./auth";

/**
 * Identidad básica del tenant: el **nombre visible** de la empresa.
 *
 * Igual que la identidad de la tirilla (ver `tirilla.ts`), este dato pertenece al
 * NEGOCIO, no al equipo: por eso la fuente de verdad es `empresas.nombre` en
 * Supabase (acotado a `mi_empresa()`), NO localStorage.
 *
 * MOTIVO DEL CAMBIO: antes el nombre vivía solo en
 * `mi-dashboard-erp:businessName:v1:<empresa_id>`. Como el logout purga todas las
 * claves con ese prefijo (`purgeDashboardCache` en `auth.ts`), al reingresar el
 * nombre volvía siempre a "Mi Empresa". El localStorage se conserva únicamente
 * como CACHÉ de primer pintado (segmentado por empresa), nunca como verdad.
 */

/** Nombre por defecto cuando el tenant aún no ha configurado el suyo. */
export const DEFAULT_BUSINESS_NAME = "Mi Empresa";

/**
 * Nombres "de relleno" que el servidor pudo dejar en `empresas.nombre` y que NO
 * deben pisar un nombre mejor ya cacheado (el trigger de alta usa este literal
 * cuando el signUp no trajo `nombre_comercial`).
 */
const PLACEHOLDER_NOMBRES = new Set(["", "Empresa sin nombre"]);

/** Base de la clave de caché; coincide con la que purga el logout. */
const CACHE_BASE = "mi-dashboard-erp:businessName:v1";
const cacheKey = (empresaId: string) => `${CACHE_BASE}:${empresaId}`;

/** Lee el nombre cacheado de ESE tenant. `null` si no hay empresa o no hay caché. */
export function loadBusinessNameCache(empresaId: string | null): string | null {
  if (!empresaId || typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(cacheKey(empresaId)) || null;
  } catch {
    return null;
  }
}

function saveBusinessNameCache(empresaId: string, nombre: string): void {
  try {
    window.localStorage.setItem(cacheKey(empresaId), nombre);
  } catch {
    // Cuota excedida o modo privado → se pierde solo el primer pintado offline.
  }
}

/**
 * Trae el nombre visible desde Supabase (fuente de verdad) y refresca el caché
 * del tenant.
 *
 * Devuelve `null` cuando NO se pudo resolver nada útil (sin sesión, RLS negó la
 * lectura, fila sin nombre…). El llamador debe interpretar ese `null` como "deja
 * lo que ya tienes en pantalla", nunca como "vacía el nombre": así una caída de
 * red no borra visualmente lo que el usuario ya guardó.
 */
export async function fetchBusinessName(): Promise<string | null> {
  const empresaId = await getEmpresaIdActivaConReintentos();
  if (!empresaId) return null;

  const { data, error } = await supabase
    .from("empresas")
    .select("nombre")
    .eq("id", empresaId)
    .maybeSingle();

  if (error) {
    // Sin red o RLS negó la lectura → se conserva el caché del tenant.
    console.error("[fetchBusinessName] lectura de 'empresas' falló:", error);
    return loadBusinessNameCache(empresaId);
  }

  const nombre = (data?.nombre as string | null)?.trim() ?? "";
  if (PLACEHOLDER_NOMBRES.has(nombre)) {
    // El servidor no tiene un nombre real todavía: no pisamos uno mejor cacheado.
    return loadBusinessNameCache(empresaId);
  }

  saveBusinessNameCache(empresaId, nombre);
  return nombre;
}

/**
 * Persiste el nombre visible en la fila del tenant vía la RPC
 * `actualizar_nombre_empresa` (SECURITY DEFINER, acotada a `mi_empresa()` y
 * reservada al administrador). Devuelve el nombre tal cual quedó guardado.
 *
 * Lanza si el servidor rechaza el guardado (empleado sin permiso, usuario sin
 * empresa, RPC no desplegada) para que la UI avise en vez de mentir con un
 * "Guardado" que se perdería en el próximo login.
 */
export async function saveBusinessName(nombre: string): Promise<string> {
  const limpio = nombre.trim();
  if (!limpio) throw new Error("El nombre de la empresa no puede estar vacío.");

  const { data, error } = await supabase.rpc("actualizar_nombre_empresa", {
    p_nombre: limpio,
  });
  if (error) {
    throw new Error(
      `No se pudo guardar el nombre de la empresa: ${error.message}` +
        (error.code ? ` (code=${error.code})` : ""),
    );
  }

  const guardado = (data as string | null)?.trim() || limpio;
  const empresaId = await getEmpresaIdActiva();
  if (empresaId) saveBusinessNameCache(empresaId, guardado);
  return guardado;
}
