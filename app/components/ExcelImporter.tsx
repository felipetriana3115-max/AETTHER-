"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDashboard, type BulkImportResult } from "./DashboardProvider";
import { parseFilesToBundle } from "../lib/import-excel";

type Status =
  | { kind: "idle" }
  | { kind: "loading"; fileName: string } // un solo archivo → importación rápida
  | { kind: "processing"; files: string[]; message: string } // ≥2 archivos → carga masiva
  | { kind: "success"; fileName: string; result: BulkImportResult; unknown: string[] }
  | { kind: "bulkSuccess"; files: string[]; result: BulkImportResult; unknown: string[] }
  | { kind: "error"; message: string };

const VALID_EXT = ["xlsx", "xls", "csv"];

// Textos rápidos de la animación cyberpunk (uno cada ~500 ms hasta completar 2 s).
const BULK_MESSAGES = [
  "Analizando estructuras de archivos adjuntos…",
  "Distribuyendo base de datos de Clientes al CRM…",
  "Sincronizando SKU e Inventario…",
  "Consolidando registros en el módulo de Ventas…",
];

function extOf(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** Resumen legible de lo distribuido, para el toast global. */
function describe(r: BulkImportResult): string {
  const parts: string[] = [];
  if (r.products) parts.push(`${r.products} producto${r.products === 1 ? "" : "s"}`);
  if (r.customers) parts.push(`${r.customers} cliente${r.customers === 1 ? "" : "s"}`);
  if (r.sales) parts.push(`${r.sales} venta${r.sales === 1 ? "" : "s"}`);
  if (r.purchases) parts.push(`${r.purchases} compra${r.purchases === 1 ? "" : "s"}`);
  return parts.length ? `Distribuido en el ERP: ${parts.join(" · ")}.` : "Sin registros nuevos.";
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function ExcelImporter() {
  const { bulkImport, showToast } = useDashboard();
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const timers = useRef<number[]>([]);

  // Limpia los temporizadores pendientes si el componente se desmonta.
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((id) => clearTimeout(id));
  }, []);

  // ── Importación de UN archivo (rápida) ─────────────────────────────────────
  const processSingle = useCallback(
    async (file: File) => {
      setStatus({ kind: "loading", fileName: file.name });

      const [report] = await Promise.all([parseFilesToBundle([file]), delay(1100)]);
      const total =
        report.matched.inventory +
        report.matched.customers +
        report.matched.sales +
        report.matched.purchases;

      if (total === 0) {
        setStatus({
          kind: "error",
          message:
            "No se reconocieron columnas válidas. Usa encabezados como Producto/Stock/Precio, Cliente/Email o Cliente/Monto/Estado.",
        });
        return;
      }

      const result = await bulkImport(report.bundle);
      setStatus({ kind: "success", fileName: file.name, result, unknown: report.unknownSheets });
      showToast("Importación exitosa", describe(result));
    },
    [bulkImport, showToast],
  );

  // ── Carga MASIVA de ≥2 archivos (animación cyberpunk de 2 s) ───────────────
  const runBulk = useCallback(
    async (files: File[]) => {
      timers.current.forEach((id) => clearTimeout(id));
      timers.current = [];

      const names = files.map((f) => f.name);
      setStatus({ kind: "processing", files: names, message: BULK_MESSAGES[0] });

      // Rotación rápida de textos: 0.5 s, 1.0 s, 1.5 s.
      for (let i = 1; i < BULK_MESSAGES.length; i++) {
        const id = window.setTimeout(() => {
          setStatus((prev) =>
            prev.kind === "processing" ? { ...prev, message: BULK_MESSAGES[i] } : prev,
          );
        }, i * 500);
        timers.current.push(id);
      }

      // Espera el parseo real Y un mínimo de 2 s de animación.
      const [report] = await Promise.all([parseFilesToBundle(files), delay(2000)]);
      const total =
        report.matched.inventory +
        report.matched.customers +
        report.matched.sales +
        report.matched.purchases;

      if (total === 0) {
        setStatus({
          kind: "error",
          message: "No se reconocieron columnas válidas en los archivos adjuntos.",
        });
        return;
      }

      const result = await bulkImport(report.bundle);
      setStatus({ kind: "bulkSuccess", files: names, result, unknown: report.unknownSheets });
      showToast("Procesamiento masivo exitoso", describe(result));
    },
    [bulkImport, showToast],
  );

  // ── Enrutador de archivos ──────────────────────────────────────────────────
  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);
      const valid = files.filter((f) => VALID_EXT.includes(extOf(f.name)));

      if (valid.length === 0) {
        setStatus({ kind: "error", message: "Formato no válido. Usa .xlsx, .xls o .csv" });
        return;
      }

      if (valid.length >= 2) {
        void runBulk(valid);
      } else {
        void processSingle(valid[0]);
      }
    },
    [processSingle, runBulk],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const busy = status.kind === "loading" || status.kind === "processing";
  const activeStep =
    status.kind === "processing" ? Math.max(0, BULK_MESSAGES.indexOf(status.message)) : -1;

  return (
    <div className="relative overflow-hidden rounded-xl border border-violet-500/20 bg-zinc-900/50 p-6">
      <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-fuchsia-600/10 blur-3xl" />

      <div className="relative mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Carga masiva de datos</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            Adjunta uno o varios <span className="text-violet-300">.xlsx</span>,{" "}
            <span className="text-violet-300">.xls</span> o <span className="text-violet-300">.csv</span>{" "}
            (Clientes, Ventas, Inventario…) y se distribuyen automáticamente por todo el ERP.
          </p>
        </div>
        <span className="hidden rounded-md border border-violet-500/20 bg-violet-500/10 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-violet-300 sm:block">
          Multi-fuente
        </span>
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !busy) inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging
            ? "border-fuchsia-500 bg-fuchsia-500/5"
            : "border-zinc-700 hover:border-violet-500/60 hover:bg-violet-500/5"
        } ${busy ? "pointer-events-none" : ""}`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {status.kind === "processing" ? (
          <div className="w-full max-w-md">
            {/* Núcleo de escaneo */}
            <div className="relative mx-auto mb-4 flex h-14 w-14 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-fuchsia-500/30" />
              <span className="absolute inset-0 animate-spin rounded-full border-2 border-violet-500/30 border-t-fuchsia-400" />
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-[0_0_20px_-2px_rgba(217,70,239,0.9)]">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12h4l3 8 4-16 3 8h4" />
                </svg>
              </span>
            </div>

            {/* Chips de archivos adjuntos */}
            <div className="mb-3 flex flex-wrap items-center justify-center gap-1.5">
              {status.files.map((f) => (
                <span
                  key={f}
                  className="inline-flex items-center gap-1 rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-200"
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                    <path d="M14 2v6h6" />
                  </svg>
                  {f}
                </span>
              ))}
            </div>

            {/* Texto dinámico */}
            <p className="min-h-[1.25rem] bg-gradient-to-r from-violet-300 to-fuchsia-300 bg-clip-text text-sm font-medium text-transparent">
              {status.message}
            </p>

            {/* Barra de escaneo neón */}
            <div className="relative mt-3 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div className="absolute inset-y-0 w-1/2 animate-[bulkScan_1s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-transparent via-fuchsia-500 to-transparent" />
            </div>

            {/* Pasos */}
            <div className="mt-3 flex items-center justify-center gap-1.5">
              {BULK_MESSAGES.map((m, i) => (
                <span
                  key={m}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i <= activeStep ? "w-6 bg-fuchsia-400" : "w-1.5 bg-zinc-700"
                  }`}
                />
              ))}
            </div>
          </div>
        ) : status.kind === "loading" ? (
          <>
            <svg className="h-8 w-8 animate-spin text-violet-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
            </svg>
            <p className="mt-3 text-sm font-medium text-zinc-200">Procesando “{status.fileName}”…</p>
            <p className="mt-1 text-xs text-zinc-500">Detectando columnas y mapeando al modelo del ERP</p>
          </>
        ) : (
          <>
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/20 to-fuchsia-600/20 text-violet-300 ring-1 ring-violet-500/30">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M17 8l-5-5-5 5" />
                <path d="M12 3v12" />
              </svg>
            </span>
            <p className="mt-3 text-sm font-medium text-zinc-200">
              Arrastra tus archivos aquí o <span className="text-fuchsia-400">búscalos</span>
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              Selección múltiple · .xlsx, .xls o .csv · Clientes · Ventas · Inventario
            </p>
          </>
        )}
      </div>

      {(status.kind === "bulkSuccess" || status.kind === "success") && (
        <div className="relative mt-3 rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-2.5">
          <div className="flex items-center gap-2 text-sm font-medium text-fuchsia-200">
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
            {status.kind === "bulkSuccess"
              ? `${status.files.length} fuentes integradas y distribuidas por el ERP.`
              : `“${status.fileName}” integrado y distribuido por el ERP.`}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 pl-6 text-xs text-fuchsia-300/80">
            {status.result.customers > 0 && <span>{status.result.customers} clientes → CRM</span>}
            {status.result.products > 0 && <span>{status.result.products} SKU → Inventario</span>}
            {status.result.sales > 0 && <span>{status.result.sales} registros → Ventas</span>}
            {status.result.purchases > 0 && <span>{status.result.purchases} órdenes → Compras</span>}
          </div>
          {status.unknown.length > 0 && (
            <p className="mt-1.5 pl-6 text-[11px] text-amber-300/80">
              Hojas no reconocidas (omitidas): {status.unknown.join(", ")}.
            </p>
          )}
        </div>
      )}

      {status.kind === "error" && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          <span>{status.message}</span>
        </div>
      )}
    </div>
  );
}
