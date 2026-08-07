-- 1. Activar Row Level Security en las tablas que faltaban
ALTER TABLE public.ventas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fiados ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cortes_caja ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos_caja ENABLE ROW LEVEL SECURITY;

-- 2. Limpiar políticas antiguas si existían
DROP POLICY IF EXISTS "Aislamiento tenant ventas" ON public.ventas;
DROP POLICY IF EXISTS "Aislamiento tenant clientes" ON public.clientes;
DROP POLICY IF EXISTS "Aislamiento tenant fiados" ON public.fiados;
DROP POLICY IF EXISTS "Aislamiento tenant cortes_caja" ON public.cortes_caja;
DROP POLICY IF EXISTS "Aislamiento tenant movimientos_caja" ON public.movimientos_caja;

-- 3. Crear políticas para forzar que solo vean datos de su propia empresa
CREATE POLICY "Aislamiento tenant ventas" ON public.ventas
FOR ALL USING (empresa_id = public.mi_empresa())
WITH CHECK (empresa_id = public.mi_empresa());

CREATE POLICY "Aislamiento tenant clientes" ON public.clientes
FOR ALL USING (empresa_id = public.mi_empresa())
WITH CHECK (empresa_id = public.mi_empresa());

CREATE POLICY "Aislamiento tenant fiados" ON public.fiados
FOR ALL USING (empresa_id = public.mi_empresa())
WITH CHECK (empresa_id = public.mi_empresa());

CREATE POLICY "Aislamiento tenant cortes_caja" ON public.cortes_caja
FOR ALL USING (empresa_id = public.mi_empresa())
WITH CHECK (empresa_id = public.mi_empresa());

CREATE POLICY "Aislamiento tenant movimientos_caja" ON public.movimientos_caja
FOR ALL USING (empresa_id = public.mi_empresa())
WITH CHECK (empresa_id = public.mi_empresa());
-- Convertir a SECURITY INVOKER las funciones de MÉTRICAS/RPC del schema public
-- para que respeten RLS con los privilegios del llamador.
--
-- ⚠️  EXCLUSIÓN OBLIGATORIA: `mi_empresa()`, `mi_rol()` y `handle_new_user()`
-- DEBEN seguir siendo SECURITY DEFINER. Degradarlas a INVOKER rompe todo el
-- aislamiento multi-tenant:
--   • mi_empresa()/mi_rol() se llaman DENTRO de las políticas RLS de `usuarios`;
--     como INVOKER provocan recursión infinita sobre esa misma tabla y las
--     políticas fallan (o dejan de resolver la empresa), colapsando el filtro
--     `empresa_id = mi_empresa()` de TODAS las tablas.
--   • handle_new_user() es el trigger de alta: inserta en `empresas`/`usuarios`
--     (con RLS) y necesita los privilegios del owner para crear el tenant.
-- Por eso el bucle las SALTA explícitamente.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.proname AS routine_name, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prokind = 'f'
          AND p.proname NOT IN ('mi_empresa', 'mi_rol', 'handle_new_user')
    LOOP
        EXECUTE format('ALTER FUNCTION public.%I(%s) SECURITY INVOKER;', r.routine_name, r.args);
    END LOOP;
END $$;

-- Reafirma (idempotente) que los helpers de RLS y el trigger de alta son
-- SECURITY DEFINER, por si una corrida previa de este script los degradó.
ALTER FUNCTION public.mi_empresa() SECURITY DEFINER;
ALTER FUNCTION public.mi_rol() SECURITY DEFINER;
ALTER FUNCTION public.handle_new_user() SECURITY DEFINER;