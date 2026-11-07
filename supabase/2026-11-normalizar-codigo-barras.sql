-- ============================================================================
-- Aether ERP — Código de barras CANÓNICO en `public.productos`
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor. Idempotente, transaccional y NO toca RLS:
-- normalizar un texto es ortogonal a las policies; el aislamiento sigue viniendo
-- de `empresa_id = public.mi_empresa()`.
--
-- POR QUÉ HACE FALTA
-- ------------------
-- La app ya normaliza el código al leer, al buscar y al guardar
-- (`normalizarCodigoBarras()` en app/lib/productos.ts), pero eso no arregla lo
-- que YA está escrito. Una fila con " 7702412100110" (pegado desde Excel, lector
-- con sufijo, importación masiva) es un código DISTINTO de "7702412100110" para
-- Postgres, y de ahí salía la discrepancia que se reportó:
--   · El índice único no ve las dos variantes como duplicadas → se puede dar de
--     alta el "mismo" producto dos veces.
--   · El POS y la validación del alta buscan con igualdad EXACTA sobre el código
--     que manda el lector (ya limpio) → no encuentran la fila, el escaneo falla y
--     el aviso de duplicado miente.
--
-- Este script hace dos cosas:
--   1) Limpia de una vez TODAS las filas existentes (vivas y archivadas).
--   2) Deja un trigger que normaliza en cada INSERT/UPDATE, así que ningún camino
--      de escritura —formulario, importación masiva, RPC o SQL a mano— puede
--      volver a meter un código con espacios.
-- ============================================================================

begin;

-- ── 0) Qué consideramos "invisible" ─────────────────────────────────────────
-- Espacio, tab, CR/LF, espacio no-separable (U+00A0, el del pegado desde Excel),
-- los de ancho cero (U+200B..U+200D) y el BOM (U+FEFF). Es exactamente el mismo
-- juego que recorta `normalizarCodigoBarras()` en el cliente: si las dos
-- definiciones se separan, vuelve la discrepancia.
create or replace function public.codigo_barras_canonico(p_codigo text)
returns text
language sql
immutable
-- INVOKER a propósito: es una función pura de texto, no lee tablas y por tanto
-- no debe elevar privilegios (ver 2026-08-fix-helpers-security-definer.sql).
security invoker
as $$
  select nullif(
    btrim(
      p_codigo,
      ' ' || chr(9) || chr(10) || chr(13) || chr(160)
          || chr(8203) || chr(8204) || chr(8205) || chr(65279)
    ),
    ''
  );
$$;

comment on function public.codigo_barras_canonico(text) is
  'Forma canónica de un código de barras: sin espacios (ni invisibles) a los lados, y NULL si no queda nada. Espejo exacto de normalizarCodigoBarras() en app/lib/productos.ts.';

-- ── 1) Preflight: ¿limpiar crearía duplicados entre filas VIVAS? ─────────────
-- Si la empresa tiene "7702…" y " 7702…" como dos productos activos distintos,
-- normalizar los volvería el MISMO código y el índice único parcial rechazaría
-- el UPDATE a mitad del script. Abortamos antes de tocar nada y decimos cuáles
-- son, para que se archive o se corrija el sobrante a mano.
do $preflight$
declare
  v_dups text;
begin
  select string_agg(
           format('empresa %s / código %L (%s filas vivas)', d.empresa_id, d.codigo, d.n),
           E'\n  '
         )
    into v_dups
  from (
    select empresa_id,
           public.codigo_barras_canonico(codigo_barras) as codigo,
           count(*) as n
    from public.productos
    where deleted_at is null
      and public.codigo_barras_canonico(codigo_barras) is not null
    group by 1, 2
    having count(*) > 1
  ) d;

  if v_dups is not null then
    raise exception using
      message = E'Al limpiar los espacios quedarían códigos repetidos entre productos VIVOS:\n  ' || v_dups,
      hint    = 'Son el mismo producto dado de alta dos veces. Archiva el sobrante (update public.productos set deleted_at = now() where id = ...) o cámbiale el código, y vuelve a ejecutar. No se ha modificado nada.';
  end if;
end
$preflight$;

-- ── 2) Limpieza de lo ya guardado ───────────────────────────────────────────
-- Vivas y archivadas: una archivada con el código sucio también estorba (retiene
-- una variante que nadie puede encontrar ni reutilizar con criterio).
update public.productos
   set codigo_barras = public.codigo_barras_canonico(codigo_barras)
 where codigo_barras is distinct from public.codigo_barras_canonico(codigo_barras);

-- ── 3) Que no vuelva a entrar sucio ─────────────────────────────────────────
-- El trigger es la garantía de verdad: cubre el formulario, los importadores
-- masivos (importar_productos_masivo), guardar_producto_por_codigo y cualquier
-- UPDATE manual desde el SQL Editor.
create or replace function public.productos_normalizar_codigo()
returns trigger
language plpgsql
security invoker
as $$
begin
  new.codigo_barras := public.codigo_barras_canonico(new.codigo_barras);
  return new;
end;
$$;

comment on function public.productos_normalizar_codigo() is
  'Trigger BEFORE INSERT/UPDATE: deja codigo_barras en su forma canónica para que la unicidad y las búsquedas exactas comparen siempre el mismo valor.';

drop trigger if exists productos_normalizar_codigo_trg on public.productos;

create trigger productos_normalizar_codigo_trg
  before insert or update of codigo_barras on public.productos
  for each row
  execute function public.productos_normalizar_codigo();

commit;

-- ============================================================================
-- VERIFICACIÓN — es la salida que verás en el panel de Supabase.
-- `sucios` debe ser 0 en las dos filas.
-- ============================================================================
select
  case when deleted_at is null then 'vivos' else 'archivados' end as estado,
  count(*) as productos,
  count(*) filter (
    where codigo_barras is distinct from public.codigo_barras_canonico(codigo_barras)
  ) as sucios
from public.productos
group by 1
order by 1;

-- ============================================================================
-- PRUEBA DEL TRIGGER (opcional, con un código de usar y tirar)
--   insert into public.productos (empresa_id, descripcion, precio_venta, codigo_barras)
--   values (public.mi_empresa(), 'Prueba trim', 1000, '  TEST-TRIM  ')
--   returning codigo_barras;  -- debe devolver 'TEST-TRIM', sin espacios
--   delete from public.productos where codigo_barras = 'TEST-TRIM';
-- ============================================================================
