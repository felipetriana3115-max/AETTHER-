"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { supabase } from "../lib/auth";

/**
 * Escáner de código de barras reutilizable para el POS.
 *
 * Es un input con `autoFocus`: un lector físico "teclea" los dígitos y cierra con
 * Enter, así que capturamos Enter, buscamos en `public.productos` por
 * `codigo_barras` EXACTO y emitimos el resultado por callback. NO gestiona el
 * carrito: eso es responsabilidad del padre (venta_actual), lo que mantiene el
 * componente desacoplado y reusable (POS, entradas de inventario, etc.).
 *
 * El aislamiento por empresa lo impone RLS (`empresa_id = public.mi_empresa()`),
 * así que la consulta NO filtra por tenant en el cliente: con sesión activa solo
 * devuelve productos de la empresa del usuario.
 */

/**
 * Handle imperativo que el componente expone por `ref`. Permite al padre (p. ej.
 * el POS tras cobrar) devolver el foco al escáner sin acoplarse al input interno.
 */
export type BarcodeScannerHandle = { focus: () => void };

/** Producto devuelto por el escaneo (columnas reales de `public.productos`). */
export type ProductoEscaneado = {
  id: number;
  descripcion: string;
  precio_venta: number;
  codigo_barras: string | null;
  stock_actual: number;
};

type Props = {
  /** Se invoca con el producto hallado (para agregarlo a la venta actual). */
  onScan: (producto: ProductoEscaneado) => void;
  /** Se invoca cuando el código no existe en la empresa (feedback en el padre). */
  onNotFound?: (codigo: string) => void;
  /** Se invoca ante un error de consulta a Supabase. */
  onError?: (mensaje: string) => void;
  /** Texto del placeholder (por defecto orientado a escaneo). */
  placeholder?: string;
  /** Autofoco al montar (activo por defecto: es el flujo de caja rápido). */
  autoFocus?: boolean;
};

function BarcodeScanner(
  {
    onScan,
    onNotFound,
    onError,
    placeholder = "Escanea o escribe el código de barras… (Enter)",
    autoFocus = true,
  }: Props,
  ref: React.Ref<BarcodeScannerHandle>,
) {
  const [codigo, setCodigo] = useState("");
  // Evita disparar dos búsquedas concurrentes (Enter del lector + debounce).
  const buscandoRef = useRef(false);
  // Último valor ya consultado: evita re-consultar/re-agregar lo mismo.
  const ultimoRef = useRef("");
  // Temporizador del debounce de la búsqueda "al escribir".
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Expone `focus()` al padre (p. ej. el POS reenfoca el escáner tras cobrar).
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  // Limpia el temporizador pendiente al desmontar.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  /**
   * Consulta `public.productos` filtrando la columna `codigo_barras` por el valor
   * EXACTO tecleado/escaneado. Si hay coincidencia la emite por `onScan` y limpia
   * el campo (listo para el siguiente). `reportarNoEncontrado` solo se activa con
   * Enter: mientras se escribe no molestamos con avisos de "no encontrado".
   */
  const buscar = useCallback(
    async (valorCrudo: string, reportarNoEncontrado: boolean) => {
      const valor = valorCrudo.trim();
      if (!valor || buscandoRef.current) return;
      if (!reportarNoEncontrado && valor === ultimoRef.current) return;
      ultimoRef.current = valor;

      buscandoRef.current = true;
      try {
        const { data, error } = await supabase
          .from("productos")
          .select("id, descripcion, precio_venta, codigo_barras, stock_actual")
          .eq("codigo_barras", valor)
          .limit(1)
          .maybeSingle();

        if (error) {
          console.error("[BarcodeScanner] Error al buscar el producto:", error);
          onError?.("Error al buscar el producto.");
          return;
        }
        if (!data) {
          // Al escribir aún puede ser un código parcial → silencio hasta Enter.
          if (reportarNoEncontrado) onNotFound?.(valor);
          return;
        }

        setCodigo(""); // Coincidencia: limpia para el siguiente código.
        ultimoRef.current = "";
        // numeric puede llegar como string desde PostgREST → normalizamos.
        const row = data as ProductoEscaneado;
        onScan({ ...row, precio_venta: Number(row.precio_venta ?? 0) });
      } finally {
        buscandoRef.current = false;
        inputRef.current?.focus(); // devuelve el foco para el siguiente escaneo
      }
    },
    [onScan, onNotFound, onError],
  );

  // Búsqueda "al escribir": debounce corto para no consultar en cada tecla y
  // añadir el producto en cuanto lo tecleado coincida con un código de barras.
  const onChange = useCallback(
    (valor: string) => {
      setCodigo(valor);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => buscar(valor, false), 250);
    },
    [buscar],
  );

  // Enter (lector físico o manual): busca de inmediato y reporta si no existe.
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void buscar(codigo, true);
    },
    [codigo, buscar],
  );

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg">🔍</span>
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        inputMode="numeric"
        value={codigo}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-3.5 pl-11 pr-3 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
      />
    </div>
  );
}

export default forwardRef(BarcodeScanner);
