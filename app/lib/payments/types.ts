// Métodos de pago soportados por la pasarela (Wompi centraliza PSE, tarjetas y
// transferencias/Nequi). Los valores son strings para serializar de forma
// estable en localStorage y en el registro de transacciones.
export enum PaymentMethod {
  NEQUI = "NEQUI",
  PSE = "PSE",
  CREDIT_CARD = "CREDIT_CARD",
  DEBIT_CARD = "DEBIT_CARD",
  TRANSFER = "TRANSFER",
}

/** Etiquetas legibles (es-CO) para pintar el selector en la UI. */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  [PaymentMethod.NEQUI]: "Nequi",
  [PaymentMethod.PSE]: "PSE",
  [PaymentMethod.CREDIT_CARD]: "Tarjeta de crédito",
  [PaymentMethod.DEBIT_CARD]: "Tarjeta débito",
  [PaymentMethod.TRANSFER]: "Transferencia",
};

/** Orden estable para renderizar el grupo de botones del selector. */
export const PAYMENT_METHODS: PaymentMethod[] = [
  PaymentMethod.NEQUI,
  PaymentMethod.PSE,
  PaymentMethod.CREDIT_CARD,
  PaymentMethod.DEBIT_CARD,
  PaymentMethod.TRANSFER,
];
