-- ============================================================================
-- Aether ERP — Corte de caja (arqueo diario) + RPC atómico para el POS
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-roles-y-rls.sql   (helpers mi_empresa() / mi_rol())
--   • 2026-07-crear-ventas.sql  (tabla public.ventas)
-- Es idempotente.
--
-- Contexto: el POS (app/dashboard/pos/page.tsx) registra cada cobro en `ventas`
-- y, en la MISMA operación, suma su total al corte de caja del día. Un "corte"
-- es una fila única por (empresa, fecha) que acumula los totales por método de
-- pago. Como supabase-js no puede hacer `total = total + x` de forma atómica
-- (leer-y-escribir es propenso a carreras entre cajas), la suma se hace en una
-- función Postgres `sumar_corte_caja` con UPSERT + incremento en el servidor.
-- ============================================================================

begin;

-- 1) Tabla cortes_caja -------------------------------------------------------
create table if not exists public.cortes_caja (
  id             uuid primary key default gen_random_uuid(),
  -- Tenant dueño del corte. DEFAULT = empresa del usuario autenticado.
  empresa_id     uuid not null default public.mi_empresa()
                   references public.empresas (id) on delete cascade,
  -- Un corte por empresa y día: el UPSERT del POS acumula sobre esta fila.
  fecha          date not null default current_date,
  total_general  numeric(14, 2) not null default 0,
  total_efectivo numeric(14, 2) not null default 0,
  total_nequi    numeric(14, 2) not null default 0,
  total_bold     numeric(14, 2) not null default 0,
  num_ventas     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- Clave del UPSERT: una sola fila de corte por empresa y fecha.
  unique (empresa_id, fecha)
);

create index if not exists cortes_caja_empresa_fecha_idx
  on public.cortes_caja (empresa_id, fecha desc);

-- 2) RLS: cada empresa solo ve/gestiona sus propios cortes -------------------
alter table public.cortes_caja enable row level security;

drop policy if exists cortes_select_propio on public.cortes_caja;
create policy cortes_select_propio on public.cortes_caja
  for select
  using (empresa_id = public.mi_empresa() or public.mi_rol() = 'super_admin');

drop policy if exists cortes_insert_propio on public.cortes_caja;
create policy cortes_insert_propio on public.cortes_caja
  for insert
  with check (empresa_id = public.mi_empresa());

drop policy if exists cortes_update_propio on public.cortes_caja;
create policy cortes_update_propio on public.cortes_caja
  for update
  using (empresa_id = public.mi_empresa())
  with check (empresa_id = public.mi_empresa());

-- 3) RPC atómico: suma una venta al corte del día ----------------------------
-- SECURITY DEFINER + `empresa_id := mi_empresa()` fijo: el llamador nunca elige
-- la empresa, siempre la suya. El UPSERT crea el corte del día si no existe o
-- incrementa los acumulados si ya existe, todo en una sola sentencia atómica.
create or replace function public.sumar_corte_caja(
  p_total  numeric,
  p_metodo text
)
returns public.cortes_caja
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa uuid := public.mi_empresa();
  v_row     public.cortes_caja;
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada.';
  end if;

  insert into public.cortes_caja as c (
    empresa_id, fecha, total_general,
    total_efectivo, total_nequi, total_bold, num_ventas
  )
  values (
    v_empresa, current_date, p_total,
    case when p_metodo = 'Efectivo'         then p_total else 0 end,
    case when p_metodo = 'Nequi/Daviplata'  then p_total else 0 end,
    case when p_metodo = 'Bold'             then p_total else 0 end,
    1
  )
  on conflict (empresa_id, fecha) do update set
    total_general  = c.total_general  + excluded.total_general,
    total_efectivo = c.total_efectivo + excluded.total_efectivo,
    total_nequi    = c.total_nequi    + excluded.total_nequi,
    total_bold     = c.total_bold     + excluded.total_bold,
    num_ventas     = c.num_ventas     + 1,
    updated_at     = now()
  returning * into v_row;

  return v_row;
end;
$$;

-- Permite invocar la RPC a usuarios autenticados (RLS/lógica interna la acotan
-- a su propia empresa vía mi_empresa()).
grant execute on function public.sumar_corte_caja(numeric, text) to authenticated;

commit;

-- Verificación rápida (el corte de hoy de tu empresa):
--   select fecha, total_general, total_efectivo, total_nequi, total_bold, num_ventas
--   from public.cortes_caja
--   where fecha = current_date;
