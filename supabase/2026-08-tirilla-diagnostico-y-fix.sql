-- ============================================================================
-- Aether ERP — Tirilla: DIAGNÓSTICO + FIX de "data: null" al leer empresas
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor. Idempotente (se puede correr varias veces).
--
-- SÍNTOMA
-- -------
-- En consola del navegador:
--   [TIRILLA FETCH] { data: null, empresaId: "7cd3b915-...", error: null }
-- La lectura NO trae fila para la empresa del usuario, y el guardado parece no
-- persistir. `data: null` con `error: null` = la consulta devolvió CERO filas
-- (NO es que las columnas estén en NULL: eso daría un objeto con campos null).
--
-- Solo hay dos causas posibles, con arreglos opuestos:
--   • CAUSA A (huérfano): NO existe fila en `empresas` con ese id. El UPDATE del
--     guardado (WHERE id = mi_empresa()) no matchea nada → escribe 0 filas en
--     silencio. Se arregla enlazando el usuario a una empresa real.
--   • CAUSA B (RLS): la fila SÍ existe (y el guardado quizá ya funcionaba, porque
--     la RPC es SECURITY DEFINER y salta RLS), pero la policy SELECT de `empresas`
--     fue borrada por un `DROP FUNCTION ... CASCADE` previo y nunca se restauró.
--     RLS activa sin policy SELECT = 0 filas para el usuario. Se arregla
--     recreando `empresas_select_propia` (parte 2, más abajo).
--
-- Los pasos 2 y 3 son SEGUROS de aplicar SIEMPRE (idempotentes) y cubren la
-- Causa B y el guardado silencioso. Para la Causa A, corre el diagnóstico del
-- paso 1 y, si aplica, usa el enlace manual del paso 4.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) DIAGNÓSTICO — decide A vs B. El SQL Editor corre como postgres (SALTA RLS),
--    así que esto ve la fila "real" aunque la app no pueda por RLS.
--    >>> Ejecuta este SELECT por separado y MIRA el resultado ANTES de reparar.
-- ----------------------------------------------------------------------------
select
  e.id                                   as empresa_existe,   -- null aquí = CAUSA A (huérfano)
  e.nit, e.direccion, e.telefono, e.mensaje_recibo,           -- ¿ya se guardó algo? = CAUSA B
  u.id  as usuario_id, u.email, u.rol, u.empresa_id
from public.usuarios u
left join public.empresas e on e.id = u.empresa_id
where u.empresa_id = '7cd3b915-e384-4f0f-a7a9-6967855ccc4b';
--   • Si `empresa_existe` es NULL  → CAUSA A. Ve al paso 4.
--   • Si trae fila y nit/direccion YA tienen tus datos → CAUSA B (el guardado ya
--     funcionaba; solo faltaba la policy de lectura). El paso 2 lo arregla.
--   • Si trae fila pero nit/direccion en NULL → aplica pasos 2 y 3, recarga la
--     app, guarda de nuevo y verifica.

begin;

-- ----------------------------------------------------------------------------
-- 2) FIX Causa B — restaurar la policy SELECT de `empresas` (por si un CASCADE
--    la borró). Idéntica a 2026-07-roles-y-rls.sql para no divergir.
-- ----------------------------------------------------------------------------
alter table public.empresas enable row level security;

drop policy if exists empresas_select_propia on public.empresas;
create policy empresas_select_propia on public.empresas
  for select
  using (id = public.mi_empresa() or public.mi_rol() = 'super_admin');

-- ----------------------------------------------------------------------------
-- 3) FIX guardado silencioso — la RPC ahora LANZA si el UPDATE no toca ninguna
--    fila (Causa A) en vez de "tener éxito" sin escribir nada. Así el toast de
--    la app muestra el error real en lugar de perder los datos en silencio.
-- ----------------------------------------------------------------------------
create or replace function public.actualizar_tirilla(
  p_nit            text,
  p_direccion      text,
  p_telefono       text,
  p_logo_url       text,
  p_mensaje_recibo text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa uuid := public.mi_empresa();
  v_filas   integer;
begin
  if v_empresa is null then
    raise exception 'El usuario no tiene una empresa asociada (empresa_id nulo).'
      using errcode = '42501';
  end if;

  update public.empresas
     set nit            = nullif(btrim(coalesce(p_nit, '')), ''),
         direccion      = nullif(btrim(coalesce(p_direccion, '')), ''),
         telefono       = nullif(btrim(coalesce(p_telefono, '')), ''),
         logo_url       = nullif(p_logo_url, ''),
         mensaje_recibo = nullif(btrim(coalesce(p_mensaje_recibo, '')), '')
   where id = v_empresa;

  get diagnostics v_filas = row_count;
  if v_filas = 0 then
    -- No existe fila en `empresas` para esta empresa: el usuario está huérfano.
    -- Antes esto pasaba desapercibido (0 filas, sin error) y "se guardaba" nada.
    raise exception
      'No existe la empresa % (usuario huérfano). Aplica el paso 4 del script 2026-08-tirilla-diagnostico-y-fix.sql.',
      v_empresa
      using errcode = 'P0002';  -- no_data_found
  end if;
end;
$$;

grant execute on function public.actualizar_tirilla(text, text, text, text, text)
  to authenticated;

commit;

-- ----------------------------------------------------------------------------
-- 4) FIX Causa A (SOLO si el paso 1 mostró `empresa_existe` = NULL) — enlazar el
--    usuario a una empresa REAL. Elige UNA de las dos opciones:
--
--   -- Opción A.1: el usuario debe ir a una empresa YA EXISTENTE. Busca su id:
--   --   select id, nombre, nit from public.empresas order by nombre;
--   -- y reenlaza (esto también corrige mi_empresa() para ese usuario):
--   --   update public.usuarios
--   --   set empresa_id = '<uuid-de-la-empresa-correcta>'
--   --   where id = '<usuario_id-del-paso-1>';
--
--   -- Opción A.2: crear una empresa nueva para el usuario y enlazarla:
--   --   with nueva as (
--   --     insert into public.empresas (nombre, tipo_negocio, moneda)
--   --     values ('Mi Empresa', 'general', 'COP')
--   --     returning id
--   --   )
--   --   update public.usuarios u
--   --   set empresa_id = (select id from nueva)
--   --   where u.id = '<usuario_id-del-paso-1>';
--
-- Tras el paso 4: cierra sesión y vuelve a entrar (refresca el JWT/empresa) antes
-- de reprobar el guardado.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- VERIFICACIÓN FINAL (tras aplicar)
-- ----------------------------------------------------------------------------
-- 1) La policy de lectura debe existir:
--    select policyname, cmd from pg_policies
--    where schemaname='public' and tablename='empresas';
--
-- 2) En la app: recarga → guarda un NIT/dirección → recarga otra vez.
--    [TIRILLA SAVE]  { error: null }              -- guardado OK
--    [TIRILLA FETCH] { data: {nit:"...", ...} }   -- lectura OK (ya no null)
-- ============================================================================
