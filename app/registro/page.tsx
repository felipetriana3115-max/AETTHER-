"use client";

import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { saveSession, signUpTenant } from "../lib/auth";

/**
 * Alta de tenant. Crea una empresa nueva + su usuario admin vía
 * `signUpTenant`, que pasa los datos de la empresa como metadata del signUp;
 * el trigger `handle_new_user` en Postgres los consume para poblar
 * `empresas` + `usuarios` de forma atómica.
 *
 * Se asume confirmación de correo DESACTIVADA: tras registrar hay sesión
 * inmediata, se escribe la cookie que lee `proxy.ts` y se entra al dashboard.
 */
export default function RegistroPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    nombreComercial: "",
    nit: "",
    tipoNegocio: "retail",
    email: "",
    password: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set =
    (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.nombreComercial.trim() || !form.email.trim() || !form.password.trim()) {
      setError("Empresa, correo y contraseña son obligatorios.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const { needsConfirm } = await signUpTenant({
        email: form.email.trim(),
        password: form.password,
        nombreComercial: form.nombreComercial.trim(),
        nit: form.nit.trim() || undefined,
        tipoNegocio: form.tipoNegocio,
      });
      // Con la confirmación de correo desactivada esto no debería ocurrir,
      // pero lo cubrimos por si el proyecto la reactiva.
      if (needsConfirm) {
        setInfo("Empresa creada. Revisa tu correo para confirmar la cuenta antes de entrar.");
        setSubmitting(false);
        return;
      }
      saveSession(form.email.trim()); // cookie que lee proxy.ts
      router.push("/");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo crear la empresa.");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-black px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-lg font-bold text-white shadow-[0_0_24px_-2px_rgba(139,92,246,0.8)]">
            A
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Crea tu empresa</h1>
          <p className="text-sm text-zinc-500">Empieza con Aether ERP</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-violet-500/15 bg-zinc-950/60 p-6 shadow-[0_0_40px_-12px_rgba(139,92,246,0.5)] backdrop-blur"
        >
          <Field label="Nombre comercial">
            <input
              className={inputCls}
              value={form.nombreComercial}
              onChange={set("nombreComercial")}
              placeholder="Mi Negocio S.A.S"
            />
          </Field>
          <Field label="NIT (opcional)">
            <input className={inputCls} value={form.nit} onChange={set("nit")} placeholder="900123456-7" />
          </Field>
          <Field label="Tipo de negocio">
            <select className={inputCls} value={form.tipoNegocio} onChange={set("tipoNegocio")}>
              <option value="retail">Retail / Tienda</option>
              <option value="restaurante">Restaurante</option>
              <option value="servicios">Servicios</option>
              <option value="general">General</option>
            </select>
          </Field>
          <Field label="Correo del admin">
            <input
              className={inputCls}
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={set("email")}
              placeholder="admin@negocio.com"
            />
          </Field>
          <Field label="Contraseña">
            <input
              className={inputCls}
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={set("password")}
              placeholder="••••••••"
            />
          </Field>

          {error && (
            <p className="text-xs text-rose-400" role="alert">
              {error}
            </p>
          )}
          {info && (
            <p className="text-xs text-emerald-400" role="status">
              {info}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-600 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_0_20px_-4px_rgba(139,92,246,0.8)] transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {submitting ? "Creando…" : "Crear empresa"}
          </button>
        </form>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-zinc-400">{label}</label>
      {children}
    </div>
  );
}
