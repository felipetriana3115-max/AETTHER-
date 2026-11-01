"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { useHotkeys } from "react-hotkeys-hook";
import PageShell from "../../components/PageShell";
import { useDashboard } from "../../components/DashboardProvider";
import { getEmpresaIdActiva } from "../../lib/auth";
import BarcodeScanner, { type BarcodeScannerHandle } from "../../components/BarcodeScanner";
import { soportaCamara } from "../../lib/barcode-camera";
import { formatCOP } from "../../lib/data-model";
import { fetchClientes, type Cliente } from "../../lib/clientes";
import { fetchVentasHoyPorMetodo, type VentasHoyPorMetodo } from "../../lib/corte";
import { loadDeviceSettings, type DrawerSettings, type PrinterSettings } from "../../lib/devices";
import { fetchTirilla, DEFAULT_TIRILLA, type TirillaConfig } from "../../lib/tirilla";
import { openCashDrawer, printReceipt, type ReceiptData } from "../../lib/receipt";
import { cacheCatalogo, descontarStockLocal, getFrecuentes } from "../../lib/offline/catalog";
import { enqueueVenta } from "../../lib/offline/outbox";
import { useOffline } from "../../lib/offline/useOffline";
import { useRolSesion } from "../../lib/useRol";
import VentaDetalleModal from "../../components/VentaDetalleModal";
import { buscarVentaPorFolio, type TicketEncontrado } from "../../lib/ventas";
import {
  MAX_EN_ESPERA,
  etiquetaPorDefecto,
  haceCuanto,
  loadEstadoCaja,
  saveEstadoCaja,
  type CarritoEnEspera,
  type LineaCarrito,
  type Producto,
} from "../../lib/pos-carrito";

/**
 * Visor de cámara: se carga bajo demanda (`ssr: false`) porque toca
 * `navigator.mediaDevices` al montar y arrastra el decodificador ZXing (~300 KB).
 * Quien cobra con lector USB nunca lo descarga.
 */
const CameraScanner = dynamic(() => import("../../components/CameraScanner"), { ssr: false });

/**
 * Punto de Venta (POS) táctil — pensado para retail rápido (superior a Eleventa).
 *
 * Fuente de verdad: tabla `public.productos` en Supabase.
 * Columnas reales: id · descripcion · precio_venta · codigo_barras · stock_actual
 * · imagen_url (opcional; sin ella la tarjeta pinta las iniciales).
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
//
// `Producto`, `LineaCarrito` y `CarritoEnEspera` viven en `lib/pos-carrito.ts`
// junto al espejo en `sessionStorage` que conserva la cuenta al navegar.

// Métodos de caja (dinero recibido) + "Fiado" (venta a crédito). El fiado NO es
// caja: se carga al saldo del cliente y se cobra al abonar (ver registrar_venta_fiado).
type MetodoPago = "Efectivo" | "Nequi/Daviplata" | "Bold" | "Fiado";

type Feedback = { tone: "error" | "ok"; msg: string } | null;

/**
 * Pago en efectivo capturado en el modal de cobro: lo que entrega el cliente y
 * el cambio que hay que devolverle. Solo vive en el cliente (UI + tirilla):
 * NO se envía a la cola ni a la RPC, la venta sigue registrándose igual.
 */
type PagoEfectivo = { recibido: number; devuelto: number };

/**
 * Lo que el banner del cambio mantiene anclado en pantalla tras cobrar: el
 * vuelto a entregar más el contexto para verificarlo (qué se cobró y con cuánto
 * pagó el cliente) sin reabrir la calculadora.
 */
type CambioPendiente = PagoEfectivo & { total: number };

// ── Config de UI ─────────────────────────────────────────────────────────────

/** Denominaciones habituales en Colombia para agilizar la caja táctil. */
const MONTOS_RAPIDOS = [10000, 20000, 50000, 100000];

/**
 * `subscribe` vacío para `useSyncExternalStore`: el soporte de cámara del
 * navegador no cambia en caliente. Fuera del componente para que su identidad
 * sea estable entre renders.
 */
const SIN_SUSCRIPCION = () => () => {};

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

/**
 * Tirilla que NO salió por el canal directo (USB o puente). Guardamos el recibo
 * y su pin para poder reintentar exactamente el mismo trabajo desde el aviso.
 */
type ImpresionFallida = {
  msg: string;
  recibo: ReceiptData;
  drawerPin: 0 | 1 | null;
  reintentable: boolean;
};

/**
 * Pin del pulso ESC/POS que debe incrustarse en la tirilla para abrir el cajón
 * en esta venta, o `null` si no debe abrirse. Depende SOLO de la configuración
 * local del equipo (`localStorage`), nunca del tenant.
 *
 * EFECTIVO SIEMPRE ABRE: entra dinero físico y el cajero necesita el cajón para
 * guardar el billete y sacar el cambio, así que el pulso va sí o sí, sin
 * depender de los interruptores de Dispositivos. En un equipo sin cajón
 * conectado el pulso es inocuo (la impresora simplemente lo ignora).
 *
 * Para el resto de métodos manda la configuración; "Fiado" queda fuera aunque
 * esté activo "cualquier método": no entra dinero a la caja, así que no hay
 * motivo para destrabar el cajón.
 */
function pinCajonPara(metodo: MetodoPago, drawer: DrawerSettings): 0 | 1 | null {
  if (metodo === "Efectivo") return drawer.pin;
  if (!drawer.enabled || drawer.trigger !== "printer" || metodo === "Fiado") return null;
  return drawer.autoOpenAllMethods ? drawer.pin : null;
}

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

/**
 * Miniatura de la tarjeta: la foto del producto si tiene una, y si no (o si la
 * URL falla al cargar) exactamente el mismo placeholder de iniciales de antes.
 * Así la imagen es 100% opcional y un enlace roto nunca deja un hueco en el grid.
 */
function Miniatura({ nombre, imagenUrl }: { nombre: string; imagenUrl?: string | null }) {
  const [fallo, setFallo] = useState(false);
  const url = imagenUrl?.trim();

  if (!url || fallo) return <Placeholder nombre={nombre} />;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- URL remota de Storage:
    // miniatura pequeña que no necesita el optimizador de next/image (y evita
    // configurar remotePatterns por proyecto de Supabase).
    <img
      src={url}
      alt={nombre}
      loading="lazy"
      onError={() => setFallo(true)}
      className="h-14 w-full rounded-lg bg-zinc-900 object-cover"
    />
  );
}

export default function PosPage() {
  const { businessName } = useDashboard();

  /**
   * "Vendido hoy" (el acumulado de caja del día) es una cifra del NEGOCIO: solo
   * la ve el dueño. El cajero empleado cobra igual, pero sin el total del día a
   * la vista. Fail-closed: oculta hasta confirmar el rol de administrador.
   * Es gateo de UI; el aislamiento de datos lo sigue imponiendo RLS.
   */
  const { esAdministrador } = useRolSesion();
  const [frecuentes, setFrecuentes] = useState<Producto[]>([]);
  const [carrito, setCarrito] = useState<LineaCarrito[]>([]);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [cobrando, setCobrando] = useState(false);
  // Modal de cobro en efectivo: abierto + monto recibido (solo dígitos).
  const [efectivoAbierto, setEfectivoAbierto] = useState(false);
  const [recibido, setRecibido] = useState("");
  /**
   * Banner del cambio de la última venta en efectivo. NO se autodestruye: el
   * cajero cuenta el vuelto a su ritmo y lo tiene a la vista hasta que empieza
   * la siguiente venta (primer producto en el carrito) o lo cierra a mano. Antes
   * desaparecía solo a los 8 s y, si el cliente se demoraba, el monto exacto a
   * devolver se perdía de pantalla.
   */
  const [devuelto, setDevuelto] = useState<CambioPendiente | null>(null);
  // Pulso del cajón en vuelo (el intento por WebUSB es asíncrono).
  const [abriendoCajon, setAbriendoCajon] = useState(false);
  // Línea seleccionada del carrito (para la tecla Delete). Guarda su `id`.
  const [seleccionado, setSeleccionado] = useState<string | number | null>(null);
  // Modal "Artículo común": abierto + campos del formulario.
  const [comunAbierto, setComunAbierto] = useState(false);
  const [comunNombre, setComunNombre] = useState("");
  const [comunPrecio, setComunPrecio] = useState("");
  // Visor de cámara (escaneo desde móvil/tablet, sin lector físico).
  const [camaraAbierta, setCamaraAbierta] = useState(false);
  // ── Devolución desde el mostrador ────────────────────────────────────────
  // Búsqueda de UN ticket por su folio ("#00291") para poder pedir su
  // devolución sin pasar por el historial de Transacciones.
  const [folioBusqueda, setFolioBusqueda] = useState("");
  const [buscandoTicket, setBuscandoTicket] = useState(false);
  // Ticket localizado: abre `VentaDetalleModal`. null = sin ticket a la vista.
  const [ticket, setTicket] = useState<TicketEncontrado | null>(null);
  // ── Carritos en espera (hold) ────────────────────────────────────────────
  // Cuentas aparcadas para atender a otro cliente sin perder la que se estaba
  // armando. Viven solo en el cliente (nada viaja a Supabase hasta cobrar).
  const [enEspera, setEnEspera] = useState<CarritoEnEspera[]>([]);
  // Modal de pausa: abierto + etiqueta con la que se identificará la cuenta.
  const [pausaAbierta, setPausaAbierta] = useState(false);
  const [etiquetaPausa, setEtiquetaPausa] = useState("");
  const etiquetaPausaRef = useRef<HTMLInputElement>(null);
  // Panel desplegable con la lista de cuentas aparcadas.
  const [esperaAbierta, setEsperaAbierta] = useState(false);
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
  // Aviso de impresión fallida (USB caído / puente sin responder). Vive aparte
  // del `feedback` porque NO debe autodesaparecer: el cajero tiene que ver que
  // esa venta se quedó sin tirilla y poder reintentarla.
  const [avisoImpresion, setAvisoImpresion] = useState<ImpresionFallida | null>(null);
  const [reintentandoImpresion, setReintentandoImpresion] = useState(false);

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

  // ── Persistencia de la caja al navegar ───────────────────────────────────
  // `/dashboard/pos` es una ruta: salir a Inventario desmonta la página y el
  // carrito se perdía. Espejamos carrito + cuentas en espera + cliente en
  // `sessionStorage` (segmentado por empresa) y lo restauramos al volver, así
  // que consultar otra sección ya no cuesta rearmar la cuenta.
  // `hidratado` evita que el primer guardado (aún con el estado vacío del
  // montaje) pise lo que había espejado.
  const [hidratado, setHidratado] = useState(false);

  useEffect(() => {
    const guardado = loadEstadoCaja();
    if (guardado.carrito.length > 0) setCarrito(guardado.carrito);
    if (guardado.enEspera.length > 0) setEnEspera(guardado.enEspera);
    if (guardado.cliente) setClienteSel(guardado.cliente);
    setHidratado(true);
  }, []);

  useEffect(() => {
    if (!hidratado) return;
    saveEstadoCaja({ carrito, enEspera, cliente: clienteSel });
  }, [hidratado, carrito, enEspera, clienteSel]);

  // Modo Sin Internet: estado de red + cola local de ventas. Al terminar una
  // sincronización con éxito, refrescamos el corte del servidor (fuente de verdad).
  const { online, pendientes, totalPend, sincronizando, sincronizar, refresh } = useOffline(() => {
    // Solo el dueño ve el acumulado del día; para el empleado ni se consulta.
    if (esAdministrador) fetchVentasHoyPorMetodo().then(setVentasHoy);
  });

  /**
   * ¿Pintamos el botón de cámara junto al input? Es una capacidad del NAVEGADOR
   * (HTTPS + `getUserMedia`), que el servidor no puede conocer. `useSyncExternalStore`
   * la lee sin romper la hidratación: el servidor renderiza `false` (sin botón)
   * y el cliente lo recalcula al montar.
   */
  const camaraDisponible = useSyncExternalStore(SIN_SUSCRIPCION, soportaCamara, () => false);

  // Autolimpia el feedback tras unos segundos para no dejar alertas pegadas.
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3500);
    return () => clearTimeout(t);
  }, [feedback]);

  // El banner del cambio NO lleva temporizador a propósito (ver `devuelto`):
  // se cierra al iniciar la siguiente venta o con la ✕ del propio aviso.

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

  // Carga las ventas del día para la tarjeta "Vendido hoy". Solo si quien cobra
  // es el dueño: al empleado no se le pinta la tarjeta, así que tampoco se
  // consulta (se re-ejecuta cuando `useRolSesion` confirma el rol).
  useEffect(() => {
    if (!esAdministrador) return;
    let activo = true;
    (async () => {
      const ventas = await fetchVentasHoyPorMetodo();
      if (activo) setVentasHoy(ventas);
    })();
    return () => {
      activo = false;
    };
  }, [esAdministrador]);

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

  // Monto tecleado (solo dígitos) y cambio en tiempo real.
  const montoRecibido = useMemo(() => Number(recibido.replace(/\D/g, "")) || 0, [recibido]);
  const cambio = montoRecibido - total;
  const puedeCobrarEfectivo = carrito.length > 0 && total > 0 && montoRecibido >= total;

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
    // Empieza una venta nueva → el vuelto de la anterior ya se entregó.
    setDevuelto(null);
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

  // ── Carritos en espera (hold) ────────────────────────────────────────────
  //
  // Flujo de mostrador: hay una cuenta a medias y llega alguien con prisa (o el
  // cliente se va a buscar otro producto). En vez de borrar el carrito, se
  // aparca con una etiqueta, se atiende al otro cliente y luego se recupera
  // intacto. Todo vive en el cliente: NADA viaja a Supabase hasta que se cobra,
  // así que una cuenta en espera no toca inventario ni caja.

  /** Abre el modal para etiquetar la cuenta que se va a aparcar. */
  const abrirPausa = useCallback(() => {
    if (carrito.length === 0) {
      setFeedback({ tone: "error", msg: "No hay ninguna cuenta que poner en espera." });
      return;
    }
    if (enEspera.length >= MAX_EN_ESPERA) {
      setFeedback({
        tone: "error",
        msg: `Ya hay ${MAX_EN_ESPERA} cuentas en espera. Cobra o descarta alguna antes de pausar otra.`,
      });
      return;
    }
    setEtiquetaPausa(etiquetaPorDefecto(enEspera));
    setPausaAbierta(true);
  }, [carrito.length, enEspera]);

  const cerrarPausa = useCallback(() => {
    setPausaAbierta(false);
    inputRef.current?.focus();
  }, []);

  // Autofoco (y preselección) de la etiqueta al abrir el modal: así el cajero
  // puede escribir "Señora del sombrero" de un tirón sin borrar el texto.
  useEffect(() => {
    if (pausaAbierta) etiquetaPausaRef.current?.select();
  }, [pausaAbierta]);

  /**
   * Aparca el carrito actual y deja la caja lista para el siguiente cliente.
   * Devuelve el ticket creado para que `recuperarEspera` pueda intercambiar
   * cuentas en una sola actualización de estado.
   */
  const pausarCarrito = useCallback(
    (lineas: LineaCarrito[], cliente: Cliente | null, etiqueta: string): CarritoEnEspera => ({
      // `crypto.randomUUID` está disponible en todo navegador con el POS (HTTPS);
      // el sufijo aleatorio del respaldo evita colisiones al pausar en ráfaga.
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `espera-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      etiqueta: etiqueta.trim() || "Cuenta en espera",
      pausadoEn: new Date().toISOString(),
      lineas,
      cliente,
    }),
    [],
  );

  /** Confirma la pausa: el carrito pasa a la lista y la caja queda limpia. */
  const confirmarPausa = useCallback(() => {
    if (carrito.length === 0) return;
    const ticket = pausarCarrito(carrito, clienteSel, etiquetaPausa);
    setEnEspera((prev) => [...prev, ticket]);
    setCarrito([]);
    setClienteSel(null);
    setSeleccionado(null);
    setDevuelto(null);
    setPausaAbierta(false);
    setFeedback({
      tone: "ok",
      msg: `"${ticket.etiqueta}" quedó en espera (${formatCOP(
        ticket.lineas.reduce((s, l) => s + l.precio * l.qty, 0),
      )}). Recupérala cuando quieras.`,
    });
    inputRef.current?.focus();
  }, [carrito, clienteSel, etiquetaPausa, pausarCarrito]);

  /**
   * Retoma una cuenta aparcada. Si en la caja hay otra cuenta a medias, se
   * APARCA automáticamente en el mismo gesto (intercambio) en vez de perderla:
   * es justo el caso de uso —atender a alguien urgente y volver— y descartar el
   * carrito activo en silencio sería la peor forma de resolverlo.
   */
  const recuperarEspera = useCallback(
    (id: string) => {
      const ticket = enEspera.find((t) => t.id === id);
      if (!ticket) return;

      const hayCuentaActiva = carrito.length > 0;
      const reemplazo = hayCuentaActiva
        ? pausarCarrito(carrito, clienteSel, etiquetaPorDefecto(enEspera))
        : null;

      setEnEspera((prev) => {
        const sinTicket = prev.filter((t) => t.id !== id);
        return reemplazo ? [...sinTicket, reemplazo] : sinTicket;
      });
      setCarrito(ticket.lineas);
      setClienteSel(ticket.cliente);
      setSeleccionado(null);
      setDevuelto(null);
      setEsperaAbierta(false);
      setFeedback({
        tone: "ok",
        msg: reemplazo
          ? `Recuperada "${ticket.etiqueta}". La cuenta que tenías abierta quedó en espera como "${reemplazo.etiqueta}".`
          : `Recuperada "${ticket.etiqueta}".`,
      });
      inputRef.current?.focus();
    },
    [enEspera, carrito, clienteSel, pausarCarrito],
  );

  /** Descarta una cuenta aparcada (nunca se cobró: no hay nada que revertir). */
  const descartarEspera = useCallback((id: string) => {
    setEnEspera((prev) => {
      const ticket = prev.find((t) => t.id === id);
      if (ticket) {
        setFeedback({ tone: "ok", msg: `"${ticket.etiqueta}" se descartó.` });
      }
      return prev.filter((t) => t.id !== id);
    });
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
    // Igual que en `agregar`: una línea nueva estrena venta y cierra el banner.
    setDevuelto(null);
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

  // Ctrl+E → poner la cuenta en espera sin soltar el teclado. Igual que Ctrl+P,
  // se habilita dentro del input del escáner (ahí vive el foco en caja).
  useHotkeys(
    "ctrl+e",
    (e) => {
      e.preventDefault();
      abrirPausa();
    },
    { enableOnFormTags: true, preventDefault: true },
    [abrirPausa],
  );

  // El escaneo por `codigo_barras` lo maneja ahora <BarcodeScanner>, que emite el
  // producto hallado por `onScan` y lo pasamos a `agregar` mapeando sus columnas.

  // ── Escaneo por cámara ───────────────────────────────────────────────────────

  /**
   * Código leído por la cámara. Cerramos el visor (ya sonó el beep dentro) y
   * se lo entregamos al <BarcodeScanner>, que lo pinta en el input y corre la
   * MISMA búsqueda que el lector físico: `findByBarcode` → `onScan` → `agregar`.
   * Ni la consulta ni el filtrado por empresa cambian; esto solo es otra forma
   * de teclear el código.
   */
  const onCodigoCamara = useCallback((codigo: string) => {
    setCamaraAbierta(false);
    inputRef.current?.escanear(codigo);
  }, []);

  // ── Impresión ────────────────────────────────────────────────────────────────

  /**
   * Envía la tirilla por el canal configurado (navegador, USB directo o puente).
   *
   * En USB/puente `printReceipt` NO cae a `window.print()`: devuelve el fallo y
   * aquí lo convertimos en un aviso persistente con reintento. Antes, ese
   * repliegue abría el PDF genérico del navegador en las All-in-One y la venta
   * se quedaba sin tirilla y sin cajón sin que nadie se enterara.
   */
  const imprimirTirilla = useCallback(
    async (recibo: ReceiptData, printer: PrinterSettings, drawerPin: 0 | 1 | null) => {
      const resultado = await printReceipt(
        recibo,
        { ...printer, ...tirillaRef.current },
        { drawerPin },
      );
      if (resultado.ok) {
        setAvisoImpresion(null);
        return true;
      }
      setAvisoImpresion({
        msg: resultado.message,
        recibo,
        drawerPin,
        reintentable: resultado.recoverable,
      });
      return false;
    },
    [],
  );

  /** Reintenta el ÚLTIMO trabajo fallido, tal cual (mismo recibo y mismo pin). */
  const reintentarImpresion = useCallback(async () => {
    const pendiente = avisoImpresion;
    if (!pendiente) return;
    setReintentandoImpresion(true);
    try {
      const { printer } = loadDeviceSettings();
      const ok = await imprimirTirilla(pendiente.recibo, printer, pendiente.drawerPin);
      if (ok) setFeedback({ tone: "ok", msg: "Tirilla impresa." });
    } finally {
      setReintentandoImpresion(false);
      inputRef.current?.focus();
    }
  }, [avisoImpresion, imprimirTirilla]);

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
    async (metodo: MetodoPago, efectivo?: PagoEfectivo) => {
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
          // `pagos` es un desglose libre de líneas: aprovechamos las dos extra
          // para imprimir recibido/cambio sin tocar el formato de la tirilla.
          pagos: [
            { metodo: nombreFiado ? `Fiado · ${nombreFiado}` : metodo, monto: total },
            ...(efectivo
              ? [
                  { metodo: "Recibido", monto: efectivo.recibido },
                  { metodo: "Cambio", monto: efectivo.devuelto },
                ]
              : []),
          ],
        };
        setUltimaVenta(recibo);

        const devices = loadDeviceSettings();
        // El cajón se abre con el mismo trabajo de impresión de la tirilla: el
        // pulso ESC/POS viaja en su cabecera. Si no hay impresión automática, lo
        // emitimos por separado para que el cajero no se quede sin cajón.
        const drawerPin = pinCajonPara(metodo, devices.drawer);
        if (devices.printer.enabled && devices.printer.autoPrint) {
          // Sin `await`: la venta no se bloquea por la impresora. Un fallo del
          // canal directo cae en `avisoImpresion`, no en el diálogo del navegador.
          void imprimirTirilla(recibo, devices.printer, drawerPin);
        } else if (drawerPin != null) {
          void openCashDrawer(drawerPin, devices.printer);
        }

        const okMsg = esFiado
          ? `Fiado a ${nombreFiado}: ${formatCOP(total)} cargado a su cuenta.`
          : efectivo
            ? `Venta cobrada con Efectivo: ${formatCOP(total)} · Devuelto ${formatCOP(efectivo.devuelto)}.`
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
    [carrito, total, businessName, online, sincronizar, refresh, clienteSel, imprimirTirilla],
  );

  // ── Cobro en efectivo (modal con cálculo de cambio) ──────────────────────────

  /** El botón verde ya no cobra: abre el modal para capturar el monto recibido. */
  const abrirEfectivo = useCallback(() => {
    if (carrito.length === 0) {
      setFeedback({ tone: "error", msg: "El carrito está vacío." });
      return;
    }
    setRecibido("");
    setEfectivoAbierto(true);
  }, [carrito.length]);

  const cerrarEfectivo = useCallback(() => {
    setEfectivoAbierto(false);
    setRecibido("");
    inputRef.current?.focus();
  }, []);

  /** Teclado numérico táctil: dígitos, "00", borrar y limpiar. */
  const teclearMonto = useCallback((tecla: string) => {
    setRecibido((prev) => {
      if (tecla === "back") return prev.slice(0, -1);
      if (tecla === "clear") return "";
      return (prev + tecla).replace(/^0+(?=\d)/, "").slice(0, 9);
    });
  }, []);

  /**
   * Confirma el cobro: cierra el modal, deja el banner del devuelto visible y
   * delega en `cobrar` (misma ruta de siempre: cola local → cajón → tirilla).
   */
  const confirmarEfectivo = useCallback(() => {
    if (cobrando || !puedeCobrarEfectivo) return;
    const pago: PagoEfectivo = { recibido: montoRecibido, devuelto: montoRecibido - total };
    setEfectivoAbierto(false);
    setRecibido("");
    // El banner queda anclado con el detalle del pago hasta la siguiente venta.
    setDevuelto({ ...pago, total });
    void cobrar("Efectivo", pago);
  }, [cobrando, puedeCobrarEfectivo, montoRecibido, total, cobrar]);

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
  const reimprimir = useCallback(async () => {
    if (!ultimaVenta) return;
    const { printer } = loadDeviceSettings();
    // `drawerPin: null` EXPLÍCITO: una copia de la tirilla no debe volver a abrir
    // el cajón, aunque sea una orden de 80 mm / 48 columnas.
    await imprimirTirilla(ultimaVenta, printer, null);
  }, [ultimaVenta, imprimirTirilla]);

  /**
   * Abre el cajón sin cobrar (dar cambio, retirar efectivo…). Usa el pin
   * configurado en Dispositivos y no toca el carrito ni la venta.
   *
   * SOLO EL DUEÑO. Un pulso manual saca el cajón de dinero sin dejar rastro en
   * `ventas` ni en `movimientos_caja`: es justo el agujero que descuadra el
   * arqueo. El empleado cobra igual por cualquier método —ahí el pulso lo emite
   * el propio cobro en efectivo— pero no puede abrirlo "porque sí". El botón ni
   * se pinta (ver más abajo); este guard cubre el resto de caminos (hotkey
   * futura, llamada desde la consola).
   */
  const abrirCajon = useCallback(async () => {
    if (!esAdministrador) {
      setFeedback({
        tone: "error",
        msg: "Solo el administrador puede abrir el cajón sin cobrar.",
      });
      return;
    }
    setAbriendoCajon(true);
    try {
      const { drawer, printer } = loadDeviceSettings();
      const resultado = await openCashDrawer(drawer.pin, printer);
      setFeedback(
        resultado.ok
          ? {
              tone: "ok",
              msg:
                resultado.via === "print"
                  ? "Pulso del cajón enviado a la impresora."
                  : "Pulso enviado al cajón.",
            }
          : { tone: "error", msg: resultado.message },
      );
    } finally {
      setAbriendoCajon(false);
      inputRef.current?.focus();
    }
  }, [esAdministrador]);

  /**
   * Busca el ticket que trae el cliente y abre su factura para devolver ítems.
   *
   * Es la ÚNICA puerta del empleado a una venta pasada, y a propósito es una
   * cerradura, no una ventana: se pide un folio concreto y el servidor devuelve
   * como mucho esa fila, acotada al `empresa_id` de la sesión (ver
   * `buscarVentaPorFolio`). No hay listado, ni paginación, ni totales del día:
   * sin el número impreso en la tirilla no se llega a ninguna venta.
   */
  const buscarTicket = useCallback(async () => {
    if (buscandoTicket) return;
    setBuscandoTicket(true);
    setFeedback(null);
    try {
      const { data, error } = await buscarVentaPorFolio(folioBusqueda);
      if (!data) {
        setFeedback({ tone: "error", msg: error ?? "No se encontró esa factura." });
        return;
      }
      setTicket(data);
      setFolioBusqueda("");
    } finally {
      setBuscandoTicket(false);
    }
  }, [buscandoTicket, folioBusqueda]);

  /** Cierra la factura y devuelve el foco al escáner (la caja sigue en marcha). */
  const cerrarTicket = useCallback(() => {
    setTicket(null);
    inputRef.current?.focus();
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <PageShell title="Punto de Venta" subtitle="Caja rápida · Escanea, cobra y descuenta inventario">
      {/* ── Banner del cambio (anclado) ──
          Se pinta al confirmar el cobro y SE QUEDA: sobrevive al vaciado del
          carrito, no caduca por tiempo y viaja pegado bajo la barra superior
          mientras el cajero desplaza la pantalla. Desaparece al añadir el primer
          producto de la siguiente venta o al pulsar "Entregado". */}
      {devuelto && (
        <div
          role="status"
          aria-live="polite"
          className="sticky top-16 z-20 mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-xl border border-emerald-500/40 bg-emerald-950/90 px-5 py-4 shadow-lg shadow-emerald-900/40 backdrop-blur"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="text-xl" aria-hidden>💵</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-emerald-200">
                Venta cobrada en efectivo · Cambio a entregar
              </p>
              <p className="text-xs text-emerald-300/70 tabular-nums">
                Total {formatCOP(devuelto.total)} · Recibido {formatCOP(devuelto.recibido)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-3xl font-bold tabular-nums text-emerald-300">
              {formatCOP(devuelto.devuelto)}
            </span>
            <button
              type="button"
              onClick={() => {
                setDevuelto(null);
                inputRef.current?.focus();
              }}
              title="Ocultar el aviso del cambio"
              className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-100 transition-colors hover:bg-emerald-500/20"
            >
              Entregado
            </button>
          </div>
        </div>
      )}

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

      {/* ── Aviso de impresión directa fallida ──
          No autodesaparece y no se pisa con el feedback de la venta: la venta SÍ
          quedó registrada, lo que falló es la impresora. */}
      {avisoImpresion && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-200"
        >
          <span className="text-base" aria-hidden>🖨️</span>
          <span className="min-w-0 flex-1">
            La venta se registró, pero la tirilla no salió. {avisoImpresion.msg}
          </span>
          {avisoImpresion.reintentable && (
            <button
              type="button"
              onClick={() => void reintentarImpresion()}
              disabled={reintentandoImpresion}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-100 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {reintentandoImpresion ? "Reintentando…" : "Reconectar e imprimir"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setAvisoImpresion(null)}
            aria-label="Descartar aviso de impresión"
            className="rounded-lg px-2 py-1 text-xs text-amber-300/70 transition-colors hover:bg-amber-500/10 hover:text-amber-100"
          >
            ✕
          </button>
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
            {/* Tres vías al mismo flujo: tecleado, lector USB (teclea y cierra
                con Enter) y cámara (botón 📷, solo si el navegador puede abrirla). */}
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <BarcodeScanner
                  ref={inputRef}
                  onScan={(p) => agregar(p)}
                  onNotFound={(codigo) => setFeedback({ tone: "error", msg: `Código ${codigo} no encontrado.` })}
                  onError={(msg) => setFeedback({ tone: "error", msg })}
                />
              </div>
              {camaraDisponible && (
                <button
                  type="button"
                  onClick={() => setCamaraAbierta(true)}
                  title="Escanear con la cámara del dispositivo"
                  aria-label="Escanear el código de barras con la cámara"
                  className="flex w-14 shrink-0 items-center justify-center rounded-lg border border-violet-500/40 bg-violet-500/10 text-violet-300 transition-colors hover:bg-violet-500/20 active:scale-[0.97]"
                >
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                </button>
              )}
            </div>

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

          {/* ── Devolución: buscar el ticket del cliente ──
              Entrada directa a UNA factura por su folio. El cajero teclea (o
              escanea) el número impreso en la tirilla y se abre esa factura
              para elegir ítems y cantidades; al enviarla queda como SOLICITUD
              pendiente en la bandeja del administrador. Nada de historial: sin
              el número no se llega a ninguna venta, y el folio de otro negocio
              simplemente no existe desde aquí. */}
          <div className="rounded-xl border border-amber-500/20 bg-zinc-900/50 p-4">
            <label htmlFor="folio-ticket" className="mb-1.5 block text-xs font-medium text-zinc-400">
              ¿Devolución? Busca la factura del cliente
            </label>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void buscarTicket();
              }}
            >
              <input
                id="folio-ticket"
                value={folioBusqueda}
                onChange={(e) => setFolioBusqueda(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                placeholder="Nº de factura, ej. #00291"
                className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <button
                type="submit"
                disabled={buscandoTicket || folioBusqueda.trim() === ""}
                title="Abre esa factura para solicitar la devolución de sus ítems"
                className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                {buscandoTicket ? "Buscando…" : "Buscar"}
              </button>
            </form>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              {esAdministrador
                ? "Se abre el desglose para elegir ítems y cantidades; puedes aprobar la devolución en el acto."
                : "Se abre el desglose para elegir ítems y cantidades. La devolución queda pendiente de aprobación del administrador: no se mueve stock, ni caja, ni el cajón."}
            </p>
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
                      <Miniatura nombre={p.nombre} imagenUrl={p.imagen_url} />
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
          {/* Vendido hoy: visibilidad del corte de caja sin salir del POS. Es la
              caja del NEGOCIO, así que solo la ve el dueño; el empleado cobra sin
              el acumulado del día a la vista (sus ventas pendientes de sincronizar
              siguen visibles arriba, en la barra de conexión). */}
          {esAdministrador && (
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
          )}

          <div
            className={`border-b border-zinc-800 p-4 ${esAdministrador ? "" : "rounded-t-xl"}`}
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-zinc-100">
                Carrito {unidades > 0 && <span className="text-zinc-500">· {unidades} und</span>}
              </h3>
              {carrito.length > 0 && (
                <span className="hidden text-xs text-zinc-500 sm:inline">
                  Selecciona y pulsa <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-[10px]">Supr</kbd> para borrar
                </span>
              )}
            </div>

            {/* ── Cuentas en espera (hold) ──
                Aparcar la cuenta en curso para atender a otro cliente y
                recuperarla después, sin perder una sola línea. */}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={abrirPausa}
                disabled={carrito.length === 0 || cobrando}
                title="Aparca esta cuenta y deja la caja libre para otro cliente (Ctrl+E)"
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
                Poner en espera
              </button>
              <button
                type="button"
                onClick={() => setEsperaAbierta((v) => !v)}
                disabled={enEspera.length === 0}
                aria-expanded={esperaAbierta}
                title="Ver las cuentas aparcadas"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                En espera
                <span
                  className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                    enEspera.length > 0 ? "bg-amber-500/20 text-amber-300" : "bg-zinc-800 text-zinc-500"
                  }`}
                >
                  {enEspera.length}
                </span>
                <svg
                  className={`h-3.5 w-3.5 transition-transform ${esperaAbierta ? "rotate-180" : ""}`}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </div>

            {esperaAbierta && enEspera.length > 0 && (
              <ul className="mt-2.5 max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/70 p-2">
                {enEspera.map((t) => {
                  const totalTicket = t.lineas.reduce((s, l) => s + l.precio * l.qty, 0);
                  const unidadesTicket = t.lineas.reduce((s, l) => s + l.qty, 0);
                  return (
                    <li
                      key={t.id}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-zinc-800/40"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-zinc-100">
                          {t.etiqueta}
                          {t.cliente && (
                            <span className="ml-1.5 font-normal text-violet-300">· {t.cliente.nombre}</span>
                          )}
                        </p>
                        <p className="truncate text-[11px] text-zinc-500 tabular-nums">
                          {unidadesTicket} und · {formatCOP(totalTicket)} · {haceCuanto(t.pausadoEn)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => recuperarEspera(t.id)}
                        className="shrink-0 rounded-lg border border-violet-500/40 bg-violet-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-violet-200 transition-colors hover:bg-violet-500/20"
                      >
                        Recuperar
                      </button>
                      <button
                        type="button"
                        onClick={() => descartarEspera(t.id)}
                        aria-label={`Descartar ${t.etiqueta}`}
                        title="Descartar esta cuenta en espera"
                        className="shrink-0 rounded-lg px-1.5 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-red-500/10 hover:text-red-400"
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
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
                  onClick={() => (m.id === "Efectivo" ? abrirEfectivo() : cobrar(m.id))}
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

            {/* Apertura manual del cajón (dar cambio, retiros): emite el pulso
                ESC/POS sin registrar ninguna venta.

                SOLO PARA EL DUEÑO (empresa_admin / super_admin). Al empleado no
                se le pinta: un pulso manual saca el cajón sin dejar rastro en
                caja, así que descuadraría el arqueo. Sigue cobrando con normalidad
                por cualquier método —el cobro en efectivo abre el cajón solo— y
                las devoluciones las abre el admin al aprobarlas. Fail-closed:
                hasta que `useRolSesion` confirme el rol, el botón no existe. */}
            {esAdministrador && (
              <button
                type="button"
                onClick={abrirCajon}
                disabled={abriendoCajon}
                title="Envía el pulso ESC/POS al cajón monedero sin cobrar"
                className="mt-2.5 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 py-2.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="20" height="12" rx="2" />
                  <path d="M2 11h20" />
                  <path d="M10 15h4" />
                  <path d="M7 7V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2" />
                </svg>
                {abriendoCajon ? "Abriendo…" : "Abrir Cajón"}
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

      {/* ── Modal: Poner la cuenta en espera ──
          Solo pide una etiqueta para reconocerla después ("Mesa 3", "Señor de
          la gorra"). El carrito no se cobra ni toca inventario: se aparca. */}
      {pausaAbierta && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pausa-titulo"
          onClick={cerrarPausa}
        >
          <form
            className="w-full max-w-sm rounded-2xl border border-amber-500/30 bg-zinc-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              confirmarPausa();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") cerrarPausa();
            }}
          >
            <h3 id="pausa-titulo" className="text-base font-semibold text-zinc-100">
              Poner la cuenta en espera
            </h3>
            <p className="mt-1 text-xs text-zinc-500">
              {unidades} und · {formatCOP(total)}
              {clienteSel && ` · ${clienteSel.nombre}`}. La cuenta se guarda tal cual y no se cobra
              hasta que la recuperes.
            </p>

            <div className="mt-4">
              <label htmlFor="pausa-etiqueta" className="mb-1.5 block text-xs font-medium text-zinc-400">
                ¿Cómo la reconoces?
              </label>
              <input
                id="pausa-etiqueta"
                ref={etiquetaPausaRef}
                value={etiquetaPausa}
                onChange={(e) => setEtiquetaPausa(e.target.value)}
                placeholder="Ej. Mesa 3, señora del sombrero…"
                maxLength={60}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>

            <div className="mt-4 flex gap-2.5">
              <button
                type="button"
                onClick={cerrarPausa}
                className="h-12 flex-1 rounded-lg border border-zinc-700 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="h-12 flex-1 rounded-lg bg-gradient-to-r from-amber-500 to-orange-600 text-sm font-semibold text-white shadow-lg shadow-amber-500/30 transition-all active:scale-[0.98]"
              >
                Poner en espera
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Modal: Cobro en efectivo (monto recibido + cambio) ──
          El botón verde abre esto en vez de cobrar directo. Al confirmar se
          llama a `cobrar("Efectivo", …)`, que es la ruta de venta de siempre
          (cola local → cajón → tirilla); aquí solo calculamos el devuelto. */}
      {efectivoAbierto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="efectivo-titulo"
          onClick={cerrarEfectivo}
        >
          <form
            className="w-full max-w-sm rounded-2xl border border-emerald-500/30 bg-zinc-900 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              confirmarEfectivo();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") cerrarEfectivo();
            }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <h3 id="efectivo-titulo" className="text-base font-semibold text-zinc-100">
                Cobro en efectivo
              </h3>
              <span className="text-xs text-zinc-500">
                {unidades} und · {carrito.length} ítem{carrito.length === 1 ? "" : "s"}
              </span>
            </div>

            {/* Total a cobrar */}
            <div className="mt-3 flex items-baseline justify-between rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3">
              <span className="text-sm text-zinc-400">Total</span>
              <span className="text-2xl font-bold tabular-nums text-zinc-50">{formatCOP(total)}</span>
            </div>

            {/* Monto recibido */}
            <label htmlFor="efectivo-recibido" className="mt-4 mb-1.5 block text-xs font-medium text-zinc-400">
              Monto recibido
            </label>
            <input
              id="efectivo-recibido"
              autoFocus
              inputMode="numeric"
              value={recibido ? formatCOP(montoRecibido) : ""}
              onChange={(e) => setRecibido(e.target.value.replace(/\D/g, "").slice(0, 9))}
              placeholder="$ 0"
              className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-right text-3xl font-bold tabular-nums text-emerald-300 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />

            {/* Montos rápidos + importe exacto */}
            <div className="mt-2.5 grid grid-cols-5 gap-2">
              {MONTOS_RAPIDOS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setRecibido(String(m))}
                  className="h-12 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-sm font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20 active:scale-95"
                >
                  ${m / 1000}k
                </button>
              ))}
              <button
                type="button"
                onClick={() => setRecibido(String(total))}
                title="El cliente paga el importe exacto"
                className="h-12 rounded-lg border border-zinc-700 text-xs font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-95"
              >
                Exacto
              </button>
            </div>

            {/* Teclado numérico táctil */}
            <div className="mt-2.5 grid grid-cols-3 gap-2">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0"].map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => teclearMonto(t)}
                  className="h-14 rounded-lg border border-zinc-800 bg-zinc-950 text-xl font-semibold text-zinc-100 transition-colors hover:bg-zinc-800 active:scale-95"
                >
                  {t}
                </button>
              ))}
              <button
                type="button"
                onClick={() => teclearMonto("back")}
                onDoubleClick={() => teclearMonto("clear")}
                aria-label="Borrar último dígito"
                title="Borrar (doble toque: limpiar)"
                className="h-14 rounded-lg border border-zinc-800 bg-zinc-950 text-xl text-zinc-300 transition-colors hover:bg-red-500/10 hover:text-red-400 active:scale-95"
              >
                ⌫
              </button>
            </div>

            {/* Cambio en tiempo real */}
            <div
              className={`mt-3 flex items-baseline justify-between rounded-xl border px-4 py-3 ${
                puedeCobrarEfectivo
                  ? "border-emerald-500/40 bg-emerald-500/10"
                  : "border-amber-500/30 bg-amber-500/10"
              }`}
            >
              <span className={`text-sm font-medium ${puedeCobrarEfectivo ? "text-emerald-300" : "text-amber-300"}`}>
                {puedeCobrarEfectivo ? "Cambio / Devuelto" : "Faltan"}
              </span>
              <span
                className={`text-2xl font-bold tabular-nums ${
                  puedeCobrarEfectivo ? "text-emerald-300" : "text-amber-300"
                }`}
              >
                {formatCOP(puedeCobrarEfectivo ? cambio : Math.max(0, -cambio))}
              </span>
            </div>

            <div className="mt-4 flex gap-2.5">
              <button
                type="button"
                onClick={cerrarEfectivo}
                className="h-14 flex-1 rounded-xl border border-zinc-700 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={!puedeCobrarEfectivo || cobrando}
                className="h-14 flex-[1.4] rounded-xl bg-gradient-to-r from-emerald-500 to-green-600 text-base font-semibold text-white shadow-lg shadow-emerald-500/30 transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {cobrando ? "Cobrando…" : "Cobrar"}
              </button>
            </div>
          </form>
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

      {/* Visor de cámara a pantalla completa. Se monta solo al pulsar el botón
          (ahí se descarga el decodificador) y se cierra tras la primera lectura. */}
      {camaraAbierta && (
        <CameraScanner
          titulo="Escanear producto"
          onDetectado={onCodigoCamara}
          onCerrar={() => setCamaraAbierta(false)}
        />
      )}

      {/* Factura del ticket buscado. Es el MISMO modal del panel de
          Transacciones, así que el empleado obtiene exactamente el flujo ya
          auditado: selector por ítem con los topes que calcula el servidor,
          motivo y "Solicitar devolución". Quien decide qué puede hacer es el
          rol (el modal lo resuelve por su cuenta con `useRolSesion`) y, en
          última instancia, las RPC. */}
      {ticket && (
        <VentaDetalleModal
          key={ticket.venta.id}
          venta={ticket.venta}
          folio={ticket.folio}
          // Entra directo al selector por ítem: desde el POS se viene a devolver.
          accionInicial="devolver"
          onClose={cerrarTicket}
          // Solo lo dispara el admin que aprueba en el acto: ahí SÍ se movió
          // caja, así que el acumulado del día deja de ser válido.
          onDevuelta={() => {
            if (esAdministrador) void fetchVentasHoyPorMetodo().then(setVentasHoy);
          }}
          // Una solicitud pendiente no toca nada: solo se confirma al cajero.
          onSolicitada={() =>
            setFeedback({
              tone: "ok",
              msg: "Solicitud de devolución enviada al administrador.",
            })
          }
        />
      )}
    </PageShell>
  );
}
