import { accountFrom, recordPayment } from "@/lib/credits";
import { ADMIN_READY, firestore } from "@/lib/firebaseAdmin";
import { createTransaction, FEDAPAY_READY } from "@/lib/fedapay";
import { PACKS } from "@/lib/offres";

/* Achat de crédits : crée la transaction FedaPay et renvoie l'adresse de sa page de paiement. */
const say = (request: Request, fr: string, en: string) => (request.headers.get("x-lang") === "en" ? en : fr);

export async function POST(request: Request) {
  if (!FEDAPAY_READY || !ADMIN_READY)
    return Response.json(
      { error: say(request, "Paiement indisponible pour le moment : FedaPay n'est pas branché.", "Payment is unavailable right now: FedaPay is not connected.") },
      { status: 503 },
    );
  const body = (await request.json().catch(() => ({}))) as { pack?: string; email?: string };
  const pack = PACKS.find((p) => p.id === body.pack);
  if (!pack) return Response.json({ error: say(request, "Offre inconnue.", "Unknown offer.") }, { status: 400 });
  const email = (body.email ?? "").trim().slice(0, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return Response.json({ error: say(request, "Adresse email invalide.", "Invalid email address.") }, { status: 400 });

  const account = await accountFrom(request);
  if (!account)
    return Response.json({ error: say(request, "Connectez-vous pour acheter des crédits.", "Sign in to buy credits."), needLogin: true }, { status: 401 });
  if (email && !account.email) await firestore().collection("xwe_accounts").doc(account.id).update({ email });
  try {
    const t = await createTransaction({
      description: `Xwé · ${pack.credits} crédits`,
      amount: pack.xof,
      callbackUrl: `${new URL(request.url).origin}/api/paiement/retour`,
      email: email || account.email || undefined,
      metadata: { account: account.id, pack: pack.id },
    });
    await recordPayment({ transactionId: t.id, account: account.id, pack: pack.id, credits: pack.credits, amount: pack.xof });
    return Response.json({ url: t.url });
  } catch (e) {
    return Response.json({ error: `${say(request, "Paiement impossible : ", "Payment failed: ")}${(e as Error).message}` }, { status: 502 });
  }
}
