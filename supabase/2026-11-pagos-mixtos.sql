-- ============================================================================
-- Aether ERP — PAGOS FRACCIONADOS / MIXTOS en el POS
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-crear-ventas.sql    (tabla ventas + RLS)
--   • 2026-07-corte-de-caja.sql   (tabla cortes_caja)
--   • 2026-08-ventas-offline.sql  (ventas.client_uuid + idempotencia)
--   • 2026-08-arqueo-diario.sql   (hoy_negocio() + sumar_corte_caja)
-- Es idempotente (add column if not exists / create or replace).
--
-- QUÉ RESUELVE: hasta ahora una venta solo podía cobrarse con UN medio de pago
-- (`ventas.metodo_pago`), así que el caso más común del mostrador —"le doy
-- $20.000 en efectivo y el resto por Nequi"— obligaba a partir la venta en dos
-- tickets o a mentir en el método. Eso descuadraba el arqueo: todo el importe
-- caía en un solo bucket de `cortes_caja` y el efectivo esperado del cierre
-- ciego no coincidía con el cajón.
--
-- CÓMO: una columna `ventas.pagos` (jsonb) guarda el desglose real
-- [{"metodo":"Efectivo","monto":20000},{"metodo":"Bold","monto":35000}] y la
-- RPC `registrar_venta_mixta` reparte CADA monto en su bucket del corte dentro
-- de la MISMA transacción que descuenta el stock y crea la venta.
--
-- SEGURIDAD: mismo contrato que el resto del POS. `security definer` con
-- `search_path = public`, la empresa la resuelve el SERVIDOR con `mi_empresa()`
-- (nunca viaja en el payload) e idempotencia por `client_uuid`, de modo que un
-- reintento de la cola offline no duplica la venta ni el corte. No se crea,
-- modifica ni relaja ninguna policy de RLS: las de `ventas` y `cortes_caja`
-- siguen exactamente como estaban.
--
-- NOTA SOBRE DEVOLUCIONES: una venta mixta se guarda con
-- `metodo_pago = 'Mixto'`, y `resolver_devolucion` solo genera el egreso
-- automático de caja (y el pulso del cajón) cuando el cobro fue
-- `metodo_pago = 'Efectivo'`. Es decir: devolver una venta mixta NO mueve el
-- cajón por su cuenta. Es el comportamiento conservador a propósito — el
-- servidor no adivina de qué bolsillo sale el reembolso—; si el dinero se
-- devuelve en efectivo, el administrador registra el egreso desde Arqueo de
-- Caja y el Reporte Z vuelve a cuadrar.
-- ============================================================================

begin;

-- ── 1) Desglose por medio de pago, en la propia venta ───────────────────────
-- Arreglo jsonb [{metodo, monto}]. Vacío en las ventas de un solo método (ahí
-- manda `metodo_pago`), así que las filas históricas no necesitan backfill.
alter table public.ventas
  add column if not exists pagos jsonb not null default '[]'::jsonb;

comment on column public.ventas.pagos is
  'Desglose del cobro por medio de pago: [{"metodo":"Efectivo","monto":20000},…]. '
  'Lo escribe únicamente registrar_venta_mixta. Vacío ([]) en las ventas cobradas '
  'con un solo método, donde la fuente de verdad sigue siendo metodo_pago.';

-- ── 2) Acumulado de caja de una venta con varios medios de pago ─────────────
-- Hermana de `sumar_corte_caja`, pero repartiendo el importe entre los tres
-- buckets en una sola fila de `cortes_caja` (num_ventas suma 1, no uno por
-- medio de pago: sigue siendo UNA venta).
create or replace function public.sumar_corte_mixto(p_pagos jsonb)
returns public.cortes_caja
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa  uuid := public.mi_empresa();
  v_row      public.cortes_caja;
  v_efectivo numeric(14, 2);
  v_nequi    numeric(14, 2);
  v_bold     numeric(14, 2);
  v_total    numeric(14, 2);
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada.' using errcode = '42501';
  end if;

  select
    coalesce(sum(monto) filter (where metodo = 'Efectivo'), 0),
    coalesce(sum(monto) filter (where metodo = 'Nequi/Daviplata'), 0),
    coalesce(sum(monto) filter (where metodo = 'Bold'), 0),
    coalesce(sum(monto), 0)
  into v_efectivo, v_nequi, v_bold, v_total
  from (
    select
      t.p->>'metodo'                      as metodo,
      round((t.p->>'monto')::numeric, 2)  as monto
    from jsonb_array_elements(coalesce(p_pagos, '[]'::jsonb)) as t(p)
  ) s;

  insert into public.cortes_caja as c (
    empresa_id, fecha, total_general,
    total_efectivo, total_nequi, total_bold, num_ventas
  )
  values (
    v_empresa, public.hoy_negocio(), v_total,
    v_efectivo, v_nequi, v_bold, 1
  )
  on conflict (empresa_id, fecha) do update set
    total_general  = c.total_general  + excluded.total_general,
    total_efectivo = c.total_efectivo + excluded.total_efectivo,
    total_nequi    = c.total_nequi    + excluded.total_nequi,
    total_bold     = c.total_bold     + excluded.total_bold,
    num_ventas     = c.num_ventas     + 1,
    updated_at     = now()
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.sumar_corte_mixto(jsonb) to authenticated;

-- ── 3) Registro de la venta con pago fraccionado ────────────────────────────
-- Misma firma y mismas garantías que `registrar_venta_offline` (idempotente por
-- client_uuid, descuento de stock con guard `>= qty`, todo en una transacción),
-- cambiando el método único por el arreglo `p_pagos`.
create or replace function public.registrar_venta_mixta(
  p_client_uuid uuid,
  p_pagos       jsonb,
  p_total       numeric,
  p_items       jsonb,
  p_created_at  timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa    uuid := public.mi_empresa();
  v_item       jsonb;
  v_id         uuid;
  v_qty        integer;
  v_es_comun   boolean;
  v_venta_id   uuid;
  v_corte      public.cortes_caja;
  v_n          integer;
  v_distintos  integer;
  v_suma       numeric(14, 2);
  v_metodo     text;
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada (empresa_id nulo).'
      using errcode = '42501';
  end if;

  if p_client_uuid is null then
    raise exception 'Falta client_uuid (clave de idempotencia).' using errcode = '22023';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'El parámetro items debe ser un arreglo JSON.' using errcode = '22023';
  end if;

  -- 3.1 Validación del desglose -------------------------------------------
  -- El cliente NO decide qué es un medio de pago válido ni si el desglose
  -- cuadra: se comprueba aquí, donde no se puede manipular. Todos los fallos
  -- salen como 22023 (error de negocio) para que la cola offline los marque y
  -- no los reintente en bucle.
  if p_pagos is null
     or jsonb_typeof(p_pagos) <> 'array'
     or jsonb_array_length(p_pagos) = 0 then
    raise exception 'El desglose de pagos debe ser un arreglo JSON con al menos un medio de pago.'
      using errcode = '22023';
  end if;

  -- `case` en vez de encadenar `or`: Postgres no garantiza cortocircuito, y sin
  -- él un `monto` no numérico reventaría en el cast con 22P02 (que la cola
  -- trataría como transitorio y reintentaría para siempre).
  if exists (
    select 1
    from jsonb_array_elements(p_pagos) as t(p)
    where jsonb_typeof(t.p) <> 'object'
       or coalesce(t.p->>'metodo', '') not in ('Efectivo', 'Nequi/Daviplata', 'Bold')
       or jsonb_typeof(t.p->'monto') <> 'number'
       or case
            when jsonb_typeof(t.p->'monto') = 'number'
              then round((t.p->>'monto')::numeric, 2) <= 0
            else false
          end
  ) then
    raise exception
      'Desglose de pagos inválido: cada entrada necesita un medio de caja (Efectivo, Nequi/Daviplata o Bold) y un monto mayor que cero.'
      using errcode = '22023';
  end if;

  select
    count(*),
    count(distinct t.p->>'metodo'),
    coalesce(sum(round((t.p->>'monto')::numeric, 2)), 0)
  into v_n, v_distintos, v_suma
  from jsonb_array_elements(p_pagos) as t(p);

  if v_n <> v_distintos then
    raise exception 'El desglose repite un mismo medio de pago; agrupa su importe en una sola entrada.'
      using errcode = '22023';
  end if;

  if v_suma <> round(coalesce(p_total, 0), 2) then
    raise exception
      'El desglose de pagos suma % pero la venta es de %. Deben coincidir exactamente.',
      v_suma, round(coalesce(p_total, 0), 2)
      using errcode = '22023';
  end if;

  -- 3.2 Cortocircuito de idempotencia --------------------------------------
  select id into v_venta_id
    from public.ventas
   where empresa_id = v_empresa
     and client_uuid = p_client_uuid
   limit 1;

  if v_venta_id is not null then
    select * into v_corte
      from public.cortes_caja
     where empresa_id = v_empresa and fecha = public.hoy_negocio();
    return jsonb_build_object(
      'venta_id',  v_venta_id,
      'duplicada', true,
      'corte',     to_jsonb(v_corte)
    );
  end if;

  -- 3.3 Descuento de inventario (idéntico a registrar_venta_offline) --------
  for v_item in select value from jsonb_array_elements(p_items) as t(value)
  loop
    v_es_comun := coalesce((v_item->>'esComun')::boolean, false);
    if v_es_comun then
      continue;
    end if;

    v_id  := (v_item->>'id')::uuid;
    v_qty := coalesce((v_item->>'qty')::integer, 0);

    if v_id is null then
      continue;
    end if;

    if v_qty <= 0 then
      raise exception 'Cantidad inválida (%) para el producto %.', v_qty, v_id
        using errcode = '22023';
    end if;

    update public.productos
       set stock_actual = stock_actual - v_qty
     where id = v_id
       and empresa_id = v_empresa
       and stock_actual >= v_qty;

    if not found then
      raise exception
        'Stock insuficiente o producto no disponible (id=%, requerido=%).',
        v_id, v_qty
        using errcode = 'P0001';
    end if;
  end loop;

  -- 3.4 La venta -------------------------------------------------------------
  -- Con un solo medio de pago se conserva su nombre en `metodo_pago` (así los
  -- reportes y las devoluciones se comportan igual que siempre); con dos o más
  -- se marca 'Mixto' y el detalle vive en `pagos`.
  v_metodo := case when v_n = 1 then p_pagos->0->>'metodo' else 'Mixto' end;

  insert into public.ventas (
    empresa_id, total, items, metodo_pago, pagos, client_uuid, created_at
  )
  values (
    v_empresa, p_total, coalesce(p_items, '[]'::jsonb), v_metodo, p_pagos,
    p_client_uuid, coalesce(p_created_at, now())
  )
  returning id into v_venta_id;

  -- 3.5 Caja: cada monto a su bucket ----------------------------------------
  select * into v_corte from public.sumar_corte_mixto(p_pagos);

  return jsonb_build_object(
    'venta_id',  v_venta_id,
    'duplicada', false,
    'metodo',    v_metodo,
    'corte',     to_jsonb(v_corte)
  );
end;
$$;

grant execute on function public.registrar_venta_mixta(uuid, jsonb, numeric, jsonb, timestamptz)
  to authenticated;

commit;

-- Verificación rápida:
--   select id, total, metodo_pago, pagos from public.ventas
--    where pagos <> '[]'::jsonb order by created_at desc limit 5;
--   select fecha, total_general, total_efectivo, total_nequi, total_bold, num_ventas
--     from public.cortes_caja where fecha = public.hoy_negocio();
