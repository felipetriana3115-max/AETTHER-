/**
 * RBAC — catálogo de permisos y mapeo ruta → permiso (fuente única de verdad).
 *
 * Este módulo es PURO (sin dependencias de red) para poder importarse tanto en
 * el `proxy.ts` (servidor, antes de renderizar) como en la UI cliente y en los
 * Route Handlers. Debe mantenerse en sincronía con:
 *   • el enum `rol_usuario` de Postgres (super_admin | empresa_admin | empresa_empleado)
 *   • el catálogo de `usuarios.permissions` (CHECK en 2026-08-rbac-permisos.sql)
 *
 * RECORDATORIO DE SEGURIDAD: lo que hay aquí gobierna el ENRUTADO/UI. El control
 * de acceso REAL a los datos lo imponen (a) RLS en Postgres y (b) la revalidación
 * del JWT + permisos en cada Route Handler (ver app/lib/authz-server.ts). Nunca
 * confíes solo en esta capa.
 */

/** Roles tal cual viven en Postgres (enum `rol_usuario`). */
export type Rol = "super_admin" | "empresa_admin" | "empresa_empleado";

/**
 * Roles del enunciado ('admin' | 'employee'). El super_admin no es un tenant;
 * se trata como 'admin' a efectos de UI dentro de esta app de empresa.
 */
export type RoleApp = "admin" | "employee";

/** Catálogo canónico de permisos finos (debe coincidir con el CHECK del SQL). */
export const PERMISOS = [
  "pos",
  "inventario",
  "compras",
  "ventas",
  "clientes",
  "reportes",
  "dashboard",
] as const;

export type Permiso = (typeof PERMISOS)[number];

/** Etiquetas legibles para la UI de gestión de empleados. */
export const PERMISO_LABELS: Record<Permiso, string> = {
  pos: "POS y caja",
  inventario: "Inventario",
  compras: "Compras",
  ventas: "Ventas (historial)",
  clientes: "Clientes y fiados",
  reportes: "Reportes",
  dashboard: "Panel principal",
};

/**
 * Mapa ruta → permiso requerido. Cada entrada es un prefijo de ruta; se elige la
 * coincidencia MÁS LARGA (la más específica) para decidir el permiso. Las rutas
 * NO listadas aquí son accesibles para cualquier sesión válida (p. ej. /perfil).
 */
export const RUTA_PERMISO: ReadonlyArray<{ prefijo: string; permiso: Permiso }> = [
  { prefijo: "/dashboard/pos", permiso: "pos" },
  { prefijo: "/caja", permiso: "pos" },
  { prefijo: "/inventario", permiso: "inventario" },
  { prefijo: "/compras", permiso: "compras" },
  { prefijo: "/ventas", permiso: "ventas" },
  { prefijo: "/clientes", permiso: "clientes" },
  { prefijo: "/reportes", permiso: "reportes" },
  { prefijo: "/", permiso: "dashboard" }, // el panel principal exige 'dashboard'
];

/**
 * Rutas reservadas SOLO al admin de empresa (no dependen de un permiso fino: son
 * de gestión del tenant, p. ej. dar de alta empleados). Prefijos.
 */
export const RUTAS_SOLO_ADMIN: readonly string[] = ["/empleados"];

/** true si la ruta es de administración de empresa. */
export function esRutaSoloAdmin(pathname: string): boolean {
  return RUTAS_SOLO_ADMIN.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/** true si el rol es administrador (acceso total en su tenant). */
export function esAdmin(rol: Rol | null | undefined): boolean {
  return rol === "empresa_admin" || rol === "super_admin";
}

/** Traduce el enum de Postgres al rol del enunciado. */
export function aRoleApp(rol: Rol | null | undefined): RoleApp {
  return esAdmin(rol) ? "admin" : "employee";
}

/** Devuelve el permiso requerido por una ruta, o null si es libre para toda sesión. */
export function permisoDeRuta(pathname: string): Permiso | null {
  let mejor: { prefijo: string; permiso: Permiso } | null = null;
  for (const entrada of RUTA_PERMISO) {
    const coincide =
      pathname === entrada.prefijo ||
      (entrada.prefijo === "/"
        ? pathname === "/"
        : pathname.startsWith(`${entrada.prefijo}/`) || pathname === entrada.prefijo);
    if (coincide && (!mejor || entrada.prefijo.length > mejor.prefijo.length)) {
      mejor = entrada;
    }
  }
  return mejor?.permiso ?? null;
}

/**
 * ¿Puede este usuario acceder a `pathname`?
 *   • admin/super_admin → siempre (acceso total en su tenant).
 *   • empleado → solo si la ruta no requiere permiso, o si tiene ese permiso.
 */
export function puedeAcceder(
  rol: Rol | null | undefined,
  permisos: readonly string[],
  pathname: string,
): boolean {
  if (esAdmin(rol)) return true;
  // Zonas de administración: vetadas a empleados aunque no exijan un permiso fino.
  if (esRutaSoloAdmin(pathname)) return false;
  const requerido = permisoDeRuta(pathname);
  if (!requerido) return true; // ruta libre para cualquier sesión válida
  return permisos.includes(requerido);
}

/**
 * Primera ruta que un empleado SÍ puede ver, para redirigirlo ahí cuando entra a
 * una zona prohibida (evita bucles de redirección a una raíz que tampoco puede
 * ver). Si no tiene ningún permiso, se le manda a /sin-acceso.
 */
export function rutaInicioEmpleado(permisos: readonly string[]): string {
  const orden: Array<{ permiso: Permiso; ruta: string }> = [
    { permiso: "dashboard", ruta: "/" },
    { permiso: "pos", ruta: "/dashboard/pos" },
    { permiso: "ventas", ruta: "/ventas" },
    { permiso: "inventario", ruta: "/inventario" },
    { permiso: "compras", ruta: "/compras" },
    { permiso: "clientes", ruta: "/clientes" },
    { permiso: "reportes", ruta: "/reportes" },
  ];
  for (const { permiso, ruta } of orden) {
    if (permisos.includes(permiso)) return ruta;
  }
  return "/sin-acceso";
}

/** Serializa/parsea permisos para la cookie-pista que lee el proxy. */
export function serializarPermisos(permisos: readonly string[]): string {
  return permisos.join(",");
}

export function parsearPermisos(valor: string | undefined | null): Permiso[] {
  if (!valor) return [];
  return valor
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is Permiso => (PERMISOS as readonly string[]).includes(p));
}
