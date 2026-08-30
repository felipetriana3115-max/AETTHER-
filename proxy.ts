import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, ROLE_COOKIE, PERMISSIONS_COOKIE } from "./app/lib/auth";
import {
  parsearPermisos,
  puedeAcceder,
  rutaInicioEmpleado,
  type Rol,
} from "./app/lib/authz";

/**
 * Proxy de autenticación + autorización por rol/permiso.
 *
 * En Next.js 16 el convenio `middleware.ts` fue renombrado a `proxy.ts` y la
 * función debe llamarse `proxy` (ver node_modules/next/dist/docs/.../proxy.md).
 * Se ejecuta en el servidor, antes de renderizar cualquier ruta.
 *
 * Reglas:
 *   1. Sin cookie de sesión, toda ruta protegida redirige a /login.
 *   2. Un usuario autenticado que visite /login vuelve al dashboard.
 *   3. /admin es solo para 'super_admin'; cualquier otro rol vuelve a /.
 *   4. RBAC: el ADMIN de empresa entra a todo su tenant; el EMPLEADO solo a las
 *      rutas cubiertas por sus `permissions` (p. ej. solo 'pos'). Si intenta
 *      entrar a una zona prohibida, se le redirige a su primera ruta permitida.
 *
 * NOTA de seguridad: rol y permisos viajan en cookies-pista (`ROLE_COOKIE`,
 * `PERMISSIONS_COOKIE`) para ENRUTADO/UI, NO son control de acceso. El acceso
 * real a los datos lo imponen RLS en Postgres y la revalidación del JWT en los
 * Route Handlers (/api/*). Un empleado que falsee la cookie de permisos podría
 * "ver" una pantalla, pero RLS le negaría toda lectura/escritura fuera de su rol.
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

  // A partir de aquí, sesión activa en ruta protegida. Resolvemos rol y permisos.
  if (hasSession && !isPublic) {
    const rol = (request.cookies.get(ROLE_COOKIE)?.value ?? null) as Rol | null;
    const permisos = parsearPermisos(request.cookies.get(PERMISSIONS_COOKIE)?.value);

    // Zona de superadmin: solo 'super_admin' entra a /admin.
    const isAdminZone = pathname === "/admin" || pathname.startsWith("/admin/");
    if (isAdminZone && rol !== "super_admin") {
      return NextResponse.redirect(new URL("/", request.url));
    }

    // La página "sin acceso" siempre es visible (evita bucles de redirección).
    const esSinAcceso = pathname === "/sin-acceso";

    // RBAC de rutas: el empleado solo entra donde sus permisos lo autorizan.
    if (!isAdminZone && !esSinAcceso && !puedeAcceder(rol, permisos, pathname)) {
      const destino = rutaInicioEmpleado(permisos);
      // Si su ruta de inicio es la misma que la actual, cae a /sin-acceso para
      // no redirigir en bucle sobre una ruta que tampoco puede ver.
      const url = new URL(destino === pathname ? "/sin-acceso" : destino, request.url);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Se ejecuta en todas las rutas salvo API, assets estáticos, imágenes, favicon
  // y los archivos de la PWA. El manifest y el service worker se piden SIN
  // credenciales (o deben cargar antes del login), así que no pueden redirigir a
  // /login: se excluyen aquí para que la app siga siendo instalable y offline.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icon-192.png|icon-512.png|icon-maskable-512.png).*)",
  ],
};
