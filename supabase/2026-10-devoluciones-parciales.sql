-- ============================================================================
-- Aether ERP — Devoluciones PARCIALES con flujo de solicitud → aprobación
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   · 2026-07-roles-y-rls.sql           (helpers `mi_empresa()` / `mi_rol()`)
--   · 2026-07-crear-ventas.sql          (tabla `public.ventas` + RLS)
--   · 2026-07-registrar-venta.sql       (tabla `public.productos`)
--   · 2026-10-devoluciones-ventas.sql   (devolución total + columnas de estado)
-- Opcionales (si no están, la devolución funciona igual; solo se omite el
-- egreso de caja):
--   · 2026-07-arqueo-caja.sql   (tabla `public.movimientos_caja`)
--   · 2026-08-arqueo-diario.sql (función `public.hoy_negocio()`)
-- Es idempotente (create table/column if not exists, create or replace).
--
-- QUÉ RESUELVE
-- ------------
-- Hasta ahora devolver era todo-o-nada y solo el dueño podía hacerlo: si un
-- cliente devolvía 1 de 5 unidades, el cajero no tenía forma de registrarlo y
-- el admin tenía que reembolsar la factura entera. Además no quedaba rastro de
-- QUIÉN pidió la devolución: el empleado no podía ni proponerla.
--
-- Este script añade el circuito completo:
--   1. `solicitar_devolucion`  → CUALQUIER miembro del tenant (incluido el
--      empleado) registra una SOLICITUD con los ítems y cantidades exactas.
--      NO toca stock, NO toca caja, NO toca el estado de la venta.
--   2. `resolver_devolucion`   → SOLO empresa_admin/super_admin la aprueba o la
--      rechaza. Al aprobar, en UNA sola transacción: repone el stock de las
--      líneas seleccionadas, acumula lo devuelto en la venta, la marca
--      'Reembolsado' si ya no queda nada por devolver y registra el egreso de
--      caja si el cobro fue en efectivo. Al rechazar no se altera NADA.
--   3. `devolucion_disponible` → cuánto queda devolvible por línea (vendido −
--      ya devuelto − reservado por otras solicitudes pendientes). Es lo que
--      acota los selectores de cantidad del modal de factura.
--
-- EL CAJÓN DE DINERO
-- ------------------
-- `resolver_devolucion` devuelve `abrir_cajon`: true SOLO cuando se aprobó y el
-- cobro original fue en efectivo con monto > 0. El pulso ESC/POS lo dispara el
-- cliente con ese booleano (ver app/components/DevolucionesPendientes.tsx), así
-- que un rechazo —o la aprobación de una venta cobrada por Nequi/Bold/Fiado—
-- deja el cajón cerrado. La decisión la toma el SERVIDOR, no la interfaz.
--
-- AISLAMIENTO MULTI-TENANT / RLS
-- ------------------------------
-- `public.devoluciones` tiene RLS con SELECT acotado a `mi_empresa()` y NINGUNA
-- policy de INSERT/UPDATE/DELETE: la tabla solo se escribe desde las RPC
-- SECURITY DEFINER de este archivo, que resuelven la empresa server-side con
-- `public.mi_empresa()` y filtran por ella en TODAS las sentencias. La empresa
-- nunca viaja en el payload. Este script NO desactiva, borra ni debilita
-- ninguna política existente.
--
-- INTEGRIDAD DE IMPORTES
-- ----------------------
-- El cliente envía SOLO pares `{idx, qty}` (índice de la línea dentro de
-- `ventas.items` y cantidad). El nombre, el precio y el tope de cantidad los
-- lee el servidor de la propia venta: un cliente manipulado no puede inventarse
-- un precio ni devolver más unidades de las que se vendieron.
-- ============================================================================

begin;

-- ── 1) Acumulado de lo ya devuelto en cada venta ────────────────────────────
-- `devuelto_items` es un objeto jsonb indexado por la POSICIÓN de la línea
-- dentro de `ventas.items` ({"0": 2, "3": 1}), no por el id del producto: así
-- soporta ventas con la misma referencia en dos líneas y artículos comunes
-- (que llevan ids negativos y no son únicos).
alter table public.ventas
  add column if not exists devuelto_items jsonb not null default '{}'::jsonb;
alter table public.ventas
  add column if not exists devuelto_total numeric(14, 2) not null default 0;

comment on column public.ventas.devuelto_items is
  'Unidades ya devueltas por posición de línea en `items` ({"0": 2}). Lo mantiene resolver_devolucion; permite devoluciones parciales acumulativas.';
comment on column public.ventas.devuelto_total is
  'Importe acumulado reembolsado de esta venta. Se descuenta del total de ingresos aunque la venta no esté completamente Reembolsada.';

-- ── 2) Tabla de solicitudes de devolución ───────────────────────────────────
create table if not exists public.devoluciones (
  id          uuid primary key default gen_random_uuid(),
  -- Tenant dueño. DEFAULT = empresa del usuario autenticado; las RPC lo
  -- rellenan explícitamente y el `select` de RLS filtra por él.
  empresa_id  uuid not null default public.mi_empresa()
                references public.empresas (id) on delete cascade,
  venta_id    uuid not null references public.ventas (id) on delete cascade,
  estado      text not null default 'pendiente'
                check (estado in ('pendiente', 'aprobada', 'rechazada')),
  -- Snapshot enriquecido construido por el SERVIDOR a partir de ventas.items:
  -- [{idx, id, nombre, qty, precio, esComun}]. El panel del admin lo pinta tal
  -- cual, sin volver a leer la venta.
  items       jsonb not null default '[]'::jsonb,
  monto       numeric(14, 2) not null default 0 check (monto >= 0),
  motivo      text,
  -- Método del cobro ORIGINAL: decide el egreso de caja y el pulso del cajón.
  metodo_pago text,
  solicitada_por uuid,
  -- Quién la pidió, en texto, para que el admin lo vea sin join contra
  -- `usuarios` (un empleado no puede leer la fila de otro).
  solicitante    text,
  solicitada_at  timestamptz not null default now(),
  resuelta_por   uuid,
  resuelta_at    timestamptz,
  resolucion_nota text,
  -- Resultado de la aprobación (auditoría de lo que realmente se repuso).
  unidades_repuestas integer,
  sin_producto       integer
);

create index if not exists devoluciones_empresa_estado_idx
  on public.devoluciones (empresa_id, estado, solicitada_at desc);
create index if not exists devoluciones_venta_idx
  on public.devoluciones (venta_id);

comment on table public.devoluciones is
  'Solicitudes de devolución (parcial o total). Un empleado las crea con solicitar_devolucion; solo empresa_admin/super_admin las resuelve con resolver_devolucion. Se escribe ÚNICAMENTE desde esas RPC SECURITY DEFINER.';

-- RLS: lectura acotada al tenant; la escritura NO tiene policy a propósito.
alter table public.devoluciones enable row level security;

drop policy if exists devoluciones_select_propia on public.devoluciones;
create policy devoluciones_select_propia on public.devoluciones
  for select
  using (empresa_id = public.mi_empresa() or public.mi_rol() = 'super_admin');

-- ── 3) Cuánto queda devolvible por línea ────────────────────────────────────
-- Vendido − ya devuelto (`ventas.devuelto_items`) − reservado por solicitudes
-- aún pendientes. Esa resta es lo que impide que dos cajeros pidan por separado
-- las mismas unidades y el admin apruebe ambas.
create or replace function public.devolucion_disponible(p_venta_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_empresa    uuid := public.mi_empresa();
  v_venta      public.ventas;
  v_pendientes jsonb;
  v_lineas     jsonb;
begin
  if v_empresa is null then
    raise exception 'Tu usuario no tiene una empresa asociada (nulo): no se puede consultar la devolución.'
      using errcode = '42501';
  end if;

  select * into v_venta
    from public.ventas
   where id = p_venta_id
     and empresa_id = v_empresa;

  if not found then
    raise exception 'La venta no existe o no pertenece a tu empresa.' using errcode = 'P0001';
  end if;

  -- Unidades comprometidas por solicitudes todavía sin resolver, por posición.
  select coalesce(jsonb_object_agg(idx, qty), '{}'::jsonb)
    into v_pendientes
    from (
      select it->>'idx' as idx, sum(coalesce((it->>'qty')::numeric, 0)) as qty
        from public.devoluciones d
        cross join lateral jsonb_array_elements(d.items) as it
       where d.venta_id = p_venta_id
         and d.empresa_id = v_empresa
         and d.estado = 'pendiente'
       group by 1
    ) s;

  select coalesce(jsonb_agg(l order by (l->>'idx')::int), '[]'::jsonb)
    into v_lineas
    from (
      select jsonb_build_object(
               'idx',       (e.ord - 1),
               'id',        e.value->>'id',
               'nombre',    coalesce(e.value->>'nombre', 'Artículo'),
               'precio',    coalesce((e.value->>'precio')::numeric, 0),
               'esComun',   coalesce((e.value->>'esComun')::boolean, false),
               'qty',       coalesce((e.value->>'qty')::numeric, 0),
               'devuelta',  coalesce((v_venta.devuelto_items ->> (e.ord - 1)::text)::numeric, 0),
               'pendiente', coalesce((v_pendientes        ->> (e.ord - 1)::text)::numeric, 0),
               'disponible', greatest(
                 coalesce((e.value->>'qty')::numeric, 0)
                   - coalesce((v_venta.devuelto_items ->> (e.ord - 1)::text)::numeric, 0)
                   - coalesce((v_pendientes        ->> (e.ord - 1)::text)::numeric, 0),
                 0)
             ) as l
        from jsonb_array_elements(coalesce(v_venta.items, '[]'::jsonb))
             with ordinality as e(value, ord)
    ) t;

  return jsonb_build_object(
    'venta_id',       v_venta.id,
    'estado',         v_venta.estado,
    'metodo',         v_venta.metodo_pago,
    'total',          v_venta.total,
    'devuelto_total', v_venta.devuelto_total,
    'lineas',         v_lineas
  );
end;
$$;

comment on function public.devolucion_disponible(uuid) is
  'Líneas de una venta de MI empresa con cuánto queda devolvible de cada una (vendido − ya devuelto − reservado por solicitudes pendientes). Acota los selectores de cantidad del modal de factura.';

grant execute on function public.devolucion_disponible(uuid) to authenticated;

-- ── 4) Solicitud de devolución (la crea cualquier miembro del tenant) ───────
-- `p_items` es un array de pares {"idx": <posición en ventas.items>, "qty": n}.
-- Precio, nombre y tope de cantidad los pone el SERVIDOR leyendo la venta.
--
-- Con `p_auto_aprobar` llama a `resolver_devolucion`, que se crea en el punto 5
-- de este MISMO script: PL/pgSQL no resuelve las funciones invocadas hasta la
-- ejecución, así que el orden de creación es indiferente (al terminar el
-- `commit` ambas existen).
create or replace function public.solicitar_devolucion(
  p_venta_id     uuid,
  p_items        jsonb,
  p_motivo       text    default null,
  p_auto_aprobar boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa    uuid := public.mi_empresa();
  v_venta      public.ventas;
  v_pendientes jsonb;
  v_par        jsonb;
  v_idx        integer;
  v_qty        numeric;
  v_linea      jsonb;
  v_vendida    numeric;
  v_disponible numeric;
  v_items      jsonb := '[]'::jsonb;
  v_vistos     int[]  := '{}';
  v_monto      numeric := 0;
  v_unidades   numeric := 0;
  v_motivo     text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_solicitud  uuid;
  v_quien      text;
begin
  -- 0) Guardas de contexto -------------------------------------------------
  if v_empresa is null then
    raise exception 'Tu usuario no tiene una empresa asociada (nulo): no se puede solicitar la devolución.'
      using errcode = '42501';
  end if;
  if p_venta_id is null then
    raise exception 'Falta el identificador de la venta a devolver.' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Selecciona al menos un producto y una cantidad para devolver.'
      using errcode = '22023';
  end if;

  -- 1) Venta de ESTA empresa. El filtro por empresa_id es lo que hace seguro
  --    el SECURITY DEFINER: un id de otro tenant no encuentra fila.
  select * into v_venta
    from public.ventas
   where id = p_venta_id
     and empresa_id = v_empresa
   for update;

  if not found then
    raise exception 'La venta no existe o no pertenece a tu empresa.' using errcode = 'P0001';
  end if;

  if v_venta.estado = 'Reembolsado' then
    raise exception 'Esta venta ya fue devuelta por completo.' using errcode = 'P0001';
  end if;

  -- 2) Unidades ya comprometidas por otras solicitudes pendientes -----------
  select coalesce(jsonb_object_agg(idx, qty), '{}'::jsonb)
    into v_pendientes
    from (
      select it->>'idx' as idx, sum(coalesce((it->>'qty')::numeric, 0)) as qty
        from public.devoluciones d
        cross join lateral jsonb_array_elements(d.items) as it
       where d.venta_id = p_venta_id
         and d.empresa_id = v_empresa
         and d.estado = 'pendiente'
       group by 1
    ) s;

  -- 3) Validación línea por línea CONTRA LA VENTA ---------------------------
  for v_par in select value from jsonb_array_elements(p_items) as t(value)
  loop
    v_idx := nullif(v_par->>'idx', '')::integer;
    v_qty := coalesce((v_par->>'qty')::numeric, 0);

    if v_idx is null or v_idx < 0
       or v_idx >= jsonb_array_length(coalesce(v_venta.items, '[]'::jsonb)) then
      raise exception 'La línea % no existe en esta venta.', coalesce(v_idx::text, 'indicada')
        using errcode = '22023';
    end if;
    if v_idx = any(v_vistos) then
      raise exception 'La línea % viene repetida en la solicitud.', v_idx using errcode = '22023';
    end if;
    v_vistos := v_vistos || v_idx;

    -- Cantidades enteras: no se devuelve media unidad desde el mostrador.
    if v_qty <= 0 or v_qty <> trunc(v_qty) then
      raise exception 'La cantidad a devolver de la línea % debe ser un entero positivo.', v_idx
        using errcode = '22023';
    end if;

    v_linea   := v_venta.items -> v_idx;
    v_vendida := coalesce((v_linea->>'qty')::numeric, 0);
    v_disponible := greatest(
      v_vendida
        - coalesce((v_venta.devuelto_items ->> v_idx::text)::numeric, 0)
        - coalesce((v_pendientes           ->> v_idx::text)::numeric, 0),
      0);

    if v_qty > v_disponible then
      raise exception
        'Solo quedan % unidad(es) devolvibles de "%" (se pidieron %).',
        v_disponible, coalesce(v_linea->>'nombre', 'el artículo'), v_qty
        using errcode = 'P0001';
    end if;

    -- Snapshot con el PRECIO DE LA VENTA (no el que mande el cliente).
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'idx',     v_idx,
      'id',      v_linea->>'id',
      'nombre',  coalesce(v_linea->>'nombre', 'Artículo'),
      'qty',     v_qty,
      'precio',  coalesce((v_linea->>'precio')::numeric, 0),
      'esComun', coalesce((v_linea->>'esComun')::boolean, false)
    ));

    v_monto    := v_monto + v_qty * coalesce((v_linea->>'precio')::numeric, 0);
    v_unidades := v_unidades + v_qty;
  end loop;

  -- El reembolso jamás puede superar lo que queda vivo de la factura (p. ej.
  -- una venta con descuento donde la suma de líneas excede el total cobrado).
  v_monto := least(v_monto, greatest(coalesce(v_venta.total, 0) - coalesce(v_venta.devuelto_total, 0), 0));

  -- 4) Quién la pide (texto, para que el admin no dependa de un join) -------
  select coalesce(nullif(btrim(coalesce(u.nombre_comercial, '')), ''), u.email, 'Usuario')
    into v_quien
    from public.usuarios u
   where u.id = auth.uid();

  insert into public.devoluciones (
    empresa_id, venta_id, estado, items, monto, motivo, metodo_pago,
    solicitada_por, solicitante
  ) values (
    v_empresa, v_venta.id, 'pendiente', v_items, v_monto, v_motivo, v_venta.metodo_pago,
    auth.uid(), coalesce(v_quien, 'Usuario')
  )
  returning id into v_solicitud;

  -- 5) Atajo del dueño: pedir y aprobar en la MISMA transacción -------------
  --    Solo para admin; `resolver_devolucion` vuelve a comprobar el rol, así
  --    que un empleado que mande p_auto_aprobar => true recibe un 42501 y la
  --    solicitud entera se revierte (no queda a medias).
  if coalesce(p_auto_aprobar, false) then
    return public.resolver_devolucion(v_solicitud, true, v_motivo)
             || jsonb_build_object('solicitud_id', v_solicitud, 'auto_aprobada', true);
  end if;

  return jsonb_build_object(
    'solicitud_id',  v_solicitud,
    'estado',        'pendiente',
    'auto_aprobada', false,
    'monto',         v_monto,
    'unidades',      v_unidades,
    'lineas',        jsonb_array_length(v_items),
    'metodo',        v_venta.metodo_pago,
    -- Una solicitud NO abre el cajón: el dinero no se ha movido todavía.
    'abrir_cajon',   false
  );
end;
$$;

comment on function public.solicitar_devolucion(uuid, jsonb, text, boolean) is
  'Registra una solicitud de devolución parcial (ítems + cantidades + motivo) sin tocar stock, caja ni el estado de la venta. La puede crear cualquier miembro del tenant; precios y topes los impone el servidor leyendo ventas.items. Con p_auto_aprobar => true la resuelve en la misma transacción (solo empresa_admin/super_admin).';

grant execute on function public.solicitar_devolucion(uuid, jsonb, text, boolean) to authenticated;

-- ── 5) Resolución: aprobar (mueve stock y caja) o rechazar (no mueve nada) ──
create or replace function public.resolver_devolucion(
  p_solicitud_id uuid,
  p_aprobar      boolean,
  p_nota         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa    uuid := public.mi_empresa();
  v_rol        text := public.mi_rol()::text;
  v_sol        public.devoluciones;
  v_venta      public.ventas;
  v_item       jsonb;
  v_idx        integer;
  v_qty        numeric;
  v_linea      jsonb;
  v_vendida    numeric;
  v_ya         numeric;
  v_raw_id     text;
  v_devuelto   jsonb;
  v_unidades   integer := 0;
  v_sin_prod   integer := 0;
  v_nota       text := nullif(btrim(coalesce(p_nota, '')), '');
  v_total_dev  numeric;
  v_completa   boolean;
  v_abrir      boolean := false;
begin
  -- 0) Guardas de contexto -------------------------------------------------
  if v_empresa is null then
    raise exception 'Tu usuario no tiene una empresa asociada (nulo): no se puede resolver la devolución.'
      using errcode = '42501';
  end if;

  -- SOLO EL DUEÑO APRUEBA. Mismo razonamiento que `registrar_devolucion`: al
  -- aprobar se mueve inventario y dinero. El gateo va aquí dentro —no solo en
  -- React— porque la función es SECURITY DEFINER y cualquiera con la anon key
  -- podría invocarla. `coalesce` deliberado: con rol nulo, `not in` daría NULL
  -- y el `if` no dispararía (fail-OPEN); con '' la guarda falla cerrada.
  if coalesce(v_rol, '') not in ('empresa_admin', 'super_admin') then
    raise exception 'Solo el administrador de la empresa puede aprobar o rechazar devoluciones.'
      using errcode = '42501';
  end if;

  if p_solicitud_id is null then
    raise exception 'Falta el identificador de la solicitud.' using errcode = '22023';
  end if;

  -- 1) Solicitud de ESTA empresa, bloqueada para serializar resoluciones ----
  select * into v_sol
    from public.devoluciones
   where id = p_solicitud_id
     and empresa_id = v_empresa
   for update;

  if not found then
    raise exception 'La solicitud no existe o no pertenece a tu empresa.' using errcode = 'P0001';
  end if;

  -- 2) Idempotencia: ya resuelta → no se vuelve a tocar nada ----------------
  if v_sol.estado <> 'pendiente' then
    return jsonb_build_object(
      'solicitud_id', v_sol.id,
      'venta_id',     v_sol.venta_id,
      'estado',       v_sol.estado,
      'duplicada',    true,
      'monto',        v_sol.monto,
      'unidades',     coalesce(v_sol.unidades_repuestas, 0),
      'sin_producto', coalesce(v_sol.sin_producto, 0),
      'abrir_cajon',  false
    );
  end if;

  -- 3) RECHAZO: cero efectos colaterales. Ni stock, ni caja, ni cajón. ------
  if not coalesce(p_aprobar, false) then
    update public.devoluciones
       set estado = 'rechazada',
           resuelta_por = auth.uid(),
           resuelta_at  = now(),
           resolucion_nota = v_nota
     where id = v_sol.id
       and empresa_id = v_empresa;

    return jsonb_build_object(
      'solicitud_id', v_sol.id,
      'venta_id',     v_sol.venta_id,
      'estado',       'rechazada',
      'duplicada',    false,
      'monto',        v_sol.monto,
      'unidades',     0,
      'sin_producto', 0,
      'abrir_cajon',  false
    );
  end if;

  -- 4) APROBACIÓN -----------------------------------------------------------
  select * into v_venta
    from public.ventas
   where id = v_sol.venta_id
     and empresa_id = v_empresa
   for update;

  if not found then
    raise exception 'La venta de esta solicitud ya no existe en tu empresa.' using errcode = 'P0001';
  end if;

  -- La venta se devolvió entera por otra vía mientras la solicitud esperaba:
  -- se cierra como rechazada en vez de re-sumar stock por segunda vez.
  if v_venta.estado = 'Reembolsado' then
    update public.devoluciones
       set estado = 'rechazada',
           resuelta_por = auth.uid(),
           resuelta_at  = now(),
           resolucion_nota = coalesce(v_nota || ' · ', '')
             || 'La venta ya había sido devuelta por completo.'
     where id = v_sol.id
       and empresa_id = v_empresa;

    return jsonb_build_object(
      'solicitud_id', v_sol.id,
      'venta_id',     v_sol.venta_id,
      'estado',       'rechazada',
      'duplicada',    false,
      'monto',        0,
      'unidades',     0,
      'sin_producto', 0,
      'abrir_cajon',  false,
      'aviso',        'La venta ya había sido devuelta por completo.'
    );
  end if;

  v_devuelto := coalesce(v_venta.devuelto_items, '{}'::jsonb);

  for v_item in select value from jsonb_array_elements(coalesce(v_sol.items, '[]'::jsonb)) as t(value)
  loop
    v_idx := nullif(v_item->>'idx', '')::integer;
    v_qty := coalesce((v_item->>'qty')::numeric, 0);
    if v_idx is null or v_qty <= 0 then
      continue;
    end if;

    v_linea   := v_venta.items -> v_idx;
    v_vendida := coalesce((v_linea->>'qty')::numeric, 0);
    v_ya      := coalesce((v_devuelto ->> v_idx::text)::numeric, 0);

    -- Revalidación en el momento de aprobar: entre la solicitud y el visto
    -- bueno pudieron aprobarse otras devoluciones de la misma línea.
    if v_ya + v_qty > v_vendida then
      raise exception
        'La solicitud supera lo que queda por devolver de "%": vendidas %, ya devueltas %, se piden %.',
        coalesce(v_linea->>'nombre', 'el artículo'), v_vendida, v_ya, v_qty
        using errcode = 'P0001';
    end if;

    v_devuelto := jsonb_set(v_devuelto, array[v_idx::text], to_jsonb(v_ya + v_qty), true);

    -- Los "artículos comunes" nunca descontaron stock, así que tampoco lo
    -- devuelven (mismo criterio que registrar_venta_offline).
    if coalesce((v_item->>'esComun')::boolean, false) then
      continue;
    end if;

    v_raw_id := v_item->>'id';
    -- Guarda defensiva: una venta vieja puede llevar el id negativo de un
    -- artículo suelto sin marcar `esComun`. Sin este filtro el cast reventaría
    -- (22P02) y tumbaría la aprobación entera.
    if v_raw_id is null
       or v_raw_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      continue;
    end if;

    update public.productos
       set stock_actual = stock_actual + v_qty::integer
     where id = v_raw_id::uuid
       and empresa_id = v_empresa;

    if found then
      v_unidades := v_unidades + v_qty::integer;
    else
      -- El producto se borró del catálogo tras la venta. No aborta la
      -- devolución (el dinero sí hay que devolverlo); se reporta a la interfaz.
      v_sin_prod := v_sin_prod + 1;
    end if;
  end loop;

  v_total_dev := coalesce(v_venta.devuelto_total, 0) + coalesce(v_sol.monto, 0);

  -- ¿Queda algo vivo en la factura? Si todas las líneas están completamente
  -- devueltas (o, en ventas importadas sin desglose, si el importe cubre el
  -- total), la venta pasa a 'Reembolsado' y deja de contar como ingreso.
  select not exists (
    select 1
      from jsonb_array_elements(coalesce(v_venta.items, '[]'::jsonb)) with ordinality as e(value, ord)
     where coalesce((e.value->>'qty')::numeric, 0)
           > coalesce((v_devuelto ->> (e.ord - 1)::text)::numeric, 0)
  ) into v_completa;

  if jsonb_array_length(coalesce(v_venta.items, '[]'::jsonb)) = 0 then
    v_completa := v_total_dev >= coalesce(v_venta.total, 0);
  end if;

  update public.ventas
     set devuelto_items  = v_devuelto,
         devuelto_total  = v_total_dev,
         estado          = case when v_completa then 'Reembolsado' else estado end,
         devuelta_at     = case when v_completa then now() else devuelta_at end,
         devuelta_por    = case when v_completa then auth.uid() else devuelta_por end,
         devuelta_motivo = case when v_completa then coalesce(v_sol.motivo, devuelta_motivo)
                                else devuelta_motivo end
   where id = v_venta.id
     and empresa_id = v_empresa;

  -- 5) Ajuste de caja: el efectivo devuelto SALE del cajón hoy --------------
  --    Solo para cobros en efectivo: en Nequi/Bold/Fiado no hay billete que
  --    sacar, así que un egreso falsearía el arqueo. El bloque va protegido
  --    porque el módulo de arqueo es opcional: si no está instalado, el
  --    savepoint se revierte y la devolución (stock + estado) se conserva.
  if coalesce(v_venta.metodo_pago, '') = 'Efectivo' and coalesce(v_sol.monto, 0) > 0 then
    v_abrir := true;
    begin
      insert into public.movimientos_caja (empresa_id, fecha, tipo, monto, concepto)
      values (
        v_empresa,
        public.hoy_negocio(),
        'egreso',
        v_sol.monto,
        'Devolución venta ' || left(v_venta.id::text, 8)
          || coalesce(' · ' || v_sol.motivo, '')
      );
    exception
      when undefined_table or undefined_function then
        raise notice 'Módulo de arqueo no instalado: se omite el egreso de caja de la devolución.';
    end;
  end if;

  update public.devoluciones
     set estado = 'aprobada',
         resuelta_por = auth.uid(),
         resuelta_at  = now(),
         resolucion_nota = v_nota,
         unidades_repuestas = v_unidades,
         sin_producto = v_sin_prod
   where id = v_sol.id
     and empresa_id = v_empresa;

  return jsonb_build_object(
    'solicitud_id', v_sol.id,
    'venta_id',     v_venta.id,
    'estado',       'aprobada',
    'duplicada',    false,
    'monto',        v_sol.monto,
    'metodo',       v_venta.metodo_pago,
    'unidades',     v_unidades,
    'sin_producto', v_sin_prod,
    'venta_completa', v_completa,
    -- EL CAJÓN: solo aquí, y solo si salió efectivo de verdad.
    'abrir_cajon',  v_abrir
  );
end;
$$;

comment on function public.resolver_devolucion(uuid, boolean, text) is
  'Aprueba o rechaza una solicitud de devolución. Reservada a empresa_admin/super_admin. Aprobar repone el stock de los ítems pedidos, acumula lo devuelto en la venta (Reembolsado si ya no queda nada) y registra el egreso de caja si el cobro fue en efectivo; devuelve abrir_cajon=true SOLO en ese caso. Rechazar no altera nada. Atómica e idempotente.';

grant execute on function public.resolver_devolucion(uuid, boolean, text) to authenticated;

-- ── 6) La devolución TOTAL convive con las parciales ────────────────────────
-- `registrar_devolucion` (2026-10-devoluciones-ventas.sql) seguía reponiendo la
-- cantidad VENDIDA de cada línea. Sobre una venta con devoluciones parciales ya
-- aprobadas eso inflaría el inventario, así que ahora repone solo lo que queda
-- y cierra las solicitudes pendientes de esa venta. Misma firma, mismo gateo.
create or replace function public.registrar_devolucion(
  p_venta_id uuid,
  p_motivo   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa     uuid := public.mi_empresa();
  v_rol         text := public.mi_rol()::text;
  v_venta       public.ventas;
  v_rec         record;
  v_raw_id      text;
  v_qty         integer;
  v_unidades    integer := 0;
  v_lineas      integer := 0;
  v_sin_producto integer := 0;
  v_devuelto    jsonb;
  v_pendiente   numeric;
  v_motivo      text := nullif(btrim(coalesce(p_motivo, '')), '');
begin
  if v_empresa is null then
    raise exception 'Tu usuario no tiene una empresa asociada (nulo): no se puede devolver la venta.'
      using errcode = '42501';
  end if;

  -- SOLO EL DUEÑO DEVUELVE (ver la nota extensa en 2026-10-devoluciones-ventas.sql).
  if coalesce(v_rol, '') not in ('empresa_admin', 'super_admin') then
    raise exception 'Solo el administrador de la empresa puede procesar devoluciones.'
      using errcode = '42501';
  end if;

  if p_venta_id is null then
    raise exception 'Falta el identificador de la venta a devolver.' using errcode = '22023';
  end if;

  select * into v_venta
    from public.ventas
   where id = p_venta_id
     and empresa_id = v_empresa
   for update;

  if not found then
    raise exception 'La venta no existe o no pertenece a tu empresa.' using errcode = 'P0001';
  end if;

  if v_venta.estado = 'Reembolsado' then
    return jsonb_build_object(
      'venta_id',   v_venta.id,
      'duplicada',  true,
      'total',      v_venta.total,
      'unidades',   0,
      'lineas',     0,
      'sin_producto', 0
    );
  end if;

  v_devuelto  := coalesce(v_venta.devuelto_items, '{}'::jsonb);
  -- Lo que realmente falta por reembolsar de la factura.
  v_pendiente := greatest(coalesce(v_venta.total, 0) - coalesce(v_venta.devuelto_total, 0), 0);

  for v_rec in
    select (e.ord - 1) as idx, e.value as item
      from jsonb_array_elements(coalesce(v_venta.items, '[]'::jsonb))
           with ordinality as e(value, ord)
  loop
    -- Solo el RESTO: lo ya devuelto en parciales no se vuelve a reponer.
    v_qty := greatest(
      coalesce((v_rec.item->>'qty')::numeric, 0)
        - coalesce((v_devuelto ->> v_rec.idx::text)::numeric, 0),
      0)::integer;
    if v_qty <= 0 then
      continue;
    end if;

    v_devuelto := jsonb_set(
      v_devuelto,
      array[v_rec.idx::text],
      to_jsonb(coalesce((v_rec.item->>'qty')::numeric, 0)),
      true);

    -- Los artículos comunes nunca descontaron stock; tampoco lo devuelven.
    if coalesce((v_rec.item->>'esComun')::boolean, false) then
      continue;
    end if;

    v_raw_id := v_rec.item->>'id';
    if v_raw_id is null
       or v_raw_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      continue;
    end if;

    v_lineas := v_lineas + 1;

    update public.productos
       set stock_actual = stock_actual + v_qty
     where id = v_raw_id::uuid
       and empresa_id = v_empresa;

    if found then
      v_unidades := v_unidades + v_qty;
    else
      v_sin_producto := v_sin_producto + 1;
    end if;
  end loop;

  update public.ventas
     set estado          = 'Reembolsado',
         devuelta_at     = now(),
         devuelta_por    = auth.uid(),
         devuelta_motivo = v_motivo,
         devuelto_items  = v_devuelto,
         devuelto_total  = coalesce(v_venta.total, 0)
   where id = v_venta.id
     and empresa_id = v_empresa;

  -- Las solicitudes que seguían en cola sobre esta venta ya no tienen objeto.
  update public.devoluciones
     set estado = 'rechazada',
         resuelta_por = auth.uid(),
         resuelta_at  = now(),
         resolucion_nota = 'La venta se devolvió por completo desde el panel de Transacciones.'
   where venta_id = v_venta.id
     and empresa_id = v_empresa
     and estado = 'pendiente';

  -- Egreso de caja por lo que QUEDABA pendiente de reembolsar.
  if v_venta.metodo_pago = 'Efectivo' and v_pendiente > 0 then
    begin
      insert into public.movimientos_caja (empresa_id, fecha, tipo, monto, concepto)
      values (
        v_empresa,
        public.hoy_negocio(),
        'egreso',
        v_pendiente,
        'Devolución venta ' || left(v_venta.id::text, 8)
          || coalesce(' · ' || v_motivo, '')
      );
    exception
      when undefined_table or undefined_function then
        raise notice 'Módulo de arqueo no instalado: se omite el egreso de caja de la devolución.';
    end;
  end if;

  return jsonb_build_object(
    'venta_id',     v_venta.id,
    'duplicada',    false,
    'total',        v_venta.total,
    'metodo',       v_venta.metodo_pago,
    'unidades',     v_unidades,
    'lineas',       v_lineas,
    'sin_producto', v_sin_producto,
    -- Mismo contrato que `resolver_devolucion`: el cajón solo si salió efectivo.
    'abrir_cajon',  (v_venta.metodo_pago = 'Efectivo' and v_pendiente > 0)
  );
end;
$$;

grant execute on function public.registrar_devolucion(uuid, text) to authenticated;

-- ── 7) Las devoluciones parciales también dejan de contar como ingreso ──────
-- Antes bastaba con excluir las ventas 'Reembolsado'. Ahora una venta viva
-- puede llevar parte reembolsada: se descuenta `devuelto_total` del ingreso y
-- las unidades devueltas de la rentabilidad.
create or replace function public.total_ventas_empresa()
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(greatest(coalesce(total, 0) - coalesce(devuelto_total, 0), 0)), 0)::numeric
  from public.ventas
  where empresa_id = public.mi_empresa()
    and coalesce(estado, 'Pagado') <> 'Reembolsado';
$$;

grant execute on function public.total_ventas_empresa() to authenticated;

create or replace function public.metricas_rentabilidad_empresa()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with lineas as (
    select
      e.value->>'id'                                  as raw_id,
      coalesce((e.value->>'esComun')::boolean, false) as es_comun,
      -- Cantidad NETA: lo vendido menos lo ya devuelto en esa misma línea.
      greatest(
        coalesce((e.value->>'qty')::numeric, 0)
          - coalesce((v.devuelto_items ->> (e.ord - 1)::text)::numeric, 0),
        0)                                            as qty,
      coalesce((e.value->>'precio')::numeric, 0)      as precio
    from public.ventas v
    cross join lateral jsonb_array_elements(v.items) with ordinality as e(value, ord)
    where v.empresa_id = public.mi_empresa()
      -- Una venta devuelta no generó ingreso ni consumió mercancía.
      and coalesce(v.estado, 'Pagado') <> 'Reembolsado'
  ),
  -- Solo líneas de productos REALES del catálogo (con costo conocido). Los
  -- artículos comunes quedan fuera y su id negativo jamás casa con un id real.
  vendidos as (
    select l.qty, l.precio, coalesce(p.precio_costo, 0) as precio_costo
    from lineas l
    join public.productos p
      on p.empresa_id = public.mi_empresa()
     and p.id::text = l.raw_id
    where not l.es_comun
  ),
  ventas_agg as (
    select
      coalesce(sum(qty * precio), 0)        as ingresos,
      coalesce(sum(qty * precio_costo), 0)  as costo,
      coalesce(sum(qty), 0)                 as unidades
    from vendidos
  ),
  inv_agg as (
    select coalesce(sum(coalesce(stock_actual, 0) * coalesce(precio_costo, 0)), 0) as valor_costo
    from public.productos
    where empresa_id = public.mi_empresa()
  )
  select jsonb_build_object(
    'ingresos',               va.ingresos,
    'costo',                  va.costo,
    'unidades_vendidas',      va.unidades,
    'valor_inventario_costo', ia.valor_costo,
    'margen',   case when va.ingresos   > 0
                     then round(((va.ingresos - va.costo) / va.ingresos) * 100, 1)
                     else 0 end,
    'rotacion', case when ia.valor_costo > 0
                     then round(va.costo / ia.valor_costo, 2)
                     else 0 end
  )
  from ventas_agg va cross join inv_agg ia;
$$;

grant execute on function public.metricas_rentabilidad_empresa() to authenticated;

commit;

-- Verificación rápida:
--   -- 1) Toma una venta del POS con varias líneas:
--   select id, total, metodo_pago, estado, items from public.ventas
--    where jsonb_array_length(items) > 1 order by created_at desc limit 1;
--   -- 2) Cuánto se puede devolver de cada línea:
--   select public.devolucion_disponible('<venta_id>');
--   -- 3) Solicita 1 unidad de la primera línea (como empleado: queda pendiente):
--   select public.solicitar_devolucion('<venta_id>', '[{"idx":0,"qty":1}]'::jsonb, 'Defectuoso');
--   -- 4) Como admin, apruébala y mira `abrir_cajon`:
--   select public.resolver_devolucion('<solicitud_id>', true, 'Visto bueno');
--   -- 5) Comprueba stock, acumulado y egreso de caja:
--   select estado, devuelto_total, devuelto_items from public.ventas where id = '<venta_id>';
--   select concepto, tipo, monto from public.movimientos_caja order by created_at desc limit 3;
--   -- 6) Rechazo: NO debe mover nada ni abrir el cajón.
--   select public.resolver_devolucion('<otra_solicitud>', false, 'No procede');
