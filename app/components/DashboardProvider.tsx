
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  deriveMonthlyRevenue,
  headlineRevenue,
  type InventoryItem,
  type Customer,
  type Sale,
  type SaleStatus,
  type Tier,
  type MonthPoint,
  type PurchaseOrder,
  type PurchaseStatus,
} from "../lib/demo-data";
import type { BoldPaymentStatus } from "../lib/bold";
import type { PaymentMethod } from "../lib/payments/types";
import { supabase } from "../lib/auth";
import { fetchVentasEmpresa, fetchProductosEmpresa } from "../lib/resumen";

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
};

/** Lo que puede traer un archivo/lote importado: cualquier combinación de módulos. */
export type ImportBundle = {
  inventory?: NewInventoryItem[];
  customers?: NewCustomer[];
  sales?: NewSale[];
  purchases?: NewPurchase[];
};

export type Transaction = {
  id: string;
  reference: string;
  amount: number;
  method: string;
  /** Método de pago elegido en el POS (Wompi). Opcional para compatibilidad
   *  con transacciones previas que solo traían `method` como texto libre. */
  paymentMethod?: PaymentMethod;
  status: BoldPaymentStatus;
  createdAt: string; // ISO
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
  // Compras
  purchases: PurchaseOrder[];
  addPurchases: (rows: NewPurchase[]) => number;
  // Importación (uno o varios archivos → uno o varios módulos)
  imported: boolean;
  bulkImport: (bundle: ImportBundle) => BulkImportResult;
  // Pagos en vivo (Bold)
  transactions: Transaction[];
  registerPayment: (tx: Transaction) => void;
  // Toast global
  toast: Toast | null;
  showToast: (title: string, message: string) => void;
  dismissToast: () => void;
};

const DashboardContext = createContext<DashboardContextValue | null>(null);

/** Clave de localStorage para persistir la data importada entre recargas. */
const STORAGE_KEY = "mi-dashboard-erp:v1";

/** Clave de localStorage para el nombre de la empresa configurado por el usuario. */
const BUSINESS_NAME_KEY = "mi-dashboard-erp:businessName:v1";

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

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [extraSales, setExtraSales] = useState(0);

  const [toast, setToast] = useState<Toast | null>(null);
  const [toastSeq, setToastSeq] = useState(0);

  // ── Persistencia en localStorage ─────────────────────────────────────────────
  // La data importada sobrevive a las recargas: se recupera al montar y se
  // guarda ante cualquier cambio de inventario, ventas o compras. `hydrated`
  // evita que el guardado inicial (aún con estados vacíos) pise lo almacenado.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
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
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ inventory, sales, purchases }));
    } catch {
      // cuota excedida o modo privado → se ignora el guardado.
    }
  }, [hydrated, inventory, sales, purchases]);

  // ── Carga desde Supabase (fuente de verdad multi-tenant) ─────────────────────
  // Si hay sesión activa, la data real de la empresa manda sobre lo local: RLS ya
  // la deja aislada por `empresa_id = mi_empresa()` (resuelto desde `auth.uid()`),
  // así que NO se filtra por tenant en el cliente. Sin sesión no se toca nada: RLS
  // devolvería cero filas, y conservamos lo importado localmente como fallback.
  useEffect(() => {
    let activo = true;

    // Carga real de la empresa. RLS ya aísla por `empresa_id = mi_empresa()`,
    // así que basta con que la petición viaje con la sesión activa.
    const cargar = async () => {
      const [ventas, productos] = await Promise.all([
        fetchVentasEmpresa(),
        fetchProductosEmpresa(),
      ]);
      if (!activo) return;
      // Reemplazamos (no acumulamos) para reflejar el estado real del servidor.
      if (ventas.length) setSales(ventas);
      if (productos.length) setInventory(productos);
    };

    // 1) Intento inicial: si la sesión YA está hidratada, cargamos de una.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (activo && session) cargar();
    });

    // 2) Fuente de verdad para el arranque en frío: onAuthStateChange dispara
    //    cuando el cliente termina de rehidratar la sesión desde storage (evento
    //    INITIAL_SESSION) o cuando el usuario inicia sesión (SIGNED_IN). Así NO
    //    consultamos con sesión vacía —causa del dashboard en $0 en incógnito—.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (activo && session) cargar();
    });

    return () => {
      activo = false;
      subscription.unsubscribe();
    };
  }, []);

  // ── Nombre de la empresa ─────────────────────────────────────────────────────
  // Se hidrata una vez al montar; el guardado ocurre en el setter para no pisar
  // el valor por defecto durante el primer render en el servidor/cliente.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(BUSINESS_NAME_KEY);
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
      localStorage.setItem(BUSINESS_NAME_KEY, next);
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
  const addPurchases = useCallback((rows: NewPurchase[]) => {
    if (rows.length === 0) return 0;
    setPurchases((prev) => {
      let seq = prev.length;
      const mapped: PurchaseOrder[] = rows.map((r) => ({
        id: r.id && r.id.trim() ? r.id.trim() : `OC-${String(++seq).padStart(4, "0")}`,
        clientId: CURRENT_CLIENT_ID,
        supplier: r.supplier,
        items: r.items,
        units: r.units,
        cost: r.cost,
        eta: r.eta,
        status: r.status,
      }));
      return [...mapped, ...prev];
    });
    return rows.length;
  }, []);

  /** Inyecta en los cuatro módulos lo que traiga el lote importado. */
  const bulkImport = useCallback(
    (bundle: ImportBundle): BulkImportResult => {
      const products = bundle.inventory?.length ? addInventoryItems(bundle.inventory) : 0;
      const custs = bundle.customers?.length ? addCustomers(bundle.customers) : 0;
      const sls = bundle.sales?.length ? addSales(bundle.sales) : 0;
      const purch = bundle.purchases?.length ? addPurchases(bundle.purchases) : 0;
      if (products || custs || sls || purch) setImported(true);
      return { customers: custs, products, sales: sls, purchases: purch };
    },
    [addInventoryItems, addCustomers, addSales, addPurchases],
  );

  const registerPayment = useCallback((tx: Transaction) => {
    setTransactions((prev) => [tx, ...prev]);
    if (tx.status === "SUCCESSFUL") {
      setExtraSales((prev) => prev + tx.amount);
    }
  }, []);

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
    // "Ventas Totales del Mes" = ingreso del mes actual y, si el mes actual no
    // tiene datos, la tendencia histórica (último mes registrado) + pagos Bold.
    const headline = headlineRevenue(monthlyRevenue);
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
      salesTotal: headline + extraSales,
      purchases,
      addPurchases,
      imported,
      bulkImport,
      transactions,
      registerPayment,
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
    extraSales,
    purchases,
    addPurchases,
    imported,
    bulkImport,
    transactions,
    registerPayment,
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
