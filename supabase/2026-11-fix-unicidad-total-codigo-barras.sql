-- ============================================================================
-- Aether ERP — Barrido de unicidades TOTALES residuales sobre `codigo_barras`
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de 2026-11-soft-delete-productos.sql
-- (o en su lugar: este script es un superconjunto de su parte de índices).
-- Idempotente, transaccional y NO toca RLS: los índices son ortogonales a las
-- policies; el aislamiento sigue viniendo de `empresa_id = public.mi_empresa()`.
--
-- POR QUÉ HACE FALTA
-- ------------------
-- 2026-11-soft-delete-productos.sql solo elimina:
--   a) constraints UNIQUE (pg_constraint.contype = 'u'), y
--   b) un índice por NOMBRE: productos_empresa_codigo_barras_uniq.
-- Si la instancia tiene un índice único TOTAL creado a mano con otro nombre
-- (`create unique index ... on productos (codigo_barras)`, típico de una unique
-- GLOBAL sin empresa_id), ese índice SOBREVIVE a la migración. Resultado: una
-- fila archivada —o incluso la de OTRO tenant— sigue ocupando el código, el
-- INSERT revienta con 23505 y la app lo reporta como "ya existe un producto
-- ACTIVO", que es falso.
--
-- Este script barre TODA unicidad total (constraint o índice suelto) cuyo juego
-- de columnas sea un subconjunto de (empresa_id, codigo_barras, sku) e incluya
-- `codigo_barras`, y deja solo la unicidad PARCIAL sobre las filas vivas.
-- ============================================================================

begin;

-- 1) La columna del borrado lógico debe existir antes de indexar por ella -------
alter table public.productos
  add column if not exists deleted_at timestamptz;

comment on column public.productos.deleted_at is
  'Borrado lógico: NULL = producto vivo. Las filas con valor no se listan en la app y liberan su (empresa_id, codigo_barras) para un alta nueva.';

-- 2) Preflight: duplicados entre filas VIVAS -----------------------------------
-- Si existen, `create unique index` fallaría a mitad del script. Abortamos ANTES
-- de tocar nada (la transacción revierte) y decimos exactamente qué arreglar.
do $preflight$
declare
  v_dups text;
begin
  select string_agg(format('empresa %s / código %L (%s filas)', d.empresa_id, d.codigo_barras, d.n), E'\n  ')
    into v_dups
  from (
    select empresa_id, codigo_barras, count(*) as n
    from public.productos
    where deleted_at is null
      and codigo_barras is not null
    group by empresa_id, codigo_barras
    having count(*) > 1
  ) d;

  if v_dups is not null then
    raise exception using
      message = E'Hay códigos de barras repetidos entre productos VIVOS:\n  ' || v_dups,
      hint    = 'Archiva o corrige los sobrantes (update public.productos set deleted_at = now() where id = ...) y vuelve a ejecutar. No se ha modificado nada.';
  end if;
end
$preflight$;

-- 3) Drop de constraints UNIQUE totales sobre el código -------------------------
do $constraints$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.productos'::regclass
      and c.contype = 'u'
      and (
        select bool_and(a.attname = any (array['empresa_id','codigo_barras','sku']::name[]))
           and bool_or(a.attname = 'codigo_barras')
        from unnest(c.conkey) k
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
      )
  loop
    raise notice 'Eliminando constraint UNIQUE total: %', r.conname;
    execute format('alter table public.productos drop constraint %I', r.conname);
  end loop;
end
$constraints$;

-- 4) Drop de ÍNDICES únicos totales sobre el código (sin constraint detrás) -----
-- Esto es lo que la migración anterior no cubría: cualquier nombre, no solo
-- `productos_empresa_codigo_barras_uniq`. `indpred is null` = índice TOTAL, así
-- que los parciales (los que queremos conservar) quedan intactos.
do $indices$
declare
  r record;
begin
  for r in
    select i.indexrelid::regclass::text as idx
    from pg_index i
    where i.indrelid = 'public.productos'::regclass
      and i.indisunique
      and not i.indisprimary
      and i.indpred is null
      and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)
      and (
        -- Todas las columnas del índice deben resolverse a atributos reales
        -- (una expresión da attnum 0 → attname NULL → no se toca) y estar
        -- dentro del juego permitido, incluyendo codigo_barras.
        select count(*) = i.indnatts
           and bool_and(a.attname = any (array['empresa_id','codigo_barras','sku']::name[]))
           and bool_or(a.attname = 'codigo_barras')
        from unnest(string_to_array(i.indkey::text, ' ')::int[]) as k(attnum)
        left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      )
  loop
    raise notice 'Eliminando índice único TOTAL: %', r.idx;
    execute format('drop index if exists %s', r.idx);
  end loop;
end
$indices$;

-- 5) Unicidad PARCIAL: solo entre productos VIVOS de la MISMA empresa -----------
-- Dos tenants pueden reusar el mismo código; un producto archivado deja de
-- bloquearlo. (Los NULL no participan en un índice único, así que no hace falta
-- `codigo_barras is not null` en el predicado, y dejarlo fuera mantiene simple
-- la inferencia del ON CONFLICT.)
create unique index if not exists productos_empresa_codigo_barras_vivos_uniq
  on public.productos (empresa_id, codigo_barras)
  where deleted_at is null;

comment on index public.productos_empresa_codigo_barras_vivos_uniq is
  'Clave natural del catálogo VIVO por empresa. Destino del ON CONFLICT de importar_productos_masivo()/guardar_producto_por_codigo(): el INSERT debe repetir `where deleted_at is null` para inferirlo.';

do $sku$
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
end
$sku$;

-- Lectura del catálogo vivo (el filtro que ahora hace toda la app).
create index if not exists productos_empresa_vivos_idx
  on public.productos (empresa_id)
  where deleted_at is null;

-- 6) Post-check: que no haya sobrevivido ninguna unicidad total -----------------
do $postcheck$
declare
  v_resto text;
begin
  select string_agg(i.indexrelid::regclass::text, ', ')
    into v_resto
  from pg_index i
  where i.indrelid = 'public.productos'::regclass
    and i.indisunique
    and not i.indisprimary
    and i.indpred is null
    and exists (
      select 1
      from unnest(string_to_array(i.indkey::text, ' ')::int[]) as k(attnum)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where a.attname = 'codigo_barras'
    );

  if v_resto is not null then
    raise exception using
      message = 'Siguen existiendo unicidades TOTALES sobre codigo_barras: ' || v_resto,
      hint    = 'Revísalas a mano en pg_indexes y elimínalas; luego repite este script.';
  end if;
end
$postcheck$;

commit;

-- ============================================================================
-- VERIFICACIÓN — es la salida que verás en el panel de Supabase.
-- Debe aparecer `productos_empresa_codigo_barras_vivos_uniq` marcado PARCIAL y
-- NINGÚN índice único TOTAL que mencione codigo_barras.
-- ============================================================================
select
  indexname,
  indexdef,
  case
    when indexdef ilike '%unique%' and indexdef ilike '%deleted\_at is null%' then 'PARCIAL (ok)'
    when indexdef ilike '%unique%' and indexdef ilike '%codigo\_barras%'      then 'TOTAL (revisar)'
    when indexdef ilike '%unique%'                                            then 'unique (otra columna)'
    else 'no unico'
  end as tipo
from pg_indexes
where schemaname = 'public'
  and tablename  = 'productos'
order by indexname;

-- ============================================================================
-- PRUEBA DEL BUG (opcional, con un código de usar y tirar)
--   select public.guardar_producto_por_codigo('{"codigo_barras":"TEST-001","descripcion":"Prueba","precio_venta":1000}'::jsonb);
--   update public.productos set deleted_at = now() where codigo_barras = 'TEST-001';
--   select public.guardar_producto_por_codigo('{"codigo_barras":"TEST-001","descripcion":"Prueba 2","precio_venta":2000}'::jsonb);
--   -- 2ª llamada debe devolver la MISMA fila reactivada (deleted_at = null), sin 23505.
--   delete from public.productos where codigo_barras = 'TEST-001';
-- ============================================================================
