"use client";

import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { supabase } from "../lib/auth";

/**
 * Panel de superadministrador (/admin).
 *
 * El proxy solo deja entrar a rol 'super_admin'; aun así, cada llamada a la API
 * envía el JWT de Supabase en `Authorization: Bearer <token>` y el servidor
 * revalida el rol antes de actuar (defensa en profundidad).
 *
 *   • Formulario: registra empresa + su usuario admin (Supabase Auth).
 *   • Tabla: lista empresas y alterna su estado ACTIVO/SUSPENDIDO.
 */

type Empresa = {
  id: string;
  nombre?: string | null;
  nit?: string | null;
  tipo_negocio?: string | null;
  estado?: "ACTIVO" | "SUSPENDIDO" | null;
};

/** fetch autenticado: adjunta el access_token de la sesión Supabase. */
async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  return fetch(input, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

export default function AdminPage() {
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const res = await apiFetch("/api/admin/empresas");
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Error al cargar empresas.");
      setEmpresas(json.empresas as Empresa[]);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Error al cargar empresas.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  async function toggleEstado(empresa: Empresa) {
    const siguiente = empresa.estado === "SUSPENDIDO" ? "ACTIVO" : "SUSPENDIDO";
    // Optimista: reflejamos el cambio y revertimos si falla.
    setEmpresas((prev) =>
      prev.map((e) => (e.id === empresa.id ? { ...e, estado: siguiente } : e)),
    );
    const res = await apiFetch("/api/admin/empresas", {
      method: "PATCH",
      body: JSON.stringify({ empresaId: empresa.id, estado: siguiente }),
    });
    if (!res.ok) {
      // Revertir en caso de error.
      setEmpresas((prev) =>
        prev.map((e) => (e.id === empresa.id ? { ...e, estado: empresa.estado } : e)),
      );
      const json = await res.json().catch(() => ({}));
      alert(json.error ?? "No se pudo cambiar el estado.");
    }
  }

  return (
    <div className="min-h-screen bg-black px-4 py-10 text-zinc-100">
      <div className="mx-auto w-full max-w-5xl space-y-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="bg-gradient-to-r from-violet-400 to-fuchsia-400 bg-clip-text text-transparent">
              Superadministrador
            </span>
          </h1>
          <p className="text-sm text-zinc-500">Gestiona las empresas de la plataforma</p>
        </header>

        <NuevaEmpresaForm onCreada={cargar} />

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Empresas</h2>
            <button
              onClick={cargar}
              className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900"
            >
              Actualizar
            </button>
          </div>

          {listError && (
            <p className="text-sm text-rose-400" role="alert">
              {listError}
            </p>
          )}

          <div className="overflow-hidden rounded-2xl border border-violet-500/15 bg-zinc-950/60">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-3">Empresa</th>
                  <th className="px-4 py-3">NIT</th>
                  <th className="px-4 py-3">Tipo</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3 text-right">Acción</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                      Cargando…
                    </td>
                  </tr>
                ) : empresas.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                      Aún no hay empresas registradas.
                    </td>
                  </tr>
                ) : (
                  empresas.map((e) => (
                    <tr key={e.id} className="border-b border-zinc-900 last:border-0">
                      <td className="px-4 py-3 font-medium">{e.nombre ?? "—"}</td>
                      <td className="px-4 py-3 text-zinc-400">{e.nit ?? "—"}</td>
                      <td className="px-4 py-3 text-zinc-400">{e.tipo_negocio ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            e.estado === "SUSPENDIDO"
                              ? "rounded-full bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-400"
                              : "rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400"
                          }
                        >
                          {e.estado ?? "ACTIVO"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => toggleEstado(e)}
                          className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900"
                        >
                          {e.estado === "SUSPENDIDO" ? "Activar" : "Suspender"}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

// ── Formulario de alta ───────────────────────────────────────────────────────
function NuevaEmpresaForm({ onCreada }: { onCreada: () => void }) {
  const [form, setForm] = useState({
    nombreComercial: "",
    nit: "",
    tipoNegocio: "retail",
    email: "",
    password: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set =
    (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setOk(null);
    if (!form.nombreComercial.trim() || !form.email.trim() || !form.password.trim()) {
      setError("Empresa, correo y contraseña son obligatorios.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch("/api/admin/empresas", {
        method: "POST",
        body: JSON.stringify({
          email: form.email.trim(),
          password: form.password,
          nombreComercial: form.nombreComercial.trim(),
          nit: form.nit.trim() || undefined,
          tipoNegocio: form.tipoNegocio,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo crear la empresa.");
      setOk(`Empresa "${form.nombreComercial.trim()}" creada.`);
      setForm({ nombreComercial: "", nit: "", tipoNegocio: "retail", email: "", password: "" });
      onCreada();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo crear la empresa.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-2xl border border-violet-500/15 bg-zinc-950/60 p-6 shadow-[0_0_40px_-12px_rgba(139,92,246,0.5)]">
      <h2 className="mb-4 text-lg font-semibold">Registrar empresa</h2>
      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        <div className="hidden sm:block" />
        <Field label="Correo del admin">
          <input
            className={inputCls}
            type="email"
            autoComplete="off"
            value={form.email}
            onChange={set("email")}
            placeholder="admin@negocio.com"
          />
        </Field>
        <Field label="Contraseña inicial">
          <input
            className={inputCls}
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={set("password")}
            placeholder="••••••••"
          />
        </Field>

        <div className="sm:col-span-2 space-y-3">
          {error && (
            <p className="text-xs text-rose-400" role="alert">
              {error}
            </p>
          )}
          {ok && (
            <p className="text-xs text-emerald-400" role="status">
              {ok}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-600 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_0_20px_-4px_rgba(139,92,246,0.8)] transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {submitting ? "Creando…" : "Crear empresa + admin"}
          </button>
        </div>
      </form>
    </section>
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
