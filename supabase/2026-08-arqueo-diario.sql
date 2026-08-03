-- ============================================================================
-- Aether ERP — Arqueo por DÍA DE NEGOCIO (America/Bogota) + lectura optimizada
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-corte-de-caja.sql   (tabla cortes_caja + RPC sumar_corte_caja)
--   • 2026-07-arqueo-caja.sql     (movimientos_caja + abrir_caja / cerrar_caja)
--   • 2026-08-ventas-offline.sql  (RPC registrar_venta_offline)
-- Es idempotente.
--
-- MOTIVO: el arqueo "arrastraba" valores del día anterior. La causa era una
-- doble noción de "hoy": el frontend filtraba por la fecha LOCAL del navegador
-- (Colombia, UTC-5) mientras la BD escribía/leía con `current_date`, que en
-- Supabase corre en UTC. Entre las 7:00 p.m. y medianoche hora Colombia, UTC ya
-- está en el día siguiente: las ventas y movimientos de esa franja caían en la
-- fila de "mañana" y reaparecían como si fueran de hoy a la mañana siguiente.
--
-- ARREGLO: un único "día de negocio" en America/Bogota — `public.hoy_negocio()`
-- — usado en TODA la escritura de caja (defaults de fecha, apertura, cierre,
-- acumulado del POS y reenvío offline). El frontend calcula la misma fecha en
-- America/Bogota, así que ambos lados coinciden y el arqueo reinicia limpio a la
-- medianoche local. No cambia el histórico: solo cambia en QUÉ fecha cae una
-- fila NUEVA; las filas ya guardadas quedan intactas y los reportes por `fecha`
-- siguen funcionando igual.
-- ============================================================================

begin;

-- 1) Día de negocio en zona horaria de Colombia ------------------------------
-- `now()` es estable dentro de una transacción, así que todas las sentencias de
-- una misma RPC (cierre, reenvío offline) ven la MISMA fecha. Marcada `stable`.
create or replace function public.hoy_negocio()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/Bogota')::date;
$$;

grant execute on function public.hoy_negocio() to authenticated;

-- 2) Defaults de fecha → día de negocio --------------------------------------
-- Cubre los INSERT directos del cliente (movimientos_caja) y cualquier inserción
-- que dependa del DEFAULT. Solo afecta filas nuevas.
alter table public.cortes_caja      alter column fecha set default public.hoy_negocio();
alter table public.movimientos_caja alter column fecha set default public.hoy_negocio();

-- 3) Acumulado del POS: la venta suma al corte del día de negocio -------------
create or replace function public.sumar_corte_caja(
  p_total  numeric,
  p_metodo text
)
returns public.cortes_caja
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa uuid := public.mi_empresa();
  v_row     public.cortes_caja;
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada.';
  end if;

  insert into public.cortes_caja as c (
    empresa_id, fecha, total_general,
    total_efectivo, total_nequi, total_bold, num_ventas
  )
  values (
    v_empresa, public.hoy_negocio(), p_total,
    case when p_metodo = 'Efectivo'         then p_total else 0 end,
    case when p_metodo = 'Nequi/Daviplata'  then p_total else 0 end,
    case when p_metodo = 'Bold'             then p_total else 0 end,
    1
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

grant execute on function public.sumar_corte_caja(numeric, text) to authenticated;

-- 4) Apertura de caja: base inicial del día de negocio ------------------------
create or replace function public.abrir_caja(p_base numeric)
returns public.cortes_caja
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa uuid := public.mi_empresa();
  v_row     public.cortes_caja;
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada.' using errcode = '42501';
  end if;
  if p_base is null or p_base < 0 then
    raise exception 'La base inicial no puede ser negativa.' using errcode = '22023';
  end if;

  insert into public.cortes_caja as c (empresa_id, fecha, base_inicial, estado, abierto_at)
  values (v_empresa, public.hoy_negocio(), p_base, 'abierta', now())
  on conflict (empresa_id, fecha) do update set
    base_inicial     = excluded.base_inicial,
    estado           = 'abierta',
    abierto_at       = coalesce(c.abierto_at, now()),
    efectivo_contado = null,   -- reabrir descarta el conteo anterior
    diferencia       = null,
    cerrado_at       = null,
    updated_at       = now()
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.abrir_caja(numeric) to authenticated;

-- 5) Cierre ciego: esperado/diferencia del día de negocio ---------------------
create or replace function public.cerrar_caja(p_efectivo_contado numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa    uuid := public.mi_empresa();
  v_hoy        date := public.hoy_negocio();
  v_corte      public.cortes_caja;
  v_ingresos   numeric(14, 2);
  v_egresos    numeric(14, 2);
  v_esperado   numeric(14, 2);
  v_diferencia numeric(14, 2);
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada.' using errcode = '42501';
  end if;
  if p_efectivo_contado is null or p_efectivo_contado < 0 then
    raise exception 'El efectivo contado no puede ser negativo.' using errcode = '22023';
  end if;

  select * into v_corte
  from public.cortes_caja
  where empresa_id = v_empresa and fecha = v_hoy
  for update;

  if not found then
    raise exception 'No hay una caja abierta hoy para cerrar.' using errcode = 'P0002';
  end if;

  select
    coalesce(sum(monto) filter (where tipo = 'ingreso'), 0),
    coalesce(sum(monto) filter (where tipo = 'egreso'), 0)
  into v_ingresos, v_egresos
  from public.movimientos_caja
  where empresa_id = v_empresa and fecha = v_hoy;

  -- Efectivo esperado en cajón = base + ventas en efectivo + ingresos - egresos.
  -- (Nequi/Bold no tocan el cajón físico, por eso solo entra total_efectivo.)
  v_esperado   := v_corte.base_inicial + v_corte.total_efectivo + v_ingresos - v_egresos;
  v_diferencia := p_efectivo_contado - v_esperado;

  update public.cortes_caja
     set estado           = 'cerrada',
         efectivo_contado = p_efectivo_contado,
         diferencia       = v_diferencia,
         cerrado_at       = now(),
         updated_at       = now()
   where empresa_id = v_empresa and fecha = v_hoy
   returning * into v_corte;

  return jsonb_build_object(
    'corte',            to_jsonb(v_corte),
    'base_inicial',     v_corte.base_inicial,
    'ventas_efectivo',  v_corte.total_efectivo,
    'ingresos',         v_ingresos,
    'egresos',          v_egresos,
    'esperado',         v_esperado,
    'efectivo_contado', p_efectivo_contado,
    'diferencia',       v_diferencia
  );
end;
$$;

grant execute on function public.cerrar_caja(numeric) to authenticated;

-- 6) Reenvío offline: cortocircuito de idempotencia por día de negocio --------
create or replace function public.registrar_venta_offline(
  p_client_uuid uuid,
  p_metodo      text,
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
  v_empresa  uuid := public.mi_empresa();
  v_item     jsonb;
  v_id       uuid;
  v_qty      integer;
  v_es_comun boolean;
  v_venta_id uuid;
  v_corte    public.cortes_caja;
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada (empresa_id nulo).'
      using errcode = '42501';
  end if;

  if p_client_uuid is null then
    raise exception 'Falta client_uuid (clave de idempotencia).' using errcode = '22023';
  end if;

  if p_metodo not in ('Efectivo', 'Nequi/Daviplata', 'Bold') then
    raise exception 'Método de pago inválido: %', p_metodo using errcode = '22023';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'El parámetro items debe ser un arreglo JSON.' using errcode = '22023';
  end if;

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

  insert into public.ventas (empresa_id, total, items, metodo_pago, client_uuid, created_at)
  values (v_empresa, p_total, coalesce(p_items, '[]'::jsonb), p_metodo, p_client_uuid,
          coalesce(p_created_at, now()))
  returning id into v_venta_id;

  select * into v_corte from public.sumar_corte_caja(p_total, p_metodo);

  return jsonb_build_object(
    'venta_id',  v_venta_id,
    'duplicada', false,
    'corte',     to_jsonb(v_corte)
  );
end;
$$;

grant execute on function public.registrar_venta_offline(uuid, text, numeric, jsonb, timestamptz)
  to authenticated;

-- 7) Lectura optimizada del arqueo del día en UNA sola llamada ----------------
-- Reemplaza las dos consultas del frontend (corte + movimientos) por un único
-- round-trip. La fecha la decide el servidor con `hoy_negocio()`, así que el
-- cliente no puede desalinear el filtro por día. `corte` es null si aún no hay
-- fila para hoy; `movimientos` va ordenado del más reciente al más antiguo.
create or replace function public.arqueo_hoy()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa uuid := public.mi_empresa();
  v_hoy     date := public.hoy_negocio();
  v_corte   public.cortes_caja;
  v_found   boolean := false;
  v_movs    jsonb;
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada.' using errcode = '42501';
  end if;

  select * into v_corte
  from public.cortes_caja
  where empresa_id = v_empresa and fecha = v_hoy;
  v_found := found;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at desc), '[]'::jsonb)
  into v_movs
  from public.movimientos_caja m
  where m.empresa_id = v_empresa and m.fecha = v_hoy;

  return jsonb_build_object(
    'corte',       case when v_found then to_jsonb(v_corte) else null end,
    'movimientos', v_movs
  );
end;
$$;

grant execute on function public.arqueo_hoy() to authenticated;

commit;

-- Verificación rápida:
--   select public.hoy_negocio();                 -- fecha en America/Bogota
--   select public.arqueo_hoy();                  -- { corte, movimientos } de hoy
