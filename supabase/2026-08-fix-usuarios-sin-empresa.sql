-- ============================================================================
-- Aether ERP — FIX: usuarios-tenant SIN empresa (causa real del RLS en productos)
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor. Idempotente (se puede correr varias veces).
--
-- SÍNTOMA QUE RESUELVE
-- --------------------
-- Al guardar un producto con una cuenta de EMPRESA (no el super_admin):
--   new row violates row-level security policy for table "productos"
--
-- CAUSA RAÍZ (NO es la política — la política está bien)
-- -----------------------------------------------------
-- El flujo es correcto de punta a punta:
--   • ProductForm envía el payload SIN empresa_id.
--   • productos.empresa_id tiene DEFAULT public.mi_empresa().
--   • La policy INSERT exige  with check (empresa_id = public.mi_empresa()).
--   • mi_empresa()/mi_rol() ya son SECURITY DEFINER.
-- El INSERT falla porque, para ESTE usuario, `public.mi_empresa()` devuelve NULL:
-- su fila en public.usuarios tiene empresa_id = NULL (o directamente NO existe
-- fila en public.usuarios). Entonces el DEFAULT estampa empresa_id = NULL y el
-- check evalúa  NULL = NULL  → NULL → se trata como FALSO → INSERT denegado.
--
-- Esto le pasa a cuentas creadas ANTES de que existiera el trigger
-- handle_new_user (2026-07-ampliar-empresas.sql), o si ese trigger falló: nunca
-- se les creó su empresa ni se enlazó empresa_id.
--
-- ⚠️  NO relajamos la RLS de productos: dejar pasar empresa_id NULL crearía
-- productos HUÉRFANOS visibles/mezclados entre tenants (la fuga que cerró
-- 2026-08-rls-productos.sql). La cura correcta es darle a cada usuario-tenant la
-- empresa que le corresponde, replicando lo que handle_new_user debió hacer.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) DIAGNÓSTICO (opcional, ejecutar a mano ANTES de reparar)
-- ----------------------------------------------------------------------------
-- IMPORTANTE: el SQL Editor corre como postgres/service_role, así que
-- `select public.mi_empresa()` aquí devuelve NULL SIEMPRE (no hay auth.uid()).
-- Para ver la empresa de un usuario concreto, consúltalo por su fila:
--
--   -- a) Usuarios-tenant SIN empresa (estos son los que fallan al crear productos):
--   select id, email, rol, empresa_id
--   from public.usuarios
--   where rol <> 'super_admin' and empresa_id is null;
--
--   -- b) Cuentas en Auth que NO tienen fila en public.usuarios (trigger no corrió):
--   select au.id, au.email
--   from auth.users au
--   left join public.usuarios u on u.id = au.id
--   where u.id is null;

begin;

-- ----------------------------------------------------------------------------
-- 1) Backfill de filas de `usuarios` que faltan (cuentas previas al trigger).
--    Crea, para cada auth.user sin perfil (salvo el super_admin), su empresa a
--    partir de la metadata + su fila en usuarios como 'empresa_admin'. Es la
--    misma lógica de handle_new_user, aplicada en lote y de forma idempotente.
-- ----------------------------------------------------------------------------
do $$
declare
  r            record;
  v_empresa_id uuid;
  v_nombre     text;
begin
  for r in
    select au.id, au.email, au.raw_user_meta_data as meta
    from auth.users au
    left join public.usuarios u on u.id = au.id
    where u.id is null
      and au.email is distinct from 'felipetriana3115@gmail.com'  -- el super_admin va sin empresa
  loop
    v_nombre := coalesce(
      nullif(trim(r.meta->>'nombre_comercial'), ''),
      nullif(split_part(r.email, '@', 1), ''),
      'Empresa sin nombre'
    );

    insert into public.empresas (nombre, tipo_negocio, nit, moneda)
    values (
      v_nombre,
      coalesce(nullif(trim(r.meta->>'tipo_negocio'), ''), 'general'),
      nullif(trim(r.meta->>'nit'), ''),
      coalesce(nullif(trim(r.meta->>'moneda'), ''), 'COP')
    )
    returning id into v_empresa_id;

    insert into public.usuarios (id, email, rol, empresa_id, nombre_comercial)
    values (r.id, r.email, 'empresa_admin', v_empresa_id, v_nombre)
    on conflict (id) do nothing;

    raise notice 'Perfil creado para % con empresa %', r.email, v_empresa_id;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 2) Backfill de empresa para usuarios-tenant que YA tienen fila pero con
--    empresa_id NULL. Se les crea su propia empresa y se enlaza. Nunca toca al
--    super_admin (debe seguir con empresa_id = NULL: no es un tenant).
-- ----------------------------------------------------------------------------
do $$
declare
  r            record;
  v_empresa_id uuid;
  v_nombre     text;
begin
  for r in
    select u.id, u.email, u.nombre_comercial
    from public.usuarios u
    where u.rol <> 'super_admin'
      and u.empresa_id is null
  loop
    v_nombre := coalesce(
      nullif(trim(r.nombre_comercial), ''),
      nullif(split_part(r.email, '@', 1), ''),
      'Empresa sin nombre'
    );

    insert into public.empresas (nombre, tipo_negocio, moneda)
    values (v_nombre, 'general', 'COP')
    returning id into v_empresa_id;

    update public.usuarios
    set empresa_id = v_empresa_id
    where id = r.id;

    raise notice 'Empresa % asignada a %', v_empresa_id, r.email;
  end loop;
end $$;

commit;

-- ============================================================================
-- VERIFICACIÓN (ejecutar a mano tras aplicar)
-- ----------------------------------------------------------------------------
-- 1) Ya NO debe quedar ningún usuario-tenant sin empresa (0 filas):
--    select id, email, rol, empresa_id
--    from public.usuarios
--    where rol <> 'super_admin' and empresa_id is null;
--
-- 2) Toda cuenta de Auth debe tener perfil (0 filas):
--    select au.id, au.email
--    from auth.users au
--    left join public.usuarios u on u.id = au.id
--    where u.id is null;
--
-- 3) Cierra sesión y vuelve a entrar con la cuenta que fallaba (para refrescar
--    el JWT/sesión) y prueba a crear el producto: el INSERT ya debe pasar.
--
-- NOTA — si el usuario debía pertenecer a una empresa YA EXISTENTE (no a una
-- nueva), en lugar de este backfill automático enlázalo a mano:
--    update public.usuarios set empresa_id = '<uuid-de-la-empresa>'
--    where email = 'usuario@tenant.com';
-- y borra la empresa vacía que este script le haya creado, si aplica.
-- ============================================================================
