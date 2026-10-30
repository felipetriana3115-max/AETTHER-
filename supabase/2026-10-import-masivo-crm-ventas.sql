-- ============================================================================
-- Aether ERP — Carga masiva de CLIENTES y VENTAS que sí persiste
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   · 2026-07-roles-y-rls.sql        (helpers `mi_empresa()` / `mi_rol()`)
--   · 2026-07-crear-ventas.sql       (tabla `public.ventas` + RLS)
--   · 2026-07-total-ventas.sql       (RPC `total_ventas_empresa`)
--   · 2026-08-clientes-y-fiados.sql  (tablas `public.clientes` / `public.fiados`)
-- Es idempotente (se puede correr varias veces sin efectos secundarios).
--
-- PROBLEMA QUE RESUELVE
-- ---------------------
-- Gemelo exacto del de inventario (ver 2026-10-import-masivo-productos.sql):
-- `addCustomers()` y `addSales()` del <DashboardProvider> solo hacían
-- `setCustomers(...)` / `setSales(...)`. Nada viajaba a Postgres, así que al
-- recargar o cambiar de módulo los clientes y las ventas importadas desaparecían.
--
-- AISLAMIENTO MULTI-TENANT / RLS
-- ------------------------------
-- Ambas RPC son **SECURITY INVOKER**: corren con los privilegios de quien las
-- llama, así que las políticas RLS de `clientes` y `ventas` se evalúan íntegras.
-- Este script NO desactiva, borra ni debilita ninguna política. El `empresa_id`
-- lo resuelve el SERVIDOR con `mi_empresa()`; nunca viaja en el payload.
--
-- DOS ESTRATEGIAS DE IDEMPOTENCIA DISTINTAS, A PROPÓSITO
-- ------------------------------------------------------
-- · CLIENTES → emparejar-y-actualizar. NO se crea un índice único sobre el
--   nombre: dos clientes homónimos en un mismo negocio son legítimos y una
--   restricción así rompería el alta manual del CRM con un 23505. El
--   emparejamiento se hace dentro de la RPC: por email (cuando lo hay, que es la
--   clave natural de verdad) y si no por nombre normalizado.
-- · VENTAS → `ON CONFLICT ... DO NOTHING` sobre `(empresa_id, referencia)`. Una
--   venta histórica es INMUTABLE: re-importar el mismo archivo no debe
--   reescribirla. Además `ventas` no tiene (ni debe tener) policy de UPDATE —
--   un DO UPDATE sería denegado por RLS, y crear esa policy abriría la edición
--   de las ventas del POS. DO NOTHING es a la vez lo correcto y lo más estricto.
-- ============================================================================

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — CLIENTES (CRM)
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1.1) Columnas que hoy trae el archivo y se perdían ──────────────────────
-- El Excel de clientes suele traer segmento/nivel, número de pedidos y total
-- gastado. Sin estas columnas esa información se descartaba en silencio. Se
-- llaman "historicas"/"gastado" porque son el acumulado que venía del sistema
-- anterior: no se recalculan con las ventas nuevas del POS.
alter table public.clientes add column if not exists segmento text;
alter table public.clientes
  add column if not exists compras_historicas integer not null default 0;
alter table public.clientes
  add column if not exists total_gastado numeric(14, 2) not null default 0;

-- El importador solo produce Oro/Plata/Bronce (normalizeTier en import-excel.ts).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.clientes'::regclass
      and conname = 'clientes_segmento_check'
  ) then
    alter table public.clientes
      add constraint clientes_segmento_check
      check (segmento is null or segmento in ('Oro', 'Plata', 'Bronce'));
  end if;
end $$;

comment on column public.clientes.segmento is
  'Nivel/tier del CRM (Oro/Plata/Bronce). Lo llena la importación masiva; null = sin clasificar.';
comment on column public.clientes.compras_historicas is
  'Nº de pedidos acumulado que venía del sistema anterior. NO se actualiza con las ventas del POS.';
comment on column public.clientes.total_gastado is
  'Total gastado acumulado que venía del sistema anterior (LTV). NO se actualiza con las ventas del POS.';

-- Índices que usa el emparejamiento de la importación (lower(), case-insensitive).
create index if not exists clientes_empresa_email_lower_idx
  on public.clientes (empresa_id, lower(email));
create index if not exists clientes_empresa_nombre_lower_idx
  on public.clientes (empresa_id, lower(nombre));

-- ── 1.2) RPC de carga masiva de clientes ────────────────────────────────────
-- Recibe:
--   [{"nombre":"Ana Ruiz","email":"a@x.com","telefono":"300…",
--     "segmento":"Oro","pedidos":12,"total_gastado":450000}, …]
-- Devuelve: {"recibidos":n,"validos":n,"insertados":n,"actualizados":n}
create or replace function public.importar_clientes_masivo(p_items jsonb)
returns jsonb
language plpgsql
-- SECURITY INVOKER = las policies RLS de `clientes` SÍ se aplican aquí dentro.
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
  if v_empresa is null then
    raise exception
      'Tu usuario no tiene una empresa asociada (nulo): no se pueden importar los clientes.'
      using errcode = 'P0001';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items debe ser un arreglo JSON de clientes.' using errcode = '22023';
  end if;

  v_recibidos := jsonb_array_length(p_items);
  if v_recibidos = 0 then
    return jsonb_build_object(
      'recibidos', 0, 'validos', 0, 'insertados', 0, 'actualizados', 0
    );
  end if;

  with entrada as (
    select
      nullif(btrim(coalesce(it ->> 'nombre', '')), '')                    as nombre,
      -- Se guarda con el formato original y se compara en minúsculas: el email
      -- es case-insensitive en la práctica, pero el usuario espera verlo tal
      -- como lo escribió en su archivo.
      nullif(btrim(coalesce(it ->> 'email', '')), '')                     as email_orig,
      lower(nullif(btrim(coalesce(it ->> 'email', '')), ''))              as email,
      nullif(btrim(coalesce(it ->> 'telefono', '')), '')                  as telefono,
      nullif(btrim(coalesce(it ->> 'segmento', '')), '')                  as segmento,
      greatest(coalesce(nullif(it ->> 'pedidos', '')::numeric, 0), 0)     as pedidos,
      greatest(coalesce(nullif(it ->> 'total_gastado', '')::numeric, 0), 0) as total_gastado,
      ord
    from jsonb_array_elements(p_items) with ordinality as t(it, ord)
  ),
  normalizada as (
    select
      nombre,
      lower(nombre) as nombre_norm,
      email,
      email_orig,
      telefono,
      -- Solo valores que pasan el CHECK; cualquier otra cosa queda sin clasificar.
      case when segmento in ('Oro', 'Plata', 'Bronce') then segmento end as segmento,
      pedidos,
      total_gastado,
      -- Clave de deduplicación DENTRO del lote: el email manda cuando existe
      -- (es la clave natural), y si no, el nombre normalizado.
      coalesce(email, lower(nombre)) as clave,
      ord
    from entrada
    where nombre is not null
  ),
  -- Ante el mismo cliente repetido en el archivo gana la ÚLTIMA aparición.
  validas as (
    select distinct on (clave) *
    from normalizada
    order by clave, ord desc
  ),
  -- Paso 1: actualizar los que YA existen en el CRM de esta empresa.
  -- `saldo_pendiente` NO se toca: es propiedad exclusiva de registrar_fiado y
  -- pisarlo con un dato del Excel descuadraría las cuentas por cobrar.
  actualizados as (
    update public.clientes c
       set nombre             = v.nombre,
           email              = coalesce(v.email_orig, c.email),
           telefono           = coalesce(v.telefono, c.telefono),
           segmento           = coalesce(v.segmento, c.segmento),
           -- El acumulado histórico nunca decrece por una re-importación parcial.
           compras_historicas = greatest(v.pedidos::integer, c.compras_historicas),
           total_gastado      = greatest(v.total_gastado, c.total_gastado)
      from validas v
     where c.empresa_id = v_empresa
       and (
         -- Con email: se empareja por email (case-insensitive).
         (v.email is not null and lower(c.email) = v.email)
         -- Sin email: por nombre normalizado, que es lo único disponible.
         or (v.email is null and lower(c.nombre) = v.nombre_norm)
       )
    returning v.clave
  ),
  -- Paso 2: insertar el resto. La referencia a `actualizados` fuerza el orden.
  insertados as (
    insert into public.clientes (
      empresa_id, nombre, email, telefono, segmento, compras_historicas, total_gastado
    )
    select
      v_empresa,            -- tenant estampado por el SERVIDOR, no por el cliente
      v.nombre,
      v.email_orig,
      v.telefono,
      v.segmento,
      v.pedidos::integer,
      v.total_gastado
    from validas v
    where not exists (select 1 from actualizados a where a.clave = v.clave)
    returning 1
  )
  select
    (select count(*) from validas),
    (select count(distinct clave) from actualizados),
    (select count(*) from insertados)
  into v_validos, v_actualizados, v_insertados;

  return jsonb_build_object(
    'recibidos',    v_recibidos,
    'validos',      coalesce(v_validos, 0),
    'insertados',   coalesce(v_insertados, 0),
    'actualizados', coalesce(v_actualizados, 0)
  );
end;
$$;

comment on function public.importar_clientes_masivo(jsonb) is
  'Carga masiva del CRM desde Excel/CSV. Empareja por email (o por nombre si no hay email) y actualiza; inserta el resto. Atómica y SECURITY INVOKER: respeta las policies RLS de clientes. Nunca toca saldo_pendiente.';

grant execute on function public.importar_clientes_masivo(jsonb) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — VENTAS
-- ════════════════════════════════════════════════════════════════════════════

-- ── 2.1) Columnas que el POS no necesitaba pero el histórico sí ─────────────
-- Hasta ahora `fetchVentasEmpresa` inventaba en el cliente el comprador
-- ("Venta POS"), el canal ("POS") y el estado ("Pagado") porque no había dónde
-- guardarlos. Una venta importada sí trae esos tres datos.
alter table public.ventas add column if not exists cliente_nombre text;
alter table public.ventas add column if not exists canal text;
alter table public.ventas add column if not exists estado text not null default 'Pagado';
alter table public.ventas add column if not exists referencia text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ventas'::regclass
      and conname = 'ventas_estado_check'
  ) then
    alter table public.ventas
      add constraint ventas_estado_check
      check (estado in ('Pagado', 'Pendiente', 'Reembolsado'));
  end if;
end $$;

comment on column public.ventas.cliente_nombre is
  'Comprador. Null en las ventas del POS (mostrador); lo llena la importación del histórico.';
comment on column public.ventas.canal is
  'Canal de venta del archivo importado. Null = POS.';
comment on column public.ventas.estado is
  'Pagado | Pendiente | Reembolsado. El POS siempre crea Pagado (es el DEFAULT); solo la importación produce los otros dos.';
comment on column public.ventas.referencia is
  'Folio/factura del sistema anterior. Clave de idempotencia de la importación; null en las ventas del POS.';

-- Clave única de la importación. NO es parcial para que `ON CONFLICT
-- (empresa_id, referencia)` pueda inferir el índice. Las ventas del POS llevan
-- `referencia` NULL y los NULL no colisionan entre sí (NULLS DISTINCT), así que
-- este índice no les impone ninguna restricción.
do $$
declare
  v_dups integer;
begin
  select count(*) into v_dups
  from (
    select empresa_id, referencia
    from public.ventas
    where referencia is not null
    group by empresa_id, referencia
    having count(*) > 1
  ) d;

  if v_dups > 0 then
    raise exception
      'No se puede crear el índice único: hay % combinaciones (empresa_id, referencia) duplicadas en public.ventas.',
      v_dups;
  end if;
end $$;

create unique index if not exists ventas_empresa_referencia_uniq
  on public.ventas (empresa_id, referencia);

-- ── 2.2) RPC de carga masiva de ventas ──────────────────────────────────────
-- Recibe:
--   [{"referencia":"F-1021","cliente":"Ana Ruiz","canal":"Mostrador",
--     "metodo":"Efectivo","monto":48000,"estado":"Pagado","fecha":"2026-03-14",
--     "ocurrencia":1}, …]
-- `referencia` y `ocurrencia` son opcionales (ver sus comentarios más abajo).
-- Devuelve: {"recibidos":n,"validos":n,"insertados":n,"omitidas":n}
create or replace function public.importar_ventas_masivo(p_items jsonb)
returns jsonb
language plpgsql
-- SECURITY INVOKER = la policy `ventas_insert_propia` SÍ se evalúa aquí dentro.
security invoker
set search_path = public, pg_temp
as $$
declare
  v_empresa    uuid := public.mi_empresa();
  v_recibidos  integer := 0;
  v_validos    integer := 0;
  v_insertados integer := 0;
begin
  if v_empresa is null then
    raise exception
      'Tu usuario no tiene una empresa asociada (nulo): no se pueden importar las ventas.'
      using errcode = 'P0001';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items debe ser un arreglo JSON de ventas.' using errcode = '22023';
  end if;

  v_recibidos := jsonb_array_length(p_items);
  if v_recibidos = 0 then
    return jsonb_build_object(
      'recibidos', 0, 'validos', 0, 'insertados', 0, 'omitidas', 0
    );
  end if;

  with entrada as (
    select
      nullif(btrim(coalesce(it ->> 'referencia', '')), '')              as referencia,
      nullif(btrim(coalesce(it ->> 'cliente', '')), '')                 as cliente,
      nullif(btrim(coalesce(it ->> 'canal', '')), '')                   as canal,
      coalesce(nullif(btrim(coalesce(it ->> 'metodo', '')), ''), 'No especificado') as metodo,
      greatest(coalesce(nullif(it ->> 'monto', '')::numeric, 0), 0)     as monto,
      -- Nº de aparición de esta fila entre las IDÉNTICAS del archivo, calculado
      -- en el cliente sobre el archivo COMPLETO. No se deriva aquí con
      -- row_number() porque el importador trocea en lotes: la numeración se
      -- reiniciaría en cada lote y dos ventas idénticas a ambos lados de un
      -- corte producirían la misma clave (la segunda se perdería por DO NOTHING).
      greatest(coalesce(nullif(it ->> 'ocurrencia', '')::integer, 1), 1) as ocurrencia,
      case
        when it ->> 'estado' in ('Pagado', 'Pendiente', 'Reembolsado') then it ->> 'estado'
        else 'Pagado'
      end                                                               as estado,
      -- La fecha ya llega normalizada a ISO desde el cliente (toISODate), pero
      -- cuando el Excel trae algo como "Julio" ese helper devuelve el texto tal
      -- cual. El guard del regex evita que un valor así reviente el lote entero
      -- con un 22007: lo que no sea YYYY-MM-DD queda NULL y abajo cae a now().
      case
        when btrim(coalesce(it ->> 'fecha', '')) ~ '^\d{4}-\d{2}-\d{2}$'
        then (btrim(it ->> 'fecha'))::date
      end                                                               as fecha,
      ord
    from jsonb_array_elements(p_items) with ordinality as t(it, ord)
  ),
  util as (
    select
      *,
      -- Huella del contenido de la venta: identifica filas "iguales".
      md5(
        coalesce(fecha::text, '') || '|' || lower(coalesce(cliente, '')) || '|' ||
        monto::text || '|' || lower(metodo) || '|' || estado
      ) as huella
    from entrada
    where cliente is not null or monto > 0
  ),
  con_clave as (
    select
      *,
      -- Sin folio en el archivo se deriva uno DETERMINISTA del contenido. El
      -- sufijo de ocurrencia evita dos problemas a la vez: dos ventas
      -- legítimamente idénticas el mismo día NO se colapsan en una, y
      -- re-importar el mismo archivo reproduce exactamente las mismas claves
      -- (así que no duplica nada).
      coalesce(
        referencia,
        'IMP-' || upper(substr(huella, 1, 12)) || '-' || ocurrencia
      ) as ref_final
    from util
  ),
  -- Dentro del lote, un mismo folio explícito repetido: gana la última fila.
  validas as (
    select distinct on (ref_final) *
    from con_clave
    order by ref_final, ord desc
  ),
  insertadas as (
    insert into public.ventas (
      empresa_id, total, items, metodo_pago, cliente_nombre, canal, estado, referencia, created_at
    )
    select
      v_empresa,            -- tenant estampado por el SERVIDOR, no por el cliente
      v.monto,
      '[]'::jsonb,          -- el histórico no trae el detalle de líneas
      v.metodo,
      v.cliente,
      v.canal,
      v.estado,
      v.ref_final,
      coalesce(v.fecha::timestamptz, now())
    from validas v
    -- Una venta histórica es inmutable: si ya se importó, se omite en silencio.
    -- (Además `ventas` no tiene policy de UPDATE: un DO UPDATE sería denegado.)
    on conflict (empresa_id, referencia) do nothing
    returning 1
  )
  select
    (select count(*) from validas),
    (select count(*) from insertadas)
  into v_validos, v_insertados;

  return jsonb_build_object(
    'recibidos',  v_recibidos,
    'validos',    coalesce(v_validos, 0),
    'insertados', coalesce(v_insertados, 0),
    'omitidas',   coalesce(v_validos, 0) - coalesce(v_insertados, 0)
  );
end;
$$;

comment on function public.importar_ventas_masivo(jsonb) is
  'Carga masiva del histórico de ventas desde Excel/CSV. Idempotente por (empresa_id, referencia) con ON CONFLICT DO NOTHING: una venta histórica no se reescribe. Atómica y SECURITY INVOKER: respeta la policy ventas_insert_propia.';

grant execute on function public.importar_ventas_masivo(jsonb) to authenticated;

-- ── 2.3) El total del dashboard deja de contar reembolsos ───────────────────
-- Hasta ahora `total_ventas_empresa()` sumaba TODAS las filas de `ventas`, lo
-- cual era correcto mientras la única fuente era el POS (que solo crea cobros
-- efectivos). Con el histórico importado entran ventas Reembolsadas y
-- Pendientes, que no son ingreso. El filtro es un no-op para todo lo que existía
-- antes: `estado` tiene DEFAULT 'Pagado', así que las ventas del POS —pasadas y
-- futuras— siguen contando exactamente igual.
create or replace function public.total_ventas_empresa()
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(total), 0)::numeric
  from public.ventas
  where empresa_id = public.mi_empresa()
    and coalesce(estado, 'Pagado') = 'Pagado';
$$;

grant execute on function public.total_ventas_empresa() to authenticated;

commit;

-- ============================================================================
-- VERIFICACIÓN (ejecutar a mano, opcional)
-- ----------------------------------------------------------------------------
-- 1) Ambas RPC deben quedar como INVOKER (prosecdef = false) y ejecutables:
--    select proname, prosecdef from pg_proc
--    where proname in ('importar_clientes_masivo', 'importar_ventas_masivo');
--    select has_function_privilege('authenticated',
--             'public.importar_clientes_masivo(jsonb)', 'execute'),
--           has_function_privilege('authenticated',
--             'public.importar_ventas_masivo(jsonb)', 'execute');
--
-- 2) Prueba en seco (como tu usuario, NO como postgres: la RPC necesita
--    auth.uid() para resolver mi_empresa()):
--    select public.importar_clientes_masivo(
--      '[{"nombre":"Cliente Import","email":"ci@test.com","telefono":"300","segmento":"Oro","pedidos":3,"total_gastado":90000}]'::jsonb);
--    -- Repetir: debe devolver actualizados = 1, insertados = 0.
--    select public.importar_ventas_masivo(
--      '[{"referencia":"TEST-F1","cliente":"Cliente Import","canal":"Mostrador","metodo":"Efectivo","monto":48000,"estado":"Pagado","fecha":"2026-03-14"}]'::jsonb);
--    -- Repetir: debe devolver insertados = 0, omitidas = 1.
--    delete from public.ventas   where referencia = 'TEST-F1';
--    delete from public.clientes where email = 'ci@test.com';
--
-- 3) Las policies NO cambiaron (clientes: 4, ventas: 2 — select e insert):
--    select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public' and tablename in ('clientes', 'ventas')
--    order by tablename, cmd;
--
-- 4) El total del dashboard excluye reembolsos pero no cambia para el POS:
--    select public.total_ventas_empresa() as con_filtro,
--           (select coalesce(sum(total),0) from public.ventas
--             where empresa_id = public.mi_empresa()) as sin_filtro;
-- ============================================================================
