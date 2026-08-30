-- ============================================================================
-- Aether ERP — Identidad de la tirilla en `empresas` (por tenant)
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-ampliar-empresas.sql            (columna empresas.nit, trigger alta)
--   • 2026-08-fix-helpers-security-definer.sql (mi_empresa() SECURITY DEFINER)
-- Es idempotente (add column if not exists / create or replace).
--
-- MOTIVO: los datos de identidad del recibo (NIT, dirección, teléfono, logo y
-- mensaje de agradecimiento) vivían SOLO en localStorage del navegador, así que:
--   (a) se BORRABAN al cerrar sesión (el logout purga el caché del dashboard), y
--   (b) no seguían al negocio entre equipos/navegadores.
-- Al persistirlos en la fila de la empresa quedan asociados al TENANT y
-- sobreviven al logout. El hardware de la caja (impresora/cajón/báscula) sigue en
-- localStorage porque es propio de CADA equipo, no del tenant.
--
-- SEGURIDAD / MULTITENANT: NO se tocan las políticas RLS existentes. La política
-- `empresas_update_admin` (2026-07-roles-y-rls.sql) solo deja al super_admin
-- actualizar `empresas`, por eso el guardado del tenant se hace con una RPC
-- SECURITY DEFINER que escribe EXCLUSIVAMENTE la fila `id = mi_empresa()`. Un
-- empleado/admin jamás puede tocar otra empresa aunque manipule la petición. La
-- lectura usa la política `empresas_select_propia` ya existente (id = mi_empresa()).
-- ============================================================================

begin;

-- 1) Columnas de identidad de la tirilla (nit ya existe desde 2026-07) ---------
alter table public.empresas add column if not exists direccion       text;
alter table public.empresas add column if not exists telefono        text;
-- Guarda un data URL (base64) del logo; text no tiene límite práctico en Postgres.
alter table public.empresas add column if not exists logo_url        text;
alter table public.empresas add column if not exists mensaje_recibo  text;

-- 2) RPC de guardado acotada al propio tenant ---------------------------------
-- Escribe solo la fila de la empresa del usuario autenticado. Los NULL entrantes
-- se normalizan a cadena vacía / se permiten según el campo; el cliente siempre
-- envía los cinco valores (usa '' para "sin dato").
create or replace function public.actualizar_tirilla(
  p_nit            text,
  p_direccion      text,
  p_telefono       text,
  p_logo_url       text,
  p_mensaje_recibo text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa uuid := public.mi_empresa();
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada (empresa_id nulo).'
      using errcode = '42501';
  end if;

  update public.empresas
     set nit            = nullif(btrim(coalesce(p_nit, '')), ''),
         direccion      = nullif(btrim(coalesce(p_direccion, '')), ''),
         telefono       = nullif(btrim(coalesce(p_telefono, '')), ''),
         logo_url       = nullif(p_logo_url, ''),
         mensaje_recibo = nullif(btrim(coalesce(p_mensaje_recibo, '')), '')
   where id = v_empresa;
end;
$$;

grant execute on function public.actualizar_tirilla(text, text, text, text, text)
  to authenticated;

commit;

-- Verificación rápida (como usuario de un tenant, no super_admin):
--   select public.actualizar_tirilla('900.123.456-7', 'Cra 10 #20-30', '3001112233', '', 'Gracias!');
--   select nit, direccion, telefono, mensaje_recibo from public.empresas where id = public.mi_empresa();
