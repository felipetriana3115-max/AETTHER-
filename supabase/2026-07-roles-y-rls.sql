-- ============================================================================
-- Aether ERP — Roles + Row Level Security
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor (una sola vez; es idempotente).
--
-- Decisión de arquitectura: en vez de crear una tabla `perfiles` nueva (que
-- duplicaría el mapeo usuario→empresa que ya vive en `usuarios`), añadimos el
-- rol a la tabla `usuarios` existente. `usuarios.id` ya referencia auth.users y
-- `usuarios.empresa_id` ya referencia `empresas`, así que solo faltan:
--   • usuarios.rol     → el papel del usuario
--   • usuarios.email   → copia del correo (comodidad; la verdad está en auth)
--   • empresas.estado  → ACTIVO / SUSPENDIDO (para el panel de superadmin)
--
-- El aislamiento real entre empresas lo impone RLS aquí, NO el frontend.
-- ============================================================================

begin;

-- 1) ROL en usuarios ---------------------------------------------------------
-- Enum de roles. `create type` no admite IF NOT EXISTS, así que lo envolvemos.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'rol_usuario') then
    create type public.rol_usuario as enum (
      'super_admin',      -- dueño de la plataforma: ve/gestiona todas las empresas
      'empresa_admin',    -- administrador de una empresa (tenant)
      'empresa_empleado'  -- empleado de una empresa (tenant)
    );
  end if;
end $$;

-- Columna rol. Las altas por el trigger handle_new_user (registro público)
-- quedan como 'empresa_admin' por defecto. Los super_admin se promueven a mano
-- (ver el bloque de bootstrap al final) o desde el panel /admin.
alter table public.usuarios
  add column if not exists rol public.rol_usuario not null default 'empresa_admin';

-- Copia del email para listados cómodos. La fuente de verdad sigue en auth.users.
alter table public.usuarios
  add column if not exists email text;

-- Backfill del email para filas existentes.
update public.usuarios u
set email = au.email
from auth.users au
where au.id = u.id and u.email is distinct from au.email;

-- 2) ESTADO en empresas ------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'estado_empresa') then
    create type public.estado_empresa as enum ('ACTIVO', 'SUSPENDIDO');
  end if;
end $$;

alter table public.empresas
  add column if not exists estado public.estado_empresa not null default 'ACTIVO';

-- 3) HELPERS (SECURITY DEFINER) ----------------------------------------------
-- Leer el rol/empresa del usuario actual DENTRO de una política sobre `usuarios`
-- provocaría recursión infinita. La solución estándar de Supabase es encapsular
-- la lectura en una función SECURITY DEFINER: corre como su dueño (postgres),
-- que es dueño de la tabla y por tanto salta RLS, cortando la recursión.

create or replace function public.mi_rol()
returns public.rol_usuario
language sql
stable
security definer
set search_path = public
as $$
  select rol from public.usuarios where id = auth.uid();
$$;

create or replace function public.mi_empresa()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select empresa_id from public.usuarios where id = auth.uid();
$$;

-- 4) RLS sobre usuarios ------------------------------------------------------
alter table public.usuarios enable row level security;

-- Cada usuario ve su propia fila; el super_admin ve todas.
drop policy if exists usuarios_select_propio ON public.usuarios;
create policy usuarios_select_propio on public.usuarios
  for select
  using (id = auth.uid() or public.mi_rol() = 'super_admin');

-- Solo el super_admin puede insertar/actualizar/borrar usuarios vía la API
-- normal (el resto pasa por el trigger o por la service_role, que salta RLS).
-- Evitamos un UPDATE "de mi propia fila" porque permitiría auto-escalar el rol.
drop policy if exists usuarios_admin_all ON public.usuarios;
create policy usuarios_admin_all on public.usuarios
  for all
  using (public.mi_rol() = 'super_admin')
  with check (public.mi_rol() = 'super_admin');

-- 5) RLS sobre empresas ------------------------------------------------------
alter table public.empresas enable row level security;

-- Los miembros ven SU empresa; el super_admin ve todas.
drop policy if exists empresas_select_propia ON public.empresas;
create policy empresas_select_propia on public.empresas
  for select
  using (id = public.mi_empresa() or public.mi_rol() = 'super_admin');

-- Solo el super_admin cambia estado (ACTIVO/SUSPENDIDO) u otros campos globales.
drop policy if exists empresas_update_admin ON public.empresas;
create policy empresas_update_admin on public.empresas
  for update
  using (public.mi_rol() = 'super_admin')
  with check (public.mi_rol() = 'super_admin');

commit;

-- ============================================================================
-- BOOTSTRAP DEL SUPER_ADMIN (ejecutar UNA vez, ajustando el correo)
-- ----------------------------------------------------------------------------
-- Tras crear tu usuario (por /registro o Supabase Auth), promuévelo:
--
--   update public.usuarios
--   set rol = 'super_admin'
--   where email = 'felipetriana3115@gmail.com';
--
-- Si ese usuario no debe pertenecer a ninguna empresa, deja empresa_id en NULL
-- (requiere que la columna lo permita).
-- ============================================================================
