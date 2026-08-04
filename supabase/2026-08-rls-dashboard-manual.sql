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