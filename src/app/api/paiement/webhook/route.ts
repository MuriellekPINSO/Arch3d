import { settlePayment } from "@/lib/credits";
import { verifyWebhook } from "@/lib/fedapay";

/* Notification de FedaPay (à déclarer dans le tableau de bord FedaPay → Webhooks, adresse …/api/paiement/webhook).
   Elle crédite le compte même si le client a fermé la page avant de revenir sur l'app. */
export async function POST(request: Request) {
  const secret = process.env.FEDAPAY_WEBHOOK_SECRET ?? "";
  const payload = await request.text();
  if (!verifyWebhook(payload, request.headers.get("x-fedapay-signature"), secret)) return new Response("signature invalide", { status: 400 });
  let event: { name?: string; entity?: { id?: number | string } };
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response("corps invalide", { status: 400 });
  }
  const id = event.entity?.id;
  if (event.name?.startsWith("transaction.") && id !== undefined) {
    try {
      await settlePayment(String(id));
    } catch {
      return new Response("réessayer", { status: 500 }); // FedaPay renverra la notification
    }
  }
  return Response.json({ ok: true });
}
