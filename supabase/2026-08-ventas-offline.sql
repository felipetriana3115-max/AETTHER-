-- ============================================================================
-- Aether ERP — Modo Sin Internet: sincronización idempotente de ventas offline
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-crear-ventas.sql       (tabla public.ventas)
--   • 2026-07-corte-de-caja.sql      (RPC sumar_corte_caja)
--   • 2026-07-registrar-venta.sql    (RPC registrar_venta, que replicamos aquí)
-- Es idempotente (create or replace / add column if not exists).
--
-- MOTIVO: el POS ahora encola las ventas cobradas SIN CONEXIÓN en el navegador
-- (IndexedDB/Dexie) y las reenvía cuando vuelve la red. Un reenvío puede repetir
-- una venta que el servidor YA registró (p. ej. la respuesta se perdió por un
-- corte de red justo tras el COMMIT). Para NO duplicar, cada venta lleva un
-- `client_uuid` generado una sola vez en el cliente:
--
--   • Se añade la columna única `ventas.client_uuid`.
--   • `registrar_venta_offline` primero busca una venta con ese uuid en la
--     empresa: si existe, la devuelve TAL CUAL (sin volver a descontar stock ni
--     sumar el corte). Si no, procede como `registrar_venta` y la marca con el
--     uuid, todo en una sola transacción.
--
-- La RPC clásica `registrar_venta` NO cambia: las ventas online en vivo la
-- siguen usando. Esta función es exclusiva del reenvío de la cola offline.
-- ============================================================================

begin;

-- 1) Clave de idempotencia en ventas ----------------------------------------
alter table public.ventas
  add column if not exists client_uuid uuid;

-- Único por empresa: dos empresas podrían (teóricamente) generar el mismo uuid;
-- lo acotamos al tenant. NULL permitido para las ventas online históricas.
create unique index if not exists ventas_empresa_client_uuid_key
  on public.ventas (empresa_id, client_uuid)
  where client_uuid is not null;

-- 2) Guarda opcional de fecha del cobro -------------------------------------
-- Registrar cuándo se cobró realmente (offline) es útil para reportes; se guarda
-- en created_at cuando el cliente lo envía. (Ver p_created_at más abajo.)

-- 3) RPC idempotente para reenviar ventas de la cola offline ----------------
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
  -- 0) Guardas de contexto y de entrada -------------------------------------
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

  -- 1) CORTOCIRCUITO DE IDEMPOTENCIA ----------------------------------------
  --    Si esta venta ya se registró (mismo client_uuid en esta empresa), la
  --    devolvemos sin reprocesar: ni descuento de stock ni suma al corte.
  select id into v_venta_id
    from public.ventas
   where empresa_id = v_empresa
     and client_uuid = p_client_uuid
   limit 1;

  if v_venta_id is not null then
    select * into v_corte
      from public.cortes_caja
     where empresa_id = v_empresa and fecha = current_date;
    return jsonb_build_object(
      'venta_id',  v_venta_id,
      'duplicada', true,
      'corte',     to_jsonb(v_corte)
    );
  end if;

  -- 2) Descuento de inventario por línea (solo productos reales) -------------
  for v_item in select value from jsonb_array_elements(p_items) as t(value)
  loop
    v_es_comun := coalesce((v_item->>'esComun')::boolean, false);
    if v_es_comun then
      continue;  -- artículo suelto: no toca inventario
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

  -- 3) Registro de la venta con la clave de idempotencia y su fecha real -----
  insert into public.ventas (empresa_id, total, items, metodo_pago, client_uuid, created_at)
  values (v_empresa, p_total, coalesce(p_items, '[]'::jsonb), p_metodo, p_client_uuid,
          coalesce(p_created_at, now()))
  returning id into v_venta_id;

  -- 4) Acumular al corte de caja del día, en la MISMA transacción ------------
  select * into v_corte from public.sumar_corte_caja(p_total, p_metodo);

  -- 5) Payload para el frontend ----------------------------------------------
  return jsonb_build_object(
    'venta_id',  v_venta_id,
    'duplicada', false,
    'corte',     to_jsonb(v_corte)
  );
end;
$$;

grant execute on function public.registrar_venta_offline(uuid, text, numeric, jsonb, timestamptz)
  to authenticated;

commit;

-- Verificación rápida (idempotencia): ejecutar DOS veces con el MISMO uuid;
-- la segunda debe devolver "duplicada": true y NO crear otra fila.
--   select public.registrar_venta_offline(
--     '00000000-0000-4000-8000-000000000001', 'Efectivo', 1000,
--     '[{"id":-1,"nombre":"Prueba suelta","qty":1,"precio":1000,"esComun":true}]'::jsonb,
--     now()
--   );
