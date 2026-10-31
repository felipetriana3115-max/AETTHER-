"use client";

import { useEffect, useState } from "react";
import { supabase } from "../../lib/auth";
import { FieldLabel, PrimaryButton } from "./primitives";

/**
 * Cambio de contraseña del usuario AUTENTICADO.
 *
 * Seguridad:
 *  • Se usa exclusivamente la API de Supabase Auth (`auth.updateUser`), que actúa
 *    sobre `auth.users` con el JWT de la sesión. NO se toca `public.usuarios` ni
 *    ninguna política RLS: un usuario solo puede cambiar SU propia contraseña,
 *    porque el servidor la deriva del token, no de un id que mande el cliente.
 *  • `updateUser({ password })` NO pide la contraseña actual, así que antes
 *    REAUTENTICAMOS con `signInWithPassword` usando el correo de la sesión viva.
 *    Así una sesión abierta y desatendida no basta para secuestrar la cuenta.
 *    Un intento fallido no invalida la sesión actual; uno correcto la renueva
 *    para el MISMO usuario, así que el tenant y los permisos no cambian.
 *  • El `empresa_id` del usuario no interviene: la contraseña es de la identidad
 *    en Auth, no del tenant, de modo que el multi-tenant queda intacto.
 */

/** Mínimo de Supabase por defecto; se valida también en el servidor. */
const MIN_LEN = 8;

type Estado = { tone: "error" | "ok"; msg: string } | null;

export default function PasswordSection() {
  const [email, setEmail] = useState<string | null>(null);
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [verPass, setVerPass] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [estado, setEstado] = useState<Estado>(null);

  // Correo de la sesión viva: es el que se usa para reautenticar. Se lee tras
  // montar (el servidor no tiene la sesión del navegador).
  useEffect(() => {
    let activo = true;
    void supabase.auth.getUser().then(({ data }) => {
      if (activo) setEmail(data.user?.email ?? null);
    });
    return () => {
      activo = false;
    };
  }, []);

  const coinciden = nueva !== "" && nueva === confirmacion;
  const largoOk = nueva.length >= MIN_LEN;
  const distinta = nueva !== actual;
  const puedeGuardar =
    !guardando && email !== null && actual !== "" && largoOk && coinciden && distinta;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeGuardar || !email) return;

    setGuardando(true);
    setEstado(null);
    try {
      // 1) Reautenticación: verifica que quien está al teclado conoce la actual.
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password: actual,
      });
      if (authError) {
        setEstado({ tone: "error", msg: "La contraseña actual no es correcta." });
        return;
      }

      // 2) Cambio efectivo sobre la identidad de la sesión.
      const { error } = await supabase.auth.updateUser({ password: nueva });
      if (error) {
        setEstado({
          tone: "error",
          msg: error.message || "No se pudo actualizar la contraseña.",
        });
        return;
      }

      setActual("");
      setNueva("");
      setConfirmacion("");
      setEstado({
        tone: "ok",
        msg: "Contraseña actualizada. Úsala en tu próximo inicio de sesión.",
      });
    } catch (err) {
      setEstado({
        tone: "error",
        msg: err instanceof Error ? err.message : "No se pudo actualizar la contraseña.",
      });
    } finally {
      setGuardando(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 transition-colors focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <section className="relative overflow-hidden rounded-xl border border-violet-500/15 bg-zinc-900/50 p-6">
      <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-violet-600/10 blur-3xl" />

      <div className="relative flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-300 ring-1 ring-violet-500/20">
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </span>
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Cambiar contraseña</h3>
          <p className="mt-1 max-w-md text-xs text-zinc-500">
            {email
              ? `Actualiza la clave de acceso de ${email}. Te pediremos la contraseña actual para confirmar que eres tú.`
              : "Actualiza tu clave de acceso. Te pediremos la contraseña actual para confirmar que eres tú."}
          </p>
        </div>
      </div>

      <form className="relative mt-6 space-y-4" onSubmit={handleSubmit}>
        {/* Campo oculto con el correo: ayuda a los gestores de contraseñas a
            asociar el cambio con la cuenta correcta. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={email ?? ""}
          readOnly
          hidden
        />

        <div>
          <FieldLabel htmlFor="password-actual">Contraseña actual</FieldLabel>
          <input
            id="password-actual"
            type={verPass ? "text" : "password"}
            autoComplete="current-password"
            value={actual}
            disabled={guardando}
            onChange={(e) => setActual(e.target.value)}
            placeholder="••••••••"
            className={inputClass}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="password-nueva">Nueva contraseña</FieldLabel>
            <input
              id="password-nueva"
              type={verPass ? "text" : "password"}
              autoComplete="new-password"
              value={nueva}
              disabled={guardando}
              onChange={(e) => setNueva(e.target.value)}
              placeholder="••••••••"
              className={inputClass}
            />
            {nueva !== "" && !largoOk && (
              <p className="mt-1.5 text-xs text-red-400">
                Debe tener al menos {MIN_LEN} caracteres.
              </p>
            )}
            {largoOk && !distinta && (
              <p className="mt-1.5 text-xs text-red-400">
                La nueva contraseña debe ser distinta de la actual.
              </p>
            )}
          </div>

          <div>
            <FieldLabel htmlFor="password-confirmacion">Confirmar nueva contraseña</FieldLabel>
            <input
              id="password-confirmacion"
              type={verPass ? "text" : "password"}
              autoComplete="new-password"
              value={confirmacion}
              disabled={guardando}
              onChange={(e) => setConfirmacion(e.target.value)}
              placeholder="••••••••"
              className={inputClass}
            />
            {confirmacion !== "" && !coinciden && (
              <p className="mt-1.5 text-xs text-red-400">Las contraseñas no coinciden.</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={verPass}
              onChange={(e) => setVerPass(e.target.checked)}
              className="h-3.5 w-3.5 accent-violet-500"
            />
            Mostrar contraseñas
          </label>

          <PrimaryButton type="submit" disabled={!puedeGuardar}>
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
              <path d="M17 21v-8H7v8" />
              <path d="M7 3v5h8" />
            </svg>
            {guardando ? "Actualizando…" : "Actualizar contraseña"}
          </PrimaryButton>
        </div>

        {estado && (
          <p
            role="status"
            className={`text-xs ${estado.tone === "ok" ? "text-emerald-400" : "text-red-400"}`}
          >
            {estado.msg}
          </p>
        )}
      </form>
    </section>
  );
}
