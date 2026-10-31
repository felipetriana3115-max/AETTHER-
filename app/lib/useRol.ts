"use client";

import { useEffect, useState } from "react";
import { getPermisos, getRol, supabase } from "./auth";
import { esAdmin, type Rol } from "./authz";

/**
 * Rol y permisos de la sesión viva, para GATEAR LA UI (no es control de acceso).
 *
 * Resuelve en dos pasos, de menos a más autoritativo:
 *   1. Cookie-pista (`getRol`/`getPermisos`): disponible al instante tras montar,
 *      evita el parpadeo de "todo oculto" en la primera pintura del admin.
 *   2. RPC `mi_rol()` (SECURITY DEFINER): la verdad del servidor; corrige la
 *      cookie si estuviera obsoleta o manipulada. Si el RPC falla (helper aún
 *      degradado a INVOKER), se conserva la pista de la cookie.
 *
 * FAIL-CLOSED: hasta que haya un rol resuelto, `esAdministrador` es `false`, así
 * que las tarjetas financieras arrancan ocultas y solo aparecen al confirmarse
 * que quien mira es el dueño.
 *
 * RECORDATORIO DE SEGURIDAD: esto decide qué se PINTA. El acceso real a los
 * datos lo imponen RLS en Postgres y la revalidación del JWT en los Route
 * Handlers (ver `authz-server.ts`). Nunca confíes solo en esta capa.
 */
export type SesionRol = {
  rol: Rol | null;
  permisos: string[];
  /** true solo para empresa_admin / super_admin (el dueño del tenant). */
  esAdministrador: boolean;
  /** false hasta que la resolución en el cliente termina (evita mismatch SSR). */
  resuelto: boolean;
};

export function useRolSesion(): SesionRol {
  const [rol, setRol] = useState<Rol | null>(null);
  const [permisos, setPermisos] = useState<string[]>([]);
  const [resuelto, setResuelto] = useState(false);

  useEffect(() => {
    let activo = true;

    // 1) Pista inmediata desde las cookies (el servidor no las ve vía document,
    //    por eso se lee tras montar: evita desajustes de hidratación).
    setRol(getRol());
    setPermisos(getPermisos());

    // 2) Confirmación autoritativa contra el servidor.
    void supabase
      .rpc("mi_rol")
      .then(({ data, error }) => {
        if (!activo) return;
        if (error) {
          console.error("[useRolSesion] mi_rol() falló; se usa la cookie-pista:", error);
        } else {
          setRol((data as Rol | null) ?? null);
        }
        setResuelto(true);
      });

    return () => {
      activo = false;
    };
  }, []);

  return { rol, permisos, esAdministrador: esAdmin(rol), resuelto };
}
