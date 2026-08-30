"use client";

import { useRouter } from "next/navigation";
import { clearSession } from "../lib/auth";

/**
 * Pantalla "sin acceso": destino del proxy cuando un empleado no tiene ningún
 * permiso que le habilite alguna ruta (o intenta entrar a una zona prohibida y
 * su ruta de inicio coincide con la actual). No expone datos; solo explica y
 * ofrece cerrar sesión. El aislamiento real lo siguen imponiendo RLS y la API.
 */
export default function SinAccesoPage() {
  const router = useRouter();

  function salir() {
    clearSession();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-black px-4 text-zinc-100">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-violet-500/15 bg-zinc-950/60 p-8 text-center shadow-[0_0_40px_-12px_rgba(139,92,246,0.5)]">
        <h1 className="text-xl font-semibold">Sin acceso</h1>
        <p className="text-sm text-zinc-400">
          Tu cuenta no tiene permisos asignados para ninguna sección. Pídele a tu
          administrador que te habilite los módulos que necesites (por ejemplo, el
          POS).
        </p>
        <button
          onClick={salir}
          className="rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-900"
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
