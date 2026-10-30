-- ============================================================================
-- Aether ERP — Carga masiva de inventario que SÍ persiste (upsert multi-tenant)
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   · 2026-07-roles-y-rls.sql                 (helpers `mi_empresa()` / `mi_rol()`)
--   · 2026-08-rls-productos.sql               (RLS de `public.productos`)
--   · 2026-08-fix-helpers-security-definer.sql
-- Es idempotente (se puede correr varias veces sin efectos secundarios).
--
-- PROBLEMA QUE RESUELVE
-- ---------------------
-- El importador de Excel/CSV NUNCA escribía en Postgres: `addInventoryItems()`
-- del <DashboardProvider> solo hacía `setInventory(...)` (estado de React +
-- caché de localStorage). Al recargar o cambiar de módulo, el efecto de carga
-- del provider relee `fetchProductosEmpresa()` y REEMPLAZA el estado con la
-- verdad del servidor → las 413 referencias importadas desaparecían y volvía a
-- verse el inventario dado de alta a mano. No era RLS rechazando filas: no había
-- ningún INSERT que rechazar.
--
-- QUÉ AÑADE ESTE SCRIPT
-- ---------------------
-- 1) Índice ÚNICO `(empresa_id, codigo_barras)` sobre `public.productos`. Es el
--    destino de conflicto del upsert y, de paso, impide SKUs duplicados dentro
--    de una misma empresa sin estorbar a otras (la clave incluye el tenant).
-- 2) RPC `public.importar_productos_masivo(jsonb)`: hace el lote completo en UNA
--    sentencia `INSERT ... ON CONFLICT ... DO UPDATE`, atómica.
--
-- AISLAMIENTO MULTI-TENANT / RLS
-- ------------------------------
-- · La RPC es **SECURITY INVOKER** (el default, declarado explícito abajo): corre
--   con los privilegios de quien la llama, así que las políticas RLS de
--   `productos` se evalúan íntegras dentro del INSERT y del DO UPDATE. Este
--   script NO desactiva, borra ni modifica ninguna política.
-- · El `empresa_id` NO viaja desde el cliente: lo resuelve el servidor con
--   `public.mi_empresa()` (que deriva de `auth.uid()`), así que un payload
--   manipulado no puede escribir en el catálogo de otro tenant. El cliente lo
--   resuelve también, pero solo para abortar temprano con un mensaje legible.
-- · Como la clave única incluye `empresa_id`, el ON CONFLICT jamás puede tocar
--   una fila de otra empresa: dos tenants pueden usar el mismo código de barras.
-- ============================================================================

begin;

-- ── 0) Pre-chequeo: duplicados que impedirían crear el índice único ─────────
-- Si una misma empresa ya tiene el mismo `codigo_barras` repetido, el CREATE
-- UNIQUE INDEX fallaría con un mensaje opaco. Aquí se aborta con uno claro.
do $$
declare
  v_dups integer;
begin
  select count(*) into v_dups
  from (
    select empresa_id, codigo_barras
    from public.productos
    where codigo_barras is not null and empresa_id is not null
    group by empresa_id, codigo_barras
    having count(*) > 1
  ) d;

  if v_dups > 0 then
    raise exception
      'No se puede crear el índice único: hay % combinaciones (empresa_id, codigo_barras) duplicadas en public.productos. Resuélvelas con la consulta de VERIFICACIÓN nº 1 del pie de este script y vuelve a ejecutarlo.',
      v_dups;
  end if;
end $$;

-- ── 1) Índice único (empresa_id, codigo_barras) ─────────────────────────────
-- NO es parcial a propósito: PostgREST/Postgres solo puede inferir el destino de
-- un `ON CONFLICT (cols)` con un índice único TOTAL sobre esas columnas. Un
-- índice parcial (`where codigo_barras is not null`) haría fallar la inferencia
-- con "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification". Los NULL no colisionan entre sí (NULLS DISTINCT por defecto),
-- así que los productos sin código de barras siguen pudiendo ser varios.
create unique index if not exists productos_empresa_codigo_barras_uniq
  on public.productos (empresa_id, codigo_barras);

comment on index public.productos_empresa_codigo_barras_uniq is
  'Clave natural del catálogo POR EMPRESA. Destino del ON CONFLICT de importar_productos_masivo(); dos tenants distintos pueden reusar el mismo codigo_barras.';

-- ── 2) RPC de carga masiva ──────────────────────────────────────────────────
-- Recibe un arreglo JSON de la forma:
--   [{"sku":"7701234","nombre":"Arroz 500g","stock":40,"min_stock":5,"precio":3200}, …]
-- `sku` y `min_stock` son opcionales. Devuelve un jsonb con el conteo real:
--   {"recibidos": 413, "validos": 410, "insertados": 402, "actualizados": 8}
create or replace function public.importar_productos_masivo(p_items jsonb)
returns jsonb
language plpgsql
-- SECURITY INVOKER = las políticas RLS de `productos` SÍ se aplican aquí dentro.
security invoker
set search_path = public, pg_temp
as $$
declare
  v_empresa      uuid := public.mi_empresa();
  v_recibidos    integer := 0;
  v_validos      integer := 0;
  v_insertados   integer := 0;
  v_actualizados integer := 0;
begin
  -- Sin empresa resoluble el `with check` de RLS rechazaría todo con un error
  -- opaco; preferimos un mensaje accionable (mismo texto que usa el POS).
  if v_empresa is null then
    raise exception
      'Tu usuario no tiene una empresa asociada (nulo): no se puede importar el inventario.'
      using errcode = 'P0001';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items debe ser un arreglo JSON de productos.'
      using errcode = '22023';
  end if;

  v_recibidos := jsonb_array_length(p_items);
  if v_recibidos = 0 then
    return jsonb_build_object(
      'recibidos', 0, 'validos', 0, 'insertados', 0, 'actualizados', 0
    );
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
      -- Sin SKU en el archivo se deriva uno DETERMINISTA del nombre: así una
      -- segunda importación del mismo archivo actualiza la fila en vez de
      -- duplicarla, que es justo lo que debe hacer un upsert.
      coalesce(sku, 'IMP-' || upper(substr(md5(lower(descripcion)), 1, 10))) as codigo_barras,
      stock_actual,
      stock_minimo,
      precio_venta,
      ord
    from entrada
    where descripcion is not null
  ),
  -- Deduplicación DENTRO del lote: Postgres aborta un ON CONFLICT DO UPDATE que
  -- intente afectar la misma fila dos veces ("cannot affect row a second time"),
  -- y un Excel de 413 referencias trae códigos repetidos con facilidad. Ante un
  -- duplicado gana la ÚLTIMA aparición en el archivo.
  validas as (
    select distinct on (codigo_barras) *
    from normalizada
    order by codigo_barras, ord desc
  ),
  afectadas as (
    insert into public.productos as p (
      empresa_id,
      codigo_barras,
      descripcion,
      tipo,
      precio_costo,
      margen_ganancia,
      precio_venta,
      stock_actual,
      stock_minimo
    )
    select
      v_empresa,            -- tenant estampado por el SERVIDOR, no por el cliente
      v.codigo_barras,
      v.descripcion,
      'unidad',
      0,                    -- el costo real se captura en Compras / ProductForm
      0,
      v.precio_venta,
      v.stock_actual::integer,
      v.stock_minimo::integer
    from validas v
    on conflict (empresa_id, codigo_barras) do update set
      descripcion  = excluded.descripcion,
      stock_actual = excluded.stock_actual,
      -- Un 0 en el archivo significa "la columna venía vacía", no "ponlo en 0":
      -- por eso un precio/mínimo ausente NO pisa el que ya tenía el catálogo.
      precio_venta = case when excluded.precio_venta > 0
                          then excluded.precio_venta else p.precio_venta end,
      stock_minimo = case when excluded.stock_minimo > 0
                          then excluded.stock_minimo else p.stock_minimo end
    -- Columnas deliberadamente NO tocadas en el UPDATE para no destruir trabajo
    -- manual previo: precio_costo, margen_ganancia, precio_mayoreo,
    -- departamento_id, stock_maximo, fecha_vencimiento, imagen_url.
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

comment on function public.importar_productos_masivo(jsonb) is
  'Carga masiva de inventario desde Excel/CSV. Upsert por (empresa_id, codigo_barras) en una sola sentencia atómica. SECURITY INVOKER: respeta íntegramente las policies RLS de productos. El empresa_id lo resuelve el servidor vía mi_empresa().';

-- Sin este GRANT la RPC responde 403 "permission denied for function" aunque la
-- sesión y las policies estén perfectas.
grant execute on function public.importar_productos_masivo(jsonb) to authenticated;

commit;

-- ============================================================================
-- VERIFICACIÓN (ejecutar a mano, opcional)
-- ----------------------------------------------------------------------------
-- 1) Duplicados que bloquean el índice único (debe devolver 0 filas):
--    select empresa_id, codigo_barras, count(*), array_agg(id)
--    from public.productos
--    where codigo_barras is not null and empresa_id is not null
--    group by empresa_id, codigo_barras having count(*) > 1;
--    -- Para resolverlos, conserva el id más reciente de cada grupo y borra el resto.
--
-- 2) ¿Existe un índice único GLOBAL sobre codigo_barras (sin empresa_id)? Sería
--    una fuga multi-tenant al revés: impediría que dos empresas usen el mismo
--    SKU y haría fallar importaciones legítimas. Si aparece, hay que borrarlo:
--    select indexname, indexdef from pg_indexes
--    where schemaname = 'public' and tablename = 'productos'
--      and indexdef ilike '%unique%';
--
-- 3) Confirmar que la RPC quedó como INVOKER (prosecdef debe ser false) y con
--    permiso para `authenticated`:
--    select proname, prosecdef, pg_get_function_identity_arguments(oid)
--    from pg_proc where proname = 'importar_productos_masivo';
--    select has_function_privilege('authenticated',
--      'public.importar_productos_masivo(jsonb)', 'execute');
--
-- 4) Prueba en seco desde el SQL Editor (como tu usuario, no como postgres):
--    select public.importar_productos_masivo(
--      '[{"nombre":"Prueba import","sku":"TEST-001","stock":7,"precio":1500}]'::jsonb
--    );
--    -- Repítela: la segunda vez debe devolver actualizados = 1, insertados = 0.
--    delete from public.productos where codigo_barras = 'TEST-001';
-- ============================================================================
