"use client";

import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import PageShell from "../components/PageShell";
import { supabase } from "../lib/auth";
import { PERMISOS, PERMISO_LABELS, type Permiso } from "../lib/authz";

/**
 * Gestión de EMPLEADOS del tenant (solo admin de empresa).
 *
 * El proxy ya veta esta ruta a los empleados (RUTAS_SOLO_ADMIN); aun así, cada
 * llamada envía el JWT en Authorization: Bearer y /api/empleados revalida que el
 * llamante sea admin y acota TODO a su empresa (defensa en profundidad).
 *
 *   • Alta: crea el empleado (Supabase Auth) ya enlazado a la empresa del admin.
 *   • Lista: muestra los empleados y sus permisos.
 *   • Edición: alterna permisos por empleado (PATCH), guardado en vivo.
 */

type Empleado = {
  id: string;
  email: string | null;
  nombre_comercial: string | null;
  rol: string;
  permissions: string[] | null;
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

export default function EmpleadosPage() {
  const [empleados, setEmpleados] = useState<Empleado[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const res = await apiFetch("/api/empleados");
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Error al cargar empleados.");
      setEmpleados(json.empleados as Empleado[]);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Error al cargar empleados.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  return (
    <PageShell
      title="Empleados"
      subtitle="Da de alta empleados y controla a qué módulos acceden"
    >
      <div className="mx-auto max-w-4xl space-y-6">
        <NuevoEmpleadoForm onCreado={cargar} />

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-100">Empleados</h2>
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

          {loading ? (
            <p className="rounded-xl border border-violet-500/15 bg-zinc-900/50 px-4 py-8 text-center text-sm text-zinc-500">
              Cargando…
            </p>
          ) : empleados.length === 0 ? (
            <p className="rounded-xl border border-violet-500/15 bg-zinc-900/50 px-4 py-8 text-center text-sm text-zinc-500">
              Aún no has dado de alta ningún empleado.
            </p>
          ) : (
            <ul className="space-y-3">
              {empleados.map((emp) => (
                <EmpleadoCard key={emp.id} empleado={emp} onCambio={cargar} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </PageShell>
  );
}

// ── Tarjeta de empleado con edición de permisos en vivo ──────────────────────
function EmpleadoCard({
  empleado,
  onCambio,
}: {
  empleado: Empleado;
  onCambio: () => void;
}) {
  const [permisos, setPermisos] = useState<Permiso[]>(
    (empleado.permissions ?? []).filter((p): p is Permiso =>
      (PERMISOS as readonly string[]).includes(p),
    ),
  );
  const [saving, setSaving] = useState<Permiso | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(permiso: Permiso) {
    const activo = permisos.includes(permiso);
    const siguiente = activo
      ? permisos.filter((p) => p !== permiso)
      : [...permisos, permiso];
    // Optimista: aplica y revierte si el PATCH falla.
    setPermisos(siguiente);
    setSaving(permiso);
    setError(null);
    try {
      const res = await apiFetch("/api/empleados", {
        method: "PATCH",
        body: JSON.stringify({ empleadoId: empleado.id, permisos: siguiente }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo guardar.");
      onCambio();
    } catch (e) {
      setPermisos(permisos); // revertir
      setError(e instanceof Error ? e.message : "No se pudo guardar.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <li className="rounded-xl border border-violet-500/15 bg-zinc-900/50 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-100">
            {empleado.nombre_comercial?.trim() || empleado.email || "Empleado"}
          </p>
          <p className="truncate text-xs text-zinc-500">{empleado.email}</p>
        </div>
        <span className="rounded-full bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-300">
          Empleado
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {PERMISOS.map((permiso) => {
          const activo = permisos.includes(permiso);
          return (
            <button
              key={permiso}
              type="button"
              disabled={saving === permiso}
              onClick={() => toggle(permiso)}
              aria-pressed={activo}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                activo
                  ? "bg-violet-600/20 text-violet-200 ring-1 ring-inset ring-violet-500/40"
                  : "bg-zinc-800/60 text-zinc-400 ring-1 ring-inset ring-zinc-700 hover:text-zinc-200"
              }`}
            >
              {PERMISO_LABELS[permiso]}
            </button>
          );
        })}
      </div>

      {error && (
        <p className="mt-3 text-xs text-rose-400" role="alert">
          {error}
        </p>
      )}
      {permisos.length === 0 && (
        <p className="mt-3 text-[11px] text-zinc-600">
          Sin permisos: este empleado verá la pantalla “Sin acceso” al entrar.
        </p>
      )}
    </li>
  );
}

// ── Formulario de alta de empleado ───────────────────────────────────────────
function NuevoEmpleadoForm({ onCreado }: { onCreado: () => void }) {
  const [form, setForm] = useState({ nombre: "", email: "", password: "" });
  const [permisos, setPermisos] = useState<Permiso[]>(["pos"]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function togglePermiso(p: Permiso) {
    setPermisos((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setOk(null);
    if (!form.email.trim() || !form.password.trim()) {
      setError("Correo y contraseña son obligatorios.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch("/api/empleados", {
        method: "POST",
        body: JSON.stringify({
          nombre: form.nombre.trim() || undefined,
          email: form.email.trim(),
          password: form.password,
          permisos,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo crear el empleado.");
      setOk(`Empleado "${form.email.trim()}" creado.`);
      setForm({ nombre: "", email: "", password: "" });
      setPermisos(["pos"]);
      onCreado();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo crear el empleado.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-xl border border-violet-500/15 bg-zinc-900/50 p-6 shadow-[0_0_40px_-12px_rgba(139,92,246,0.5)]">
      <h2 className="mb-4 text-lg font-semibold text-zinc-100">Dar de alta un empleado</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-zinc-400">Nombre (opcional)</label>
            <input
              className={inputCls}
              value={form.nombre}
              onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))}
              placeholder="María"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-zinc-400">Correo</label>
            <input
              className={inputCls}
              type="email"
              autoComplete="off"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="empleado@negocio.com"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-zinc-400">Contraseña inicial</label>
            <input
              className={inputCls}
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              placeholder="••••••••"
            />
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">Permisos iniciales</p>
          <div className="flex flex-wrap gap-2">
            {PERMISOS.map((permiso) => {
              const activo = permisos.includes(permiso);
              return (
                <button
                  key={permiso}
                  type="button"
                  onClick={() => togglePermiso(permiso)}
                  aria-pressed={activo}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                    activo
                      ? "bg-violet-600/20 text-violet-200 ring-1 ring-inset ring-violet-500/40"
                      : "bg-zinc-800/60 text-zinc-400 ring-1 ring-inset ring-zinc-700 hover:text-zinc-200"
                  }`}
                >
                  {PERMISO_LABELS[permiso]}
                </button>
              );
            })}
          </div>
        </div>

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
          {submitting ? "Creando…" : "Crear empleado"}
        </button>
      </form>
    </section>
  );
}

const inputCls =
  "w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";
