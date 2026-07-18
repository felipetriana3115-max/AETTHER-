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

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente Supabase (browser), inicializado de forma **perezosa**.
 *
 * `createClient` NO debe ejecutarse al importar el módulo: durante `next build`
 * las páginas cliente se pre-renderizan en el servidor y evaluarían este módulo
 * sin las variables `NEXT_PUBLIC_*`, provocando `Error: supabaseUrl is required`.
 * Al diferir la creación, el cliente solo se instancia la primera vez que se usa
 * (en el navegador, en runtime), nunca durante el pre-render del build.
 */
let client: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL y/o NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Configúralas en .env.local (local) o en las variables de entorno de Vercel.",
    );
  }

  client = createClient(url, anonKey);
  return client;
}

/**
 * Proxy que difiere la creación del cliente hasta el primer acceso a una
 * propiedad (p. ej. `supabase.auth` o `supabase.from(...)`). Reutiliza la sesión
 * que gestiona supabase-js y expone el mismo API que un `SupabaseClient` normal.
 */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const real = getSupabase();
    const value = Reflect.get(real, prop, receiver);
    // Preservar `this` en los métodos (auth, from, etc.).
    return typeof value === "function" ? value.bind(real) : value;
  },
});

/** Nombre de la cookie de sesión. Debe coincidir con el de `proxy.ts`. */
export const SESSION_COOKIE = "aether_session";

/**
 * Cookie con el rol del usuario, leída por `proxy.ts` para enrutar /admin.
 * NO es un control de acceso: es una pista de UI/enrutado. El acceso real a los
 * datos lo impone RLS en Postgres y la verificación del JWT en la API server.
 */
export const ROLE_COOKIE = "aether_role";

/** Roles posibles; debe coincidir con el enum `rol_usuario` de Postgres. */
export type Rol = "super_admin" | "empresa_admin" | "empresa_empleado";

/** Clave del espejo en localStorage (solo para lectura desde la UI). */
const SESSION_STORAGE_KEY = "aether:session";

/** Duración de la sesión: 7 días. */
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export type Session = { user: string };

/**
 * Guarda la sesión tras un login correcto: cookie (para el proxy) + espejo en
 * localStorage (para la UI). Solo debe llamarse desde el cliente.
 */
export function saveSession(user: string, rol?: Rol): void {
  document.cookie = `${SESSION_COOKIE}=1; path=/; max-age=${SESSION_MAX_AGE}; samesite=lax`;
  if (rol) {
    document.cookie = `${ROLE_COOKIE}=${rol}; path=/; max-age=${SESSION_MAX_AGE}; samesite=lax`;
  }
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ user } satisfies Session));
  } catch {
    // Modo privado o cuota excedida → la cookie basta para la protección.
  }
}

/** Cierra la sesión: borra cookies y espejo. Solo desde el cliente. */
export function clearSession(): void {
  document.cookie = `${SESSION_COOKIE}=; path=/; max-age=0; samesite=lax`;
  document.cookie = `${ROLE_COOKIE}=; path=/; max-age=0; samesite=lax`;
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

// ── Multi-tenant (Supabase Auth) ─────────────────────────────────────────────

/** Clave de UI: tenant cacheado SOLO para pintar la interfaz (no es seguridad). */
const TENANT_STORAGE_KEY = "aether:tenant";

export type TenantInfo = { empresaId: string; tipoNegocio: string };

/**
 * Inicia sesión, resuelve la empresa del usuario y cachea `tipo_negocio` para UI.
 * El aislamiento real lo impone RLS en Postgres: `empresa_id` aquí es
 * conveniencia, NUNCA control de acceso.
 */
export async function signIn(
  email: string,
  password: string,
): Promise<TenantInfo & { rol: Rol }> {
  const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
  if (authError) throw authError;

  const { data, error } = await supabase
    .from("usuarios")
    .select("empresa_id, rol, empresas ( tipo_negocio )")
    .single();
  if (error) throw error;

  const tenant: TenantInfo = {
    empresaId: data.empresa_id,
    // @ts-expect-error relación embebida de Supabase
    tipoNegocio: data.empresas?.tipo_negocio ?? "",
  };

  try {
    localStorage.setItem(TENANT_STORAGE_KEY, JSON.stringify(tenant));
  } catch {
    // Modo privado: la UI usará un fallback; no afecta seguridad.
  }
  return { ...tenant, rol: data.rol as Rol };
}

/** Lee el tenant cacheado (solo UI). */
export function getTenant(): TenantInfo | null {
  try {
    const raw = localStorage.getItem(TENANT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TenantInfo) : null;
  } catch {
    return null;
  }
}

export type NuevaEmpresa = {
  email: string;
  password: string;
  nombreComercial: string;
  nit?: string;
  tipoNegocio: string;
  moneda?: string;
};

/**
 * Registra una empresa nueva + su usuario admin. Los datos de la empresa viajan
 * en `options.data` (metadata); el trigger `handle_new_user` los consume para
 * crear `empresas` + `usuarios` de forma atómica.
 *
 * Devuelve `needsConfirm = true` si Supabase exige confirmar el correo antes de
 * poder iniciar sesión (según config del proyecto).
 */
export async function signUpTenant(input: NuevaEmpresa): Promise<{ needsConfirm: boolean }> {
  const { data, error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      data: {
        nombre_comercial: input.nombreComercial,
        nit: input.nit ?? null,
        tipo_negocio: input.tipoNegocio,
        moneda: input.moneda ?? "COP",
      },
    },
  });
  if (error) throw error;
  // Sin sesión activa tras signUp ⇒ el proyecto pide confirmación por correo.
  return { needsConfirm: data.session === null };
}
