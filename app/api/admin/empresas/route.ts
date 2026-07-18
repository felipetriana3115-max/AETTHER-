/**
 * API del panel de superadministrador. Todas las operaciones exigen que el
 * llamante sea 'super_admin':
 *
 *   1. El cliente (/admin) manda su JWT en `Authorization: Bearer <token>`.
 *   2. Aquí lo validamos con la service_role y confirmamos rol='super_admin'
 *      en la tabla `usuarios`.
 *
 * La cookie de rol del proxy es solo una pista de enrutado; la autorización
 * REAL vive aquí (revalidación del JWT) y en RLS.
 *
 *   GET   → lista de empresas
 *   POST  → crea empresa + usuario admin (Supabase Auth)
 *   PATCH → cambia el estado de una empresa (ACTIVO/SUSPENDIDO)
 */
import { getSupabaseAdmin } from "@/app/lib/supabase-admin";

/** Valida el Bearer token y exige rol super_admin. Devuelve el id del usuario. */
async function requireSuperAdmin(request: Request): Promise<string> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) throw new HttpError(401, "Falta el token de sesión.");

  const admin = getSupabaseAdmin();
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData.user) throw new HttpError(401, "Sesión inválida.");

  const { data: perfil, error: perfilErr } = await admin
    .from("usuarios")
    .select("rol")
    .eq("id", userData.user.id)
    .single();
  if (perfilErr) throw new HttpError(403, "No se pudo verificar el rol.");
  if (perfil?.rol !== "super_admin") throw new HttpError(403, "Requiere rol super_admin.");

  return userData.user.id;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function fail(e: unknown) {
  if (e instanceof HttpError) {
    return Response.json({ ok: false, error: e.message }, { status: e.status });
  }
  const msg = e instanceof Error ? e.message : "Error inesperado.";
  return Response.json({ ok: false, error: msg }, { status: 500 });
}

// ── GET: listar empresas ─────────────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    await requireSuperAdmin(request);
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from("empresas")
      .select("*")
      .order("nombre", { ascending: true });
    if (error) throw new HttpError(500, error.message);
    return Response.json({ ok: true, empresas: data ?? [] });
  } catch (e) {
    return fail(e);
  }
}

// ── POST: crear empresa + usuario admin ──────────────────────────────────────
export async function POST(request: Request) {
  try {
    await requireSuperAdmin(request);
    const body = (await request.json()) as {
      email?: string;
      password?: string;
      nombreComercial?: string;
      nit?: string;
      tipoNegocio?: string;
      moneda?: string;
    };

    const email = body.email?.trim();
    const password = body.password;
    const nombreComercial = body.nombreComercial?.trim();
    if (!email || !password || !nombreComercial) {
      throw new HttpError(400, "Correo, contraseña y nombre comercial son obligatorios.");
    }

    const admin = getSupabaseAdmin();

    // Crear el usuario en Auth. La metadata la consume el trigger
    // handle_new_user para poblar `empresas` + `usuarios` de forma atómica.
    // email_confirm: true → queda confirmado y puede iniciar sesión ya.
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        nombre_comercial: nombreComercial,
        nit: body.nit?.trim() || null,
        tipo_negocio: body.tipoNegocio || "general",
        moneda: body.moneda || "COP",
      },
    });
    if (createErr || !created.user) {
      throw new HttpError(400, createErr?.message ?? "No se pudo crear el usuario.");
    }

    // Asegurar rol de admin de empresa + email en la fila creada por el trigger.
    const { error: updErr } = await admin
      .from("usuarios")
      .update({ rol: "empresa_admin", email })
      .eq("id", created.user.id);
    if (updErr) throw new HttpError(500, updErr.message);

    return Response.json({ ok: true, userId: created.user.id }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}

// ── PATCH: cambiar estado de una empresa ─────────────────────────────────────
export async function PATCH(request: Request) {
  try {
    await requireSuperAdmin(request);
    const body = (await request.json()) as { empresaId?: string; estado?: string };
    const { empresaId, estado } = body;
    if (!empresaId) throw new HttpError(400, "Falta empresaId.");
    if (estado !== "ACTIVO" && estado !== "SUSPENDIDO") {
      throw new HttpError(400, "estado debe ser 'ACTIVO' o 'SUSPENDIDO'.");
    }

    const admin = getSupabaseAdmin();
    const { error } = await admin.from("empresas").update({ estado }).eq("id", empresaId);
    if (error) throw new HttpError(500, error.message);

    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
