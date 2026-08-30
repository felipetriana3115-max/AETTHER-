-- ============================================================================
-- Aether ERP — RBAC granular (role + permissions) sobre la multitenancy actual
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-roles-y-rls.sql            (enum rol_usuario, mi_empresa(), mi_rol())
--   • 2026-07-ampliar-empresas.sql       (trigger handle_new_user)
--   • 2026-08-rls-productos.sql          (RLS de productos)
--   • 2026-07-crear-ventas.sql / 2026-08-crear-compras.sql (RLS ventas/compras)
-- Es idempotente (se puede correr varias veces).
--
-- QUÉ AÑADE Y POR QUÉ NO ROMPE EL AISLAMIENTO EXISTENTE
-- ----------------------------------------------------------------------------
-- La multitenancy YA existe y NO se toca su columna de tenant: el `tenant_id`
-- del enunciado es `usuarios.empresa_id` (y en cada tabla, `empresa_id`), y el
-- resolutor de tenant es `public.mi_empresa()` (SECURITY DEFINER). Todas las
-- policies siguen exigiendo `empresa_id = public.mi_empresa()`, así que el
-- aislamiento entre empresas se mantiene intacto.
--
-- Sobre eso añadimos la capa RBAC que pide el enunciado:
--   1. `usuarios.permissions text[]`  → permisos finos del EMPLEADO (p. ej. {'pos'}).
--   2. Helpers `es_admin()` / `tengo_permiso(text)` para usarlos en RLS y RPCs.
--   3. Gating por permiso en las ESCRITURAS de módulos sensibles (productos,
--      compras, ventas) SIN quitar el chequeo de tenant. El admin conserva acceso
--      total (los helpers devuelven true para admin/super_admin).
--   4. `handle_new_user` aprende a dar de alta EMPLEADOS dentro de la empresa de
--      su admin (rule 2: todo registro del empleado queda en el tenant del admin).
--
-- MAPEO de roles pedidos ('admin' | 'employee') al enum ya existente:
--   • 'admin'    == rol_usuario 'empresa_admin'  (acceso total en su tenant)
--   • 'employee' == rol_usuario 'empresa_empleado' (solo según `permissions`)
--   • 'super_admin' es el dueño de la plataforma (transversal, no es un tenant).
-- No renombramos el enum ni las columnas para no romper el resto del sistema.
--
-- IMPORTANTE (por qué el POS NO se rompe al gatear productos/ventas):
--   El descuento de inventario y el alta de la venta ocurren dentro de la RPC
--   `registrar_venta` (SECURITY DEFINER), que SALTA RLS y se acota a mano por
--   empresa. Por tanto gatear las escrituras DIRECTAS de `productos`/`ventas`
--   afecta solo a los módulos de gestión (inventario, historial), no al cobro.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1) Columna de permisos finos en el perfil (rule 1)
-- ----------------------------------------------------------------------------
-- Array de slugs de permiso. Vacío por defecto: un empleado nace SIN acceso y
-- el admin le concede permisos explícitos. Para admin/super_admin es irrelevante
-- (los helpers les dan acceso total sin mirar este array).
alter table public.usuarios
  add column if not exists permissions text[] not null default '{}';

-- Catálogo canónico de permisos (debe coincidir con app/lib/authz.ts →
-- PERMISOS). Se valida con un CHECK para evitar slugs sueltos que luego no
-- mapean a ninguna ruta. Se aplica NOT VALID + validate para no fallar si
-- hubiera datos previos, y se recrea de forma idempotente.
alter table public.usuarios
  drop constraint if exists usuarios_permissions_validos;
alter table public.usuarios
  add constraint usuarios_permissions_validos
  check (
    permissions <@ array[
      'pos',        -- cobrar en el POS y arqueo/caja
      'inventario', -- crear/editar/borrar productos
      'compras',    -- órdenes de compra a proveedores
      'ventas',     -- historial/gestión de ventas
      'clientes',   -- CRM y fiados
      'reportes',   -- reportes y métricas
      'dashboard'   -- panel principal con métricas en vivo
    ]::text[]
  ) not valid;
alter table public.usuarios validate constraint usuarios_permissions_validos;

-- ----------------------------------------------------------------------------
-- 2) Helpers RBAC (SECURITY DEFINER, igual que mi_empresa()/mi_rol())
-- ----------------------------------------------------------------------------
-- Por qué SECURITY DEFINER + search_path fijo: idéntico motivo que mi_empresa()
-- (ver 2026-08-fix-helpers-security-definer.sql). Leen `usuarios` (que tiene RLS)
-- desde dentro de policies; correr como dueño evita recursión y el NULL espurio
-- que denegaría los INSERT. El search_path fijo cierra la escalada por secuestro
-- de esquema.

-- ¿El usuario actual es admin de su empresa (o super_admin)? → acceso total.
create or replace function public.es_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.mi_rol() in ('empresa_admin', 'super_admin');
$$;

-- Permisos finos del usuario actual (vacío si es admin: no los necesita).
create or replace function public.mis_permisos()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(permissions, '{}') from public.usuarios where id = auth.uid();
$$;

-- ¿Tiene el permiso `p`? El admin/super_admin SIEMPRE (acceso total en su
-- tenant, rule 4); el empleado solo si `p` está en su array `permissions`.
create or replace function public.tengo_permiso(p text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.es_admin() or (p = any(public.mis_permisos()));
$$;

-- Que el rol `authenticated` pueda invocarlos desde el cliente (login/UI).
grant execute on function public.es_admin()            to authenticated;
grant execute on function public.mis_permisos()        to authenticated;
grant execute on function public.tengo_permiso(text)   to authenticated;

-- ----------------------------------------------------------------------------
-- 3) El admin puede LEER los perfiles de SU empresa (para gestionar empleados
--    y ver actividad en tiempo real, rule 4). Sigue siendo tenant-scoped.
-- ----------------------------------------------------------------------------
-- Additivo: NO tocamos usuarios_select_propio (cada quien ve su fila) ni la
-- policy de escritura (sigue reservada a super_admin / service_role, para que un
-- empleado jamás pueda auto-escalar su rol o permisos vía la API normal).
drop policy if exists usuarios_select_empresa_admin on public.usuarios;
create policy usuarios_select_empresa_admin on public.usuarios
  for select
  using (
    empresa_id = public.mi_empresa()
    and public.mi_rol() in ('empresa_admin', 'super_admin')
  );

-- ----------------------------------------------------------------------------
-- 4) Gating por permiso en ESCRITURAS de módulos sensibles.
--    En cada caso se PRESERVA `empresa_id = public.mi_empresa()` (tenant, rule 3)
--    y se AÑADE `public.tengo_permiso(...)` (RBAC, rule 4). SELECT se deja
--    tenant-wide (todos los miembros leen su empresa; el filtrado fino de LECTURA
--    lo hace la capa de rutas en el front/API).
-- ----------------------------------------------------------------------------

-- productos: gestión de inventario → permiso 'inventario'.
-- (El POS no escribe aquí directamente: usa registrar_venta, que salta RLS.)
drop policy if exists productos_insert_propia on public.productos;
create policy productos_insert_propia on public.productos
  for insert
  with check (empresa_id = public.mi_empresa() and public.tengo_permiso('inventario'));

drop policy if exists productos_update_propia on public.productos;
create policy productos_update_propia on public.productos
  for update
  using  (empresa_id = public.mi_empresa() and public.tengo_permiso('inventario'))
  with check (empresa_id = public.mi_empresa() and public.tengo_permiso('inventario'));

drop policy if exists productos_delete_propia on public.productos;
create policy productos_delete_propia on public.productos
  for delete
  using (empresa_id = public.mi_empresa() and public.tengo_permiso('inventario'));

-- compras: órdenes a proveedores → permiso 'compras'.
drop policy if exists compras_insert_propia on public.compras;
create policy compras_insert_propia on public.compras
  for insert
  with check (empresa_id = public.mi_empresa() and public.tengo_permiso('compras'));

-- (Additivo) update/delete de compras, también gateado, por si la UI edita el
-- estado de una orden desde el cliente.
drop policy if exists compras_update_propia on public.compras;
create policy compras_update_propia on public.compras
  for update
  using  (empresa_id = public.mi_empresa() and public.tengo_permiso('compras'))
  with check (empresa_id = public.mi_empresa() and public.tengo_permiso('compras'));

-- ventas: alta DIRECTA de venta → permiso 'pos'. La RPC registrar_venta NO se ve
-- afectada (SECURITY DEFINER); esto cubre inserciones directas / sync offline
-- que sí pasan por RLS, y bloquea a un empleado sin 'pos'.
drop policy if exists ventas_insert_propia on public.ventas;
create policy ventas_insert_propia on public.ventas
  for insert
  with check (empresa_id = public.mi_empresa() and public.tengo_permiso('pos'));

commit;

-- ============================================================================
-- 5) TRIGGER de alta: aprende a crear EMPLEADOS en la empresa de su admin.
-- ----------------------------------------------------------------------------
-- Se ejecuta fuera de la transacción anterior por claridad; es idempotente.
--
-- Rule 2 ("todo registro creado por el empleado se asocia al tenant del admin"):
--   • El aislamiento de DATOS ya lo garantiza el DEFAULT `mi_empresa()` de cada
--     tabla + el `with check` de RLS: un empleado solo puede escribir filas con
--     SU empresa_id, que es la de su admin.
--   • Falta que, AL CREARSE el empleado, quede enlazado a la empresa del admin y
--     NO se le cree una empresa nueva. Eso es lo que arregla este trigger.
--
-- El alta de empleados se hace desde /api/empleados (service_role) enviando en la
-- metadata:  { es_empleado: true, empresa_id: <uuid del admin>, permissions: [...] }
-- El registro PÚBLICO (una empresa nueva) NO manda esa metadata y conserva el
-- comportamiento anterior: crea empresa + usuario 'empresa_admin'.
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa_id   uuid;
  v_es_empleado  boolean := coalesce((new.raw_user_meta_data->>'es_empleado')::boolean, false);
  v_empresa_meta uuid    := nullif(new.raw_user_meta_data->>'empresa_id', '')::uuid;
  v_nombre       text    := coalesce(nullif(trim(new.raw_user_meta_data->>'nombre_comercial'), ''), 'Empresa sin nombre');
  v_permisos     text[]  := coalesce(
    (select array_agg(value) from jsonb_array_elements_text(
       case when jsonb_typeof(new.raw_user_meta_data->'permissions') = 'array'
            then new.raw_user_meta_data->'permissions'
            else '[]'::jsonb end)),
    '{}'
  );
begin
  -- CAMINO EMPLEADO: se une a la empresa del admin, sin crear empresa nueva.
  if v_es_empleado and v_empresa_meta is not null then
    insert into public.usuarios (id, email, rol, empresa_id, nombre_comercial, permissions)
    values (new.id, new.email, 'empresa_empleado', v_empresa_meta, v_nombre, v_permisos)
    on conflict (id) do nothing;
    return new;
  end if;

  -- CAMINO ADMIN (registro público): crea la empresa + su usuario admin.
  insert into public.empresas (nombre, tipo_negocio, nit, moneda)
  values (
    v_nombre,
    coalesce(nullif(trim(new.raw_user_meta_data->>'tipo_negocio'), ''), 'general'),
    nullif(trim(new.raw_user_meta_data->>'nit'), ''),
    coalesce(nullif(trim(new.raw_user_meta_data->>'moneda'), ''), 'COP')
  )
  returning id into v_empresa_id;

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

-- ============================================================================
-- VERIFICACIÓN (ejecutar a mano tras aplicar)
-- ----------------------------------------------------------------------------
-- 1) La columna y el catálogo existen:
--    select column_name from information_schema.columns
--    where table_schema='public' and table_name='usuarios' and column_name='permissions';
--
-- 2) Los helpers son SECURITY DEFINER (prosecdef = true):
--    select proname, prosecdef from pg_proc
--    where proname in ('es_admin','mis_permisos','tengo_permiso');
--
-- 3) Las escrituras quedaron gateadas (deben aparecer con el AND tengo_permiso):
--    select tablename, policyname, cmd from pg_policies
--    where schemaname='public' and tablename in ('productos','compras','ventas')
--    order by tablename, cmd;
--
-- 4) Prueba funcional: crea un empleado con permisos {'pos'} desde /api/empleados,
--    inicia sesión con él e intenta guardar un producto → debe fallar con RLS
--    (le falta 'inventario'); cobrar en el POS → debe funcionar (tiene 'pos').
-- ============================================================================
