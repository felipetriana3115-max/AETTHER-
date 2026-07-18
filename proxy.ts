import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, ROLE_COOKIE } from "./app/lib/auth";

/**
 * Proxy de autenticación.
 *
 * En Next.js 16 el convenio `middleware.ts` fue renombrado a `proxy.ts` y la
 * función debe llamarse `proxy` (ver node_modules/next/dist/docs/.../proxy.md).
 * Se ejecuta en el servidor, antes de renderizar cualquier ruta.
 *
 * Reglas:
 *   1. Sin cookie de sesión, toda ruta protegida redirige a /login.
 *   2. Un usuario autenticado que visite /login vuelve al dashboard.
 *   3. /admin es solo para 'super_admin'; cualquier otro rol vuelve al
 *      dashboard básico (/).
 *
 * NOTA de seguridad: el rol viaja en una cookie (`ROLE_COOKIE`) que es una
 * pista de enrutado, NO un control de acceso. El acceso real a datos lo impone
 * RLS en Postgres, y la API server (`/api/admin/*`) revalida el JWT y el rol.
 */

/** Rutas públicas que NO requieren sesión. */
const PUBLIC_PATHS = ["/login", "/registro"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_COOKIE);
  const isPublic = PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );

  // Sin sesión en ruta protegida → al login.
  if (!hasSession && !isPublic) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Con sesión intentando ver el login → al dashboard.
  if (hasSession && isPublic) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Zona de superadmin: solo 'super_admin' entra a /admin.
  const isAdminZone = pathname === "/admin" || pathname.startsWith("/admin/");
  if (hasSession && isAdminZone) {
    const rol = request.cookies.get(ROLE_COOKIE)?.value;
    if (rol !== "super_admin") {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  // Se ejecuta en todas las rutas salvo API, assets estáticos, imágenes y favicon.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
