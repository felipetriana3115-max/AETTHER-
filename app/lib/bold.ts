// Normalización de eventos de webhook de Bold (https://developers.bold.co).
// Bold envía eventos tipo `SALE_APPROVED` / `SALE_REJECTED` con la información
// del pago dentro de `data`. Aquí lo normalizamos a una forma estable que
// consume tanto la ruta de API como la UI.

export type BoldPaymentStatus = "SUCCESSFUL" | "REJECTED";

export interface NormalizedBoldPayment {
  paymentId: string;
  status: BoldPaymentStatus;
  amount: number;
  currency: string;
  reference: string;
  method: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Acepta el `type` de Bold o un `status` directo y lo mapea a nuestro enum. */
function normalizeStatus(v: unknown): BoldPaymentStatus | null {
  const s = typeof v === "string" ? v.toUpperCase() : "";
  if (s === "SUCCESSFUL" || s === "SALE_APPROVED" || s === "APPROVED") return "SUCCESSFUL";
  if (s === "REJECTED" || s === "SALE_REJECTED" || s === "DECLINED") return "REJECTED";
  return null;
}

/**
 * Extrae estado, monto, referencia y método de pago de un evento de Bold.
 * Devuelve `null` si el evento no es reconocible.
 */
export function parseBoldEvent(event: unknown): NormalizedBoldPayment | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  const data = (e.data ?? {}) as Record<string, unknown>;

  const status = normalizeStatus(e.type ?? e.status);
  if (!status) return null;

  const amountObj = (data.amount ?? {}) as Record<string, unknown>;
  const amount =
    typeof amountObj.total === "number"
      ? amountObj.total
      : typeof e.amount === "number"
        ? (e.amount as number)
        : 0;

  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  const reference =
    str(metadata.reference) ?? str(e.reference) ?? str(data.payment_id) ?? "SIN-REF";

  return {
    paymentId: str(data.payment_id) ?? str(e.id) ?? reference,
    status,
    amount,
    currency: str(amountObj.currency) ?? "USD",
    reference,
    method: str(data.payment_method) ?? str(e.payment_method) ?? "DESCONOCIDO",
  };
}
