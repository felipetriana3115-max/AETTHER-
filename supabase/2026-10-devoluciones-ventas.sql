-- ============================================================================
-- Aether ERP — Devoluciones de venta (reversión atómica de stock + ajuste)
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   · 2026-07-roles-y-rls.sql              (helpers `mi_empresa()` / `mi_rol()`)
--   · 2026-07-crear-ventas.sql             (tabla `public.ventas` + RLS)
--   · 2026-07-total-ventas.sql             (RPC `total_ventas_empresa`)
--   · 2026-07-metricas-rentabilidad.sql    (RPC `metricas_rentabilidad_empresa`)
--   · 2026-10-import-masivo-crm-ventas.sql (columna `ventas.estado`)
-- Opcionales (si no están, la devolución igual funciona; solo se omite el
-- egreso de caja):
--   · 2026-07-arqueo-caja.sql   (tabla `public.movimientos_caja`)
--   · 2026-08-arqueo-diario.sql (función `public.hoy_negocio()`)
-- Es idempotente (create or replace / add column if not exists).
--
-- QUÉ RESUELVE
-- ------------
-- El panel de Transacciones (app/ventas/page.tsx) ya pintaba el estado
-- "Reembolsado", pero no había forma de producirlo: no existía ninguna operación
-- que devolviera una venta. Hacerlo desde el cliente con dos escrituras sueltas
-- (sumar stock + marcar la venta) no es aceptable: si la segunda falla, el
-- inventario queda inflado y la venta sigue contando como ingreso.
--
-- RESERVADA AL DUEÑO: la función exige `mi_rol()` en (empresa_admin,
-- super_admin). El chequeo vive DENTRO de la RPC, no solo en la interfaz:
-- siendo SECURITY DEFINER, un empleado con la anon key podría invocarla
-- directamente si el gateo fuera únicamente de React.
--
-- `registrar_devolucion` hace TODO en una sola transacción:
--   1. Bloquea la venta (`for update`) y comprueba que sea de ESTA empresa.
--   2. Devuelve al inventario las unidades de cada línea de catálogo.
--   3. Marca la venta como 'Reembolsado' y deja la auditoría (quién y cuándo).
--   4. Registra el egreso de caja si el cobro había sido en efectivo.
--
-- AISLAMIENTO MULTI-TENANT / RLS
-- ------------------------------
-- Es **SECURITY DEFINER** por necesidad: `public.ventas` NO tiene (ni debe
-- tener) policy de UPDATE —crearla abriría la edición de todas las ventas del
-- POS desde el cliente—, así que el cambio de estado tiene que ocurrir dentro de
-- una función controlada. A cambio, la empresa NUNCA viaja en el payload: se
-- resuelve server-side con `public.mi_empresa()` y TODAS las sentencias filtran
-- por ella. Un `p_venta_id` de otro tenant no encuentra fila y aborta.
-- Este script NO desactiva, borra ni debilita ninguna política existente.
--
-- IDEMPOTENCIA
-- ------------
-- Una venta ya devuelta se detecta por `estado = 'Reembolsado'` y la función
-- retorna sin volver a sumar stock: un doble clic (o un reintento de red) no
-- puede inflar el inventario.
-- ============================================================================

begin;

-- ── 1) Columnas de estado y auditoría de la devolución ──────────────────────
-- `estado` normalmente ya existe (2026-10-import-masivo-crm-ventas.sql); se
-- re-declara aquí para que esta migración sea autosuficiente en bases antiguas.
alter table public.ventas add column if not exists estado text not null default 'Pagado';
alter table public.ventas add column if not exists devuelta_at timestamptz;
alter table public.ventas add column if not exists devuelta_por uuid;
alter table public.ventas add column if not exists devuelta_motivo text;

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

comment on column public.ventas.devuelta_at is
  'Momento en que se procesó la devolución. Null = la venta nunca se devolvió.';
comment on column public.ventas.devuelta_por is
  'auth.uid() de quien procesó la devolución (auditoría). No es una FK para no acoplar public.ventas al esquema auth.';
comment on column public.ventas.devuelta_motivo is
  'Motivo opcional capturado en el panel de Transacciones.';

-- ── 2) RPC atómica de devolución ────────────────────────────────────────────
create or replace function public.registrar_devolucion(
  p_venta_id uuid,
  p_motivo   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa     uuid := public.mi_empresa();
  v_rol         text := public.mi_rol()::text;
  v_venta       public.ventas;
  v_item        jsonb;
  v_raw_id      text;
  v_id          uuid;
  v_qty         integer;
  v_unidades    integer := 0;
  v_lineas      integer := 0;
  v_sin_producto integer := 0;
  v_motivo      text := nullif(btrim(coalesce(p_motivo, '')), '');
begin
  -- 0) Guardas de contexto -------------------------------------------------
  if v_empresa is null then
    raise exception 'Tu usuario no tiene una empresa asociada (nulo): no se puede devolver la venta.'
      using errcode = '42501';
  end if;

  -- SOLO EL DUEÑO DEVUELVE. Una devolución mueve dinero (egreso de caja) e
  -- inventario sobre una venta YA cerrada, así que no es una operación de
  -- mostrador. El gateo va aquí dentro —no solo en la interfaz— porque esta
  -- función es SECURITY DEFINER: si el chequeo viviera únicamente en React,
  -- cualquiera con la anon key podría invocar la RPC directamente y reembolsar.
  -- `coalesce` deliberado: si el rol no se resuelve, `not in` daría NULL y el
  -- `if` no dispararía — fail-OPEN. Con '' la guarda falla cerrada.
  if coalesce(v_rol, '') not in ('empresa_admin', 'super_admin') then
    raise exception
      'Solo el administrador de la empresa puede procesar devoluciones.'
      using errcode = '42501';
  end if;

  if p_venta_id is null then
    raise exception 'Falta el identificador de la venta a devolver.' using errcode = '22023';
  end if;

  -- 1) Venta de ESTA empresa, bloqueada para serializar devoluciones --------
  --    El filtro por empresa_id es lo que hace seguro el SECURITY DEFINER.
  select * into v_venta
    from public.ventas
   where id = p_venta_id
     and empresa_id = v_empresa
   for update;

  if not found then
    raise exception 'La venta no existe o no pertenece a tu empresa.' using errcode = 'P0001';
  end if;

  -- 2) Cortocircuito de idempotencia: ya devuelta → no se re-suma stock -----
  if v_venta.estado = 'Reembolsado' then
    return jsonb_build_object(
      'venta_id',   v_venta.id,
      'duplicada',  true,
      'total',      v_venta.total,
      'unidades',   0,
      'lineas',     0,
      'sin_producto', 0
    );
  end if;

  -- 3) Reversión del inventario, línea por línea ---------------------------
  for v_item in
    select value from jsonb_array_elements(coalesce(v_venta.items, '[]'::jsonb)) as t(value)
  loop
    -- Los "artículos comunes" nunca descontaron stock, así que tampoco lo
    -- devuelven. Igual que en registrar_venta_offline.
    if coalesce((v_item->>'esComun')::boolean, false) then
      continue;
    end if;

    v_raw_id := v_item->>'id';
    -- Guarda defensiva: una venta vieja podría no traer `esComun` y llevar el id
    -- negativo de un artículo suelto. Sin este filtro el cast reventaría (22P02)
    -- y tumbaría la devolución entera.
    if v_raw_id is null or v_raw_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      continue;
    end if;

    v_id  := v_raw_id::uuid;
    v_qty := coalesce((v_item->>'qty')::integer, 0);
    if v_qty <= 0 then
      continue;
    end if;

    v_lineas := v_lineas + 1;

    update public.productos
       set stock_actual = stock_actual + v_qty
     where id = v_id
       and empresa_id = v_empresa;

    if found then
      v_unidades := v_unidades + v_qty;
    else
      -- El producto se borró del catálogo tras la venta. No es motivo para
      -- abortar la devolución (el dinero sí hay que devolverlo); se reporta
      -- para que la interfaz lo advierta.
      v_sin_producto := v_sin_producto + 1;
    end if;
  end loop;

  -- 4) Marcar la venta como reembolsada + auditoría -------------------------
  update public.ventas
     set estado          = 'Reembolsado',
         devuelta_at     = now(),
         devuelta_por    = auth.uid(),
         devuelta_motivo = v_motivo
   where id = v_venta.id
     and empresa_id = v_empresa;

  -- 5) Ajuste de caja: el efectivo devuelto SALE del cajón hoy --------------
  --    Solo para cobros en efectivo: en Nequi/Bold/Fiado no hay billete que
  --    sacar del cajón, así que un egreso falsearía el arqueo. El bloque va
  --    protegido porque el módulo de arqueo es opcional: si no está instalado,
  --    el savepoint se revierte y la devolución (stock + estado) se conserva.
  if v_venta.metodo_pago = 'Efectivo' and coalesce(v_venta.total, 0) > 0 then
    begin
      insert into public.movimientos_caja (empresa_id, fecha, tipo, monto, concepto)
      values (
        v_empresa,
        public.hoy_negocio(),
        'egreso',
        v_venta.total,
        'Devolución venta ' || left(v_venta.id::text, 8)
          || coalesce(' · ' || v_motivo, '')
      );
    exception
      when undefined_table or undefined_function then
        raise notice 'Módulo de arqueo no instalado: se omite el egreso de caja de la devolución.';
    end;
  end if;

  return jsonb_build_object(
    'venta_id',     v_venta.id,
    'duplicada',    false,
    'total',        v_venta.total,
    'metodo',       v_venta.metodo_pago,
    'unidades',     v_unidades,
    'lineas',       v_lineas,
    'sin_producto', v_sin_producto
  );
end;
$$;

comment on function public.registrar_devolucion(uuid, text) is
  'Devuelve una venta: restaura el stock de sus líneas de catálogo, marca la venta como Reembolsado y registra el egreso de caja si el cobro fue en efectivo. Atómica e idempotente; la empresa la resuelve el servidor con mi_empresa() y solo la ejecuta empresa_admin/super_admin.';

grant execute on function public.registrar_devolucion(uuid, text) to authenticated;

-- ── 6) Las ventas devueltas dejan de contar como ingreso ────────────────────
-- Sin esto, una venta reembolsada seguiría sumando al total del dashboard y a
-- las métricas de rentabilidad (el cliente ya la excluía del gráfico mensual:
-- ver `deriveMonthlyRevenue`). Ambas RPC conservan su firma y su semántica de
-- aislamiento: solo se añade el filtro por estado.
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
    and coalesce(estado, 'Pagado') <> 'Reembolsado';
$$;

grant execute on function public.total_ventas_empresa() to authenticated;

create or replace function public.metricas_rentabilidad_empresa()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with lineas as (
    select
      item->>'id'                                   as raw_id,
      coalesce((item->>'esComun')::boolean, false)  as es_comun,
      coalesce((item->>'qty')::numeric, 0)          as qty,
      coalesce((item->>'precio')::numeric, 0)       as precio
    from public.ventas v
    cross join lateral jsonb_array_elements(v.items) as item
    where v.empresa_id = public.mi_empresa()
      -- Una venta devuelta no generó ingreso ni consumió mercancía.
      and coalesce(v.estado, 'Pagado') <> 'Reembolsado'
  ),
  -- Solo líneas de productos REALES del catálogo (con costo conocido). Los
  -- artículos comunes quedan fuera y su id negativo jamás casa con un id real.
  vendidos as (
    select l.qty, l.precio, coalesce(p.precio_costo, 0) as precio_costo
    from lineas l
    join public.productos p
      on p.empresa_id = public.mi_empresa()
     and p.id::text = l.raw_id
    where not l.es_comun
  ),
  ventas_agg as (
    select
      coalesce(sum(qty * precio), 0)        as ingresos,
      coalesce(sum(qty * precio_costo), 0)  as costo,
      coalesce(sum(qty), 0)                 as unidades
    from vendidos
  ),
  inv_agg as (
    select coalesce(sum(coalesce(stock_actual, 0) * coalesce(precio_costo, 0)), 0) as valor_costo
    from public.productos
    where empresa_id = public.mi_empresa()
  )
  select jsonb_build_object(
    'ingresos',               va.ingresos,
    'costo',                  va.costo,
    'unidades_vendidas',      va.unidades,
    'valor_inventario_costo', ia.valor_costo,
    'margen',   case when va.ingresos   > 0
                     then round(((va.ingresos - va.costo) / va.ingresos) * 100, 1)
                     else 0 end,
    'rotacion', case when ia.valor_costo > 0
                     then round(va.costo / ia.valor_costo, 2)
                     else 0 end
  )
  from ventas_agg va cross join inv_agg ia;
$$;

grant execute on function public.metricas_rentabilidad_empresa() to authenticated;

commit;

-- Verificación rápida:
--   -- 1) Toma una venta del POS con líneas de catálogo:
--   select id, total, metodo_pago, estado, items from public.ventas
--    where jsonb_array_length(items) > 0 order by created_at desc limit 1;
--   -- 2) Devuélvela (dos veces: la segunda debe responder "duplicada": true
--   --    y NO volver a sumar stock):
--   select public.registrar_devolucion('<venta_id>', 'Producto defectuoso');
--   -- 3) Comprueba el estado, el stock y el egreso de caja:
--   select estado, devuelta_at, devuelta_por from public.ventas where id = '<venta_id>';
--   select concepto, tipo, monto from public.movimientos_caja order by created_at desc limit 3;
