-- ============================================================================
-- Aether ERP — FIX: 403 al invocar la RPC registrar_venta_offline
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor. Idempotente (se puede correr varias veces).
--
-- SÍNTOMA
-- -------
-- Al sincronizar la cola offline del POS, la llamada a
--   POST /rest/v1/rpc/registrar_venta_offline
-- responde 403 (Forbidden) con:
--   code:    42501
--   message: permission denied for function registrar_venta_offline
--
-- CAUSA
-- -----
-- El rol `authenticated` NO tiene EXECUTE sobre la función. Esto pasa cuando la
-- migración que la creó (2026-08-ventas-offline.sql / 2026-08-arqueo-diario.sql)
-- se aplicó SIN su línea de GRANT, o si EXECUTE se revocó de PUBLIC después.
-- PostgREST invoca la RPC como el rol `authenticated`; sin EXECUTE responde 403.
--
-- ⚠️  IMPORTANTE — distinguir del OTRO 403 posible:
-- Si el `message` del error NO es "permission denied for function ..." sino
--   "El usuario no tiene una empresa asociada (empresa_id nulo)."
-- entonces NO es un problema de permisos: la función SÍ se ejecutó y abortó con
-- errcode 42501 porque mi_empresa() devolvió NULL. Ese caso se repara con
-- supabase/2026-08-fix-usuarios-sin-empresa.sql (dato del usuario-tenant), NO con
-- este script. Verifica el `message` en la consola antes de decidir.
-- ============================================================================

begin;

-- 1) Reafirmar seguridad de la función (por si una corrida previa la degradó).
--    SECURITY DEFINER + search_path fijo es obligatorio: corre como su dueño y
--    salta RLS de forma controlada (cada sentencia acota por empresa_id).
alter function public.registrar_venta_offline(uuid, text, numeric, jsonb, timestamptz)
  security definer;
alter function public.registrar_venta_offline(uuid, text, numeric, jsonb, timestamptz)
  set search_path = public;

-- 2) Otorgar EXECUTE al rol que usa PostgREST para peticiones autenticadas.
grant execute
  on function public.registrar_venta_offline(uuid, text, numeric, jsonb, timestamptz)
  to authenticated;

commit;

-- ----------------------------------------------------------------------------
-- VERIFICACIÓN (ejecutar a mano tras el commit)
-- ----------------------------------------------------------------------------
-- (a) Confirmar el GRANT y el modo de seguridad de la función:
--   select p.proname,
--          p.prosecdef                       as security_definer,
--          pg_get_userbyid(p.proowner)       as owner,
--          has_function_privilege('authenticated',
--            p.oid, 'EXECUTE')               as authenticated_puede_ejecutar
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname = 'registrar_venta_offline';
--   -- Se espera: security_definer = true, authenticated_puede_ejecutar = true.
