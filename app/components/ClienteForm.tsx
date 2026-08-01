"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/auth";
import type { Cliente } from "../lib/clientes";

/**
 * Alta/edición de un cliente del CRM.
 *
 * Fuente de verdad: tabla `public.clientes` en Supabase. El aislamiento por
 * empresa lo impone RLS: este formulario NUNCA envía `empresa_id`, lo rellena el
 * DEFAULT `mi_empresa()` del servidor y el `with check` de la política lo valida
 * (mismo patrón que `ventas`/POS). `saldo_pendiente` tampoco se toca aquí: solo lo
 * mueve la RPC `registrar_fiado` desde el panel de fiados.
 */

type Props = {
  /** Si viene, el formulario edita ese cliente; si no, da de alta uno nuevo. */
  cliente?: Cliente;
  /** Se invoca tras guardar con éxito (para refrescar el directorio del padre). */
  onSaved?: (c: Cliente) => void;
  /** Se invoca al cancelar (cerrar el modal del padre). */
  onCancel?: () => void;
};

type FormState = {
  nombre: string;
  email: string;
  telefono: string;
  direccion: string;
  notas: string;
};

const INPUT =
  "w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";
const LABEL = "mb-1.5 block text-xs font-medium text-zinc-400";

function toFormState(c?: Cliente): FormState {
  return {
    nombre: c?.nombre ?? "",
    email: c?.email ?? "",
    telefono: c?.telefono ?? "",
    direccion: c?.direccion ?? "",
    notas: c?.notas ?? "",
  };
}

export default function ClienteForm({ cliente, onSaved, onCancel }: Props) {
  const editando = cliente != null;
  const [form, setForm] = useState<FormState>(() => toFormState(cliente));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Si el padre reusa el form para otro cliente, resincronizamos el estado.
  useEffect(() => {
    setForm(toFormState(cliente));
  }, [cliente]);

  const set = useCallback(
    (campo: keyof FormState) =>
      (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const value = e.target.value;
        setForm((f) => ({ ...f, [campo]: value }));
      },
    [],
  );

  const guardar = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      const nombre = form.nombre.trim();
      if (!nombre) {
        setError("El nombre es obligatorio.");
        return;
      }

      // Payload SIN empresa_id ni saldo_pendiente: el primero lo estampa el DEFAULT
      // mi_empresa() (validado por RLS); el segundo solo lo mueve registrar_fiado.
      const payload = {
        nombre,
        email: form.email.trim() || null,
        telefono: form.telefono.trim() || null,
        direccion: form.direccion.trim() || null,
        notas: form.notas.trim() || null,
      };

      setGuardando(true);
      try {
        const query = editando
          ? supabase.from("clientes").update(payload).eq("id", cliente!.id)
          : supabase.from("clientes").insert(payload);

        const { data, error } = await query
          .select("id, nombre, email, telefono, direccion, notas, saldo_pendiente, created_at")
          .single();

        if (error) {
          console.error("[ClienteForm] No se pudo guardar el cliente:", error);
          setError(`No se pudo guardar: ${error.message}`);
          return;
        }

        const row = data as {
          id: string;
          nombre: string;
          email: string | null;
          telefono: string | null;
          direccion: string | null;
          notas: string | null;
          saldo_pendiente: number | string | null;
          created_at: string;
        };
        onSaved?.({ ...row, saldo_pendiente: Number(row.saldo_pendiente ?? 0) });
        if (!editando) setForm(toFormState());
      } finally {
        setGuardando(false);
      }
    },
    [form, editando, cliente, onSaved],
  );

  return (
    <form onSubmit={guardar} className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300"
        >
          {error}
        </div>
      )}

      <div>
        <label htmlFor="cf-nombre" className={LABEL}>
          Nombre *
        </label>
        <input
          id="cf-nombre"
          value={form.nombre}
          onChange={set("nombre")}
          placeholder="Ej. María Gómez"
          className={INPUT}
          autoFocus
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="cf-telefono" className={LABEL}>
            Teléfono
          </label>
          <input
            id="cf-telefono"
            inputMode="tel"
            value={form.telefono}
            onChange={set("telefono")}
            placeholder="300 123 4567"
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="cf-email" className={LABEL}>
            Correo electrónico
          </label>
          <input
            id="cf-email"
            type="email"
            value={form.email}
            onChange={set("email")}
            placeholder="cliente@correo.com"
            className={INPUT}
          />
        </div>
      </div>

      <div>
        <label htmlFor="cf-direccion" className={LABEL}>
          Dirección
        </label>
        <input
          id="cf-direccion"
          value={form.direccion}
          onChange={set("direccion")}
          placeholder="Calle 10 # 5-20, barrio…"
          className={INPUT}
        />
      </div>

      <div>
        <label htmlFor="cf-notas" className={LABEL}>
          Notas
        </label>
        <textarea
          id="cf-notas"
          value={form.notas}
          onChange={set("notas")}
          rows={2}
          placeholder="Datos de contacto adicionales, preferencias, referencias…"
          className={`${INPUT} resize-none`}
        />
      </div>

      <div className="flex gap-2.5 pt-1">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="h-11 flex-1 rounded-lg border border-zinc-700 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            Cancelar
          </button>
        )}
        <button
          type="submit"
          disabled={guardando}
          className="h-11 flex-1 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-600 text-sm font-semibold text-white shadow-lg shadow-violet-500/30 transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {guardando ? "Guardando…" : editando ? "Guardar cambios" : "Agregar cliente"}
        </button>
      </div>
    </form>
  );
}
