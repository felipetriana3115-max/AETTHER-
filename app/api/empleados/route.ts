/**
 * API de gestión de EMPLEADOS (RBAC dentro de un tenant).
 *
 * Solo un admin de empresa gestiona los empleados de SU empresa. La autorización
 * real vive aquí (revalidación del JWT + rol) y en RLS; la cookie de rol del
 * proxy es solo enrutado.
 *
 *   GET   → lista los empleados de la empresa del admin.
 *   POST  → crea un empleado (Supabase Auth) YA enlazado al tenant del admin,
 *           con sus permisos. El trigger handle_new_user lo asocia a esa empresa
 *           (rule 2) gracias a la metadata { es_empleado, empresa_id, permissions }.
 *   PATCH → actualiza permisos de un empleado de la propia empresa.
 *
 * Aislamiento (rule 2/3): TODA operación se acota a `empresa_id` = la del admin.
 * Aunque se use la service_role (que salta RLS), el código filtra a mano por el
 * tenant del llamante, de modo que un admin jamás toca empleados de otra empresa.
 */
import { getSupabaseAdmin } from "@/app/lib/supabase-admin";
import { requireEmpresaAdmin, HttpError, fail } from "@/app/lib/authz-server";
import { PERMISOS } from "@/app/lib/authz";

/** Filtra la lista recibida al catálogo canónico de permisos (evita slugs sueltos). */
function sanearPermisos(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const validos = new Set<string>(PERMISOS as readonly string[]);
  return [...new Set(input.filter((p): p is string => typeof p === "string" && validos.has(p)))];
}

// ── GET: listar empleados de la empresa del admin ────────────────────────────
export async function GET(request: Request) {
  try {
    const admin = await requireEmpresaAdmin(request);
    const db = getSupabaseAdmin();

    // super_admin sin empresa no gestiona empleados por esta vía; devuelve vacío.
    if (!admin.empresaId) return Response.json({ ok: true, empleados: [] });

    const { data, error } = await db
      .from("usuarios")
      .select("id, email, nombre_comercial, rol, permissions")
      .eq("empresa_id", admin.empresaId)
      .eq("rol", "empresa_empleado")
      .order("email", { ascending: true });
    if (error) throw new HttpError(500, error.message);

    return Response.json({ ok: true, empleados: data ?? [] });
  } catch (e) {
    return fail(e);
  }
}

// ── POST: crear empleado enlazado al tenant del admin ────────────────────────
export async function POST(request: Request) {
  try {
    const admin = await requireEmpresaAdmin(request);
    if (!admin.empresaId) throw new HttpError(403, "El administrador no tiene empresa asociada.");

    const body = (await request.json()) as {
      email?: string;
      password?: string;
      nombre?: string;
      permisos?: unknown;
    };
    const email = body.email?.trim();
    const password = body.password;
    if (!email || !password) throw new HttpError(400, "Correo y contraseña son obligatorios.");

    const permisos = sanearPermisos(body.permisos);
    const db = getSupabaseAdmin();

    // Crea el usuario en Auth. La metadata la consume handle_new_user, que —al ver
    // es_empleado + empresa_id— crea la fila en `usuarios` como 'empresa_empleado'
    // dentro de la empresa del admin, SIN crear una empresa nueva.
    const { data: created, error: createErr } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        nombre_comercial: body.nombre?.trim() || email,
        es_empleado: true,
        empresa_id: admin.empresaId, // ← lo ata al tenant del admin (rule 2)
        permissions: permisos,
      },
    });
    if (createErr || !created.user) {
      throw new HttpError(400, createErr?.message ?? "No se pudo crear el empleado.");
    }

    // Defensa en profundidad: reafirma empresa/rol/permisos por si el trigger no
    // corrió, y —crucial— confirma que la empresa quedó siendo la del admin.
    const { error: updErr } = await db
      .from("usuarios")
      .update({
        rol: "empresa_empleado",
        empresa_id: admin.empresaId,
        email,
        permissions: permisos,
      })
      .eq("id", created.user.id);
    if (updErr) throw new HttpError(500, updErr.message);

    return Response.json({ ok: true, userId: created.user.id }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}

// ── PATCH: actualizar permisos de un empleado de la propia empresa ───────────
export async function PATCH(request: Request) {
  try {
    const admin = await requireEmpresaAdmin(request);
    if (!admin.empresaId) throw new HttpError(403, "El administrador no tiene empresa asociada.");

    const body = (await request.json()) as { empleadoId?: string; permisos?: unknown };
    const empleadoId = body.empleadoId;
    if (!empleadoId) throw new HttpError(400, "Falta empleadoId.");
    const permisos = sanearPermisos(body.permisos);

    const db = getSupabaseAdmin();

    // Verifica que el empleado pertenece a la empresa del admin ANTES de tocarlo:
    // impide que un admin edite empleados de otro tenant (aislamiento manual).
    const { data: empleado, error: readErr } = await db
      .from("usuarios")
      .select("id, empresa_id, rol")
      .eq("id", empleadoId)
      .single();
    if (readErr || !empleado) throw new HttpError(404, "Empleado no encontrado.");
    if (empleado.empresa_id !== admin.empresaId) {
      throw new HttpError(403, "Ese empleado no pertenece a tu empresa.");
    }
    if (empleado.rol !== "empresa_empleado") {
      throw new HttpError(400, "Solo se pueden editar permisos de empleados.");
    }

    const { error: updErr } = await db
      .from("usuarios")
      .update({ permissions: permisos })
      .eq("id", empleadoId)
      .eq("empresa_id", admin.empresaId); // doble seguro por tenant
    if (updErr) throw new HttpError(500, updErr.message);

    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
