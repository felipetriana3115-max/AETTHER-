// Cron (mock) del reporte ejecutivo diario.
//
// Simula la tarea programada que, al cierre del día, genera el resumen con
// `generateDailySummary` y lo "envía" por WhatsApp. No hay dependencia de red ni
// de un scheduler real: `runDailyReportMock` arma el payload y lo registra por
// consola, y `scheduleDailyReportMock` dispara un temporizador hasta fin del día.
//
// En producción, el envío se reemplazaría por una llamada al proveedor de
// WhatsApp (Meta Cloud API, Twilio, etc.) desde una ruta/servidor real.

import {
  generateDailySummary,
  type DailySummaryOptions,
} from "../notifications/whatsapp-service";
import type { Sale } from "../data-model";

export type DailyReportPayload = {
  /** Número de destino en formato internacional, p. ej. +57 300 000 0000. */
  phone: string;
  /** Mensaje en Markdown listo para enviar. */
  message: string;
  /** Momento de "envío" (ISO). */
  sentAt: string;
};

/**
 * Simula el envío del reporte diario: genera el mensaje y lo registra. Devuelve
 * el payload para que la UI pueda mostrar una confirmación/preview.
 */
export function runDailyReportMock(
  sales: Sale[],
  phone: string,
  options: DailySummaryOptions = {},
): DailyReportPayload {
  const message = generateDailySummary(sales, options);
  const payload: DailyReportPayload = {
    phone,
    message,
    sentAt: new Date().toISOString(),
  };

  // MOCK: aquí iría la llamada real al proveedor de WhatsApp.
  console.info(
    `[daily-report-mock] Reporte diario para ${phone} (${payload.sentAt})\n${message}`,
  );

  return payload;
}

/** Milisegundos restantes hasta el fin del día local (23:59:59.999). */
export function msUntilEndOfDay(now: Date = new Date()): number {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return Math.max(0, end.getTime() - now.getTime());
}

/**
 * Programa (mock, solo en cliente) el disparo del reporte al final del día.
 * `getSales` se evalúa en el momento del disparo para tomar las ventas vivas.
 * Devuelve una función para cancelar el temporizador.
 */
export function scheduleDailyReportMock(
  getSales: () => Sale[],
  phone: string,
  options: DailySummaryOptions = {},
): () => void {
  const timer = setTimeout(() => {
    runDailyReportMock(getSales(), phone, options);
  }, msUntilEndOfDay());

  return () => clearTimeout(timer);
}
