-- ============================================================================
-- Aether ERP — Insumos por Vencer · columna de caducidad en el catálogo
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor. Es idempotente (se puede correr varias veces).
--
-- MOTIVO: las "Alertas Inteligentes" del dashboard avisan de dos cosas:
--   1) STOCK CRÍTICO — un producto con menos de 5 unidades (no necesita esquema
--      nuevo: se calcula sobre `productos.stock_actual`, que ya existe).
--   2) INSUMOS POR VENCER — para esto hace falta saber CUÁNDO caduca cada ítem.
--      `public.productos` no tenía esa fecha, así que la AÑADIMOS aquí.
--
-- La columna es OPCIONAL (nullable): los productos sin caducidad (la mayoría del
-- retail) simplemente la dejan en NULL y nunca disparan la alerta de vencimiento.
-- Solo los perecederos/insumos con fecha registrada participan.
--
-- COMPATIBILIDAD: al ser `add column if not exists` sobre una columna nullable,
-- ninguna fila existente cambia y ningún flujo previo (POS, compras, recibir) se
-- ve afectado. El aislamiento por empresa lo sigue imponiendo RLS sobre la tabla.
-- ============================================================================

begin;

alter table public.productos
  add column if not exists fecha_vencimiento date;

comment on column public.productos.fecha_vencimiento is
  'Fecha de caducidad del insumo/producto perecedero. NULL = no perece / no aplica. '
  'La usa el dashboard para la alerta de "Insumos por Vencer".';

commit;
