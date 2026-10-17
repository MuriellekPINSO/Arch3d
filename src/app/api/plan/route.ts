import { FieldValue } from "firebase-admin/firestore";
import { accountFrom } from "@/lib/credits";
import { ADMIN_READY, firestore } from "@/lib/firebaseAdmin";
import { PLAN_AI_READY, readPlan } from "@/lib/planReader";
import { PLAN_READ, reserve } from "@/lib/budget";

/* Lecture d'un plan par l'IA : le navigateur envoie l'image (réduite à ~1600 px), reçoit pièces, murs, ouvertures,
   escaliers et niveaux. Gratuit, mais réservé aux comptes connectés et limité par jour (chaque lecture coûte
   quelques centimes chez fal). En local sans Firebase, ouvert à tous. */
export const maxDuration = 300;

const PER_DAY = 60;
const say = (request: Request, fr: string, en: string) => (request.headers.get("x-lang") === "en" ? en : fr);

/** compte une lecture de plus pour aujourd'hui ; false si la limite du jour est atteinte */
async function countRead(uid: string) {
  const ref = firestore().collection("xwe_accounts").doc(uid);
  const day = new Date().toISOString().slice(0, 10);
  return firestore().runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() as { planDay?: string; planReads?: number } | undefined;
    const n = d?.planDay === day ? (d.planReads ?? 0) : 0;
    if (n >= PER_DAY) return false;
    tx.set(ref, { planDay: day, planReads: d?.planDay === day ? FieldValue.increment(1) : 1 }, { merge: true });
    return true;
  });
}

export async function POST(request: Request) {
  if (!PLAN_AI_READY) return Response.json({ error: say(request, "Lecture par l'IA indisponible.", "AI reading unavailable.") }, { status: 503 });
  if (ADMIN_READY) {
    const a = await accountFrom(request);
    if (!a) return Response.json({ error: say(request, "Connexion requise.", "Sign-in required."), needLogin: true }, { status: 401 });
    if (!(await countRead(a.id)))
      return Response.json(
        { error: say(request, `Limite de ${PER_DAY} lectures de plan par jour atteinte : réessayez demain.`, `Daily limit of ${PER_DAY} plan readings reached: try again tomorrow.`) },
        { status: 429 },
      );
  }
  const body = (await request.json().catch(() => null)) as { image?: string; w?: number; h?: number; single?: string } | null;
  const image = body?.image ?? "";
  const w = Math.round(body?.w ?? 0);
  const h = Math.round(body?.h ?? 0);
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(image) || image.length > 4_000_000 || w < 50 || h < 50 || w > 4000 || h > 4000)
    return Response.json({ error: say(request, "Image du plan refusée.", "Plan image rejected.") }, { status: 400 });
  // plafond de dépenses du jour chez fal
  if (!(await reserve(PLAN_READ)))
    return Response.json(
      { error: say(request, "La lecture par l'IA a atteint sa limite du jour : réessayez demain.", "AI reading has reached its daily limit: try again tomorrow.") },
      { status: 503 },
    );
  try {
    const r = await readPlan(image, w, h, typeof body?.single === "string" ? body.single.slice(0, 40) : null);
    return Response.json(r);
  } catch (e) {
    console.error("lecture du plan", e);
    return Response.json({ error: `${say(request, "L'IA n'a pas pu lire le plan", "The AI could not read the plan")} : ${(e as Error).message}` }, { status: 502 });
  }
}
