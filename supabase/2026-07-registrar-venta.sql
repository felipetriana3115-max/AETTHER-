-- ============================================================================
-- Aether ERP — RPC atómica `registrar_venta` (venta + descuento + corte)
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-roles-y-rls.sql    (helpers mi_empresa() / mi_rol())
--   • 2026-07-crear-ventas.sql   (tabla public.ventas + RLS)
--   • 2026-07-corte-de-caja.sql  (tabla cortes_caja + RPC sumar_corte_caja)
-- Es idempotente (create or replace).
--
-- MOTIVO: supabase-js no ofrece transacciones multi-sentencia desde el cliente.
-- El POS descontaba el inventario y luego insertaba la venta en llamadas HTTP
-- separadas: si el segundo paso fallaba, el stock quedaba descontado sin venta
-- (inconsistencia). Esta función encapsula TODO en una sola transacción
-- PL/pgSQL: descuento de stock (con guard anti-sobreventa) + insert de la venta
-- + acumulado del corte de caja. Si CUALQUIER paso lanza excepción, Postgres
-- revierte (ROLLBACK) los tres de forma conjunta y automática.
--
-- SEGURIDAD (SECURITY DEFINER): la función corre como su dueño y por tanto SALTA
-- RLS. Por eso acotamos CADA sentencia por `empresa_id = mi_empresa()` de forma
-- MANUAL: el llamador jamás puede tocar el inventario ni las ventas de otra
-- empresa, aunque envíe ids ajenos. `mi_empresa()` sigue resolviendo al usuario
-- de la petición porque auth.uid() se conserva dentro de la función.
-- ============================================================================

begin;

create or replace function public.registrar_venta(
  p_metodo text,
  p_total  numeric,
  p_items  jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa  uuid := public.mi_empresa();
  v_item     jsonb;
  v_id       bigint;
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

  if p_metodo not in ('Efectivo', 'Nequi/Daviplata', 'Bold') then
    raise exception 'Método de pago inválido: %', p_metodo using errcode = '22023';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'El parámetro items debe ser un arreglo JSON.' using errcode = '22023';
  end if;

  -- 1) Descuento de inventario por línea (solo productos reales) -------------
  --    Un "artículo común" (esComun) o con id <= 0 es una venta suelta sin
  --    inventario → se salta el descuento pero sí entra en la venta.
  for v_item in select value from jsonb_array_elements(p_items) as t(value)
  loop
    v_es_comun := coalesce((v_item->>'esComun')::boolean, false);
    v_id       := coalesce((v_item->>'id')::bigint, 0);
    v_qty      := coalesce((v_item->>'qty')::integer, 0);

    if v_es_comun or v_id <= 0 then
      continue;
    end if;

    if v_qty <= 0 then
      raise exception 'Cantidad inválida (%) para el producto %.', v_qty, v_id
        using errcode = '22023';
    end if;

    -- Guard anti-sobreventa + aislamiento por empresa en la MISMA sentencia.
    -- Si no se descuenta ninguna fila (stock insuficiente, id ajeno o
    -- inexistente para esta empresa), abortamos → ROLLBACK de toda la venta.
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

  -- 2) Registro de la venta (empresa_id fijado por el servidor) --------------
  insert into public.ventas (empresa_id, total, items, metodo_pago)
  values (v_empresa, p_total, coalesce(p_items, '[]'::jsonb), p_metodo)
  returning id into v_venta_id;

  -- 3) Acumular al corte de caja del día, en la MISMA transacción ------------
  select * into v_corte from public.sumar_corte_caja(p_total, p_metodo);

  -- 4) Payload para que el frontend refresque venta_id + tarjeta del corte ---
  return jsonb_build_object(
    'venta_id', v_venta_id,
    'corte',    to_jsonb(v_corte)
  );
end;
$$;

-- Solo usuarios autenticados; la propia función se acota a su empresa vía
-- mi_empresa(), así que no puede afectar a otras.
grant execute on function public.registrar_venta(text, numeric, jsonb) to authenticated;

commit;

-- Verificación rápida (desde el SQL Editor, como el usuario dueño):
--   select public.registrar_venta(
--     'Efectivo', 1000,
--     '[{"id":-1,"nombre":"Prueba suelta","qty":1,"precio":1000,"esComun":true}]'::jsonb
--   );
--   -- debe devolver { "venta_id": "...", "corte": {...} } y crear 1 fila en ventas.
