"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { saveSession, signIn } from "../lib/auth";

/**
 * Pantalla de acceso. Autentica contra Supabase (`signIn`), consulta el rol en
 * la tabla `usuarios` y guarda la sesión (cookie + cookie de rol para el proxy).
 * Luego redirige: 'super_admin' → /admin; cualquier otro rol → dashboard (/).
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError("Ingresa correo y contraseña.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const { rol } = await signIn(email.trim(), password);
      // Escribe cookie de sesión + cookie de rol (esta última la lee el proxy).
      saveSession(email.trim(), rol);
      const destino = rol === "super_admin" ? "/admin" : "/";
      router.push(destino);
      router.refresh();
    } catch (err) {
      // DIAGNÓSTICO: imprime el objeto de error COMPLETO de Supabase en la consola
      // del navegador (DevTools) sin ocultarlo tras textos genéricos. Incluye la
      // representación serializada porque los AuthError/PostgrestError no siempre
      // muestran sus campos (code, status, name…) al expandir el objeto en consola.
      console.error("[login] Error crudo al iniciar sesión:", err);
      // Desglose explícito de los campos que Supabase no muestra en `.message`.
      {
        const e = err as { message?: string; status?: number; code?: string; name?: string };
        console.error("[login] message:", e?.message);
        console.error("[login] status:", e?.status);
        console.error("[login] code:", e?.code);
        console.error("[login] name:", e?.name);
      }
      try {
        console.error(
          "[login] Error (JSON):",
          JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}), 2),
        );
      } catch {
        // Objeto no serializable: ya quedó impreso arriba en crudo.
      }
      // Muestra el mensaje EXACTO en la UI (no un texto genérico) para diagnosticar.
      const errorMessage =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err) || "Error desconocido";
      setError(errorMessage);
      setSubmitting(false);
    }
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
              <label htmlFor="email" className="block text-xs font-medium text-zinc-400">
                Correo
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="tu@empresa.com"
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
