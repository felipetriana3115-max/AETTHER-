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

import { createBrowserClient } from "@supabase/ssr";
import { type SupabaseClient } from "@supabase/supabase-js";

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

  client = createBrowserClient(url, anonKey);
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

/**
 * Cookie con los permisos finos del EMPLEADO (CSV, p. ej. "pos,ventas"), leída
 * por `proxy.ts` para gatear rutas. Igual que ROLE_COOKIE: es una pista de
 * enrutado/UI, NO control de acceso. El acceso real lo imponen RLS y la API.
 */
export const PERMISSIONS_COOKIE = "aether_perms";

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
export function saveSession(user: string, rol?: Rol, permisos?: readonly string[]): void {
  document.cookie = `${SESSION_COOKIE}=1; path=/; max-age=${SESSION_MAX_AGE}; samesite=lax`;
  if (rol) {
    document.cookie = `${ROLE_COOKIE}=${rol}; path=/; max-age=${SESSION_MAX_AGE}; samesite=lax`;
  }
  // Permisos finos para que el proxy pueda gatear rutas del empleado. Se escribe
  // siempre (aunque venga vacío) para no dejar una cookie obsoleta de otra sesión.
  document.cookie = `${PERMISSIONS_COOKIE}=${(permisos ?? []).join(",")}; path=/; max-age=${SESSION_MAX_AGE}; samesite=lax`;
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ user } satisfies Session));
  } catch {
    // Modo privado o cuota excedida → la cookie basta para la protección.
  }
}

/** Prefijo de TODAS las claves de caché de datos del dashboard (segmentadas por
 *  empresa). Debe coincidir con las bases de clave usadas en DashboardProvider. */
const DASHBOARD_CACHE_PREFIX = "mi-dashboard-erp";

/**
 * Claves que comparten el prefijo del dashboard pero NO son datos del tenant, sino
 * configuración del EQUIPO, y por tanto NO deben borrarse al cerrar sesión.
 *
 * `mi-dashboard-erp:devices:v1` guarda el hardware de la caja (impresora, cajón,
 * báscula, lector). Es propio de la máquina y debe persistir entre usuarios/logins
 * (debe coincidir con `DEVICES_KEY` en devices.ts). NO se importa de allí para no
 * arrastrar un módulo "use client" (con hooks de React) al runtime edge del proxy,
 * que también importa este archivo.
 */
const PRESERVED_ON_LOGOUT = new Set<string>(["mi-dashboard-erp:devices:v1"]);

/**
 * Purga de `localStorage` y `sessionStorage` el caché de datos del dashboard
 * (claves `mi-dashboard-erp*`, segmentadas por empresa), EXCEPTO las de
 * `PRESERVED_ON_LOGOUT` (hardware del equipo). Sin esta purga, el siguiente
 * usuario en el MISMO navegador podría ver métricas del tenant anterior (stock,
 * ingresos, identidad de la tirilla, etc.). Se llama en cada logout.
 */
function purgeDashboardCache(): void {
  for (const storage of [
    typeof localStorage !== "undefined" ? localStorage : null,
    typeof sessionStorage !== "undefined" ? sessionStorage : null,
  ]) {
    if (!storage) continue;
    try {
      const claves: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(DASHBOARD_CACHE_PREFIX) && !PRESERVED_ON_LOGOUT.has(k)) {
          claves.push(k);
        }
      }
      for (const k of claves) storage.removeItem(k);
    } catch {
      // storage inaccesible (modo privado) → nada que purgar.
    }
  }
}

/** Cierra la sesión: borra cookies, espejo, caché de datos y la sesión de Supabase.
 *  Solo desde el cliente. */
export function clearSession(): void {
  document.cookie = `${SESSION_COOKIE}=; path=/; max-age=0; samesite=lax`;
  document.cookie = `${ROLE_COOKIE}=; path=/; max-age=0; samesite=lax`;
  document.cookie = `${PERMISSIONS_COOKIE}=; path=/; max-age=0; samesite=lax`;
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    // Borra el tenant cacheado para que el siguiente usuario NO herede la empresa
    // del anterior en este navegador (defensa contra fuga entre cuentas).
    localStorage.removeItem(TENANT_STORAGE_KEY);
    // Y purga TODO el caché de datos del dashboard (inventario/ventas segmentados
    // por empresa) en localStorage y sessionStorage: es la fuente de fugas de
    // métricas (759 productos, tendencia de ingresos, etc.) entre cuentas.
    purgeDashboardCache();
  } catch {
    // Ignorar: si la cookie ya se borró, la sesión está cerrada.
  }
  // Invalida la empresa resuelta en memoria para el filtrado de consultas.
  empresaActivaCache = null;
  // Cierra también la sesión de Supabase. Sin esto, `supabase.auth.getUser()`
  // seguiría devolviendo el usuario anterior (y su empresa) hasta el próximo
  // login, y el provider recargaría datos del tenant que se acaba de cerrar.
  // Es asíncrono; no bloqueamos el logout esperándolo (fire-and-forget).
  void supabase.auth.signOut();
}

/** Lee el valor de una cookie por nombre (cliente). */
function leerCookie(nombre: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${nombre}=`));
  return match ? decodeURIComponent(match.slice(nombre.length + 1)) : null;
}

/** Rol del usuario actual leído de la cookie-pista (para la UI). null si no hay. */
export function getRol(): Rol | null {
  const v = leerCookie(ROLE_COOKIE);
  return v === "super_admin" || v === "empresa_admin" || v === "empresa_empleado"
    ? v
    : null;
}

/** Permisos finos del usuario actual leídos de la cookie-pista (para la UI). */
export function getPermisos(): string[] {
  const v = leerCookie(PERMISSIONS_COOKIE);
  return v ? v.split(",").filter(Boolean) : [];
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
 * Normaliza CUALQUIER error de Supabase a un `Error` con mensaje legible.
 *
 * `AuthError` extiende `Error`, pero `PostgrestError` es un objeto plano
 * (`{ message, details, hint, code }`) que NO es `instanceof Error`. Si se
 * relanza tal cual, el `catch` de la UI (`e instanceof Error ? e.message : …`)
 * cae al mensaje genérico y oculta la causa real. Esta función preserva el
 * código (p. ej. `PGRST116`, `42703`) para que el fallo sea diagnosticable.
 */
function toError(err: unknown, contexto: string): Error {
  if (err instanceof Error) {
    // AuthError trae `status`/`code` que no se ven en `.message`. Los adjuntamos
    // al texto para que el fallo sea diagnosticable directamente en la UI.
    const e = err as Error & { status?: number; code?: string };
    const extra = [
      e.status != null && `status=${e.status}`,
      e.code && `code=${e.code}`,
    ].filter(Boolean);
    if (extra.length) return new Error(`${contexto}: ${err.message} (${extra.join(", ")})`);
    return err;
  }
  if (err && typeof err === "object") {
    const e = err as {
      message?: string;
      code?: string;
      status?: number;
      details?: string;
      hint?: string;
    };
    const partes = [
      e.message,
      e.status != null && `status=${e.status}`,
      e.code && `code=${e.code}`,
      e.hint,
    ].filter(Boolean);
    return new Error(`${contexto}: ${partes.join(" ") || "error desconocido"}`);
  }
  return new Error(`${contexto}: ${String(err)}`);
}

/**
 * Inicia sesión, resuelve la empresa del usuario y cachea `tipo_negocio` para UI.
 * El aislamiento real lo impone RLS en Postgres: `empresa_id` aquí es
 * conveniencia, NUNCA control de acceso.
 */
export async function signIn(
  email: string,
  password: string,
): Promise<TenantInfo & { rol: Rol; permisos: string[] }> {
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (authError) {
    // Captura el objeto completo: distingue AuthApiError (credenciales/correo sin
    // confirmar) de un problema posterior de RLS o de fetching del perfil.
    console.error("ERROR REAL LOGIN:", authError);
    // `AuthError` ya extiende `Error`, pero normalizamos por consistencia.
    throw toError(authError, "Autenticación rechazada");
  }

  // La sesión ya está lista aquí: supabase-js la persiste tras resolver el await,
  // así que las consultas siguientes viajan autenticadas. Antes de validar el
  // rol necesitamos el id del usuario recién autenticado.
  const userId = authData.user?.id;
  if (!userId) {
    const err = new Error("La autenticación no devolvió un usuario.");
    console.error("[signIn] signInWithPassword sin user:", authData);
    throw err;
  }

  // Leemos el perfil (rol + empresa) con las funciones SECURITY DEFINER
  // `mi_rol()` y `mi_empresa()` por RPC, NO con un SELECT directo sobre `usuarios`.
  //
  // MOTIVO (evitar el bloqueo RLS/406): `usuarios` tiene RLS activo, así que un
  // SELECT directo depende de la política `usuarios_select_propio`. Si esa política
  // falta o falla, PostgREST devuelve 0 filas y responde 406, bloqueando el login.
  // Las funciones SECURITY DEFINER corren como el dueño de la tabla y SALTAN RLS
  // por diseño: resuelven el perfil del usuario autenticado (`auth.uid()`) sin
  // depender de la política de lectura. Así el login funciona pase lo que pase con
  // esa política y sin tocar la base de datos.
  const [rolRes, empresaRes, permisosRes] = await Promise.all([
    supabase.rpc("mi_rol"),
    supabase.rpc("mi_empresa"),
    // Permisos finos del empleado (helper SECURITY DEFINER `mis_permisos`). Es
    // best-effort: si falla (helper aún no desplegado), degradamos a []. El admin
    // no los necesita (su rol le da acceso total).
    supabase.rpc("mis_permisos"),
  ]);

  // La resolución del perfil NO debe tumbar el login. Si el RPC falla (p. ej. el
  // helper quedó como INVOKER y RLS lo bloquea) o si aún no existe la fila del
  // usuario en `usuarios` (el trigger de alta no corrió), registramos el error
  // técnico completo y degradamos a valores por defecto. El aislamiento real lo
  // impone RLS en Postgres; `empresa_id`/`rol` aquí son solo pistas de UI/enrutado.
  if (rolRes.error) {
    console.error("[signIn] mi_rol() falló (login continúa):", rolRes.error, "userId:", userId);
  }
  if (empresaRes.error) {
    console.error("[signIn] mi_empresa() falló (login continúa):", empresaRes.error, "userId:", userId);
  }

  let rolResuelto = (rolRes.data as Rol | null) ?? null;
  let empresaResuelta = (empresaRes.data as string | null) ?? null;

  // FALLBACK NO FATAL: si los RPC no resolvieron el perfil (p. ej. los helpers
  // quedaron como INVOKER y RLS los bloquea, o el trigger de alta aún no creó la
  // fila), intentamos un SELECT directo sobre `usuarios` con `maybeSingle()`.
  //
  // `maybeSingle()` es clave: a diferencia de `single()`, si RLS filtra la fila y
  // devuelve 0 resultados NO lanza el 406 "Not Acceptable" que bloqueaba el login;
  // simplemente retorna `data: null`. Todo el bloque es best-effort: cualquier
  // error se registra y se degrada a los valores por defecto, jamás detiene el
  // login. El aislamiento real lo sigue imponiendo RLS en Postgres.
  if (rolResuelto === null || empresaResuelta === null) {
    const { data: perfil, error: perfilError } = await supabase
      .from("usuarios")
      .select("rol, empresa_id")
      .eq("id", userId)
      .maybeSingle();
    if (perfilError) {
      console.error(
        "[signIn] Fallback SELECT a 'usuarios' falló (login continúa):",
        perfilError,
        "userId:",
        userId,
      );
    } else if (perfil) {
      rolResuelto = rolResuelto ?? ((perfil.rol as Rol | null) ?? null);
      empresaResuelta = empresaResuelta ?? ((perfil.empresa_id as string | null) ?? null);
    }
  }

  // Rol por defecto seguro: si no se pudo resolver, tratamos al usuario como
  // 'empresa_empleado' (ruta al dashboard). NUNCA 'super_admin' por defecto.
  const rol = rolResuelto ?? "empresa_empleado";
  if (rolResuelto === null) {
    console.warn(
      "[signIn] Usuario autenticado sin rol resuelto en 'usuarios'; usando 'empresa_empleado' " +
        "por defecto. Aplica 2026-08-fix-helpers-security-definer.sql para que mi_rol()/mi_empresa() " +
        "sean SECURITY DEFINER y salten RLS.",
      "userId:",
      userId,
    );
  }
  const empresaId = empresaResuelta;

  // `tipo_negocio` es solo para UI. El super_admin no tiene empresa, por eso se
  // consulta solo si hay empresa_id. Si RLS lo bloquea, la UI usa un fallback vacío.
  let tipoNegocio = "";
  if (empresaId) {
    const { data: emp } = await supabase
      .from("empresas")
      .select("tipo_negocio")
      .eq("id", empresaId)
      .maybeSingle();
    tipoNegocio = emp?.tipo_negocio ?? "";
  }

  // Permisos finos: array de strings o [] ante cualquier error/degradación.
  const permisos: string[] =
    !permisosRes.error && Array.isArray(permisosRes.data)
      ? (permisosRes.data as string[])
      : [];
  if (permisosRes.error) {
    console.error("[signIn] mis_permisos() falló (login continúa):", permisosRes.error);
  }

  const tenant: TenantInfo = { empresaId: empresaId as string, tipoNegocio };

  try {
    localStorage.setItem(TENANT_STORAGE_KEY, JSON.stringify(tenant));
  } catch {
    // Modo privado: la UI usará un fallback; no afecta seguridad.
  }
  return { ...tenant, rol, permisos };
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

/**
 * Caché en memoria de la empresa del usuario autenticado. Se llena en la primera
 * resolución y se invalida en `clearSession()` (y cuando cambia el usuario).
 */
let empresaActivaCache: { userId: string; empresaId: string | null } | null = null;

/**
 * Resuelve el `empresa_id` del usuario AUTENTICADO desde la sesión viva (no desde
 * localStorage, que podría estar obsoleto). Fuente autoritativa para el filtrado
 * explícito por empresa (defensa en profundidad sobre RLS).
 *
 * Devuelve `null` si no hay sesión activa o el usuario no tiene empresa
 * (p. ej. super_admin). Ante ese `null`, las lecturas NO deben ejecutarse y
 * deben devolver vacío/0 — nunca datos de otra empresa.
 */
export async function getEmpresaIdActiva(): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    empresaActivaCache = null;
    return null;
  }
  // Reutiliza la resolución previa mientras siga siendo el MISMO usuario.
  if (empresaActivaCache?.userId === user.id) return empresaActivaCache.empresaId;

  // Igual que en `signIn`: se resuelve con la función SECURITY DEFINER `mi_empresa()`
  // (por RPC) en vez de un SELECT directo sobre `usuarios`, para no depender de la
  // política RLS de esa tabla ni chocar con un posible bloqueo/406.
  const { data, error } = await supabase.rpc("mi_empresa");
  const empresaId = error ? null : ((data as string | null) ?? null);
  empresaActivaCache = { userId: user.id, empresaId };
  return empresaId;
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
