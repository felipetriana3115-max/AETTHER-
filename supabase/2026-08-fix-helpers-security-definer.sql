-- 1. Eliminar de forma segura las funciones y dependencias
DROP FUNCTION IF EXISTS public.mi_rol() CASCADE;
DROP FUNCTION IF EXISTS public.mi_empresa() CASCADE;

-- 2. Recrear mi_empresa con SECURITY DEFINER
-- `set search_path = public` es OBLIGATORIO en funciones SECURITY DEFINER: sin él
-- un atacante puede anteponer un esquema propio al search_path de la sesión y
-- secuestrar la resolución de `usuarios` (escalada de privilegios). Además fija
-- la resolución de nombres cuando la función corre dentro de una política RLS.
CREATE OR REPLACE FUNCTION public.mi_empresa()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT empresa_id FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;

-- 3. Recrear mi_rol adaptado al tipo correcto o texto
CREATE OR REPLACE FUNCTION public.mi_rol()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT rol::text FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;

-- 4. Verificación final del aislamiento
SELECT public.mi_empresa() AS mi_empresa_id, public.mi_rol() AS mi_rol_actual;