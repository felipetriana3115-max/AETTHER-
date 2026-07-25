"use client";

import type { ReactNode } from "react";

/**
 * Primitivos de UI compartidos por las tarjetas de Configuración. Extraen los
 * mismos strings de clases que ya usa `app/configuracion/page.tsx` (input,
 * botón, toggle) para que las nuevas secciones —empezando por Dispositivos—
 * mantengan la estética cyberpunk sin duplicar Tailwind por todos lados.
 */

// ── Etiqueta de campo ────────────────────────────────────────────────────────

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-zinc-400">
      {children}
    </label>
  );
}

const INPUT_CLASS =
  "w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 transition-colors focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:cursor-not-allowed disabled:opacity-40";

// ── Campo de texto ───────────────────────────────────────────────────────────

type TextFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  type?: "text" | "tel" | "number";
  inputMode?: "text" | "tel" | "numeric";
};

export function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  disabled,
  type = "text",
  inputMode,
}: TextFieldProps) {
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id}
        type={type}
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT_CLASS}
      />
      {hint && <p className="mt-1.5 text-[11px] text-zinc-600">{hint}</p>}
    </div>
  );
}

// ── Área de texto ────────────────────────────────────────────────────────────

export function TextAreaField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  rows = 2,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  rows?: number;
  disabled?: boolean;
}) {
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT_CLASS} resize-none`}
      />
      {hint && <p className="mt-1.5 text-[11px] text-zinc-600">{hint}</p>}
    </div>
  );
}

// ── Selector ─────────────────────────────────────────────────────────────────

export function SelectField<T extends string | number>({
  id,
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: {
  id: string;
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          const parsed = (typeof value === "number" ? Number(raw) : raw) as T;
          onChange(parsed);
        }}
        className={`${INPUT_CLASS} appearance-none`}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={o.value} className="bg-zinc-900">
            {o.label}
          </option>
        ))}
      </select>
      {hint && <p className="mt-1.5 text-[11px] text-zinc-600">{hint}</p>}
    </div>
  );
}

// ── Toggle (switch) ──────────────────────────────────────────────────────────

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-200">{label}</p>
        {description && <p className="mt-0.5 text-xs text-zinc-500">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 ${
          checked ? "bg-violet-600 shadow-[0_0_16px_-3px_rgba(139,92,246,0.9)]" : "bg-zinc-700"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </div>
  );
}

// ── Botones ──────────────────────────────────────────────────────────────────

export function PrimaryButton({
  children,
  onClick,
  type = "button",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-violet-500/30 bg-violet-600/15 px-4 py-2.5 text-sm font-medium text-violet-200 shadow-[0_0_20px_-8px_rgba(139,92,246,0.7)] transition-colors hover:bg-violet-600/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-violet-600/15"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
