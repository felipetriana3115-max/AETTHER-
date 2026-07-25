-- ============================================================================
-- Aether ERP — Arqueo y Cierre de Caja (Caja Chica) · Reporte Z ciego
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-roles-y-rls.sql    (helpers mi_empresa() / mi_rol())
--   • 2026-07-corte-de-caja.sql  (tabla cortes_caja + RPC sumar_corte_caja)
-- Es idempotente.
--
-- MOTIVO: el POS ya acumula las ventas del día por método de pago en
-- `cortes_caja` (una fila por empresa y fecha). Faltaba el flujo de CAJA FÍSICA
-- del cajero: declarar la base inicial del turno, registrar entradas/salidas
-- manuales de efectivo (domicilios, insumos…) y hacer el CIERRE CIEGO — contar
-- el efectivo en mano SIN ver el total esperado y dejar que el servidor calcule
-- el sobrante/faltante. Reutilizamos `cortes_caja` (no duplicamos el acumulado
-- de ventas) y solo la AMPLIAMOS con los campos del turno; los movimientos
-- manuales viven en una tabla nueva `movimientos_caja`.
--
-- COMPATIBILIDAD CON EL POS: `sumar_corte_caja` sigue haciendo UPSERT por
-- (empresa, fecha) sobre la MISMA fila; las columnas nuevas tienen DEFAULT, así
-- que un cobro anterior a la apertura crea la fila con base 0 / estado 'abierta'
-- y la apertura solo rellena la base más tarde. Nada del flujo de venta cambia.
--
-- CIERRE CIEGO: el cálculo del esperado
--   base_inicial + total_efectivo (ventas POS) + ingresos - egresos
-- se hace SOLO en `cerrar_caja`, en el servidor, en el momento del cierre. La UI
-- nunca muestra el efectivo de ventas ni el esperado durante el turno abierto;
-- el cajero cuenta a ciegas y el sistema revela la diferencia al procesar.
-- ============================================================================

begin;

-- 1) Ampliar cortes_caja con los campos del turno/arqueo ---------------------
alter table public.cortes_caja
  add column if not exists base_inicial     numeric(14, 2) not null default 0,
  add column if not exists estado           text          not null default 'abierta',
  add column if not exists abierto_at       timestamptz,
  add column if not exists efectivo_contado numeric(14, 2),
  add column if not exists diferencia       numeric(14, 2),
  add column if not exists cerrado_at       timestamptz;

-- Acota `estado` a valores conocidos (las filas existentes ya quedaron en
-- 'abierta' por el DEFAULT, así que el CHECK no falla al crearse).
alter table public.cortes_caja drop constraint if exists cortes_estado_chk;
alter table public.cortes_caja
  add constraint cortes_estado_chk check (estado in ('abierta', 'cerrada'));

-- 2) Movimientos manuales de caja (ingresos / egresos) ----------------------
-- Entradas y salidas de efectivo que NO son ventas: "Pago domiciliario",
-- "Compra de insumos", etc. Se acumulan aparte y entran en el cálculo del
-- cierre. DEFAULTs de empresa/fecha para que el INSERT desde el cliente (bajo
-- RLS) no tenga que fijarlos ni pueda apuntar a otra empresa.
create table if not exists public.movimientos_caja (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null default public.mi_empresa()
               references public.empresas (id) on delete cascade,
  fecha      date not null default current_date,
  tipo       text not null check (tipo in ('ingreso', 'egreso')),
  monto      numeric(14, 2) not null check (monto > 0),
  concepto   text not null,
  created_at timestamptz not null default now()
);

create index if not exists movimientos_caja_empresa_fecha_idx
  on public.movimientos_caja (empresa_id, fecha desc);

-- 3) RLS: cada empresa solo ve/crea sus propios movimientos ------------------
alter table public.movimientos_caja enable row level security;

drop policy if exists mov_select_propio on public.movimientos_caja;
create policy mov_select_propio on public.movimientos_caja
  for select
  using (empresa_id = public.mi_empresa() or public.mi_rol() = 'super_admin');

drop policy if exists mov_insert_propio on public.movimientos_caja;
create policy mov_insert_propio on public.movimientos_caja
  for insert
  with check (empresa_id = public.mi_empresa());

-- 4) RPC: abrir caja (declarar la base inicial del turno) --------------------
-- SECURITY DEFINER + empresa fija: el cajero nunca elige la empresa. UPSERT por
-- (empresa, fecha): si el POS ya creó la fila del día solo rellena la base;
-- reabrir un turno cerrado limpia el cierre previo para poder recontar.
create or replace function public.abrir_caja(p_base numeric)
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
    raise exception 'El usuario no tiene una empresa asociada.' using errcode = '42501';
  end if;
  if p_base is null or p_base < 0 then
    raise exception 'La base inicial no puede ser negativa.' using errcode = '22023';
  end if;

  insert into public.cortes_caja as c (empresa_id, fecha, base_inicial, estado, abierto_at)
  values (v_empresa, current_date, p_base, 'abierta', now())
  on conflict (empresa_id, fecha) do update set
    base_inicial     = excluded.base_inicial,
    estado           = 'abierta',
    abierto_at       = coalesce(c.abierto_at, now()),
    efectivo_contado = null,   -- reabrir descarta el conteo anterior
    diferencia       = null,
    cerrado_at       = null,
    updated_at       = now()
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.abrir_caja(numeric) to authenticated;

-- 5) RPC: cierre ciego (Reporte Z) ------------------------------------------
-- El cajero envía SOLO el efectivo contado en mano. El servidor calcula el
-- esperado y la diferencia (positiva = sobrante, negativa = faltante), lo
-- persiste en la fila del corte y devuelve el desglose para revelarlo en la UI
-- recién ahora (nunca antes → cierre ciego). `for update` serializa cierres
-- concurrentes de la misma caja.
create or replace function public.cerrar_caja(p_efectivo_contado numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa    uuid := public.mi_empresa();
  v_corte      public.cortes_caja;
  v_ingresos   numeric(14, 2);
  v_egresos    numeric(14, 2);
  v_esperado   numeric(14, 2);
  v_diferencia numeric(14, 2);
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada.' using errcode = '42501';
  end if;
  if p_efectivo_contado is null or p_efectivo_contado < 0 then
    raise exception 'El efectivo contado no puede ser negativo.' using errcode = '22023';
  end if;

  select * into v_corte
  from public.cortes_caja
  where empresa_id = v_empresa and fecha = current_date
  for update;

  if not found then
    raise exception 'No hay una caja abierta hoy para cerrar.' using errcode = 'P0002';
  end if;

  select
    coalesce(sum(monto) filter (where tipo = 'ingreso'), 0),
    coalesce(sum(monto) filter (where tipo = 'egreso'), 0)
  into v_ingresos, v_egresos
  from public.movimientos_caja
  where empresa_id = v_empresa and fecha = current_date;

  -- Efectivo esperado en cajón = base + ventas en efectivo + ingresos - egresos.
  -- (Nequi/Bold no tocan el cajón físico, por eso solo entra total_efectivo.)
  v_esperado   := v_corte.base_inicial + v_corte.total_efectivo + v_ingresos - v_egresos;
  v_diferencia := p_efectivo_contado - v_esperado;

  update public.cortes_caja
     set estado           = 'cerrada',
         efectivo_contado = p_efectivo_contado,
         diferencia       = v_diferencia,
         cerrado_at       = now(),
         updated_at       = now()
   where empresa_id = v_empresa and fecha = current_date
   returning * into v_corte;

  return jsonb_build_object(
    'corte',            to_jsonb(v_corte),
    'base_inicial',     v_corte.base_inicial,
    'ventas_efectivo',  v_corte.total_efectivo,
    'ingresos',         v_ingresos,
    'egresos',          v_egresos,
    'esperado',         v_esperado,
    'efectivo_contado', p_efectivo_contado,
    'diferencia',       v_diferencia
  );
end;
$$;

grant execute on function public.cerrar_caja(numeric) to authenticated;

commit;

-- Verificación rápida (como el usuario dueño de una empresa):
--   select public.abrir_caja(100000);
--   insert into public.movimientos_caja (tipo, monto, concepto)
--     values ('egreso', 5000, 'Pago domiciliario');
--   select public.cerrar_caja(120000);  -- devuelve esperado, diferencia, etc.
