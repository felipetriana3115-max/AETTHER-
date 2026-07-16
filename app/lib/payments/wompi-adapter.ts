// Adaptador de Wompi. Por ahora SIMULA la respuesta de la pasarela: no hay
// integración con el SDK/API real todavía. Cuando llegue ese paso, solo esta
// capa debería cambiar; la UI y el dashboard consumen `processPayment` sin
// enterarse de si el pago es simulado o real.
import { PaymentMethod } from "./types";

export type WompiStatus = "success" | "failed";

export interface PaymentResult {
  status: WompiStatus;
  /** Referencia de negocio, visible al usuario. */
  reference: string;
  /** Id de la transacción del lado de la pasarela. */
  transactionId: string;
  amount: number;
  method: PaymentMethod;
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

/**
 * Procesa un pago a través de Wompi (simulado).
 *
 * Aproxima la latencia de una llamada real y devuelve un estado
 * `success` | `failed` de forma aleatoria (≈80 % de aprobación).
 */
export async function processPayment(
  amount: number,
  method: PaymentMethod,
): Promise<PaymentResult> {
  // Latencia ficticia para que la UI muestre el estado "procesando".
  await new Promise((resolve) => setTimeout(resolve, 600));

  const approved = Math.random() < 0.8;
  const reference = `WOMPI-${randomInt(100000, 999999)}`;

  return {
    status: approved ? "success" : "failed",
    reference,
    transactionId: crypto.randomUUID(),
    amount,
    method,
  };
}
