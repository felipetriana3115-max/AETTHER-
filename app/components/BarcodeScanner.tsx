"use client";

import {
  forwardRef,
  useCallback,
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
  // Evita disparar dos búsquedas si llegan Enters muy seguidos del lector.
  const [buscando, setBuscando] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Expone `focus()` al padre (p. ej. el POS reenfoca el escáner tras cobrar).
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  const buscar = useCallback(
    async (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const valor = codigo.trim();
      if (!valor || buscando) return;

      setBuscando(true);
      try {
        const { data, error } = await supabase
          .from("productos")
          .select("id, descripcion, precio_venta, codigo_barras, stock_actual")
          .eq("codigo_barras", valor)
          .limit(1)
          .maybeSingle();

        setCodigo(""); // Limpia siempre: el siguiente escaneo empieza en blanco.

        if (error) {
          console.error("[BarcodeScanner] Error al buscar el producto:", error);
          onError?.("Error al buscar el producto.");
          return;
        }
        if (!data) {
          onNotFound?.(valor);
          return;
        }

        // numeric puede llegar como string desde PostgREST → normalizamos.
        const row = data as ProductoEscaneado;
        onScan({ ...row, precio_venta: Number(row.precio_venta ?? 0) });
      } finally {
        setBuscando(false);
        inputRef.current?.focus(); // devuelve el foco para el siguiente escaneo
      }
    },
    [codigo, buscando, onScan, onNotFound, onError],
  );

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg">🔍</span>
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        inputMode="numeric"
        value={codigo}
        onChange={(e) => setCodigo(e.target.value)}
        onKeyDown={buscar}
        placeholder={placeholder}
        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-3.5 pl-11 pr-3 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
      />
    </div>
  );
}

export default forwardRef(BarcodeScanner);
