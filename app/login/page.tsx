"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { saveSession } from "../lib/auth";

/**
 * Pantalla de acceso. Al enviar el formulario guarda la sesión (cookie + espejo
 * en localStorage vía `saveSession`) y navega al dashboard. El `proxy.ts` se
 * encarga de bloquear el resto de rutas mientras no exista esa cookie.
 *
 * Versión básica: acepta cualquier usuario/contraseña no vacíos (aún no hay
 * backend de credenciales).
 */
export default function LoginPage() {
  const router = useRouter();
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user.trim() || !password.trim()) {
      setError("Ingresa usuario y contraseña.");
      return;
    }
    setError(null);
    setSubmitting(true);
    saveSession(user.trim());
    // Navega al dashboard; el proxy ya verá la cookie recién escrita.
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen">
      {/* Columna Izquierda: marca */}
      <div className="hidden w-1/2 flex-col items-center justify-center bg-gray-950 lg:flex">
        <Image alt="Logotipo de Aether" height={100} priority src="/logo-aether.png" width={300} />
        <p className="mt-6 text-2xl font-semibold text-gray-300">Potencia tu negocio</p>
      </div>

      {/* Columna Derecha: formulario */}
      <div className="flex w-full items-center justify-center bg-black px-4 lg:w-1/2">
        <div className="relative w-full max-w-sm">
          {/* Marca Aether (visible en móvil, donde la columna izquierda se oculta) */}
          <div className="mb-8 flex flex-col items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-lg font-bold text-white shadow-[0_0_24px_-2px_rgba(139,92,246,0.8)]">
              A
            </span>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
              <span className="bg-gradient-to-r from-violet-400 to-fuchsia-400 bg-clip-text text-transparent">
                Aether
              </span>{" "}
              ERP
            </h1>
            <p className="text-sm text-zinc-500">Inicia sesión para continuar</p>
          </div>

          {/* Formulario */}
          <form
            onSubmit={handleSubmit}
            className="space-y-4 rounded-2xl border border-violet-500/15 bg-zinc-950/60 p-6 shadow-[0_0_40px_-12px_rgba(139,92,246,0.5)] backdrop-blur"
          >
            <div className="space-y-1.5">
              <label htmlFor="user" className="block text-xs font-medium text-zinc-400">
                Usuario
              </label>
              <input
                id="user"
                type="text"
                autoComplete="username"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="tu.usuario"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="password" className="block text-xs font-medium text-zinc-400">
                Contraseña
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
            </div>

            {error && (
              <p className="text-xs text-rose-400" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-600 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_0_20px_-4px_rgba(139,92,246,0.8)] transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {submitting ? "Entrando…" : "Entrar"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
