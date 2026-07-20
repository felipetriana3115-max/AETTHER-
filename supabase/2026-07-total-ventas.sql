-- ============================================================================
-- Aether ERP — RPC `total_ventas_empresa` (total exacto, fuente de verdad única)
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-roles-y-rls.sql    (helper mi_empresa())
--   • 2026-07-crear-ventas.sql   (tabla public.ventas + RLS)
-- Es idempotente (create or replace).
--
-- MOTIVO: el dashboard calculaba el total de ventas en el CLIENTE, sumando un
-- estado que variaba por dispositivo (localStorage + pagos simulados en memoria).
-- El resultado: la misma cuenta mostraba $0 / $10M / $20M según el dispositivo.
-- Esta función devuelve UN solo número calculado en el servidor: la suma real de
-- `public.ventas` de la empresa del usuario autenticado. Al no depender de estado
-- local, todos los dispositivos ven exactamente lo mismo.
--
-- AISLAMIENTO: es SECURITY INVOKER (el modo por defecto), así que corre con los
-- privilegios del llamador y RLS aplica igual que en un SELECT normal: solo ve
-- las ventas de SU empresa. Además filtramos explícitamente por
-- `empresa_id = mi_empresa()` para aprovechar el índice `ventas_empresa_id_idx`
-- y dejar la intención clara (defensa en profundidad, no reemplazo de RLS).
-- ============================================================================

begin;

create or replace function public.total_ventas_empresa()
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(total), 0)::numeric
  from public.ventas
  where empresa_id = public.mi_empresa();
$$;

-- Solo usuarios autenticados; RLS + el filtro por mi_empresa() acotan el alcance.
grant execute on function public.total_ventas_empresa() to authenticated;

commit;

-- Verificación rápida (debe devolver la MISMA cifra en cualquier dispositivo):
--   select public.total_ventas_empresa();
