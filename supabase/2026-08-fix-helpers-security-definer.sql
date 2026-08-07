-- 1. Eliminar de forma segura las funciones y dependencias
DROP FUNCTION IF EXISTS public.mi_rol() CASCADE;
DROP FUNCTION IF EXISTS public.mi_empresa() CASCADE;

-- 2. Recrear mi_empresa con SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.mi_empresa()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT empresa_id FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;

-- 3. Recrear mi_rol adaptado al tipo correcto o texto
CREATE OR REPLACE FUNCTION public.mi_rol()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT rol::text FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;

-- 4. Verificación final del aislamiento
SELECT public.mi_empresa() AS mi_empresa_id, public.mi_rol() AS mi_rol_actual;