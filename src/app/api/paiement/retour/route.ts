import { settlePayment } from "@/lib/credits";

/* Retour du client après la page de paiement FedaPay (?id=…&status=…).
   On ne croit pas le statut de l'adresse : on le redemande à FedaPay, puis on revient sur l'app. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const back = new URL("/", url.origin);
  if (!/^\d{1,20}$/.test(id)) {
    back.searchParams.set("paiement", "echec");
    return Response.redirect(back, 303);
  }
  try {
    const r = await settlePayment(id);
    if (r?.credited) {
      back.searchParams.set("paiement", "ok");
      back.searchParams.set("credits", String(r.credits));
    } else back.searchParams.set("paiement", r?.status === "pending" ? "attente" : "echec");
  } catch {
    back.searchParams.set("paiement", "attente");
  }
  return Response.redirect(back, 303);
}
