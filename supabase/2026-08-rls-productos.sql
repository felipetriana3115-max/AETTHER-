-- ============================================================================
-- Aether ERP — RLS sobre `productos` (CIERRE DE BRECHA MULTI-TENANT)
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de 2026-07-roles-y-rls.sql
-- (necesita los helpers `public.mi_empresa()` y `public.mi_rol()`).
-- Es idempotente (se puede correr varias veces sin efectos secundarios).
--
-- BRECHA QUE CIERRA ESTE SCRIPT
-- -----------------------------
-- `public.productos` se creó FUERA de los scripts versionados y, a diferencia de
-- todas las demás tablas del ERP (`ventas`, `movimientos_caja`, `cortes_caja`,
-- `clientes`, `fiados`, `usuarios`, `empresas`), NUNCA se le activó Row Level
-- Security. Como Supabase concede SELECT al rol `authenticated` por defecto sobre
-- las tablas de `public`, CUALQUIER usuario autenticado (incluido uno recién
-- registrado, sin productos propios) podía leer el catálogo COMPLETO de TODAS las
-- empresas. Eso alimentaba directamente las métricas "Productos en Stock" y
-- "Alertas de Inventario" del dashboard con datos de otros tenants / demo.
--
-- El código de lectura (`app/lib/resumen.ts`, `ProductForm.tsx`) ya asume que el
-- aislamiento lo impone RLS y por eso NO filtra por empresa en el cliente; solo
-- faltaba activar realmente esa RLS en la tabla. Este script lo hace.
--
-- NOTA sobre las RPC del dashboard: `total_ventas_empresa()` y
-- `metricas_rentabilidad_empresa()` ya filtran explícitamente por
-- `empresa_id = mi_empresa()`, así que NO estaban afectadas por esta brecha.
-- ============================================================================

begin;

-- 1) Garantiza la columna de tenant y su DEFAULT --------------------------------
-- `productos.empresa_id` ya existe (lo usan recibir_compra, ProductForm, etc.);
-- lo reafirmamos de forma idempotente para que el script sea autosuficiente y
-- para asegurar que el DEFAULT estampe la empresa del usuario en cada alta.
alter table public.productos
  add column if not exists empresa_id uuid;

-- DEFAULT = empresa del usuario autenticado. Así el POS / formularios pueden
-- insertar sin enviar empresa_id y el `with check` de RLS se cumple igual.
alter table public.productos
  alter column empresa_id set default public.mi_empresa();

-- FK a empresas (borra el catálogo si se elimina la empresa). Se añade solo si
-- todavía no existe una FK sobre esa columna, para no duplicarla.
do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
     and tc.table_schema   = kcu.table_schema
    where tc.table_schema = 'public'
      and tc.table_name   = 'productos'
      and tc.constraint_type = 'FOREIGN KEY'
      and kcu.column_name = 'empresa_id'
  ) then
    alter table public.productos
      add constraint productos_empresa_id_fkey
      foreign key (empresa_id) references public.empresas (id) on delete cascade;
  end if;
end $$;

-- Índice para acelerar el filtrado por empresa (igual que en `ventas`).
create index if not exists productos_empresa_id_idx on public.productos (empresa_id);

-- 2) Activa Row Level Security --------------------------------------------------
alter table public.productos enable row level security;
-- `force` asegura que ni el DUEÑO de la tabla se salte las políticas por SELECT
-- normal (la service_role sigue saltándose RLS, como se espera para /api/admin).
alter table public.productos force row level security;

-- 3) Políticas: cada empresa solo ve/gestiona SUS productos ---------------------
-- Lectura: miembros ven el catálogo de SU empresa; el super_admin ve todo
-- (mismo patrón que `ventas_select_propia`). Las filas con empresa_id NULL
-- (posible data demo huérfana) quedan invisibles para todos salvo super_admin.
drop policy if exists productos_select_propia on public.productos;
create policy productos_select_propia on public.productos
  for select
  using (empresa_id = public.mi_empresa() or public.mi_rol() = 'super_admin');

-- Inserción: solo se puede crear un producto para la PROPIA empresa. Como
-- empresa_id tiene DEFAULT mi_empresa(), el formulario puede insertar sin enviarlo.
drop policy if exists productos_insert_propia on public.productos;
create policy productos_insert_propia on public.productos
  for insert
  with check (empresa_id = public.mi_empresa());

-- Actualización: solo sobre productos de la propia empresa, y sin poder
-- "moverlos" a otra empresa (el check impide cambiar empresa_id a un tercero).
drop policy if exists productos_update_propia on public.productos;
create policy productos_update_propia on public.productos
  for update
  using (empresa_id = public.mi_empresa())
  with check (empresa_id = public.mi_empresa());

-- Borrado: solo productos de la propia empresa.
drop policy if exists productos_delete_propia on public.productos;
create policy productos_delete_propia on public.productos
  for delete
  using (empresa_id = public.mi_empresa());

commit;

-- ============================================================================
-- VERIFICACIÓN Y LIMPIEZA (ejecutar a mano, opcional)
-- ----------------------------------------------------------------------------
-- 1) Confirmar que RLS quedó ACTIVA en productos (relrowsecurity debe ser true):
--    select relname, relrowsecurity, relforcerowsecurity
--    from pg_class where relname = 'productos';
--
-- 2) Listar las políticas creadas:
--    select policyname, cmd from pg_policies
--    where schemaname = 'public' and tablename = 'productos';
--
-- 3) Detectar productos HUÉRFANOS (sin empresa) que quedaron de datos demo. Tras
--    activar RLS son invisibles a los usuarios normales; decide si borrarlos:
--    select id, descripcion, empresa_id from public.productos where empresa_id is null;
--    -- Para eliminarlos (irreversible), como super_admin / desde el SQL Editor:
--    -- delete from public.productos where empresa_id is null;
--
-- 4) OTRAS TABLAS multi-tenant NO versionadas a auditar por la misma causa
--    (se crearon fuera de los scripts, igual que productos). Revisa si tienen
--    RLS activa; si les falta, replica este patrón:
--    select c.relname, c.relrowsecurity
--    from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public'
--      and c.relkind = 'r'
--      and c.relrowsecurity = false;   -- estas tablas NO tienen RLS
--    -- Candidata conocida: `public.departamentos` (la lee ProductForm.tsx).
-- ============================================================================
