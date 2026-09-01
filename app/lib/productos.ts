/**
 * Productos — imagen opcional en Supabase Storage.
 *
 * La foto de un producto vive en el bucket público `productos` bajo la ruta
 * `${empresa_id}/${archivo}`. Ese primer segmento NO es decorativo: las políticas
 * de Storage (ver `supabase/2026-08-imagen-productos.sql`) exigen que la primera
 * carpeta de la ruta sea `mi_empresa()`, así que un tenant no puede escribir ni
 * sobrescribir imágenes en la carpeta de otro. La lectura sí es pública, que es
 * lo que permite guardar la URL directa en `productos.imagen_url` y pintarla en
 * el POS sin firmar cada request.
 *
 * La imagen es SIEMPRE opcional: `imagen_url` nulo significa "sin foto" y la UI
 * cae al placeholder de iniciales.
 */

import { supabase, getEmpresaIdActiva } from "./auth";

/** Bucket de Storage donde viven las fotos de producto. */
export const BUCKET_IMAGENES = "productos";

/** Tamaño máximo aceptado (2 MB). El bucket impone el mismo límite en servidor. */
export const MAX_IMAGEN_BYTES = 2 * 1024 * 1024;

/** Formatos aceptados. El bucket impone la misma lista en servidor. */
export const TIPOS_IMAGEN = ["image/png", "image/jpeg", "image/jpg"] as const;

/** Para el atributo `accept` del input de archivo. */
export const ACCEPT_IMAGEN = "image/png,image/jpeg";

/**
 * Valida el archivo antes de gastar red. Devuelve el mensaje de error a mostrar,
 * o `null` si el archivo es aceptable.
 */
export function validarImagen(file: File): string | null {
  if (!TIPOS_IMAGEN.includes(file.type as (typeof TIPOS_IMAGEN)[number])) {
    return "La imagen debe ser PNG o JPG.";
  }
  if (file.size > MAX_IMAGEN_BYTES) {
    return "La imagen no puede pesar más de 2 MB.";
  }
  return null;
}

/** Extensión a partir del MIME (no del nombre, que el usuario controla). */
function extension(file: File): string {
  return file.type === "image/png" ? "png" : "jpg";
}

/**
 * Sube la imagen de un producto y devuelve su URL pública.
 *
 * El nombre del archivo se genera aquí (timestamp + aleatorio) en vez de reusar
 * el del usuario: evita colisiones, caracteres raros en la ruta y que un nombre
 * malicioso intente escapar de la carpeta de la empresa.
 *
 * Lanza `Error` con un mensaje presentable si el archivo no pasa la validación,
 * no hay empresa resoluble o Storage rechaza la subida.
 */
export async function subirImagenProducto(file: File): Promise<string> {
  const invalido = validarImagen(file);
  if (invalido) throw new Error(invalido);

  const empresaId = await getEmpresaIdActiva();
  if (!empresaId) {
    throw new Error(
      "Tu usuario no tiene una empresa asignada, así que no se puede subir la imagen.",
    );
  }

  const nombre = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension(file)}`;
  const ruta = `${empresaId}/${nombre}`;

  const { error } = await supabase.storage.from(BUCKET_IMAGENES).upload(ruta, file, {
    contentType: file.type,
    // Ruta nueva en cada subida → nunca hay que sobrescribir.
    upsert: false,
  });

  if (error) {
    throw new Error(`No se pudo subir la imagen: ${error.message}`);
  }

  const { data } = supabase.storage.from(BUCKET_IMAGENES).getPublicUrl(ruta);
  return data.publicUrl;
}
