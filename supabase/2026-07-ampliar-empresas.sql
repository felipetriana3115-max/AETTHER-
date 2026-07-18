-- ============================================================================
-- Aether ERP — Ampliar `empresas` + trigger de alta + bootstrap super_admin
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de 2026-07-roles-y-rls.sql.
-- Es idempotente.
--
-- Contexto: el esquema real de `empresas` era mínimo (id, nombre, estado) y no
-- había un trigger que poblara `usuarios`. Aquí:
--   1. Añadimos a `empresas` los campos que usa la app (tipo_negocio, nit, moneda).
--   2. Creamos `handle_new_user`: cada alta en Auth crea su empresa + su usuario
--      (rol 'empresa_admin') de forma atómica, leyendo la metadata del signUp/
--      createUser (nombre_comercial, tipo_negocio, nit, moneda).
--   3. Damos de alta la fila de `usuarios` del super_admin (que existía en Auth
--      pero no en la tabla, por eso el UPDATE anterior no afectó filas).
-- ============================================================================

begin;

-- 1) Campos que la app espera en `empresas` ----------------------------------
alter table public.empresas add column if not exists tipo_negocio text not null default 'general';
alter table public.empresas add column if not exists nit          text;
alter table public.empresas add column if not exists moneda       text not null default 'COP';

-- 2) Trigger de alta: auth.users → empresas + usuarios -----------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa_id uuid;
  v_nombre     text := coalesce(nullif(trim(new.raw_user_meta_data->>'nombre_comercial'), ''), 'Empresa sin nombre');
begin
  -- Crea la empresa a partir de la metadata (estado usa su default 'ACTIVO').
  insert into public.empresas (nombre, tipo_negocio, nit, moneda)
  values (
    v_nombre,
    coalesce(nullif(trim(new.raw_user_meta_data->>'tipo_negocio'), ''), 'general'),
    nullif(trim(new.raw_user_meta_data->>'nit'), ''),
    coalesce(nullif(trim(new.raw_user_meta_data->>'moneda'), ''), 'COP')
  )
  returning id into v_empresa_id;

  -- Crea el perfil enlazado a esa empresa, como admin de empresa.
  insert into public.usuarios (id, email, rol, empresa_id, nombre_comercial)
  values (new.id, new.email, 'empresa_admin', v_empresa_id, v_nombre)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

commit;

-- 3) BOOTSTRAP del super_admin (idempotente) ---------------------------------
-- Crea/actualiza la fila de `usuarios` del dueño de la plataforma. Sin empresa
-- (empresa_id = NULL) porque no pertenece a ningún tenant.
insert into public.usuarios (id, email, rol, empresa_id, nombre_comercial)
select au.id, au.email, 'super_admin', null, 'Super Admin'
from auth.users au
where au.email = 'felipetriana3115@gmail.com'
on conflict (id) do update set rol = 'super_admin';

-- Verificación rápida (debería listar tu correo con rol super_admin):
--   select email, rol, empresa_id from public.usuarios where rol = 'super_admin';
