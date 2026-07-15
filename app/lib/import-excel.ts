// Lectura real de Excel/CSV con SheetJS y mapeo al modelo del ERP.
//
// Cada hoja de cada archivo se clasifica por sus ENCABEZADOS (inventario,
// clientes o ventas) y sus columnas se mapean exactamente a la estructura que
// esperan los estados de React del <DashboardProvider>. Tolerante a acentos,
// mayúsculas, orden de columnas, sinónimos y formatos numéricos es-CO/en-US.

import * as XLSX from "xlsx";
import type { SaleStatus, Tier, PurchaseStatus } from "./demo-data";
import type {
  NewInventoryItem,
  NewCustomer,
  NewSale,
  NewPurchase,
  ImportBundle,
} from "../components/DashboardProvider";

export type ParseReport = {
  bundle: ImportBundle;
  matched: { inventory: number; customers: number; sales: number; purchases: number };
  sheetsSeen: number;
  unknownSheets: string[];
};

type Grid = (string | number | boolean | null)[][];
type Row = (string | number | boolean | null)[];

// ── Normalización ────────────────────────────────────────────────────────────

const norm = (s: unknown) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** Convierte texto/numero a número tolerando "$", separadores es-CO y en-US. */
function toNumber(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  let s = String(v ?? "").trim();
  if (!s) return 0;
  s = s.replace(/[^\d,.-]/g, ""); // quita $, espacios, letras, %
  if (!s || s === "-" || s === "." || s === ",") return 0;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // Coma decimal (es-CO): "1.234.567,89" → miles con punto.
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // Punto decimal (en-US): "1,234,567.89" → miles con coma.
    s = s.replace(/,/g, "");
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

const toInt = (v: unknown): number => Math.round(toNumber(v));
const text = (row: Row, i: number): string => (i >= 0 ? String(row[i] ?? "").trim() : "");
const extOf = (name: string): string => name.split(".").pop()?.toLowerCase() ?? "";

/** Localiza el índice de una columna por cualquiera de sus sinónimos. */
function makeIndexer(headers: string[]) {
  const normed = headers.map(norm);
  return (...names: string[]): number => {
    const wanted = names.map(norm);
    // 1) coincidencia exacta
    let i = normed.findIndex((h) => wanted.includes(h));
    if (i >= 0) return i;
    // 2) coincidencia parcial (solo tokens ≥ 4 chars, evita falsos positivos como "id" ⊂ "unidad")
    i = normed.findIndex((h) => wanted.some((w) => w.length >= 4 && h.includes(w)));
    return i;
  };
}

// ── Normalizadores de dominio ────────────────────────────────────────────────

function normalizeTier(v: unknown): Tier {
  const s = norm(v);
  if (s.includes("oro") || s.includes("gold") || s.includes("premium")) return "Oro";
  if (s.includes("plata") || s.includes("silver")) return "Plata";
  return "Bronce";
}

function normalizeStatus(v: unknown): SaleStatus {
  const s = norm(v);
  if (s.includes("reembols") || s.includes("refund") || s.includes("devuel") || s.includes("anul"))
    return "Reembolsado";
  if (s.includes("pend") || s.includes("proceso") || s.includes("espera")) return "Pendiente";
  return "Pagado";
}

function normalizePurchaseStatus(v: unknown): PurchaseStatus {
  const s = norm(v);
  if (s.includes("cancel") || s.includes("anul") || s.includes("rechaz")) return "Cancelado";
  if (
    s.includes("recib") ||
    s.includes("entreg") ||
    s.includes("complet") ||
    s.includes("received") ||
    s.includes("cerrad")
  )
    return "Recibido";
  return "Pendiente";
}

// ── Clasificación + mapeo de una hoja ─────────────────────────────────────────

type SheetKind = "inventory" | "customers" | "sales" | "purchases" | "unknown";

function classifyAndMap(headers: string[], body: Row[], bundle: ImportBundle): SheetKind {
  const at = makeIndexer(headers);

  // Inventario
  const iName = at("producto", "nombre", "product", "item", "articulo", "descripcion");
  const iCategory = at("categoria", "category", "tipo", "linea", "familia");
  const iStock = at("stock", "existencia", "existencias", "cantidad", "inventario", "unidades");
  const iPrice = at("precio", "price", "precio unitario");
  const iMin = at("minimo", "stock minimo", "reorden", "min");
  const iSku = at("sku", "codigo", "cod", "referencia interna");

  // Clientes
  const iEmail = at("email", "correo", "correo electronico", "mail", "e-mail");
  const iPhone = at("telefono", "celular", "phone", "movil", "contacto");
  const iOrders = at("pedidos", "ordenes", "compras", "orders");
  const iSpent = at("total gastado", "compras acumuladas", "gastado", "ltv", "valor total", "total");
  const iTier = at("tier", "nivel", "segmento", "membresia", "categoria cliente");

  // Ventas
  const iCustomer = at("cliente", "comprador", "razon social");
  const iChannel = at("canal", "channel", "origen", "fuente");
  const iMethod = at("metodo", "medio de pago", "forma de pago", "pago", "payment");
  const iAmount = at("monto", "importe", "valor venta", "venta", "amount", "total venta", "valor", "total");
  const iStatus = at("estado", "status", "estado pago");
  const iDate = at("fecha", "date", "fecha venta");
  const iRef = at("referencia", "factura", "transaccion", "comprobante", "id venta");

  // Compras
  const pSupplier = at("proveedor", "supplier", "vendor", "distribuidor", "fabricante");
  const pItems = at("insumos", "insumo", "articulos", "articulo", "items", "material", "producto", "descripcion", "detalle");
  const pUnits = at("unidades", "cantidad", "units", "qty", "cantidad pedida");
  const pCost = at("costo", "costo total", "valor compra", "cost", "importe", "total compra", "total");
  const pEta = at("entrega", "eta", "fecha entrega", "fecha de entrega", "llegada", "recepcion");
  const pStatus = at("estado", "status", "estado orden");
  const pId = at("orden", "oc", "orden de compra", "numero orden", "no orden", "id orden");

  // Decisión por señales EXCLUSIVAS de cada módulo (orden de prioridad).
  // "Proveedor" es la señal exclusiva de Compras: gana antes que Inventario
  // (evita que "unidades" o "costo" lo clasifiquen como stock).
  let kind: SheetKind = "unknown";
  if (pSupplier >= 0 && (pCost >= 0 || pUnits >= 0 || pEta >= 0 || pStatus >= 0)) kind = "purchases";
  else if (iStock >= 0 || iSku >= 0) kind = "inventory";
  else if (iEmail >= 0 || iTier >= 0 || iOrders >= 0) kind = "customers";
  else if (iStatus >= 0 || iChannel >= 0 || iRef >= 0 || iDate >= 0) kind = "sales";
  else if (iName >= 0 && iPrice >= 0) kind = "inventory";

  if (kind === "inventory") {
    const rows: NewInventoryItem[] = [];
    for (const r of body) {
      const name = text(r, iName);
      if (!name) continue;
      rows.push({
        name,
        category: text(r, iCategory) || "Sin categoría",
        stock: toInt(r[iStock]),
        price: toNumber(r[iPrice]),
        ...(iMin >= 0 ? { minStock: toInt(r[iMin]) } : {}),
      });
    }
    bundle.inventory = [...(bundle.inventory ?? []), ...rows];
  } else if (kind === "customers") {
    const nameIdx = iName >= 0 ? iName : iCustomer;
    const rows: NewCustomer[] = [];
    for (const r of body) {
      const name = text(r, nameIdx);
      if (!name) continue;
      rows.push({
        name,
        email: text(r, iEmail),
        phone: text(r, iPhone),
        orders: toInt(r[iOrders]),
        totalSpent: toNumber(r[iSpent]),
        tier: normalizeTier(iTier >= 0 ? r[iTier] : ""),
      });
    }
    bundle.customers = [...(bundle.customers ?? []), ...rows];
  } else if (kind === "sales") {
    const custIdx = iCustomer >= 0 ? iCustomer : iName;
    const rows: NewSale[] = [];
    for (const r of body) {
      const customer = text(r, custIdx);
      const amount = toNumber(r[iAmount]);
      if (!customer && amount === 0) continue;
      rows.push({
        id: text(r, iRef),
        customer: customer || "—",
        channel: text(r, iChannel) || "—",
        method: text(r, iMethod) || "—",
        amount,
        status: normalizeStatus(iStatus >= 0 ? r[iStatus] : ""),
        date: text(r, iDate),
      });
    }
    bundle.sales = [...(bundle.sales ?? []), ...rows];
  } else if (kind === "purchases") {
    const rows: NewPurchase[] = [];
    for (const r of body) {
      const supplier = text(r, pSupplier);
      const items = text(r, pItems);
      if (!supplier && !items) continue;
      rows.push({
        id: text(r, pId),
        supplier: supplier || "—",
        items: items || "—",
        units: toInt(r[pUnits]),
        cost: toNumber(r[pCost]),
        eta: text(r, pEta),
        status: normalizePurchaseStatus(pStatus >= 0 ? r[pStatus] : ""),
      });
    }
    bundle.purchases = [...(bundle.purchases ?? []), ...rows];
  }

  return kind;
}

// ── Entrada pública ───────────────────────────────────────────────────────────

/** Lee y parsea varios archivos, agregando todo en un único lote importable. */
export async function parseFilesToBundle(files: File[]): Promise<ParseReport> {
  const bundle: ImportBundle = {};
  const unknownSheets: string[] = [];
  let sheetsSeen = 0;

  for (const file of files) {
    let workbook: XLSX.WorkBook;
    try {
      const buf = await file.arrayBuffer();
      // Los .xlsx/.xls llevan su propia codificación (UTF-8 interno). Los .csv
      // se decodifican explícitamente como UTF-8 para no corromper acentos/ñ.
      if (extOf(file.name) === "csv") {
        const text = new TextDecoder("utf-8").decode(new Uint8Array(buf));
        workbook = XLSX.read(text, { type: "string" });
      } else {
        workbook = XLSX.read(buf, { type: "array" });
      }
    } catch {
      continue; // archivo ilegible → se ignora
    }

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const grid = XLSX.utils.sheet_to_json<Row>(sheet, {
        header: 1,
        blankrows: false,
        defval: "",
      }) as Grid;
      if (grid.length < 2) continue; // sin encabezado + al menos una fila

      sheetsSeen++;
      const headers = grid[0].map((c) => String(c ?? ""));
      const body = grid.slice(1);
      const kind = classifyAndMap(headers, body, bundle);
      if (kind === "unknown") {
        unknownSheets.push(files.length > 1 ? `${file.name} · ${sheetName}` : sheetName);
      }
    }
  }

  return {
    bundle,
    matched: {
      inventory: bundle.inventory?.length ?? 0,
      customers: bundle.customers?.length ?? 0,
      sales: bundle.sales?.length ?? 0,
      purchases: bundle.purchases?.length ?? 0,
    },
    sheetsSeen,
    unknownSheets,
  };
}
