-- ============================================================================
-- Aether ERP — RPC atómica `recibir_compra` (compra recibida → impacto en stock)
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-roles-y-rls.sql    (helper mi_empresa())
--   • (la tabla public.productos ya debe existir, con RLS por empresa)
-- Es idempotente (create or replace).
--
-- MOTIVO: el módulo de Compras vivía aislado del inventario. Cuando una orden se
-- marca como "Recibido" hay que SUMAR exactamente las unidades compradas al
-- `stock_actual` del producto del catálogo — y, si el producto no existía, crearlo
-- con ese stock inicial. Hacerlo en el cliente con un SELECT + UPDATE separados
-- abría una condición de carrera (dos recepciones simultáneas se pisan el stock).
-- Esta función encapsula el emparejamiento + upsert del stock en UNA transacción.
--
-- SEGURIDAD (SECURITY DEFINER): corre como su dueño y por tanto SALTA RLS. Por eso
-- CADA sentencia se acota a mano por `empresa_id = mi_empresa()`: el llamador jamás
-- puede tocar ni crear productos en el catálogo de otra empresa, aunque envíe ids
-- ajenos. `mi_empresa()` sigue resolviendo al usuario de la petición porque
-- auth.uid() se conserva dentro de la función.
--
-- EMPAREJAMIENTO (en orden de prioridad, todo acotado a la empresa):
--   1) por id del producto seleccionado en el catálogo,
--   2) por código de barras (índice único por empresa),
--   3) por descripción exacta (case-insensitive),
--   4) si nada coincide → alta automática con el stock inicial de la orden.
-- ============================================================================

begin;

-- El id del catálogo es UUID (igual que en `registrar_venta`). La versión previa
-- de esta función lo declaraba `bigint`; como cambiar el TIPO de un parámetro crea
-- una sobrecarga NUEVA (no reemplaza), primero borramos la firma antigua para no
-- dejar dos `recibir_compra` conviviendo.
drop function if exists public.recibir_compra(bigint, text, text, integer, numeric);

create or replace function public.recibir_compra(
  p_producto_id   uuid,     -- id del producto del catálogo (o null si es nuevo)
  p_descripcion   text,     -- nombre del insumo/producto (obligatorio para altas)
  p_codigo_barras text,     -- código de barras / referencia (opcional)
  p_unidades      integer,  -- unidades compradas a sumar al stock
  p_costo         numeric   -- costo TOTAL de la orden (para el costo unitario de altas)
)
returns public.productos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa     uuid    := public.mi_empresa();
  v_descripcion text    := nullif(btrim(p_descripcion), '');
  v_codigo      text    := nullif(btrim(p_codigo_barras), '');
  v_costo_unit  numeric;
  v_producto    public.productos;
begin
  -- 0) Guardas de contexto y de entrada -------------------------------------
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada (empresa_id nulo).'
      using errcode = '42501';
  end if;

  if p_unidades is null or p_unidades <= 0 then
    raise exception 'Las unidades recibidas deben ser mayores que cero (recibido=%).', p_unidades
      using errcode = '22023';
  end if;

  -- Costo unitario derivado del costo total de la orden (solo para altas nuevas).
  v_costo_unit := case
    when p_costo is null or p_costo <= 0 then 0
    else round(p_costo / p_unidades)
  end;

  -- 1) Emparejamiento por id (producto seleccionado del catálogo) ------------
  if p_producto_id is not null then
    update public.productos
       set stock_actual = coalesce(stock_actual, 0) + p_unidades
     where id = p_producto_id
       and empresa_id = v_empresa
    returning * into v_producto;

    if found then
      return v_producto;
    end if;
    -- Un id ajeno o inexistente para esta empresa no crea nada a ciegas: se
    -- reintenta por código/descripción antes de decidir un alta.
  end if;

  -- 2) Emparejamiento por código de barras (único por empresa) ---------------
  if v_codigo is not null then
    update public.productos
       set stock_actual = coalesce(stock_actual, 0) + p_unidades
     where empresa_id = v_empresa
       and codigo_barras = v_codigo
    returning * into v_producto;

    if found then
      return v_producto;
    end if;
  end if;

  -- 3) Emparejamiento por descripción exacta (case-insensitive) --------------
  --    Acotado a UNA fila (la descripción no es única) para no inflar el stock
  --    de varios productos homónimos de golpe.
  if v_descripcion is not null then
    update public.productos
       set stock_actual = coalesce(stock_actual, 0) + p_unidades
     where id = (
       select id
       from public.productos
       where empresa_id = v_empresa
         and lower(descripcion) = lower(v_descripcion)
       order by id
       limit 1
     )
    returning * into v_producto;

    if found then
      return v_producto;
    end if;
  end if;

  -- 4) No existía → alta automática con el stock inicial de la orden ---------
  if v_descripcion is null then
    raise exception 'Se requiere una descripción para dar de alta el producto nuevo.'
      using errcode = '22023';
  end if;

  -- El empresa_id lo estampa el servidor. El precio de venta arranca igual al
  -- costo (margen 0): el usuario lo ajusta luego desde el módulo de Inventario.
  insert into public.productos (
    empresa_id, codigo_barras, descripcion, tipo,
    precio_costo, margen_ganancia, precio_venta,
    stock_actual, stock_minimo
  )
  values (
    v_empresa, v_codigo, v_descripcion, 'unidad',
    v_costo_unit, 0, v_costo_unit,
    p_unidades, 0
  )
  returning * into v_producto;

  return v_producto;
end;
$$;

-- Solo usuarios autenticados; la función se acota a su empresa vía mi_empresa().
grant execute on function public.recibir_compra(uuid, text, text, integer, numeric)
  to authenticated;

commit;

-- Verificación rápida (desde el SQL Editor, como el usuario dueño):
--   -- Alta nueva:
--   select public.recibir_compra(null, 'Harina de trigo', '7702000000001', 50, 250000);
--   -- Reingreso al mismo producto (suma +20 al stock existente):
--   select public.recibir_compra(null, 'Harina de trigo', '7702000000001', 20, 100000);
