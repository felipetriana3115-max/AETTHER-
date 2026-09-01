-- ============================================================================
-- Aether ERP — Imagen opcional por producto (columna + bucket de Storage)
-- ----------------------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor DESPUÉS de:
--   · 2026-07-roles-y-rls.sql            (helpers `mi_empresa()` / `mi_rol()`)
--   · 2026-08-rls-productos.sql          (RLS de `public.productos`)
--   · 2026-08-fix-helpers-security-definer.sql
-- Es idempotente (se puede correr varias veces sin efectos secundarios).
--
-- QUÉ AÑADE
-- ---------
-- 1) `public.productos.imagen_url` (TEXT, nullable): URL pública de la foto del
--    producto. NULL = el producto no tiene imagen y la UI cae al placeholder de
--    iniciales del POS. Es OPCIONAL por diseño: ningún flujo existente cambia.
-- 2) El bucket de Storage `productos`, público SOLO en lectura, donde cada
--    empresa escribe únicamente dentro de su carpeta `<empresa_id>/…`.
--
-- AISLAMIENTO MULTI-TENANT
-- ------------------------
-- · Tabla: las políticas de `productos` son a nivel de FILA (`empresa_id =
--   mi_empresa()`), así que cubren automáticamente cualquier columna nueva —
--   incluida `imagen_url`. Abajo se reafirman de forma idempotente para que este
--   script sea autosuficiente, y se reafirman los GRANT a nivel de TABLA (no de
--   columna) para que la columna nueva quede incluida en los privilegios.
-- · Storage: la ruta del objeto es `${empresa_id}/${filename}`, y las políticas de
--   escritura exigen que la PRIMERA carpeta de la ruta sea la empresa del usuario
--   (`(storage.foldername(name))[1] = mi_empresa()::text`). Un tenant no puede
--   subir, sobrescribir ni borrar imágenes en la carpeta de otro.
-- · La LECTURA es pública a propósito: las URLs públicas de Storage son las que
--   se guardan en `imagen_url` y se pintan en el POS sin firmar cada request.
--   No hay dato sensible en una foto de producto y las rutas no son enumerables
--   por un tercero (necesitaría el UUID de la empresa y el nombre del archivo).
-- ============================================================================

begin;

-- ── 1) Columna `imagen_url` en productos ────────────────────────────────────
alter table public.productos
  add column if not exists imagen_url text;

comment on column public.productos.imagen_url is
  'URL pública de la imagen del producto en el bucket de Storage `productos` '
  '(ruta `<empresa_id>/<archivo>`). NULL = sin imagen; la UI usa el placeholder '
  'de iniciales.';

-- ── 2) RLS de productos: reafirmar cobertura para la columna nueva ──────────
-- Las políticas son por fila, no por columna, así que `imagen_url` queda cubierta
-- sin cambios. Lo que sí conviene reafirmar son los privilegios A NIVEL DE TABLA:
-- si alguna vez se otorgaron por lista de columnas, la columna nueva quedaría
-- fuera y el UPDATE fallaría con "permission denied for column imagen_url".
grant select, insert, update, delete on public.productos to authenticated;

-- RLS activa (no-op si ya lo estaba) y políticas reafirmadas tal cual las definió
-- 2026-08-rls-productos.sql, para que este script no dependa de que aquél siga
-- aplicado.
alter table public.productos enable row level security;
alter table public.productos force row level security;

drop policy if exists productos_select_propia on public.productos;
create policy productos_select_propia on public.productos
  for select
  using (empresa_id = public.mi_empresa() or public.mi_rol() = 'super_admin');

drop policy if exists productos_insert_propia on public.productos;
create policy productos_insert_propia on public.productos
  for insert
  with check (empresa_id = public.mi_empresa());

drop policy if exists productos_update_propia on public.productos;
create policy productos_update_propia on public.productos
  for update
  using (empresa_id = public.mi_empresa())
  with check (empresa_id = public.mi_empresa());

drop policy if exists productos_delete_propia on public.productos;
create policy productos_delete_propia on public.productos
  for delete
  using (empresa_id = public.mi_empresa());

commit;

-- ============================================================================
-- 3) BUCKET DE STORAGE `productos`
-- ----------------------------------------------------------------------------
-- Se crea/actualiza el bucket con límite de 2 MB y solo PNG/JPG, los mismos
-- límites que valida el formulario en el cliente (defensa en profundidad: si
-- alguien salta la validación del navegador, Storage rechaza el archivo).
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'productos',
  'productos',
  true,                                             -- lectura pública
  2097152,                                          -- 2 MB
  array['image/png', 'image/jpeg', 'image/jpg']
)
on conflict (id) do update
  set public             = true,
      file_size_limit    = 2097152,
      allowed_mime_types = array['image/png', 'image/jpeg', 'image/jpg'];

-- ── Políticas sobre storage.objects para el bucket `productos` ───────────────
-- NOTA: `storage.objects` ya tiene RLS activa en cualquier proyecto Supabase.
-- Estas sentencias deben ejecutarse desde el SQL Editor del dashboard (rol con
-- privilegios sobre el esquema `storage`). Si diera "must be owner of table
-- objects", crea las mismas políticas desde Storage → Policies en el dashboard.

-- Lectura: pública (anon + authenticated). Habilita las URLs públicas que
-- guardamos en `productos.imagen_url`.
drop policy if exists productos_imagenes_select_publica on storage.objects;
create policy productos_imagenes_select_publica on storage.objects
  for select
  to public
  using (bucket_id = 'productos');

-- Subida: solo dentro de la carpeta de la PROPIA empresa (`<empresa_id>/...`).
drop policy if exists productos_imagenes_insert_propia on storage.objects;
create policy productos_imagenes_insert_propia on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'productos'
    and (storage.foldername(name))[1] = public.mi_empresa()::text
  );

-- Sobrescritura (upsert / reemplazo de foto): mismo confinamiento, y el `with
-- check` impide "mover" un objeto a la carpeta de otro tenant.
drop policy if exists productos_imagenes_update_propia on storage.objects;
create policy productos_imagenes_update_propia on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'productos'
    and (storage.foldername(name))[1] = public.mi_empresa()::text
  )
  with check (
    bucket_id = 'productos'
    and (storage.foldername(name))[1] = public.mi_empresa()::text
  );

-- Borrado: solo imágenes de la propia empresa.
drop policy if exists productos_imagenes_delete_propia on storage.objects;
create policy productos_imagenes_delete_propia on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'productos'
    and (storage.foldername(name))[1] = public.mi_empresa()::text
  );

-- ============================================================================
-- VERIFICACIÓN (ejecutar a mano, opcional)
-- ----------------------------------------------------------------------------
-- 1) Columna creada y nullable:
--    select column_name, data_type, is_nullable
--    from information_schema.columns
--    where table_schema = 'public' and table_name = 'productos'
--      and column_name = 'imagen_url';
--
-- 2) Bucket con sus límites:
--    select id, public, file_size_limit, allowed_mime_types
--    from storage.buckets where id = 'productos';
--
-- 3) Políticas del bucket:
--    select policyname, cmd, roles from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and policyname like 'productos_imagenes%';
--
-- 4) Sanity check de aislamiento (como usuario normal, NO service_role):
--    -- debe devolver solo objetos de tu empresa al intentar escribir; una subida
--    -- a '<otro-uuid>/x.png' debe fallar con "new row violates row-level
--    -- security policy".
--    select public.mi_empresa();
-- ============================================================================
