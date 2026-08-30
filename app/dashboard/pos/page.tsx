"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import PageShell from "../../components/PageShell";
import { useDashboard } from "../../components/DashboardProvider";
import { getEmpresaIdActiva } from "../../lib/auth";
import BarcodeScanner, { type BarcodeScannerHandle } from "../../components/BarcodeScanner";
import { formatCOP } from "../../lib/data-model";
import { fetchClientes, type Cliente } from "../../lib/clientes";
import { fetchVentasHoyPorMetodo, type VentasHoyPorMetodo } from "../../lib/corte";
import { loadDeviceSettings } from "../../lib/devices";
import { fetchTirilla, DEFAULT_TIRILLA, type TirillaConfig } from "../../lib/tirilla";
import { printReceipt, type ReceiptData } from "../../lib/receipt";
import { cacheCatalogo, descontarStockLocal, getFrecuentes } from "../../lib/offline/catalog";
import { enqueueVenta } from "../../lib/offline/outbox";
import { useOffline } from "../../lib/offline/useOffline";

/**
 * Punto de Venta (POS) táctil — pensado para retail rápido (superior a Eleventa).
 *
 * Fuente de verdad: tabla `public.productos` en Supabase.
 * Columnas reales: id · descripcion · precio_venta · codigo_barras · stock_actual.
 * Las leemos con alias PostgREST (`nombre:descripcion`, `precio:precio_venta`)
 * para conservar las claves `nombre`/`precio` que usa el carrito sin renombrar
 * todo el componente.
 *
 * Flujos clave:
 *  - Escáner: input con autoFocus; al pulsar Enter busca por `codigo_barras`,
 *    añade 1 unidad al carrito y limpia el campo (listo para el siguiente código).
 *  - Grid táctil: botones grandes para los productos más frecuentes.
 *  - Cobro: valida stock, descuenta `stock_actual` por unidad vendida y registra
 *    el método de pago. El descuento usa un guard optimista (`.gte`) en la BD
 *    para impedir sobreventa aunque dos cajas cobren a la vez.
 */

// ── Tipos ────────────────────────────────────────────────────────────────────

type Producto = {
  // Los productos reales usan UUID (string); los "artículos comunes" ids
  // negativos temporales (number). Por eso la clave es `string | number`.
  id: string | number;
  nombre: string;
  precio: number;
  codigo_barras: string | null;
  stock_actual: number;
};

// Una línea puede ser un producto real del inventario o un "artículo común":
// un ítem temporal (nombre + precio a mano) que NO existe en `productos` y por
// tanto NO descuenta stock al cobrar. Se marca con `esComun`.
type LineaCarrito = Producto & { qty: number; esComun?: boolean };

// Métodos de caja (dinero recibido) + "Fiado" (venta a crédito). El fiado NO es
// caja: se carga al saldo del cliente y se cobra al abonar (ver registrar_venta_fiado).
type MetodoPago = "Efectivo" | "Nequi/Daviplata" | "Bold" | "Fiado";

type Feedback = { tone: "error" | "ok"; msg: string } | null;

// ── Config de UI ─────────────────────────────────────────────────────────────

const METODOS: { id: MetodoPago; label: string; sub: string; classes: string }[] = [
  {
    id: "Efectivo",
    label: "Efectivo",
    sub: "Pago en caja",
    classes: "from-emerald-500 to-green-600 shadow-emerald-500/40",
  },
  {
    id: "Nequi/Daviplata",
    label: "Nequi / Daviplata",
    sub: "Billetera móvil",
    classes: "from-fuchsia-500 to-purple-600 shadow-fuchsia-500/40",
  },
  {
    id: "Bold",
    label: "Bold",
    sub: "Datáfono / tarjeta",
    classes: "from-sky-500 to-blue-600 shadow-sky-500/40",
  },
];

// Placeholder de imagen: iniciales del producto sobre un degradado.
function Placeholder({ nombre }: { nombre: string }) {
  const iniciales = nombre
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div className="flex h-14 w-full items-center justify-center rounded-lg bg-gradient-to-br from-violet-600/30 to-fuchsia-600/30 text-lg font-bold text-violet-200">
      {iniciales || "?"}
    </div>
  );
}

export default function PosPage() {
  const { businessName } = useDashboard();
  const [frecuentes, setFrecuentes] = useState<Producto[]>([]);
  const [carrito, setCarrito] = useState<LineaCarrito[]>([]);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [cobrando, setCobrando] = useState(false);
  // Línea seleccionada del carrito (para la tecla Delete). Guarda su `id`.
  const [seleccionado, setSeleccionado] = useState<string | number | null>(null);
  // Modal "Artículo común": abierto + campos del formulario.
  const [comunAbierto, setComunAbierto] = useState(false);
  const [comunNombre, setComunNombre] = useState("");
  const [comunPrecio, setComunPrecio] = useState("");
  const inputRef = useRef<BarcodeScannerHandle>(null);
  const comunNombreRef = useRef<HTMLInputElement>(null);
  // Contador de ids para los artículos comunes. Negativo y decreciente para no
  // colisionar nunca con los ids reales de `productos` (siempre positivos).
  const comunIdRef = useRef(-1);
  // Ventas del día por método (leídas de `ventas`, no de `cortes_caja`):
  // alimentan la tarjeta "Vendido hoy". No dependen de que exista un corte hoy.
  const [ventasHoy, setVentasHoy] = useState<VentasHoyPorMetodo | null>(null);
  // Última venta cobrada: habilita reimprimir la tirilla tras vaciar el carrito.
  const [ultimaVenta, setUltimaVenta] = useState<ReceiptData | null>(null);

  // Identidad del recibo (NIT, dirección, logo, mensaje) del tenant, desde Supabase.
  // En un ref para que los handlers de impresión lean siempre el valor vigente sin
  // recomputar sus dependencias. `fetchTirilla` cae al caché local si no hay red.
  const tirillaRef = useRef<TirillaConfig>(DEFAULT_TIRILLA);

  // ── Cliente + fiado ──────────────────────────────────────────────────────
  // Directorio del CRM para asociar la venta a un cliente (necesario para fiar).
  const [clientes, setClientes] = useState<Cliente[]>([]);
  // Cliente seleccionado para esta venta (null = venta general, sin cliente).
  const [clienteSel, setClienteSel] = useState<Cliente | null>(null);
  // Modal de búsqueda/selección de cliente + su término de filtro.
  const [selectorAbierto, setSelectorAbierto] = useState(false);
  const [buscarCliente, setBuscarCliente] = useState("");
  // true si el módulo de clientes/fiados aún no se ha migrado en Supabase.
  const [faltaFiado, setFaltaFiado] = useState(false);

  // Modo Sin Internet: estado de red + cola local de ventas. Al terminar una
  // sincronización con éxito, refrescamos el corte del servidor (fuente de verdad).
  const { online, pendientes, totalPend, sincronizando, sincronizar, refresh } = useOffline(() => {
    fetchVentasHoyPorMetodo().then(setVentasHoy);
  });

  // Autolimpia el feedback tras unos segundos para no dejar alertas pegadas.
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3500);
    return () => clearTimeout(t);
  }, [feedback]);

  // Carga la identidad de la tirilla del tenant (una vez) para imprimirla en los
  // recibos. Best-effort: si falla, se imprime sin NIT/logo (degradación suave).
  useEffect(() => {
    let activo = true;
    void fetchTirilla().then((cfg) => {
      if (activo) tirillaRef.current = cfg;
    });
    return () => {
      activo = false;
    };
  }, []);

  // Carga inicial del grid táctil + cacheo del catálogo para uso sin conexión.
  // `cacheCatalogo` refresca el espejo local completo (lo usan el scanner y la
  // búsqueda cuando no hay red); `getFrecuentes` responde desde Supabase con red
  // o desde IndexedDB sin ella.
  useEffect(() => {
    let activo = true;
    (async () => {
      void cacheCatalogo();
      const productos = await getFrecuentes(12);
      if (!activo) return;
      setFrecuentes(productos as Producto[]);
    })();
    return () => {
      activo = false;
    };
  }, []);

  // Carga las ventas del día para la tarjeta "Vendido hoy".
  useEffect(() => {
    let activo = true;
    (async () => {
      const ventas = await fetchVentasHoyPorMetodo();
      if (activo) setVentasHoy(ventas);
    })();
    return () => {
      activo = false;
    };
  }, []);

  // Directorio de clientes para poder fiar. Con red viene de Supabase; si la
  // migración de clientes/fiados no está aplicada, marcamos `faltaFiado` para
  // guiar al usuario en el selector en vez de romper el POS.
  useEffect(() => {
    let activo = true;
    (async () => {
      const { clientes, faltaMigracion } = await fetchClientes();
      if (!activo) return;
      setClientes(clientes);
      setFaltaFiado(faltaMigracion);
    })();
    return () => {
      activo = false;
    };
  }, []);

  const total = useMemo(() => carrito.reduce((s, l) => s + l.precio * l.qty, 0), [carrito]);
  const unidades = useMemo(() => carrito.reduce((s, l) => s + l.qty, 0), [carrito]);

  // Clientes que casan con la búsqueda del selector (nombre / teléfono).
  const clientesFiltrados = useMemo(() => {
    const q = buscarCliente.trim().toLowerCase();
    if (!q) return clientes;
    return clientes.filter(
      (c) => c.nombre.toLowerCase().includes(q) || (c.telefono ?? "").toLowerCase().includes(q),
    );
  }, [clientes, buscarCliente]);

  // ── Carrito ────────────────────────────────────────────────────────────────

  /**
   * Agrega un producto al carrito (cantidad +1). UX proactiva: si el stock es 0
   * (o la línea ya alcanzó el stock disponible), no agrega y avisa en rojo.
   */
  const agregar = useCallback((p: Producto) => {
    if (p.stock_actual <= 0) {
      setFeedback({ tone: "error", msg: `Sin stock: "${p.nombre}" no tiene existencias.` });
      return;
    }
    setCarrito((prev) => {
      const existente = prev.find((l) => l.id === p.id);
      if (existente) {
        if (existente.qty >= p.stock_actual) {
          setFeedback({
            tone: "error",
            msg: `Solo hay ${p.stock_actual} unidad(es) de "${p.nombre}".`,
          });
          return prev;
        }
        return prev.map((l) => (l.id === p.id ? { ...l, qty: l.qty + 1 } : l));
      }
      return [...prev, { ...p, qty: 1 }];
    });
  }, []);

  const cambiarQty = useCallback((id: string | number, delta: number) => {
    setCarrito((prev) =>
      prev
        .map((l) => {
          if (l.id !== id) return l;
          const nueva = l.qty + delta;
          if (nueva > l.stock_actual) {
            setFeedback({ tone: "error", msg: `Solo hay ${l.stock_actual} unidad(es) de "${l.nombre}".` });
            return l;
          }
          return { ...l, qty: nueva };
        })
        .filter((l) => l.qty > 0),
    );
  }, []);

  const quitar = useCallback((id: string | number) => {
    setCarrito((prev) => prev.filter((l) => l.id !== id));
    setSeleccionado((sel) => (sel === id ? null : sel));
  }, []);

  // ── Artículo común (ítem temporal sin inventario) ────────────────────────────

  /**
   * Abre el modal para capturar nombre y precio de un artículo que no está en el
   * inventario (p. ej. una venta suelta). Se dispara con el botón o con Ctrl+P.
   */
  const agregarArticuloComun = useCallback(() => {
    setComunNombre("");
    setComunPrecio("");
    setComunAbierto(true);
  }, []);

  // Cierra el modal y devuelve el foco al input principal (flujo de caja rápido).
  const cerrarComun = useCallback(() => {
    setComunAbierto(false);
    inputRef.current?.focus();
  }, []);

  // Autofoco en el nombre al abrir el modal.
  useEffect(() => {
    if (comunAbierto) comunNombreRef.current?.focus();
  }, [comunAbierto]);

  /**
   * Valida el formulario y crea la línea temporal en el carrito. Usa un id
   * negativo único (`comunIdRef`) para no chocar con productos reales; al cobrar,
   * estas líneas se saltan el descuento de stock (ver `cobrar`).
   */
  const confirmarComun = useCallback(() => {
    const nombre = comunNombre.trim();
    const precio = Math.round(Number(comunPrecio.replace(/[^\d]/g, "")));
    if (!nombre) {
      setFeedback({ tone: "error", msg: "Escribe un nombre para el artículo común." });
      return;
    }
    if (!Number.isFinite(precio) || precio <= 0) {
      setFeedback({ tone: "error", msg: "El precio debe ser mayor que cero." });
      return;
    }
    const id = comunIdRef.current--;
    setCarrito((prev) => [
      ...prev,
      {
        id,
        nombre,
        precio,
        codigo_barras: null,
        stock_actual: Number.POSITIVE_INFINITY, // sin límite: no toca inventario.
        qty: 1,
        esComun: true,
      },
    ]);
    setComunAbierto(false);
    setFeedback({ tone: "ok", msg: `Artículo común agregado: "${nombre}".` });
    inputRef.current?.focus();
  }, [comunNombre, comunPrecio]);

  // ── Selección + borrado por teclado ──────────────────────────────────────────

  /** Elimina la línea seleccionada del carrito (tecla Delete). */
  const borrarSeleccionado = useCallback(() => {
    if (seleccionado == null) {
      setFeedback({ tone: "error", msg: "Selecciona una línea del carrito para borrarla." });
      return;
    }
    quitar(seleccionado);
  }, [seleccionado, quitar]);

  // ── Atajos de teclado (interfaz híbrida táctil + teclado) ────────────────────

  // Ctrl+P → abrir "Artículo común". `enableOnFormTags` permite dispararlo aunque
  // el cursor esté en el input del escáner; `preventDefault` bloquea el diálogo
  // de impresión del navegador.
  useHotkeys(
    "ctrl+p",
    (e) => {
      e.preventDefault();
      agregarArticuloComun();
    },
    { enableOnFormTags: true, preventDefault: true },
    [agregarArticuloComun],
  );

  // Delete → borrar la línea seleccionada. Por defecto react-hotkeys-hook NO se
  // dispara mientras se escribe en un input, así que no interfiere con el escáner.
  useHotkeys("delete", () => borrarSeleccionado(), [borrarSeleccionado]);

  // El escaneo por `codigo_barras` lo maneja ahora <BarcodeScanner>, que emite el
  // producto hallado por `onScan` y lo pasamos a `agregar` mapeando sus columnas.

  // ── Cobro (transacción de venta) ─────────────────────────────────────────────

  /**
   * Procesa la venta con el método de pago elegido, con enfoque OFFLINE-FIRST.
   *
   * 1) La venta se persiste PRIMERO en la cola local (IndexedDB/Dexie) con un
   *    `clientUuid` de idempotencia. Así jamás se pierde, haya red o no.
   * 2) Se aplican los efectos optimistas: descuento de stock local, tirilla,
   *    impresión y vaciado del carrito.
   * 3) Si hay conexión, se dispara la sincronización, que envía la venta (y las
   *    pendientes) a Supabase vía la RPC idempotente `registrar_venta_offline`.
   *    Todo el cobro en el servidor (descuento + venta + corte) sigue siendo una
   *    única transacción atómica; el `clientUuid` evita duplicados en reintentos.
   */
  const cobrar = useCallback(
    async (metodo: MetodoPago) => {
      if (carrito.length === 0) {
        setFeedback({ tone: "error", msg: "El carrito está vacío." });
        return;
      }
      // Fiar exige un cliente al que cargar la deuda. Si no hay, abrimos el
      // selector en vez de cobrar (el total se registraría "en el aire").
      if (metodo === "Fiado" && !clienteSel) {
        setFeedback({ tone: "error", msg: "Selecciona un cliente para registrar el fiado." });
        setSelectorAbierto(true);
        return;
      }
      // Validación de stock en cliente: feedback inmediato. El servidor la
      // revalida al sincronizar (fuente de verdad). Los artículos comunes no
      // tienen inventario, así que se excluyen del control de stock.
      const sinStock = carrito
        .filter((l) => !l.esComun)
        .find((l) => l.stock_actual <= 0 || l.qty > l.stock_actual);
      if (sinStock) {
        setFeedback({
          tone: "error",
          msg: `Stock insuficiente para "${sinStock.nombre}" (disponibles: ${sinStock.stock_actual}).`,
        });
        return;
      }

      setCobrando(true);
      try {
        // `esComun` viaja en cada línea para que la RPC sepa cuáles saltan el
        // descuento de inventario (mismo shape que ya usaba registrar_venta).
        const items = carrito.map((l) => ({
          id: l.id,
          nombre: l.nombre,
          qty: l.qty,
          precio: l.precio,
          esComun: l.esComun ?? false,
        }));

        // 1) Persistir en la cola local ANTES de tocar la red (durabilidad).
        //    En fiado adjuntamos el cliente: la sincronización cargará el total a
        //    su saldo vía registrar_venta_fiado (sin sumar al corte de caja).
        const esFiado = metodo === "Fiado";
        await enqueueVenta({
          metodo,
          total,
          items,
          clienteId: esFiado ? clienteSel?.id ?? null : null,
          clienteNombre: esFiado ? clienteSel?.nombre ?? null : null,
        });

        // 2) Efectos optimistas: descuento local + grid + tirilla + impresión.
        await descontarStockLocal(items);
        setFrecuentes((prev) =>
          prev.map((p) => {
            const vendida = carrito.find((l) => l.id === p.id);
            return vendida ? { ...p, stock_actual: p.stock_actual - vendida.qty } : p;
          }),
        );

        // En la tirilla dejamos claro que fue a crédito y a nombre de quién.
        const nombreFiado = esFiado ? clienteSel?.nombre ?? null : null;
        const recibo: ReceiptData = {
          businessName,
          fecha: new Date().toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" }),
          items: carrito.map((l) => ({ nombre: l.nombre, qty: l.qty, precio: l.precio })),
          total,
          pagos: [{ metodo: nombreFiado ? `Fiado · ${nombreFiado}` : metodo, monto: total }],
        };
        setUltimaVenta(recibo);

        const devices = loadDeviceSettings();
        if (devices.printer.enabled && devices.printer.autoPrint) {
          printReceipt(recibo, { ...devices.printer, ...tirillaRef.current });
        }

        const okMsg = esFiado
          ? `Fiado a ${nombreFiado}: ${formatCOP(total)} cargado a su cuenta.`
          : `Venta cobrada con ${metodo}: ${formatCOP(total)}.`;

        setCarrito([]);
        // Soltamos el cliente tras fiar para no cargarle sin querer la próxima venta.
        if (esFiado) setClienteSel(null);
        inputRef.current?.focus();

        // 3) Sincronizar si hay red. Con conexión, el corte se refresca vía el
        //    callback `onSynced` de useOffline; sin ella, la tarjeta "Vendido
        //    hoy" suma los pendientes (ver render).
        if (online) {
          const r = await sincronizar();
          // ÉXITO REAL, y solo entonces mensaje verde: estando EN LÍNEA la venta se
          // subió de verdad si —y solo si— la sincronización confirmó progreso
          // (`enviadas > 0`), vació la cola (`restantes === 0`) y no hubo rechazos
          // (`conError === 0`). Cualquier otro desenlace en línea significa que la
          // persistencia final NO se completó (RPC interceptada/silenciada, gate de
          // sesión que salió temprano, corte de red o rechazo del servidor): en ese
          // caso mostramos ERROR VISIBLE con el motivo real, en vez de un mensaje
          // tranquilizador que haga creer que se guardó cuando no fue así.
          const subidaConfirmada = !!r && r.conError === 0 && r.enviadas > 0 && r.restantes === 0;
          if (subidaConfirmada) {
            setFeedback({ tone: "ok", msg: okMsg });
            // Refrescamos el saldo del cliente en el selector tras cargar el fiado,
            // para que un segundo fiado al mismo cliente muestre su deuda al día.
            if (esFiado) {
              fetchClientes().then(({ clientes }) => {
                if (clientes.length > 0) setClientes(clientes);
              });
            }
          } else {
            setFeedback({
              tone: "error",
              msg:
                r?.mensaje ??
                `La venta quedó guardada localmente pero NO se subió al servidor (${formatCOP(total)}). Revisa tu conexión y tu sesión, y pulsa Sincronizar.`,
            });
          }
        } else {
          await refresh();
          setFeedback({
            tone: "ok",
            msg: esFiado
              ? `Fiado a ${nombreFiado} guardado SIN conexión (${formatCOP(total)}). Se cargará a su cuenta al volver la red.`
              : `Venta guardada SIN conexión (${formatCOP(total)}). Se sincronizará al volver la red.`,
          });
        }
      } catch (e) {
        console.error("[POS] No se pudo encolar la venta:", e);
        setFeedback({ tone: "error", msg: "No se pudo guardar la venta localmente. Intenta de nuevo." });
      } finally {
        setCobrando(false);
      }
    },
    [carrito, total, businessName, online, sincronizar, refresh, clienteSel],
  );

  /**
   * Sincronización MANUAL (botón de la barra de estado). A diferencia del auto-sync
   * silencioso, aquí traducimos el ResultadoSync a un mensaje visible: así el cajero
   * sabe exactamente por qué una venta no subió (sesión sin empresa, red o rechazo
   * del servidor) en vez de ver que "no pasa nada".
   */
  const manejarSync = useCallback(async () => {
    const r = await sincronizar();
    if (!r) return; // sin conexión real: el botón ya está deshabilitado offline.

    if (r.sinEmpresa) {
      // La outbox marca `sinEmpresa` ante un 42501, pero ese código también salta
      // por carreras transitorias (token recién rehidratado cuyo JWT aún no lleva
      // la empresa). Confirmamos contra la sesión VIVA: si `mi_empresa()` resuelve
      // un empresa_id real, el rechazo fue un falso positivo y NO debemos asustar
      // al cajero con "hay que reparar tu cuenta"; basta con reintentar.
      const empresaId = await getEmpresaIdActiva();
      if (empresaId) {
        setFeedback({
          tone: "error",
          msg: `No se pudieron subir las ventas por un problema temporal de sesión. Quedan ${r.restantes} en la cola; pulsa Sincronizar de nuevo.`,
        });
        return;
      }
      setFeedback({
        tone: "error",
        msg:
          "Tu sesión no tiene una empresa asociada, por eso las ventas no se pueden subir. " +
          "Cierra sesión y vuelve a entrar; si persiste, hay que reparar tu cuenta.",
      });
      return;
    }
    if (r.conError > 0) {
      setFeedback({
        tone: "error",
        msg: `El servidor rechazó ${r.conError} venta${r.conError === 1 ? "" : "s"} (${
          r.mensaje ?? "revisa el stock o el cliente"
        }). Quedan ${r.restantes} en la cola.`,
      });
      return;
    }
    if (r.detuvoPorRed) {
      setFeedback({
        tone: "error",
        msg: `No hay conexión real con el servidor${
          r.mensaje ? `: ${r.mensaje}` : ""
        }. Quedan ${r.restantes} por sincronizar; se reintentará.`,
      });
      return;
    }
    if (r.enviadas > 0) {
      setFeedback({
        tone: "ok",
        msg:
          r.restantes === 0
            ? `${r.enviadas} venta${r.enviadas === 1 ? "" : "s"} sincronizada${
                r.enviadas === 1 ? "" : "s"
              } correctamente.`
            : `${r.enviadas} sincronizada${r.enviadas === 1 ? "" : "s"}; quedan ${r.restantes}.`,
      });
      return;
    }
    // Nada enviado y sin errores: o ya no había pendientes, o hay otro drenado en curso.
    setFeedback({
      tone: "ok",
      msg: r.restantes === 0 ? "Todo sincronizado." : `Reintentando… quedan ${r.restantes}.`,
    });
  }, [sincronizar]);

  /** Reimprime la tirilla de la última venta (botón manual del POS). */
  const reimprimir = useCallback(() => {
    if (!ultimaVenta) return;
    const devices = loadDeviceSettings();
    printReceipt(ultimaVenta, { ...devices.printer, ...tirillaRef.current });
  }, [ultimaVenta]);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <PageShell title="Punto de Venta" subtitle="Caja rápida · Escanea, cobra y descuenta inventario">
      {feedback && (
        <div
          role="alert"
          className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium ${
            feedback.tone === "error"
              ? "border-red-500/30 bg-red-500/10 text-red-300"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          }`}
        >
          <span className="text-base">{feedback.tone === "error" ? "⚠️" : "✅"}</span>
          {feedback.msg}
        </div>
      )}

      {/* ── Barra de estado de conexión + sincronización ── */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`inline-flex h-2.5 w-2.5 rounded-full ${
              online ? "bg-emerald-400" : "bg-amber-400"
            }`}
            aria-hidden
          />
          <span className={online ? "font-medium text-emerald-300" : "font-medium text-amber-300"}>
            {online ? "En línea" : "Sin conexión"}
          </span>
          {pendientes > 0 && (
            <span className="ml-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300">
              {pendientes} venta{pendientes === 1 ? "" : "s"} por sincronizar · {formatCOP(totalPend)}
            </span>
          )}
          {online && pendientes === 0 && (
            <span className="ml-1 text-xs text-zinc-500">Todo sincronizado</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void manejarSync()}
          disabled={!online || sincronizando || pendientes === 0}
          className="inline-flex items-center gap-2 rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-xs font-semibold text-violet-200 transition-colors hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className={sincronizando ? "animate-spin" : ""}>↻</span>
          {sincronizando ? "Sincronizando…" : `Sincronizar${pendientes > 0 ? ` (${pendientes})` : ""}`}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ── Columna izquierda: escáner + grid táctil ── */}
        <section className="space-y-4 lg:col-span-2">
          {/* Escáner / búsqueda */}
          <div className="rounded-xl border border-violet-500/15 bg-zinc-900/50 p-4">
            <label htmlFor="scan" className="mb-1.5 block text-xs font-medium text-zinc-400">
              Escanea o escribe el código de barras
            </label>
            <BarcodeScanner
              ref={inputRef}
              onScan={(p) => agregar(p)}
              onNotFound={(codigo) => setFeedback({ tone: "error", msg: `Código ${codigo} no encontrado.` })}
              onError={(msg) => setFeedback({ tone: "error", msg })}
            />

            {/* Artículo común: ítem suelto sin inventario (botón grande táctil). */}
            <button
              type="button"
              onClick={agregarArticuloComun}
              className="mt-3 flex h-16 w-full items-center justify-center gap-2 rounded-lg border border-violet-500/40 bg-violet-500/10 text-base font-semibold text-violet-200 transition-all hover:bg-violet-500/20 active:scale-[0.99]"
            >
              <span className="text-xl">➕</span>
              Artículo común
              <kbd className="ml-1 rounded border border-violet-400/30 bg-violet-950/60 px-1.5 py-0.5 text-xs font-normal text-violet-300">
                Ctrl+P
              </kbd>
            </button>
          </div>

          {/* Grid táctil de productos frecuentes */}
          <div className="rounded-xl border border-violet-500/15 bg-zinc-900/50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-zinc-100">Productos frecuentes</h3>
            {frecuentes.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">
                No hay productos cargados en el inventario.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {frecuentes.map((p) => {
                  const agotado = p.stock_actual <= 0;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => agregar(p)}
                      disabled={agotado}
                      className={`group flex flex-col gap-2 rounded-xl border p-3 text-left transition-all ${
                        agotado
                          ? "cursor-not-allowed border-red-500/30 bg-red-500/5 opacity-60"
                          : "border-zinc-800 bg-zinc-950 hover:border-violet-500/50 hover:bg-zinc-900 active:scale-95"
                      }`}
                    >
                      <Placeholder nombre={p.nombre} />
                      <span className="line-clamp-2 min-h-[2.5rem] text-sm font-medium text-zinc-100">
                        {p.nombre}
                      </span>
                      <span className="text-sm font-semibold text-violet-300">{formatCOP(p.precio)}</span>
                      <span
                        className={`text-xs ${agotado ? "font-semibold text-red-400" : "text-zinc-500"}`}
                      >
                        {agotado ? "AGOTADO" : `Stock: ${p.stock_actual}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* ── Columna derecha: carrito + pago ── */}
        <section className="flex flex-col rounded-xl border border-violet-500/15 bg-zinc-900/50">
          {/* Vendido hoy: visibilidad del corte de caja sin salir del POS. */}
          <div className="flex items-center justify-between gap-3 rounded-t-xl border-b border-emerald-500/20 bg-gradient-to-r from-emerald-500/10 to-transparent p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/15 text-lg">💰</span>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-emerald-400/80">Vendido hoy</p>
                <p className="text-xs text-zinc-500">
                  {(ventasHoy?.num_ventas ?? 0) + pendientes} venta
                  {(ventasHoy?.num_ventas ?? 0) + pendientes === 1 ? "" : "s"}
                  {pendientes > 0 && (
                    <span className="text-amber-400"> · {pendientes} sin sincronizar</span>
                  )}
                </p>
              </div>
            </div>
            <span className="text-xl font-bold tracking-tight text-emerald-300 tabular-nums">
              {formatCOP((ventasHoy?.total_general ?? 0) + totalPend)}
            </span>
          </div>

          <div className="flex items-center justify-between border-b border-zinc-800 p-4">
            <h3 className="text-sm font-semibold text-zinc-100">
              Carrito {unidades > 0 && <span className="text-zinc-500">· {unidades} und</span>}
            </h3>
            {carrito.length > 0 && (
              <span className="text-xs text-zinc-500">
                Selecciona y pulsa <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-[10px]">Supr</kbd> para borrar
              </span>
            )}
          </div>

          {/* Líneas del carrito */}
          <div className="max-h-[40vh] flex-1 divide-y divide-zinc-800/70 overflow-y-auto lg:max-h-[calc(100vh-24rem)]">
            {carrito.length === 0 ? (
              <p className="p-8 text-center text-sm text-zinc-500">Agrega productos para iniciar la venta.</p>
            ) : (
              carrito.map((l) => (
                <div
                  key={l.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSeleccionado((sel) => (sel === l.id ? null : l.id))}
                  className={`flex cursor-pointer items-center gap-3 p-3 transition-colors ${
                    seleccionado === l.id ? "bg-violet-500/15 ring-1 ring-inset ring-violet-500/50" : "hover:bg-zinc-800/30"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-100">
                      {l.nombre}
                      {l.esComun && (
                        <span className="ml-1.5 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">
                          común
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {formatCOP(l.precio)} · {formatCOP(l.precio * l.qty)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        cambiarQty(l.id, -1);
                      }}
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 text-lg text-zinc-300 hover:bg-zinc-800"
                      aria-label="Quitar una unidad"
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-sm font-semibold tabular-nums text-zinc-100">
                      {l.qty}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        cambiarQty(l.id, 1);
                      }}
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 text-lg text-zinc-300 hover:bg-zinc-800"
                      aria-label="Agregar una unidad"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        quitar(l.id);
                      }}
                      className="ml-1 flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-red-500/10 hover:text-red-400"
                      aria-label="Eliminar del carrito"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Cliente de la venta (obligatorio para fiar) */}
          <div className="border-t border-zinc-800 p-4 pb-0">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-base">
                  👤
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Cliente</p>
                  {clienteSel ? (
                    <p className="truncate text-sm font-semibold text-zinc-100">
                      {clienteSel.nombre}
                      {clienteSel.saldo_pendiente > 0 && (
                        <span className="ml-1.5 text-xs font-medium text-amber-400">
                          debe {formatCOP(clienteSel.saldo_pendiente)}
                        </span>
                      )}
                    </p>
                  ) : (
                    <p className="text-sm text-zinc-500">Venta general (sin cliente)</p>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {clienteSel && (
                  <button
                    type="button"
                    onClick={() => setClienteSel(null)}
                    className="rounded-lg px-2 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                  >
                    Quitar
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setBuscarCliente("");
                    setSelectorAbierto(true);
                  }}
                  className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-xs font-semibold text-violet-200 transition-colors hover:bg-violet-500/20"
                >
                  {clienteSel ? "Cambiar" : "Seleccionar"}
                </button>
              </div>
            </div>
          </div>

          {/* Total + botones de pago rápido */}
          <div className="border-t-0 p-4">
            <div className="mb-4 flex items-baseline justify-between">
              <span className="text-sm text-zinc-400">Total</span>
              <span className="text-3xl font-bold tracking-tight text-zinc-50">{formatCOP(total)}</span>
            </div>

            <div className="grid grid-cols-1 gap-2.5">
              {METODOS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  disabled={cobrando || carrito.length === 0}
                  onClick={() => cobrar(m.id)}
                  className={`flex h-16 w-full items-center justify-between rounded-xl bg-gradient-to-r px-4 text-left text-white shadow-lg transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${m.classes}`}
                >
                  <span>
                    <span className="block text-base font-semibold">{m.label}</span>
                    <span className="block text-xs text-white/80">{m.sub}</span>
                  </span>
                  <span className="text-xl">{cobrando ? "…" : "→"}</span>
                </button>
              ))}

              {/* Fiado (venta a crédito): carga el total al saldo del cliente. */}
              <button
                type="button"
                disabled={cobrando || carrito.length === 0}
                onClick={() => cobrar("Fiado")}
                title={clienteSel ? `Fiar a ${clienteSel.nombre}` : "Selecciona un cliente para fiar"}
                className="flex h-16 w-full items-center justify-between rounded-xl border-2 border-dashed border-amber-500/50 bg-amber-500/10 px-4 text-left text-amber-200 transition-all active:scale-[0.98] hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span>
                  <span className="block text-base font-semibold">Fiado (crédito)</span>
                  <span className="block text-xs text-amber-300/80">
                    {clienteSel ? `A cuenta de ${clienteSel.nombre}` : "Requiere elegir cliente"}
                  </span>
                </span>
                <span className="text-xl">{cobrando ? "…" : "→"}</span>
              </button>
            </div>

            {ultimaVenta && (
              <button
                type="button"
                onClick={reimprimir}
                className="mt-2.5 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 py-2.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9V2h12v7" />
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <path d="M6 14h12v8H6z" />
                </svg>
                Reimprimir tirilla ({formatCOP(ultimaVenta.total)})
              </button>
            )}
          </div>
        </section>
      </div>

      {/* ── Modal: Artículo común ── */}
      {comunAbierto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="comun-titulo"
          onClick={cerrarComun}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-violet-500/25 bg-zinc-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="comun-titulo" className="text-base font-semibold text-zinc-100">
              Artículo común
            </h3>
            <p className="mt-1 text-xs text-zinc-500">
              Venta suelta que no está en el inventario. No descuenta stock.
            </p>

            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                confirmarComun();
              }}
            >
              <div>
                <label htmlFor="comun-nombre" className="mb-1.5 block text-xs font-medium text-zinc-400">
                  Nombre
                </label>
                <input
                  id="comun-nombre"
                  ref={comunNombreRef}
                  value={comunNombre}
                  onChange={(e) => setComunNombre(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cerrarComun();
                  }}
                  placeholder="Ej. Bolsa, servicio, varios…"
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
              </div>

              <div>
                <label htmlFor="comun-precio" className="mb-1.5 block text-xs font-medium text-zinc-400">
                  Precio (COP)
                </label>
                <input
                  id="comun-precio"
                  inputMode="numeric"
                  value={comunPrecio}
                  onChange={(e) => setComunPrecio(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cerrarComun();
                  }}
                  placeholder="0"
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
              </div>

              <div className="flex gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={cerrarComun}
                  className="h-12 flex-1 rounded-lg border border-zinc-700 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="h-12 flex-1 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-600 text-sm font-semibold text-white shadow-lg shadow-violet-500/30 transition-all active:scale-[0.98]"
                >
                  Agregar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Selector de cliente (para fiar / asociar la venta) ── */}
      {selectorAbierto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cliente-selector-titulo"
          onClick={() => setSelectorAbierto(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-violet-500/25 bg-zinc-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="cliente-selector-titulo" className="text-base font-semibold text-zinc-100">
                  Selecciona un cliente
                </h3>
                <p className="mt-1 text-xs text-zinc-500">
                  Asocia la venta a un cliente para poder fiarla.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectorAbierto(false)}
                aria-label="Cerrar"
                className="shrink-0 rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>

            {faltaFiado ? (
              <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
                El módulo de clientes aún no está activo. Ejecuta{" "}
                <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-xs">
                  supabase/2026-08-clientes-y-fiados.sql
                </code>{" "}
                en Supabase para poder fiar.
              </div>
            ) : (
              <>
                <input
                  autoFocus
                  value={buscarCliente}
                  onChange={(e) => setBuscarCliente(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setSelectorAbierto(false);
                  }}
                  placeholder="Buscar por nombre o teléfono…"
                  className="mt-4 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />

                <div className="mt-3 flex-1 divide-y divide-zinc-800/70 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/60">
                  {clientes.length === 0 ? (
                    <p className="p-6 text-center text-sm text-zinc-500">
                      No hay clientes registrados. Créalos en la sección Clientes.
                    </p>
                  ) : clientesFiltrados.length === 0 ? (
                    <p className="p-6 text-center text-sm text-zinc-500">
                      Sin resultados para “{buscarCliente}”.
                    </p>
                  ) : (
                    clientesFiltrados.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setClienteSel(c);
                          setSelectorAbierto(false);
                        }}
                        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-violet-500/10"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-zinc-100">{c.nombre}</p>
                          {c.telefono && <p className="truncate text-xs text-zinc-500">{c.telefono}</p>}
                        </div>
                        {c.saldo_pendiente > 0 ? (
                          <span className="shrink-0 text-xs font-semibold text-amber-400 tabular-nums">
                            debe {formatCOP(c.saldo_pendiente)}
                          </span>
                        ) : (
                          <span className="shrink-0 text-xs text-emerald-400">al día</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
