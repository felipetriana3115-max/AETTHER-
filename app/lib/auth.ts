/**
 * Sesión de autenticación (versión básica).
 *
 * La fuente de verdad es una **cookie**, no `localStorage`: el `proxy.ts`
 * (antes `middleware.ts`) se ejecuta en el servidor, antes de renderizar, y solo
 * puede leer cookies — nunca `localStorage`. Por eso el login escribe la cookie
 * para que el proxy proteja las rutas, y además refleja el usuario en
 * `localStorage` para que la UI del cliente pueda mostrarlo sin round-trip.
 *
 * IMPORTANTE: `SESSION_COOKIE` debe coincidir con el nombre que lee `proxy.ts`.
 */

/** Nombre de la cookie de sesión. Debe coincidir con el de `proxy.ts`. */
export const SESSION_COOKIE = "aether_session";

/** Clave del espejo en localStorage (solo para lectura desde la UI). */
const SESSION_STORAGE_KEY = "aether:session";

/** Duración de la sesión: 7 días. */
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export type Session = { user: string };

/**
 * Guarda la sesión tras un login correcto: cookie (para el proxy) + espejo en
 * localStorage (para la UI). Solo debe llamarse desde el cliente.
 */
export function saveSession(user: string): void {
  document.cookie = `${SESSION_COOKIE}=1; path=/; max-age=${SESSION_MAX_AGE}; samesite=lax`;
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ user } satisfies Session));
  } catch {
    // Modo privado o cuota excedida → la cookie basta para la protección.
  }
}

/** Cierra la sesión: borra cookie y espejo. Solo desde el cliente. */
export function clearSession(): void {
  document.cookie = `${SESSION_COOKIE}=; path=/; max-age=0; samesite=lax`;
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignorar: si la cookie ya se borró, la sesión está cerrada.
  }
}

/** Devuelve el usuario de la sesión activa (espejo en localStorage) o null. */
export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
