-- ============================================================================
-- Aether ERP — RPC `metricas_rentabilidad_empresa` (margen real + rotación)
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-roles-y-rls.sql    (helper mi_empresa())
--   • 2026-07-crear-ventas.sql   (tabla public.ventas + RLS)
--   • (la tabla public.productos ya debe existir, con precio_costo y RLS)
-- Es idempotente (create or replace).
--
-- MOTIVO: el dashboard mostraba un margen de ganancia QUEMADO (62.4% / 0%) y no
-- tenía rotación de inventario. Ambas cifras deben salir de datos reales: cruzar
-- las líneas vendidas (`ventas.items`) con el costo del catálogo
-- (`productos.precio_costo`). Como `supabase-js` no debe recorrer todas las
-- ventas en el cliente, este cálculo vive en el servidor y devuelve UN objeto
-- con las dos métricas ya resueltas, igual que `total_ventas_empresa()`.
--
-- DEFINICIONES:
--   • Ingresos vendidos = Σ (qty · precio) de las líneas de productos del catálogo.
--   • Costo vendido (COGS) = Σ (qty · precio_costo) de esas mismas líneas.
--   • Margen (%) = (Ingresos − COGS) / Ingresos · 100.
--   • Valor de inventario a costo = Σ (stock_actual · precio_costo) del catálogo.
--   • Rotación (veces) = COGS / Valor de inventario a costo.
--
-- Los "artículos comunes" del POS (esComun = true, id temporal negativo) NO tienen
-- costo en el catálogo, así que se EXCLUYEN del margen y del COGS (no distorsionan
-- una rentabilidad que no podemos conocer). El emparejamiento con `productos` se
-- hace por texto (`p.id::text = item->>'id'`) para ser robusto al tipo real del id.
--
-- AISLAMIENTO: SECURITY INVOKER (por defecto), así que RLS aplica igual que en un
-- SELECT normal (solo las filas de la empresa del usuario). Además filtramos por
-- `empresa_id = mi_empresa()` de forma explícita (defensa en profundidad y uso de
-- índice), igual que `total_ventas_empresa()`.
-- ============================================================================

begin;

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

-- Solo usuarios autenticados; RLS + el filtro por mi_empresa() acotan el alcance.
grant execute on function public.metricas_rentabilidad_empresa() to authenticated;

commit;

-- Verificación rápida (debe devolver el mismo objeto en cualquier dispositivo):
--   select public.metricas_rentabilidad_empresa();
--   -- p. ej. { "margen": 42.5, "rotacion": 3.2, "costo": 1200000, ... }
