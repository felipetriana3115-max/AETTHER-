-- ============================================================================
-- Aether ERP — Soft delete en `productos` + unicidad PARCIAL del código de barras
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de 2026-10-import-masivo-productos.sql.
-- Idempotente. NO toca RLS: los índices son ortogonales a las policies y el
-- aislamiento sigue viniendo de `empresa_id = mi_empresa()`.
--
-- BUG QUE CIERRA
-- --------------
-- `productos_empresa_codigo_barras_uniq` es un índice único TOTAL: una fila
-- borrada lógicamente sigue ocupando su (empresa_id, codigo_barras), así que la
-- app (que filtra `deleted_at is null`) la da por inexistente pero el INSERT
-- revienta con 23505. Se reemplaza por un índice único PARCIAL sobre las filas
-- vivas.
-- ============================================================================

begin;

-- 1) Columna de borrado lógico --------------------------------------------------
alter table public.productos
  add column if not exists deleted_at timestamptz;

comment on column public.productos.deleted_at is
  'Borrado lógico: NULL = producto vivo. Las filas con valor no se listan en la app y liberan su (empresa_id, codigo_barras) para un alta nueva.';

-- 2) Elimina CUALQUIER unicidad total sobre el código de barras -----------------
-- Cubre tanto el índice versionado como constraints UNIQUE creadas a mano fuera
-- de los scripts (incluida una global sobre `codigo_barras` sin empresa_id).
do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.productos'::regclass
      and c.contype = 'u'
      and (
        select array_agg(a.attname order by a.attname)
        from unnest(c.conkey) k
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
      ) <@ array['empresa_id', 'codigo_barras', 'sku']::name[]
  loop
    execute format('alter table public.productos drop constraint %I', r.conname);
  end loop;
end $$;

drop index if exists public.productos_empresa_codigo_barras_uniq;

-- 3) Unicidad PARCIAL: solo entre productos vivos de la MISMA empresa -----------
-- Dos tenants pueden reusar el mismo código; un producto archivado deja de
-- bloquearlo. (Los NULL no participan en un índice único, así que no hace falta
-- un `codigo_barras is not null` en el predicado — y dejarlo fuera mantiene
-- simple la inferencia del ON CONFLICT de abajo.)
create unique index if not exists productos_empresa_codigo_barras_vivos_uniq
  on public.productos (empresa_id, codigo_barras)
  where deleted_at is null;

comment on index public.productos_empresa_codigo_barras_vivos_uniq is
  'Clave natural del catálogo VIVO por empresa. Destino del ON CONFLICT de importar_productos_masivo(): el INSERT debe llevar `where deleted_at is null` para inferirlo.';

-- Mismo tratamiento para `sku` si esa columna llegó a existir en esta instancia.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'productos' and column_name = 'sku'
  ) then
    execute $ix$
      create unique index if not exists productos_empresa_sku_vivos_uniq
        on public.productos (empresa_id, sku)
        where deleted_at is null
    $ix$;
  end if;
end $$;

-- Lectura del catálogo vivo (el filtro que ahora hace toda la app).
create index if not exists productos_empresa_vivos_idx
  on public.productos (empresa_id)
  where deleted_at is null;

commit;

-- ============================================================================
-- 4) El upsert masivo debe apuntar al índice PARCIAL
-- ----------------------------------------------------------------------------
-- Postgres solo infiere un índice parcial como árbitro si el INSERT repite su
-- predicado. Sin este `where deleted_at is null`, importar_productos_masivo()
-- falla con 42P10 "no unique or exclusion constraint matching the ON CONFLICT".
-- Se re-crea la función COMPLETA (misma firma, mismo SECURITY INVOKER).
-- ============================================================================

create or replace function public.importar_productos_masivo(p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_empresa      uuid := public.mi_empresa();
  v_recibidos    integer := coalesce(jsonb_array_length(p_items), 0);
  v_validos      integer;
  v_insertados   integer;
  v_actualizados integer;
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene empresa asociada (nulo)';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or v_recibidos = 0 then
    return jsonb_build_object('recibidos', 0, 'validos', 0, 'insertados', 0, 'actualizados', 0);
  end if;

  with entrada as (
    select
      nullif(btrim(coalesce(it ->> 'nombre', '')), '')                      as descripcion,
      nullif(btrim(coalesce(it ->> 'sku', '')), '')                         as sku,
      greatest(coalesce(nullif(it ->> 'stock', '')::numeric, 0), 0)         as stock_actual,
      greatest(coalesce(nullif(it ->> 'min_stock', '')::numeric, 0), 0)     as stock_minimo,
      greatest(coalesce(nullif(it ->> 'precio', '')::numeric, 0), 0)        as precio_venta,
      ord
    from jsonb_array_elements(p_items) with ordinality as t(it, ord)
  ),
  normalizada as (
    select
      descripcion,
      coalesce(sku, 'IMP-' || upper(substr(md5(lower(descripcion)), 1, 10))) as codigo_barras,
      stock_actual,
      stock_minimo,
      precio_venta,
      ord
    from entrada
    where descripcion is not null
  ),
  validas as (
    select distinct on (codigo_barras) *
    from normalizada
    order by codigo_barras, ord desc
  ),
  afectadas as (
    insert into public.productos as p (
      empresa_id, codigo_barras, descripcion, tipo,
      precio_costo, margen_ganancia, precio_venta, stock_actual, stock_minimo
    )
    select
      v_empresa, v.codigo_barras, v.descripcion, 'unidad',
      0, 0, v.precio_venta, v.stock_actual::integer, v.stock_minimo::integer
    from validas v
    -- El `where` replica el predicado del índice parcial: sin él no hay árbitro.
    on conflict (empresa_id, codigo_barras) where deleted_at is null
    do update set
      descripcion  = excluded.descripcion,
      stock_actual = excluded.stock_actual,
      precio_venta = case when excluded.precio_venta > 0
                          then excluded.precio_venta else p.precio_venta end,
      stock_minimo = case when excluded.stock_minimo > 0
                          then excluded.stock_minimo else p.stock_minimo end
    returning (xmax = 0) as es_insert
  )
  select
    count(*),
    count(*) filter (where es_insert),
    count(*) filter (where not es_insert)
  into v_validos, v_insertados, v_actualizados
  from afectadas;

  return jsonb_build_object(
    'recibidos',    v_recibidos,
    'validos',      coalesce(v_validos, 0),
    'insertados',   coalesce(v_insertados, 0),
    'actualizados', coalesce(v_actualizados, 0)
  );
end;
$$;

grant execute on function public.importar_productos_masivo(jsonb) to authenticated;

-- ============================================================================
-- 5) Alta-o-reactivación en UNA llamada (lo que consume el cliente JS)
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER: las policies de `productos` siguen mandando; `empresa_id`
-- lo estampa el servidor con mi_empresa(), nunca el cliente.
-- ============================================================================

create or replace function public.guardar_producto_por_codigo(p_producto jsonb)
returns public.productos
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_empresa uuid := public.mi_empresa();
  v_codigo  text := nullif(btrim(coalesce(p_producto ->> 'codigo_barras', '')), '');
  v_fila    public.productos;
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene empresa asociada (nulo)';
  end if;
  if v_codigo is null then
    raise exception 'El producto no trae codigo_barras';
  end if;

  -- Reactiva el archivado con ese código si existe (conserva id e historial).
  update public.productos
     set deleted_at      = null,
         descripcion     = coalesce(p_producto ->> 'descripcion', descripcion),
         precio_venta    = coalesce((p_producto ->> 'precio_venta')::numeric, precio_venta),
         precio_costo    = coalesce((p_producto ->> 'precio_costo')::numeric, precio_costo),
         stock_actual    = coalesce((p_producto ->> 'stock_actual')::integer, stock_actual),
         stock_minimo    = coalesce((p_producto ->> 'stock_minimo')::integer, stock_minimo),
         imagen_url      = coalesce(p_producto ->> 'imagen_url', imagen_url)
   where empresa_id = v_empresa
     and codigo_barras = v_codigo
     and deleted_at is not null
     -- Si hay varios archivados con el mismo código gana el más reciente.
     and id = (
       select id from public.productos
       where empresa_id = v_empresa and codigo_barras = v_codigo and deleted_at is not null
       order by deleted_at desc limit 1
     )
  returning * into v_fila;

  if found then
    return v_fila;
  end if;

  insert into public.productos as p (
    empresa_id, codigo_barras, descripcion, tipo,
    precio_costo, margen_ganancia, precio_venta,
    stock_actual, stock_minimo, imagen_url
  )
  values (
    v_empresa,
    v_codigo,
    coalesce(p_producto ->> 'descripcion', ''),
    coalesce(p_producto ->> 'tipo', 'unidad'),
    coalesce((p_producto ->> 'precio_costo')::numeric, 0),
    coalesce((p_producto ->> 'margen_ganancia')::numeric, 0),
    coalesce((p_producto ->> 'precio_venta')::numeric, 0),
    coalesce((p_producto ->> 'stock_actual')::integer, 0),
    coalesce((p_producto ->> 'stock_minimo')::integer, 0),
    p_producto ->> 'imagen_url'
  )
  on conflict (empresa_id, codigo_barras) where deleted_at is null
  do update set
    descripcion  = excluded.descripcion,
    precio_venta = excluded.precio_venta,
    precio_costo = excluded.precio_costo,
    stock_actual = excluded.stock_actual,
    stock_minimo = excluded.stock_minimo,
    imagen_url   = coalesce(excluded.imagen_url, p.imagen_url)
  returning * into v_fila;

  return v_fila;
end;
$$;

comment on function public.guardar_producto_por_codigo(jsonb) is
  'Alta de producto tolerante al soft delete: reactiva el archivado con el mismo (empresa_id, codigo_barras) o inserta/actualiza el vivo. SECURITY INVOKER + mi_empresa(): respeta RLS y el aislamiento por empresa.';

-- Sin este GRANT la RPC responde 403 "permission denied for function".
grant execute on function public.guardar_producto_por_codigo(jsonb) to authenticated;

-- ============================================================================
-- VERIFICACIÓN (a mano)
-- 1) select indexname, indexdef from pg_indexes
--    where schemaname='public' and tablename='productos';
--    -- debe aparecer ...vivos_uniq con "WHERE (deleted_at IS NULL)" y NO el total.
-- 2) Prueba del bug: soft-delete + alta con el mismo código.
--    update public.productos set deleted_at = now() where codigo_barras = 'TEST-001';
--    select public.guardar_producto_por_codigo(
--      '{"codigo_barras":"TEST-001","descripcion":"Prueba","precio_venta":1000}'::jsonb);
-- ============================================================================
