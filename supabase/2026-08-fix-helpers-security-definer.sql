-- ============================================================================
-- Aether ERP — FIX: helpers multi-tenant como SECURITY DEFINER
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor. Idempotente (se puede correr varias veces).
--
-- SÍNTOMA QUE RESUELVE
-- --------------------
-- Al guardar un producto:
--   new row violates row-level security policy for table "productos"
--
-- CAUSA RAÍZ (dos caras del mismo problema)
-- -----------------------------------------
-- `productos.empresa_id` tiene DEFAULT public.mi_empresa() y la policy de INSERT
-- exige `empresa_id = public.mi_empresa()`. Ese WITH CHECK falla si:
--   (a) mi_empresa() quedó como SECURITY INVOKER: dentro de una policy sobre
--       `usuarios` dispara recursión / no resuelve la empresa y devuelve NULL
--       (NULL = NULL es NULL, tratado como falso => se deniega el INSERT); o
--   (b) NO existe ninguna policy de INSERT en `productos` (RLS activa sin
--       políticas => deny by default), que es justo lo que pasa si antes se
--       corrió la versión de este script que empezaba con DROP ... CASCADE.
--
-- ⚠️  POR QUÉ ESTE SCRIPT YA NO USA "DROP FUNCTION ... CASCADE":
-- mi_empresa()/mi_rol() son referenciadas por las policies y RPCs de TODAS las
-- tablas multi-tenant (usuarios, empresas, productos, ventas, clientes, fiados,
-- departamentos, ...). Un DROP ... CASCADE borra en silencio esas policies y
-- deja las tablas con RLS activa pero SIN políticas => todo INSERT queda
-- denegado. Por eso aquí usamos ALTER FUNCTION: cambia la propiedad de
-- seguridad SIN tocar las funciones ni sus dependencias.
-- ============================================================================

begin;

-- 1) Forzar SECURITY DEFINER + search_path fijo, preservando las policies.
-- `set search_path = public` es OBLIGATORIO en funciones SECURITY DEFINER: sin
-- él un atacante puede anteponer un esquema propio al search_path de la sesión y
-- secuestrar la resolución de `usuarios` (escalada de privilegios). Además fija
-- la resolución de nombres cuando la función corre dentro de una policy RLS.
alter function public.mi_empresa() security definer;
alter function public.mi_empresa() set search_path = public;

alter function public.mi_rol() security definer;
alter function public.mi_rol() set search_path = public;

-- 2) Auto-sanado de las policies de `productos`.
-- Si una ejecución previa (con DROP ... CASCADE) las eliminó, aquí se restauran.
-- Si ya existen, `drop policy if exists` + `create` las deja idénticas. Coincide
-- con 2026-08-rls-productos.sql para no divergir.
alter table public.productos enable row level security;
alter table public.productos force row level security;

drop policy if exists productos_select_propia on public.productos;
create policy productos_select_propia on public.productos
  for select
  using (empresa_id = public.mi_empresa() or public.mi_rol() = 'super_admin');

drop policy if exists productos_insert_propia on public.productos;
create policy productos_insert_propia on public.productos
  for insert
  with check (empresa_id = public.mi_empresa());

drop policy if exists productos_update_propia on public.productos;
create policy productos_update_propia on public.productos
  for update
  using (empresa_id = public.mi_empresa())
  with check (empresa_id = public.mi_empresa());

drop policy if exists productos_delete_propia on public.productos;
create policy productos_delete_propia on public.productos
  for delete
  using (empresa_id = public.mi_empresa());

commit;

-- ============================================================================
-- VERIFICACIÓN (opcional, ejecutar a mano)
-- ----------------------------------------------------------------------------
-- 1) prosecdef debe ser TRUE en ambas funciones y proconfig debe fijar el
--    search_path a public:
--    select p.proname, p.prosecdef as es_security_definer, p.proconfig
--    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname in ('mi_empresa', 'mi_rol');
--
-- 2) Aislamiento: debe devolver TU empresa (no NULL). Si devuelve NULL, tu fila
--    en public.usuarios no tiene empresa_id => arréglalo antes de crear productos:
--    select public.mi_empresa() as mi_empresa_id, public.mi_rol() as mi_rol_actual;
--
-- 3) `productos` debe tener las 4 policies:
--    select policyname, cmd from pg_policies
--    where schemaname = 'public' and tablename = 'productos';
--
-- NOTA: si tras el CASCADE también perdiste policies de OTRAS tablas, vuelve a
-- aplicar los scripts idempotentes correspondientes (2026-07-roles-y-rls.sql,
-- 2026-08-rls-departamentos.sql, etc.).
-- ============================================================================
