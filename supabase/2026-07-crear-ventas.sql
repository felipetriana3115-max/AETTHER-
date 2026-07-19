-- ============================================================================
-- Aether ERP — Tabla `ventas` (registro de cobros del POS) + RLS
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de 2026-07-roles-y-rls.sql
-- (necesita el helper `public.mi_empresa()` y el rol `super_admin`).
-- Es idempotente.
--
-- Contexto: el POS (app/dashboard/pos/page.tsx) descuenta inventario y registra
-- cada cobro aquí con su método de pago. El cliente NO envía `empresa_id`: lo
-- rellena el DEFAULT `public.mi_empresa()`, y el aislamiento entre empresas lo
-- impone RLS (no el frontend). `items` guarda el detalle de la venta en JSONB
-- (id, nombre, qty, precio) para no depender de una tabla de líneas.
-- ============================================================================

begin;

-- gen_random_uuid() vive en pgcrypto; en Supabase suele estar activa, pero la
-- garantizamos por si el proyecto es nuevo.
create extension if not exists pgcrypto;

-- 1) Tabla ventas -----------------------------------------------------------
create table if not exists public.ventas (
  id          uuid primary key default gen_random_uuid(),
  -- Tenant dueño de la venta. DEFAULT = empresa del usuario autenticado, así el
  -- POS puede insertar sin enviarlo y el `with check` de RLS lo valida.
  empresa_id  uuid not null default public.mi_empresa()
                references public.empresas (id) on delete cascade,
  total       numeric(14, 2) not null default 0,
  items       jsonb not null default '[]'::jsonb,
  metodo_pago text not null,
  created_at  timestamptz not null default now()
);

-- Índices para los listados/reportes: por empresa y por fecha.
create index if not exists ventas_empresa_id_idx on public.ventas (empresa_id);
create index if not exists ventas_created_at_idx on public.ventas (created_at desc);

-- 2) RLS: cada empresa solo ve/gestiona sus propias ventas -------------------
alter table public.ventas enable row level security;

-- Lectura: miembros ven las ventas de SU empresa; el super_admin ve todas.
drop policy if exists ventas_select_propia on public.ventas;
create policy ventas_select_propia on public.ventas
  for select
  using (empresa_id = public.mi_empresa() or public.mi_rol() = 'super_admin');

-- Inserción: solo se puede crear una venta para la PROPIA empresa. Como
-- `empresa_id` tiene DEFAULT mi_empresa(), el POS inserta sin enviarlo y el
-- check se cumple igual.
drop policy if exists ventas_insert_propia on public.ventas;
create policy ventas_insert_propia on public.ventas
  for insert
  with check (empresa_id = public.mi_empresa());

commit;

-- Verificación rápida (debería listar solo las ventas de tu empresa):
--   select id, total, metodo_pago, created_at from public.ventas order by created_at desc;
