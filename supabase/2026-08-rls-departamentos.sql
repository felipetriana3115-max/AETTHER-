-- ============================================================================
-- Aether ERP — RLS sobre `departamentos` (CIERRE DE BRECHA MULTI-TENANT)
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de 2026-07-roles-y-rls.sql
-- (necesita los helpers `public.mi_empresa()` y `public.mi_rol()`).
-- Es idempotente (se puede correr varias veces sin efectos secundarios).
--
-- MISMA BRECHA QUE `productos` (ver 2026-08-rls-productos.sql)
-- ------------------------------------------------------------
-- `public.departamentos` también se creó FUERA de los scripts versionados y
-- nunca se le activó Row Level Security. La lee `ProductForm.tsx` (selector de
-- departamento) e `inventario/page.tsx` (embed `departamentos(nombre)`), ambos
-- asumiendo que "RLS ya los aísla por empresa" — cosa que NO era cierta. Sin
-- RLS, un usuario autenticado veía los departamentos de TODAS las empresas.
--
-- ⚠️  A DIFERENCIA de `productos`, en el código NO existe ningún INSERT en
-- `departamentos` (no hay UI de alta de departamentos): las filas actuales son
-- data sembrada a mano, probablemente SIN `empresa_id`. Léelo bien:
--   • Este script añade `empresa_id` si falta y activa RLS por empresa.
--   • Toda fila con `empresa_id IS NULL` (las que ya existen) quedará INVISIBLE
--     para los usuarios normales tras la RLS — que es justo lo correcto si eran
--     demo/globales. Si algún tenant REAL ya usaba esos departamentos y quieres
--     conservárselos, usa el BACKFILL del bloque final ANTES de asumir que se
--     perdieron (no se borran; solo dejan de verse hasta asignarles empresa).
-- ============================================================================

begin;

-- 1) Garantiza la columna de tenant y su DEFAULT --------------------------------
alter table public.departamentos
  add column if not exists empresa_id uuid;

-- DEFAULT = empresa del usuario autenticado, para que un futuro alta de
-- departamento no tenga que enviarlo y el `with check` de RLS se cumpla igual.
alter table public.departamentos
  alter column empresa_id set default public.mi_empresa();

-- FK a empresas (borra los departamentos si se elimina la empresa). Solo si no
-- hay ya una FK sobre esa columna, para no duplicarla.
do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
     and tc.table_schema   = kcu.table_schema
    where tc.table_schema = 'public'
      and tc.table_name   = 'departamentos'
      and tc.constraint_type = 'FOREIGN KEY'
      and kcu.column_name = 'empresa_id'
  ) then
    alter table public.departamentos
      add constraint departamentos_empresa_id_fkey
      foreign key (empresa_id) references public.empresas (id) on delete cascade;
  end if;
end $$;

-- Índice para el filtrado por empresa.
create index if not exists departamentos_empresa_id_idx on public.departamentos (empresa_id);

-- 2) Activa Row Level Security --------------------------------------------------
alter table public.departamentos enable row level security;
alter table public.departamentos force row level security;

-- 3) Políticas: cada empresa solo ve/gestiona SUS departamentos -----------------
-- Lectura: miembros ven los de SU empresa; el super_admin ve todos. Las filas con
-- empresa_id NULL quedan invisibles para todos salvo super_admin.
drop policy if exists departamentos_select_propia on public.departamentos;
create policy departamentos_select_propia on public.departamentos
  for select
  using (empresa_id = public.mi_empresa() or public.mi_rol() = 'super_admin');

-- Inserción: solo para la PROPIA empresa (DEFAULT mi_empresa() lo rellena).
drop policy if exists departamentos_insert_propia on public.departamentos;
create policy departamentos_insert_propia on public.departamentos
  for insert
  with check (empresa_id = public.mi_empresa());

-- Actualización: solo los de la propia empresa, sin poder reasignarlos a otra.
drop policy if exists departamentos_update_propia on public.departamentos;
create policy departamentos_update_propia on public.departamentos
  for update
  using (empresa_id = public.mi_empresa())
  with check (empresa_id = public.mi_empresa());

-- Borrado: solo los de la propia empresa.
drop policy if exists departamentos_delete_propia on public.departamentos;
create policy departamentos_delete_propia on public.departamentos
  for delete
  using (empresa_id = public.mi_empresa());

commit;

-- ============================================================================
-- VERIFICACIÓN Y BACKFILL (ejecutar a mano, opcional)
-- ----------------------------------------------------------------------------
-- 1) Confirmar que RLS quedó ACTIVA:
--    select relname, relrowsecurity, relforcerowsecurity
--    from pg_class where relname = 'departamentos';
--
-- 2) Listar los departamentos HUÉRFANOS (sin empresa) que quedaron invisibles:
--    select id, nombre, empresa_id from public.departamentos where empresa_id is null;
--
-- 3) BACKFILL: si esos departamentos huérfanos pertenecen de verdad a una empresa
--    concreta y quieres conservárselos, asígnaselos (ajusta el email del dueño).
--    Ejecutar desde el SQL Editor (postgres salta RLS):
--    update public.departamentos
--    set empresa_id = (
--      select u.empresa_id from public.usuarios u
--      where u.email = 'CORREO_DEL_DUENO@ejemplo.com'
--    )
--    where empresa_id is null;
--
--    -- o, si eran solo demo y no interesan, borrarlos (irreversible):
--    -- delete from public.departamentos where empresa_id is null;
-- ============================================================================
