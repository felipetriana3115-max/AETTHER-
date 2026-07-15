import { createHmac, timingSafeEqual } from "node:crypto";
import { parseBoldEvent } from "@/app/lib/bold";

// Este endpoint no se cachea (los POST nunca se cachean), corre en cada request.

/**
 * Verifica la firma del webhook contra el secreto de Bold.
 * Bold firma el cuerpo con HMAC-SHA256 y lo envía en `x-bold-signature`.
 * En modo demo (sin `BOLD_SECRET_KEY`) se omite la verificación.
 */
function verifySignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.BOLD_SECRET_KEY;
  if (!secret) return true; // modo demo: sin secreto configurado
  if (!signature) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  // Se lee el cuerpo crudo para poder verificar la firma sobre el texto exacto.
  const rawBody = await request.text();
  const signature = request.headers.get("x-bold-signature");

  if (!verifySignature(rawBody, signature)) {
    return Response.json({ ok: false, error: "Firma inválida" }, { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const payment = parseBoldEvent(event);
  if (!payment) {
    return Response.json(
      { ok: false, error: "Evento de Bold no reconocido" },
      { status: 422 },
    );
  }

  // En producción aquí se persistiría la transacción, se conciliaría la venta,
  // se actualizaría el inventario, etc. Para la demo devolvemos el pago
  // normalizado para que el frontend lo registre en tiempo real.
  const processed = payment.status === "SUCCESSFUL";

  return Response.json({
    ok: true,
    processed,
    payment,
  });
}

// Endpoint de salud para verificar que la ruta está viva.
export async function GET() {
  return Response.json({
    ok: true,
    service: "bold-webhook",
    accepts: ["SALE_APPROVED", "SALE_REJECTED"],
  });
}
