-- ============================================================================
-- Aether ERP — Fiar desde el POS: venta a crédito atómica (venta + cargo)
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-registrar-venta.sql     (patrón de descuento de stock)
--   • 2026-08-ventas-offline.sql      (columna ventas.client_uuid + idempotencia)
--   • 2026-08-clientes-y-fiados.sql   (tablas clientes/fiados + RPC registrar_fiado)
-- Es idempotente (create or replace).
--
-- MOTIVO: el cajero puede cobrar una venta del POS con el método "Fiado" (crédito)
-- asociándola a un cliente registrado. En una sola operación hay que:
--   1) descontar el inventario (la mercancía SÍ sale del negocio),
--   2) registrar la venta con metodo_pago = 'Fiado' (y su client_uuid para no
--      duplicar al reenviar la cola offline),
--   3) cargar el total al saldo del cliente vía la RPC atómica registrar_fiado,
--      dejando el fiado ENLAZADO a la venta (fiados.venta_id),
--   4) NO sumar al corte de caja: un fiado NO es dinero recibido, es una cuenta
--      por cobrar. El efectivo entrará el día que el cliente abone.
--
-- Todo ocurre en la MISMA transacción PL/pgSQL: si cualquier paso falla (stock
-- insuficiente, cliente inexistente…), Postgres revierte los cuatro juntos.
--
-- IDEMPOTENCIA: igual que registrar_venta_offline, se corta por client_uuid. Si
-- la venta ya se registró (reenvío de la cola tras una respuesta perdida), se
-- devuelve la existente SIN volver a descontar stock ni volver a cargar el fiado.
--
-- SEGURIDAD (SECURITY DEFINER): la función salta RLS, por eso acota CADA sentencia
-- por empresa_id = mi_empresa(); el llamador jamás toca datos de otra empresa
-- aunque envíe ids ajenos. registrar_fiado (invocada aquí) hace lo propio.
-- ============================================================================

begin;

create or replace function public.registrar_venta_fiado(
  p_client_uuid uuid,
  p_cliente_id  uuid,
  p_total       numeric,
  p_items       jsonb,
  p_descripcion text default null,
  p_created_at  timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa   uuid := public.mi_empresa();
  v_item      jsonb;
  v_id        uuid;
  v_qty       integer;
  v_es_comun  boolean;
  v_venta_id  uuid;
  v_fiado     jsonb;
  v_saldo     numeric;
begin
  -- 0) Guardas de contexto y de entrada -------------------------------------
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada (empresa_id nulo).'
      using errcode = '42501';
  end if;

  if p_client_uuid is null then
    raise exception 'Falta client_uuid (clave de idempotencia).' using errcode = '22023';
  end if;

  if p_cliente_id is null then
    raise exception 'Una venta fiada requiere un cliente (cliente_id nulo).'
      using errcode = '22023';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'El parámetro items debe ser un arreglo JSON.' using errcode = '22023';
  end if;

  if p_total is null or p_total <= 0 then
    raise exception 'El total de la venta fiada debe ser mayor que cero.'
      using errcode = '22023';
  end if;

  -- 1) CORTOCIRCUITO DE IDEMPOTENCIA ----------------------------------------
  --    Si esta venta ya se registró (mismo client_uuid en esta empresa), la
  --    devolvemos sin reprocesar: ni descuento de stock ni nuevo cargo de fiado.
  select id into v_venta_id
    from public.ventas
   where empresa_id = v_empresa
     and client_uuid = p_client_uuid
   limit 1;

  if v_venta_id is not null then
    select saldo_pendiente into v_saldo
      from public.clientes
     where id = p_cliente_id and empresa_id = v_empresa;
    return jsonb_build_object(
      'venta_id',        v_venta_id,
      'duplicada',       true,
      'cliente_id',      p_cliente_id,
      'saldo_pendiente', coalesce(v_saldo, 0)
    );
  end if;

  -- 2) Descuento de inventario por línea (solo productos reales) -------------
  --    Idéntico a registrar_venta_offline: los "comunes" (esComun) no tocan
  --    inventario; el guard `stock_actual >= v_qty` impide sobreventa.
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

  -- 3) Registro de la venta con método 'Fiado', su client_uuid y fecha real --
  insert into public.ventas (empresa_id, total, items, metodo_pago, client_uuid, created_at)
  values (v_empresa, p_total, coalesce(p_items, '[]'::jsonb), 'Fiado', p_client_uuid,
          coalesce(p_created_at, now()))
  returning id into v_venta_id;

  -- 4) Cargar el total al saldo del cliente, ENLAZADO a esta venta -----------
  --    Reutilizamos la RPC atómica registrar_fiado (misma transacción): inserta
  --    el movimiento 'cargo' y actualiza clientes.saldo_pendiente con FOR UPDATE.
  --    Si el cliente no existe en esta empresa, lanza y REVIERTE toda la venta.
  v_fiado := public.registrar_fiado(
    p_cliente_id,
    'cargo',
    p_total,
    coalesce(nullif(btrim(coalesce(p_descripcion, '')), ''), 'Venta a crédito (POS)'),
    v_venta_id
  );
  v_saldo := (v_fiado->>'saldo_pendiente')::numeric;

  -- 5) OJO: NO se llama a sumar_corte_caja. El fiado no es efectivo recibido.

  -- 6) Payload para el frontend ----------------------------------------------
  return jsonb_build_object(
    'venta_id',        v_venta_id,
    'duplicada',       false,
    'cliente_id',      p_cliente_id,
    'saldo_pendiente', coalesce(v_saldo, 0)
  );
end;
$$;

grant execute on function public.registrar_venta_fiado(uuid, uuid, numeric, jsonb, text, timestamptz)
  to authenticated;

commit;

-- Verificación rápida (crea cliente, fía una venta, comprueba saldo):
--   insert into public.clientes (nombre, telefono) values ('Maria Gomez', '3001234567');
--   select public.registrar_venta_fiado(
--     '00000000-0000-4000-8000-0000000000fa',
--     (select id from public.clientes where nombre = 'Maria Gomez'),
--     9100,
--     '[{"id":-1,"nombre":"Varios","qty":1,"precio":9100,"esComun":true}]'::jsonb,
--     'Venta fiada de prueba'
--   );
--   -- el saldo del cliente debe subir a 9100, y NO debe cambiar el corte de hoy.
--   select nombre, saldo_pendiente from public.clientes where nombre = 'Maria Gomez';
--   -- reenvío idempotente: repetir con el MISMO uuid → "duplicada": true, saldo igual.
