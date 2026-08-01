-- ============================================================================
-- Aether ERP — CRM de Clientes + Sistema de Fiados (Cuentas por Cobrar)
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   • 2026-07-roles-y-rls.sql   (helpers mi_empresa() / mi_rol())
--   • 2026-07-crear-ventas.sql  (tabla public.ventas, para enlazar fiados a ventas)
-- Es idempotente (create table if not exists / add column if not exists /
-- create or replace).
--
-- QUÉ RESUELVE
--   1) CRM: tabla `public.clientes` con los datos de contacto esenciales.
--   2) FIADOS: libro de movimientos `public.fiados` (cargo = mercancía fiada,
--      abono = pago). El SALDO PENDIENTE de cada cliente se guarda DESNORMALIZADO
--      en `clientes.saldo_pendiente`.
--
-- POR QUÉ EL SALDO VA DENORMALIZADO (eficiencia)
--   El listado de clientes necesita el "cuánto me debe" de CADA fila. Sumar el
--   libro por cliente en cada carga (join + group by sobre `fiados`) escala mal y
--   obliga al frontend a cruzar dos consultas. En su lugar mantenemos un contador
--   corriente en `clientes.saldo_pendiente` que la RPC `registrar_fiado` actualiza
--   dentro de la MISMA transacción del movimiento. Así el frontend lee el saldo en
--   la misma consulta ligera del directorio (una sola columna), sin agregaciones.
--
-- AISLAMIENTO MULTI-TENANT
--   `empresa_id` tiene DEFAULT public.mi_empresa() y RLS acota cada fila a la
--   empresa del usuario (igual que `ventas`/`productos`). El frontend NUNCA envía
--   `empresa_id`: lo estampa el servidor y lo valida el `with check`.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- 1) Tabla clientes (CRM) ----------------------------------------------------
create table if not exists public.clientes (
  id              uuid primary key default gen_random_uuid(),
  -- Tenant dueño. DEFAULT = empresa del usuario autenticado; el POS/CRM insertan
  -- sin enviarlo y el `with check` de RLS lo valida.
  empresa_id      uuid not null default public.mi_empresa()
                    references public.empresas (id) on delete cascade,
  nombre          text not null,
  email           text,
  telefono        text,
  -- Datos de contacto esenciales adicionales (dirección física + notas libres).
  direccion       text,
  notas           text,
  -- Saldo pendiente (fiado) DESNORMALIZADO. Fuente de escritura: la RPC
  -- registrar_fiado, que lo mantiene sincronizado con el libro `fiados`.
  saldo_pendiente numeric(14, 2) not null default 0,
  created_at      timestamptz not null default now()
);

-- Índices para el directorio: por empresa y por nombre (orden alfabético).
create index if not exists clientes_empresa_id_idx on public.clientes (empresa_id);
create index if not exists clientes_nombre_idx on public.clientes (empresa_id, nombre);

-- Si la tabla ya existía (corrida previa parcial), garantizamos las columnas.
alter table public.clientes add column if not exists email text;
alter table public.clientes add column if not exists telefono text;
alter table public.clientes add column if not exists direccion text;
alter table public.clientes add column if not exists notas text;
alter table public.clientes
  add column if not exists saldo_pendiente numeric(14, 2) not null default 0;

-- 2) RLS clientes: cada empresa solo ve/gestiona los suyos -------------------
alter table public.clientes enable row level security;

drop policy if exists clientes_select_propia on public.clientes;
create policy clientes_select_propia on public.clientes
  for select
  using (empresa_id = public.mi_empresa() or public.mi_rol() = 'super_admin');

drop policy if exists clientes_insert_propia on public.clientes;
create policy clientes_insert_propia on public.clientes
  for insert
  with check (empresa_id = public.mi_empresa());

drop policy if exists clientes_update_propia on public.clientes;
create policy clientes_update_propia on public.clientes
  for update
  using (empresa_id = public.mi_empresa())
  with check (empresa_id = public.mi_empresa());

drop policy if exists clientes_delete_propia on public.clientes;
create policy clientes_delete_propia on public.clientes
  for delete
  using (empresa_id = public.mi_empresa());

-- 3) Tabla fiados (libro de cuentas por cobrar) ------------------------------
-- Cada fila es UN movimiento: 'cargo' aumenta la deuda (se fía mercancía),
-- 'abono' la reduce (el cliente paga). El saldo vive en clientes.saldo_pendiente.
create table if not exists public.fiados (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null default public.mi_empresa()
                references public.empresas (id) on delete cascade,
  cliente_id  uuid not null references public.clientes (id) on delete cascade,
  tipo        text not null check (tipo in ('cargo', 'abono')),
  monto       numeric(14, 2) not null check (monto > 0),
  descripcion text,
  -- Enlace opcional con la venta que originó el fiado (cuando se fía desde el POS
  -- o el módulo de ventas). Si la venta se borra, el movimiento se conserva.
  venta_id    uuid references public.ventas (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Índice clave: recuperar el libro de UN cliente en orden cronológico inverso.
create index if not exists fiados_cliente_idx
  on public.fiados (cliente_id, created_at desc);
create index if not exists fiados_empresa_idx on public.fiados (empresa_id);

-- 4) RLS fiados --------------------------------------------------------------
alter table public.fiados enable row level security;

drop policy if exists fiados_select_propia on public.fiados;
create policy fiados_select_propia on public.fiados
  for select
  using (empresa_id = public.mi_empresa() or public.mi_rol() = 'super_admin');

-- Los movimientos se crean SOLO vía la RPC registrar_fiado (SECURITY DEFINER),
-- que mantiene el saldo consistente. Aun así habilitamos el insert propio por RLS
-- por si se necesita una carga puntual desde el editor SQL del dueño.
drop policy if exists fiados_insert_propia on public.fiados;
create policy fiados_insert_propia on public.fiados
  for insert
  with check (empresa_id = public.mi_empresa());

-- 5) RPC atómica: registrar un movimiento de fiado (cargo/abono) -------------
-- Inserta el movimiento y actualiza clientes.saldo_pendiente en UNA transacción.
-- SECURITY DEFINER: salta RLS, por eso acotamos CADA sentencia por
-- empresa_id = mi_empresa() para que el llamador jamás toque otra empresa.
create or replace function public.registrar_fiado(
  p_cliente_id  uuid,
  p_tipo        text,
  p_monto       numeric,
  p_descripcion text default null,
  p_venta_id    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa uuid := public.mi_empresa();
  v_saldo   numeric;
  v_nuevo   numeric;
  v_mov_id  uuid;
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada (empresa_id nulo).'
      using errcode = '42501';
  end if;

  if p_tipo not in ('cargo', 'abono') then
    raise exception 'Tipo de movimiento inválido: % (usa cargo o abono).', p_tipo
      using errcode = '22023';
  end if;

  if p_monto is null or p_monto <= 0 then
    raise exception 'El monto debe ser mayor que cero.' using errcode = '22023';
  end if;

  -- Bloqueamos la fila del cliente (FOR UPDATE) para que dos abonos simultáneos
  -- no lean el mismo saldo y lo dejen inconsistente. El filtro por empresa impide
  -- tocar clientes ajenos aunque llegue un id de otra empresa.
  select saldo_pendiente into v_saldo
    from public.clientes
   where id = p_cliente_id and empresa_id = v_empresa
   for update;

  if not found then
    raise exception 'Cliente no encontrado en esta empresa (id=%).', p_cliente_id
      using errcode = 'P0001';
  end if;

  if p_tipo = 'cargo' then
    v_nuevo := v_saldo + p_monto;
  else
    -- No permitimos que un abono deje el saldo en negativo: sería un pago mayor a
    -- la deuda. Se avisa para que el cajero ajuste el monto.
    if p_monto > v_saldo then
      raise exception 'El abono (%) supera el saldo pendiente (%).', p_monto, v_saldo
        using errcode = '22023';
    end if;
    v_nuevo := v_saldo - p_monto;
  end if;

  insert into public.fiados (empresa_id, cliente_id, tipo, monto, descripcion, venta_id)
  values (
    v_empresa,
    p_cliente_id,
    p_tipo,
    p_monto,
    nullif(btrim(coalesce(p_descripcion, '')), ''),
    p_venta_id
  )
  returning id into v_mov_id;

  update public.clientes
     set saldo_pendiente = v_nuevo
   where id = p_cliente_id and empresa_id = v_empresa;

  return jsonb_build_object(
    'movimiento_id',   v_mov_id,
    'saldo_pendiente', v_nuevo
  );
end;
$$;

-- Solo usuarios autenticados; la función se acota a su empresa vía mi_empresa().
grant execute on function public.registrar_fiado(uuid, text, numeric, text, uuid)
  to authenticated;

commit;

-- Verificación rápida:
--   -- 1) crea un cliente
--   insert into public.clientes (nombre, telefono) values ('Cliente de prueba', '3001234567');
--   -- 2) fíale $10.000 y luego abona $4.000
--   select public.registrar_fiado(
--     (select id from public.clientes where nombre = 'Cliente de prueba'),
--     'cargo', 10000, 'Mercancía fiada'
--   );
--   select public.registrar_fiado(
--     (select id from public.clientes where nombre = 'Cliente de prueba'),
--     'abono', 4000, 'Abono parcial'
--   );
--   -- 3) el saldo debe quedar en 6.000
--   select nombre, saldo_pendiente from public.clientes where nombre = 'Cliente de prueba';
