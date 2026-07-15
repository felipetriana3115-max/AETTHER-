"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  deriveMonthlyRevenue,
  type InventoryItem,
  type Customer,
  type Sale,
  type SaleStatus,
  type Tier,
  type MonthPoint,
} from "../lib/demo-data";
import type { BoldPaymentStatus } from "../lib/bold";

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

/** Lo que puede traer un archivo/lote importado: cualquier combinación de módulos. */
export type ImportBundle = {
  inventory?: NewInventoryItem[];
  customers?: NewCustomer[];
  sales?: NewSale[];
};

export type Transaction = {
  id: string;
  reference: string;
  amount: number;
  method: string;
  status: BoldPaymentStatus;
  createdAt: string; // ISO
};

/** Resumen de lo que inyectó la importación, para el resumen y el toast. */
export type BulkImportResult = {
  customers: number;
  products: number;
  sales: number;
};

export type Toast = {
  id: number;
  title: string;
  message: string;
};

type DashboardContextValue = {
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

export function DashboardProvider({ children }: { children: ReactNode }) {
  // Sin datos quemados: todo arranca vacío y se llena desde la importación.
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [imported, setImported] = useState(false);

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [extraSales, setExtraSales] = useState(0);

  const [toast, setToast] = useState<Toast | null>(null);
  const [toastSeq, setToastSeq] = useState(0);

  // ── Inventario ─────────────────────────────────────────────────────────────
  const addInventoryItems = useCallback((rows: NewInventoryItem[]) => {
    if (rows.length === 0) return 0;
    setInventory((prev) => {
      let nextId = prev.reduce((max, i) => Math.max(max, i.id), 0);
      const mapped: InventoryItem[] = rows.map((r) => {
        const id = ++nextId;
        return {
          id,
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
      const mapped: Customer[] = rows.map((r) => ({ id: ++nextId, ...r }));
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

  /** Inyecta en los tres módulos lo que traiga el lote importado. */
  const bulkImport = useCallback(
    (bundle: ImportBundle): BulkImportResult => {
      const products = bundle.inventory?.length ? addInventoryItems(bundle.inventory) : 0;
      const custs = bundle.customers?.length ? addCustomers(bundle.customers) : 0;
      const sls = bundle.sales?.length ? addSales(bundle.sales) : 0;
      if (products || custs || sls) setImported(true);
      return { customers: custs, products, sales: sls };
    },
    [addInventoryItems, addCustomers, addSales],
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
    // "Ventas Totales del Mes" = último mes disponible + pagos Bold simulados.
    const lastMonth = monthlyRevenue[monthlyRevenue.length - 1]?.amount ?? 0;
    return {
      inventory,
      addInventoryItems,
      customers,
      addCustomers,
      sales,
      addSales,
      monthlyRevenue,
      salesTotal: lastMonth + extraSales,
      imported,
      bulkImport,
      transactions,
      registerPayment,
      toast,
      showToast,
      dismissToast,
    };
  }, [
    inventory,
    addInventoryItems,
    customers,
    addCustomers,
    sales,
    addSales,
    monthlyRevenue,
    extraSales,
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
