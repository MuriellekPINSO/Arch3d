import { accountFrom } from "@/lib/credits";
import { ADMIN_READY } from "@/lib/firebaseAdmin";
import { FEDAPAY_READY, FEDAPAY_SANDBOX } from "@/lib/fedapay";

/* Solde de l'utilisateur connecté (jeton Firebase). Sans connexion : signedIn false, l'interface propose de se connecter. */
export async function GET(request: Request) {
  const a = ADMIN_READY ? await accountFrom(request) : null;
  return Response.json({
    signedIn: !!a,
    credits: a?.credits ?? null,
    email: a?.email ?? null,
    verified: a?.verified ?? false,
    accounts: ADMIN_READY,
    payment: FEDAPAY_READY && ADMIN_READY,
    sandbox: FEDAPAY_SANDBOX,
  });
}
