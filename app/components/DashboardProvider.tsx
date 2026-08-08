
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  deriveMonthlyRevenue,
  type InventoryItem,
  type Customer,
  type Sale,
  type SaleStatus,
  type Tier,
  type MonthPoint,
  type PurchaseOrder,
  type PurchaseStatus,
} from "../lib/data-model";
import { supabase, getTenant, getEmpresaIdActiva } from "../lib/auth";
import {
  fetchVentasEmpresa,
  fetchProductosEmpresa,
  fetchTotalVentasEmpresa,
  fetchMetricasRentabilidad,
  fetchComprasEmpresa,
  insertCompras,
  METRICAS_VACIAS,
  type MetricasRentabilidad,
} from "../lib/resumen";

/** Fila de inventario importada desde Excel/CSV, sin id (lo asigna el proveedor). */
export type NewInventoryItem = {
  name: string;
  category: string;
  stock: number;
  price: number;
  minStock?: number;
};

/** Fila de cliente importada desde Excel/CSV, sin id (lo asigna el proveedor). */
export type NewCustomer = {
  name: string;
  email: string;
  phone: string;
  orders: number;
  totalSpent: number;
  tier: Tier;
};

/** Fila de venta importada desde Excel/CSV; el id es opcional (se genera si falta). */
export type NewSale = {
  id?: string;
  customer: string;
  channel: string;
  method: string;
  amount: number;
  status: SaleStatus;
  date: string;
};

/** Fila de compra importada desde Excel/CSV; el id es opcional (se genera si falta). */
export type NewPurchase = {
  id?: string;
  supplier: string;
  items: string;
  units: number;
  cost: number;
  eta: string;
  status: PurchaseStatus;
  /**
   * Vínculo opcional con el catálogo (`productos`) para el impacto en inventario
   * al recibir. Si `productoId` viene, se suma el stock a ese producto; si no, se
   * intenta emparejar por `codigoBarras`/descripción y, en última instancia, se
   * da de alta un producto nuevo. Las importaciones masivas los dejan sin definir.
   */
  productoId?: string | null;
  codigoBarras?: string | null;
};

/** Lo que puede traer un archivo/lote importado: cualquier combinación de módulos. */
export type ImportBundle = {
  inventory?: NewInventoryItem[];
  customers?: NewCustomer[];
  sales?: NewSale[];
  purchases?: NewPurchase[];
};

/** Resumen de lo que inyectó la importación, para el resumen y el toast. */
export type BulkImportResult = {
  customers: number;
  products: number;
  sales: number;
  purchases: number;
};

export type Toast = {
  id: number;
  title: string;
  message: string;
};

type DashboardContextValue = {
  // Identidad de la empresa (configurable por el usuario)
  businessName: string;
  setBusinessName: (name: string) => void;
  // Inventario
  inventory: InventoryItem[];
  addInventoryItems: (rows: NewInventoryItem[]) => number;
  // CRM / Clientes
  customers: Customer[];
  addCustomers: (rows: NewCustomer[]) => number;
  // Ventas
  sales: Sale[];
  addSales: (rows: NewSale[]) => number;
  monthlyRevenue: MonthPoint[];
  salesTotal: number;
  // Rentabilidad (margen real + rotación, calculados en el servidor)
  metricas: MetricasRentabilidad;
  // Compras (persistidas en Supabase; refresca el estado tras cada inserción)
  purchases: PurchaseOrder[];
  addPurchases: (rows: NewPurchase[]) => Promise<number>;
  // Importación (uno o varios archivos → uno o varios módulos)
  imported: boolean;
  bulkImport: (bundle: ImportBundle) => Promise<BulkImportResult>;
  // Toast global
  toast: Toast | null;
  showToast: (title: string, message: string) => void;
  dismissToast: () => void;
};

const DashboardContext = createContext<DashboardContextValue | null>(null);

// ── Caché local SEGMENTADO POR EMPRESA (aislamiento multi-tenant) ────────────
// El caché de la data importada/cargada se guarda bajo una clave que incluye el
// `empresa_id` del tenant activo. Antes era una clave GLOBAL, así que al iniciar
// sesión otra empresa en el MISMO navegador (p. ej. una cuenta nueva y vacía)
// heredaba del caché los productos/ventas de la empresa anterior (fuga de datos
// entre tenants). Con la clave segmentada, cada empresa solo puede leer su propio
// caché y una cuenta nueva arranca vacía.

/** Base de la clave de la data importada (se sufija con el empresa_id). */
const STORAGE_KEY_BASE = "mi-dashboard-erp:v1";

/** Base de la clave del nombre de la empresa (se sufija con el empresa_id). */
const BUSINESS_NAME_KEY_BASE = "mi-dashboard-erp:businessName:v1";

/** Claves GLOBALES antiguas (pre-segmentación). Se purgan para borrar datos
 *  de otro tenant que hubieran quedado cacheados en navegadores existentes. */
const LEGACY_KEYS = [STORAGE_KEY_BASE, BUSINESS_NAME_KEY_BASE];

/**
 * Clave de caché del tenant activo, o `null` si aún no se conoce la empresa
 * (sesión no resuelta o super_admin sin empresa). Con `null` NO se hidrata ni se
 * persiste nada: así jamás se lee/escribe un caché que no sea el de esta empresa.
 */
function tenantKey(base: string): string | null {
  const empresaId = getTenant()?.empresaId;
  return empresaId ? `${base}:${empresaId}` : null;
}

/** Nombre por defecto cuando el usuario aún no ha configurado el suyo. */
const DEFAULT_BUSINESS_NAME = "Mi Empresa";

/**
 * Identificador del inquilino (cliente) actual. Base de la arquitectura
 * multi-inquilino: por ahora es un valor fijo, pero es el ÚNICO punto donde el
 * proveedor obtiene el `clientId` que estampa en cada registro creado.
 * TODO(multi-tenant): reemplazar por el clientId del contexto de autenticación
 * del usuario actual cuando exista la sesión.
 */
const CURRENT_CLIENT_ID = "default";

export function DashboardProvider({ children }: { children: ReactNode }) {
  // Nombre de la empresa: configurable y persistente. Arranca con el valor por
  // defecto y se hidrata desde localStorage al montar (ver efecto de abajo).
  const [businessName, setBusinessNameState] = useState(DEFAULT_BUSINESS_NAME);

  // Sin datos quemados: todo arranca vacío y se llena desde la importación.
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [purchases, setPurchases] = useState<PurchaseOrder[]>([]);
  const [imported, setImported] = useState(false);

  // Total de ventas: SIEMPRE el número que devuelve la RPC del servidor
  // (`total_ventas_empresa`). NO se deriva de `sales` ni de localStorage, así que
  // es idéntico en todos los dispositivos. Arranca en 0 hasta que la RPC responde.
  const [salesTotal, setSalesTotal] = useState(0);

  // Margen real + rotación: también del servidor (metricas_rentabilidad_empresa),
  // que cruza ventas.items con productos.precio_costo. Arranca en ceros.
  const [metricas, setMetricas] = useState<MetricasRentabilidad>({
    ingresos: 0,
    costo: 0,
    unidadesVendidas: 0,
    valorInventarioCosto: 0,
    margen: 0,
    rotacion: 0,
  });

  const [toast, setToast] = useState<Toast | null>(null);
  const [toastSeq, setToastSeq] = useState(0);

  // ── Persistencia en localStorage ─────────────────────────────────────────────
  // La data importada sobrevive a las recargas: se recupera al montar y se
  // guarda ante cualquier cambio de inventario, ventas o compras. `hydrated`
  // evita que el guardado inicial (aún con estados vacíos) pise lo almacenado.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      // Purga cualquier caché GLOBAL antiguo (pre-segmentación): pudo quedar con
      // datos de otra empresa y sería una fuga entre tenants si se leyera.
      for (const legacy of LEGACY_KEYS) localStorage.removeItem(legacy);

      // Solo se hidrata el caché de la PROPIA empresa. Sin empresa conocida no se
      // toca nada (evita heredar datos de otro tenant en el mismo navegador).
      const key = tenantKey(STORAGE_KEY_BASE);
      const raw = key ? localStorage.getItem(key) : null;
      if (raw) {
        const saved = JSON.parse(raw) as Partial<{
          inventory: InventoryItem[];
          sales: Sale[];
          purchases: PurchaseOrder[];
        }>;
        if (Array.isArray(saved.inventory)) setInventory(saved.inventory);
        if (Array.isArray(saved.sales)) setSales(saved.sales);
        if (Array.isArray(saved.purchases)) setPurchases(saved.purchases);
        if (saved.inventory?.length || saved.sales?.length || saved.purchases?.length) {
          setImported(true);
        }
      }
    } catch {
      // localStorage inaccesible o JSON corrupto → se arranca con estados vacíos.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return; // no persistir hasta haber recuperado lo almacenado
    const key = tenantKey(STORAGE_KEY_BASE);
    if (!key) return; // sin empresa conocida no se cachea nada (aislamiento)
    try {
      localStorage.setItem(key, JSON.stringify({ inventory, sales, purchases }));
    } catch {
      // cuota excedida o modo privado → se ignora el guardado.
    }
  }, [hydrated, inventory, sales, purchases]);

  // ── Carga desde Supabase (fuente de verdad multi-tenant) ─────────────────────
  // La empresa se resuelve de la SESIÓN VIVA (getEmpresaIdActiva → mi_empresa()),
  // no de localStorage. Cada lectura filtra explícitamente por `empresa_id` además
  // de RLS (defensa en profundidad). Al CAMBIAR de empresa en el mismo montaje del
  // provider (p. ej. logout/login de otra cuenta sin recargar la página) se
  // descarta TODO el estado de la empresa anterior ANTES de pintar la nueva, para
  // que una cuenta nueva y vacía jamás herede métricas del tenant previo.

  /** empresa_id cuyos datos están cargados en el estado actual (null = ninguna). */
  const loadedEmpresaRef = useRef<string | null>(null);

  /** Vacía TODO el estado derivado del tenant (métricas incluidas). */
  const resetTenantState = useCallback((empresaId: string | null) => {
    loadedEmpresaRef.current = empresaId;
    setInventory([]);
    setSales([]);
    setPurchases([]);
    setCustomers([]);
    setSalesTotal(0);
    setMetricas(METRICAS_VACIAS);
    setImported(false);
  }, []);

  useEffect(() => {
    let activo = true;

    const cargar = async () => {
      // Fuente autoritativa de la empresa: la sesión viva, NO localStorage.
      const empresaId = await getEmpresaIdActiva();
      if (!activo) return;

      // Sin empresa resuelta (sin sesión / super_admin sin empresa): no se consulta
      // y se limpia cualquier dato heredado. Nunca se muestran filas de otro tenant.
      if (!empresaId) {
        resetTenantState(null);
        return;
      }

      // Cambió el tenant respecto a lo que hay pintado → descartar lo anterior YA,
      // antes incluso de que respondan las consultas de la empresa nueva.
      if (loadedEmpresaRef.current !== empresaId) {
        resetTenantState(empresaId);
      }

      const [ventas, productos, total, mets, compras] = await Promise.all([
        fetchVentasEmpresa(),
        fetchProductosEmpresa(),
        fetchTotalVentasEmpresa(),
        fetchMetricasRentabilidad(),
        fetchComprasEmpresa(),
      ]);
      // La empresa pudo cambiar mientras viajaban las consultas: si ya no
      // corresponde a la que resolvimos, descartamos esta respuesta (evita pintar
      // datos de un tenant que ya no es el activo).
      if (!activo || loadedEmpresaRef.current !== empresaId) return;

      // Reemplazamos (no acumulamos) con la verdad del servidor de ESTA empresa,
      // aplicando SIEMPRE el resultado —incluido vacío/0— para que una cuenta nueva
      // y vacía muestre ceros en vez de arrastrar la cifra del tenant anterior.
      setSales(ventas);
      setInventory(productos);
      setSalesTotal(total);
      setMetricas(mets);
      setPurchases(compras);
      setImported(ventas.length > 0 || productos.length > 0 || compras.length > 0);
    };

    // 1) Intento inicial: si la sesión YA está hidratada, cargamos de una.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (activo && session) cargar();
    });

    // 2) Fuente de verdad para el arranque en frío y los cambios de cuenta:
    //    onAuthStateChange dispara al rehidratar (INITIAL_SESSION), al iniciar
    //    sesión (SIGNED_IN) y al cerrarla (SIGNED_OUT). En SIGNED_OUT limpiamos el
    //    estado; en el resto recargamos resolviendo la empresa de la sesión viva.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!activo) return;
      if (event === "SIGNED_OUT" || !session) {
        resetTenantState(null);
        return;
      }
      cargar();
    });

    return () => {
      activo = false;
      subscription.unsubscribe();
    };
  }, [resetTenantState]);

  // ── Nombre de la empresa ─────────────────────────────────────────────────────
  // Se hidrata una vez al montar; el guardado ocurre en el setter para no pisar
  // el valor por defecto durante el primer render en el servidor/cliente.
  useEffect(() => {
    try {
      const key = tenantKey(BUSINESS_NAME_KEY_BASE);
      const saved = key ? localStorage.getItem(key) : null;
      if (saved) setBusinessNameState(saved);
    } catch {
      // localStorage inaccesible → se conserva el nombre por defecto.
    }
  }, []);

  /** Actualiza y persiste el nombre; vacío o solo espacios → vuelve al defecto. */
  const setBusinessName = useCallback((name: string) => {
    const next = name.trim() || DEFAULT_BUSINESS_NAME;
    setBusinessNameState(next);
    try {
      const key = tenantKey(BUSINESS_NAME_KEY_BASE);
      if (key) localStorage.setItem(key, next);
    } catch {
      // cuota excedida o modo privado → se ignora el guardado.
    }
  }, []);

  // ── Inventario ─────────────────────────────────────────────────────────────
  const addInventoryItems = useCallback((rows: NewInventoryItem[]) => {
    if (rows.length === 0) return 0;
    setInventory((prev) => {
      let nextId = prev.reduce((max, i) => Math.max(max, i.id), 0);
      const mapped: InventoryItem[] = rows.map((r) => {
        const id = ++nextId;
        return {
          id,
          clientId: CURRENT_CLIENT_ID,
          sku: `IMP-${String(id).padStart(4, "0")}`,
          name: r.name,
          category: r.category,
          stock: r.stock,
          minStock: r.minStock ?? 10,
          price: r.price,
        };
      });
      return [...mapped, ...prev];
    });
    return rows.length;
  }, []);

  // ── Clientes ─────────────────────────────────────────────────────────────
  const addCustomers = useCallback((rows: NewCustomer[]) => {
    if (rows.length === 0) return 0;
    setCustomers((prev) => {
      let nextId = prev.reduce((max, c) => Math.max(max, c.id), 0);
      const mapped: Customer[] = rows.map((r) => ({ id: ++nextId, clientId: CURRENT_CLIENT_ID, ...r }));
      return [...prev, ...mapped];
    });
    return rows.length;
  }, []);

  // ── Ventas ─────────────────────────────────────────────────────────────
  const addSales = useCallback((rows: NewSale[]) => {
    if (rows.length === 0) return 0;
    setSales((prev) => {
      let seq = prev.length;
      const mapped: Sale[] = rows.map((r) => ({
        id: r.id && r.id.trim() ? r.id.trim() : `TX-${String(++seq).padStart(5, "0")}`,
        clientId: CURRENT_CLIENT_ID,
        customer: r.customer,
        channel: r.channel,
        method: r.method,
        amount: r.amount,
        status: r.status,
        date: r.date,
      }));
      return [...mapped, ...prev];
    });
    return rows.length;
  }, []);

  // ── Compras ─────────────────────────────────────────────────────────────
  // Las órdenes se PERSISTEN en Supabase (`public.compras`, aislada por RLS y por
  // filtro explícito de `empresa_id`), no solo en memoria/localStorage: por eso
  // sobreviven a las recargas. Tras insertar, se RELEE la tabla para reflejar la
  // verdad del servidor (folios reales OC-####, orden por fecha) en el estado.
  const addPurchases = useCallback(async (rows: NewPurchase[]): Promise<number> => {
    if (rows.length === 0) return 0;
    const insertadas = await insertCompras(rows);
    if (insertadas > 0) {
      // Fuente de verdad: lo que quedó guardado en la BD de ESTA empresa.
      const compras = await fetchComprasEmpresa();
      setPurchases(compras);
      setImported((prev) => prev || compras.length > 0);
    }
    return insertadas;
  }, []);

  /** Inyecta en los cuatro módulos lo que traiga el lote importado. Las compras
   *  se PERSISTEN en Supabase (addPurchases es asíncrono), por eso el resultado
   *  también lo es: el importador espera a que la BD confirme antes del toast. */
  const bulkImport = useCallback(
    async (bundle: ImportBundle): Promise<BulkImportResult> => {
      const products = bundle.inventory?.length ? addInventoryItems(bundle.inventory) : 0;
      const custs = bundle.customers?.length ? addCustomers(bundle.customers) : 0;
      const sls = bundle.sales?.length ? addSales(bundle.sales) : 0;
      const purch = bundle.purchases?.length ? await addPurchases(bundle.purchases) : 0;
      if (products || custs || sls || purch) setImported(true);
      return { customers: custs, products, sales: sls, purchases: purch };
    },
    [addInventoryItems, addCustomers, addSales, addPurchases],
  );

  const showToast = useCallback((title: string, message: string) => {
    setToastSeq((seq) => {
      const id = seq + 1;
      setToast({ id, title, message });
      return id;
    });
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  // Los ingresos mensuales se derivan de las ventas vivas (no hay datos quemados).
  const monthlyRevenue = useMemo(() => deriveMonthlyRevenue(sales), [sales]);

  const value = useMemo<DashboardContextValue>(() => {
    return {
      businessName,
      setBusinessName,
      inventory,
      addInventoryItems,
      customers,
      addCustomers,
      sales,
      addSales,
      monthlyRevenue,
      // Total exacto del servidor (RPC), no una derivación local por dispositivo.
      salesTotal,
      // Margen real + rotación (RPC), tampoco derivados en el cliente.
      metricas,
      purchases,
      addPurchases,
      imported,
      bulkImport,
      toast,
      showToast,
      dismissToast,
    };
  }, [
    businessName,
    setBusinessName,
    inventory,
    addInventoryItems,
    customers,
    addCustomers,
    sales,
    addSales,
    monthlyRevenue,
    salesTotal,
    metricas,
    purchases,
    addPurchases,
    imported,
    bulkImport,
    toast,
    showToast,
    dismissToast,
  ]);

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboard debe usarse dentro de <DashboardProvider>");
  return ctx;
}
