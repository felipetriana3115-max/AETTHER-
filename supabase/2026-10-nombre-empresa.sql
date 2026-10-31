-- ============================================================================
-- Aether ERP — Nombre visible de la empresa persistido por tenant
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-roles-y-rls.sql                  (helpers mi_empresa() / mi_rol())
--   • 2026-07-ampliar-empresas.sql             (trigger de alta handle_new_user)
--   • 2026-08-fix-helpers-security-definer.sql (helpers SECURITY DEFINER)
-- Es idempotente (create or replace).
--
-- MOTIVO: el "Nombre visible" de Configuración vivía SOLO en localStorage
-- (`mi-dashboard-erp:businessName:v1:<empresa_id>`). Como el logout purga todas
-- las claves con prefijo `mi-dashboard-erp` (ver purgeDashboardCache en
-- app/lib/auth.ts), al reingresar el nombre volvía al defecto "Mi Empresa".
-- Aquí se persiste en la fila del tenant (`empresas.nombre`), igual que ya se
-- hace con la identidad de la tirilla.
--
-- SEGURIDAD / MULTITENANT: NO se relaja ninguna política RLS. La política
-- `empresas_update_admin` (2026-07-roles-y-rls.sql) solo deja al super_admin
-- escribir en `empresas`, así que el guardado del tenant va por una RPC
-- SECURITY DEFINER que:
--   (a) escribe EXCLUSIVAMENTE la fila `id = mi_empresa()`, y
--   (b) exige rol de administrador (empresa_admin | super_admin).
-- Un empleado no puede renombrar la empresa aunque manipule la petición. La
-- lectura usa la política `empresas_select_propia` ya existente.
-- ============================================================================

begin;

create or replace function public.actualizar_nombre_empresa(p_nombre text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa uuid := public.mi_empresa();
  v_rol     text := public.mi_rol()::text;
  v_nombre  text := nullif(btrim(coalesce(p_nombre, '')), '');
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada (empresa_id nulo).'
      using errcode = '42501';
  end if;

  -- Solo el dueño/admin del tenant renombra la empresa; el empleado operativo no.
  if v_rol is null or v_rol not in ('empresa_admin', 'super_admin') then
    raise exception 'Solo el administrador puede cambiar el nombre de la empresa.'
      using errcode = '42501';
  end if;

  if v_nombre is null then
    raise exception 'El nombre de la empresa no puede estar vacío.'
      using errcode = '22023';
  end if;

  update public.empresas
     set nombre = v_nombre
   where id = v_empresa;

  -- `usuarios.nombre_comercial` es una copia desnormalizada que escribe el
  -- trigger de alta; se mantiene en sintonía para todo el tenant (acotado a
  -- `v_empresa`, nunca toca usuarios de otra empresa).
  update public.usuarios
     set nombre_comercial = v_nombre
   where empresa_id = v_empresa;

  return v_nombre;
end;
$$;

-- Sin este GRANT, PostgREST responde 403 "permission denied for function ...".
grant execute on function public.actualizar_nombre_empresa(text) to authenticated;

commit;

-- Verificación rápida (como admin de un tenant, no super_admin):
--   select public.actualizar_nombre_empresa('Tienda La Esquina');
--   select nombre from public.empresas where id = public.mi_empresa();
-- Y como empleado debe fallar con 42501:
--   select public.actualizar_nombre_empresa('Hackeada');
