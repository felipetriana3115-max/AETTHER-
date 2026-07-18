/**
 * Cliente Supabase con `service_role` — SOLO servidor.
 *
 * La `service_role key` salta RLS y habilita el namespace `auth.admin`
 * (crear usuarios sin desloguear a nadie). NUNCA debe llegar al navegador:
 * por eso vive en una variable SIN el prefijo `NEXT_PUBLIC_` y este módulo
 * solo se importa desde Route Handlers (código server).
 *
 * Se instancia de forma perezosa para no romper el build si la variable no
 * está definida en tiempo de pre-render.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let admin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (admin) return admin;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY. " +
        "Añade SUPABASE_SERVICE_ROLE_KEY en .env.local (Supabase → Settings → API → service_role).",
    );
  }

  admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return admin;
}
