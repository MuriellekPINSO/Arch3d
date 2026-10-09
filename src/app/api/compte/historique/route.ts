import { accountFrom } from "@/lib/credits";
import { ADMIN_READY } from "@/lib/firebaseAdmin";
import { creditHistory } from "@/lib/projects";

/* Historique des crédits de l'utilisateur connecté (offerts, achats, rendus, remboursements). */
export async function GET(request: Request) {
  const a = ADMIN_READY ? await accountFrom(request) : null;
  if (!a) return Response.json({ error: "connexion requise" }, { status: 401 });
  return Response.json({ history: await creditHistory(a.id) });
}
