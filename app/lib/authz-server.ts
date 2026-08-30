/**
 * Autorización REAL del lado servidor para Route Handlers.
 *
 * El proxy solo enruta según cookies-pista; la autorización de verdad vive aquí:
 * cada endpoint valida el JWT de Supabase (Authorization: Bearer <token>) con la
 * service_role y relee rol/empresa/permisos desde la tabla `usuarios` (fuente de
 * verdad), NUNCA desde el cliente. Es la contraparte de app/lib/authz.ts (que es
 * puro y solo gobierna UI/enrutado).
 *
 * Solo se importa desde código server (Route Handlers): usa getSupabaseAdmin().
 */
import { getSupabaseAdmin } from "@/app/lib/supabase-admin";
import { esAdmin, type Permiso, type Rol } from "@/app/lib/authz";

/** Error con status HTTP para responder de forma uniforme desde los handlers. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Respuesta JSON de error estándar `{ ok: false, error }`. */
export function fail(e: unknown) {
  if (e instanceof HttpError) {
    return Response.json({ ok: false, error: e.message }, { status: e.status });
  }
  const msg = e instanceof Error ? e.message : "Error inesperado.";
  return Response.json({ ok: false, error: msg }, { status: 500 });
}

/** Perfil autenticado, resuelto desde `usuarios` con la service_role. */
export type Caller = {
  id: string;
  rol: Rol;
  empresaId: string | null;
  permisos: string[];
};

/**
 * Valida el Bearer token y devuelve el perfil del llamante leído de `usuarios`.
 * Lanza 401 si no hay token válido, 403 si no existe perfil.
 */
export async function requireUser(request: Request): Promise<Caller> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) throw new HttpError(401, "Falta el token de sesión.");

  const admin = getSupabaseAdmin();
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData.user) throw new HttpError(401, "Sesión inválida.");

  const { data: perfil, error: perfilErr } = await admin
    .from("usuarios")
    .select("rol, empresa_id, permissions")
    .eq("id", userData.user.id)
    .single();
  if (perfilErr || !perfil) throw new HttpError(403, "No se pudo verificar el perfil.");

  return {
    id: userData.user.id,
    rol: perfil.rol as Rol,
    empresaId: (perfil.empresa_id as string | null) ?? null,
    permisos: (perfil.permissions as string[] | null) ?? [],
  };
}

/**
 * Exige que el llamante sea ADMIN (empresa_admin o super_admin). Devuelve su
 * perfil. Un super_admin no tiene empresa; los endpoints que operen sobre un
 * tenant concreto deben validar `empresaId` aparte.
 */
export async function requireAdmin(request: Request): Promise<Caller> {
  const caller = await requireUser(request);
  if (!esAdmin(caller.rol)) throw new HttpError(403, "Requiere rol de administrador.");
  return caller;
}

/**
 * Exige que el llamante sea admin de empresa CON tenant asignado. Es el guard de
 * los endpoints que gestionan recursos de una empresa (p. ej. sus empleados).
 */
export async function requireEmpresaAdmin(request: Request): Promise<Caller & { empresaId: string }> {
  const caller = await requireAdmin(request);
  if (caller.rol === "empresa_admin" && !caller.empresaId) {
    throw new HttpError(403, "El administrador no tiene empresa asociada.");
  }
  return caller as Caller & { empresaId: string };
}

/**
 * Exige un permiso concreto (además de sesión válida). El admin/super_admin lo
 * cumple siempre; el empleado solo si lo tiene en su array. Espejo server de
 * `tengo_permiso()` de Postgres, para gatear acciones en endpoints propios.
 */
export async function requirePermiso(request: Request, permiso: Permiso): Promise<Caller> {
  const caller = await requireUser(request);
  if (esAdmin(caller.rol)) return caller;
  if (!caller.permisos.includes(permiso)) {
    throw new HttpError(403, `Requiere el permiso '${permiso}'.`);
  }
  return caller;
}
