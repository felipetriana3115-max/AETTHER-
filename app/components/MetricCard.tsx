import type { ReactNode } from "react";

type MetricCardProps = {
  label: string;
  value: string;
  /** Variación vs. periodo anterior, p. ej. "+12.5%". */
  delta?: string;
  /** true = la variación es buena (verde), false = mala (rojo). */
  deltaGood?: boolean;
  deltaCaption?: string;
  icon: ReactNode;
  /** Tinte del ícono, útil para resaltar alertas. */
  tone?: "violet" | "emerald" | "amber" | "fuchsia";
};

const toneClasses: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  violet: "bg-violet-500/10 text-violet-400 ring-1 ring-violet-500/20",
  emerald: "bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20",
  amber: "bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20",
  fuchsia: "bg-fuchsia-500/10 text-fuchsia-400 ring-1 ring-fuchsia-500/20",
};

export default function MetricCard({
  label,
  value,
  delta,
  deltaGood = true,
  deltaCaption = "vs. mes anterior",
  icon,
  tone = "violet",
}: MetricCardProps) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-5 transition-all duration-300 hover:border-violet-500/40 hover:shadow-[0_0_30px_-10px_rgba(139,92,246,0.45)]">
      {/* Glow morado sutil (cyberpunk) */}
      <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-violet-600/10 blur-2xl transition-opacity duration-300 group-hover:bg-violet-500/20" />

      <div className="relative flex items-start justify-between">
        <p className="text-sm font-medium text-zinc-400">{label}</p>
        <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${toneClasses[tone]}`}>
          <span className="h-5 w-5">{icon}</span>
        </span>
      </div>

      <p className="relative mt-3 text-3xl font-semibold tracking-tight text-zinc-50">{value}</p>

      {delta && (
        <div className="relative mt-2 flex items-center gap-1.5 text-xs">
          <span
            className={`inline-flex items-center gap-0.5 font-medium ${
              deltaGood ? "text-emerald-400" : "text-red-400"
            }`}
          >
            <svg
              className={`h-3.5 w-3.5 ${deltaGood ? "" : "rotate-180"}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7 17V7h10" />
              <path d="M7 7l10 10" />
            </svg>
            {delta}
          </span>
          <span className="text-zinc-500">{deltaCaption}</span>
        </div>
      )}
    </div>
  );
}
