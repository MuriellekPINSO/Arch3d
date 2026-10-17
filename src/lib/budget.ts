/* Garde-fou des dépenses chez fal.ai, côté serveur : chaque rendu ou lecture de plan est estimé en dollars et réservé
   avant de partir ; au-delà du plafond du jour (FAL_BUDGET_JOUR, en dollars, 1 par défaut), Xwé refuse.
   Estimations d'après les prix publics de fal (octobre 2026) : Qwen Image Edit 2511 0,03 $ par mégapixel arrondi
   (photo de ~3,5 Mpx → 4) ; Wan 2.2 VACE 0,05 $/s en 480p, 0,10 $/s en 720p, 81 images à 16 im/s = 5,06 s. */
import { ADMIN_READY, firestore } from "./firebaseAdmin";

export const DAILY_CAP = Math.max(0, Number(process.env.FAL_BUDGET_JOUR ?? "1") || 0);

const PHOTO = 0.12;
const CLIP = { rapide: 0.26, hd: 0.51, max: 0.6 } as const;
const MERGE = 0.02;
/** une lecture de plan par Claude (0,03 à 0,07 $ selon le plan) */
export const PLAN_READ = 0.07;

/** coût estimé d'un rendu chez fal, en dollars */
export function falCost(mode: "photo" | "anime" | "visite" | "film", size: keyof typeof CLIP = "hd", shots = 1) {
  const clip = CLIP[size] ?? CLIP.hd;
  if (mode === "photo") return PHOTO;
  if (mode === "anime") return clip;
  if (mode === "visite") return PHOTO + clip;
  return shots * (PHOTO + clip) + MERGE;
}

// sans Firebase (essais en local) : le compte du jour reste en mémoire
const local = new Map<string, number>();

/** réserve `usd` sur le budget du jour ; false si le plafond serait dépassé */
export async function reserve(usd: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  if (!ADMIN_READY) {
    const spent = local.get(day) ?? 0;
    if (spent + usd > DAILY_CAP + 1e-9) return false;
    local.set(day, spent + usd);
    return true;
  }
  const ref = firestore().collection("xwe_budget").doc(day);
  return firestore().runTransaction(async (tx) => {
    const spent = ((await tx.get(ref)).data()?.spent as number | undefined) ?? 0;
    if (spent + usd > DAILY_CAP + 1e-9) return false;
    tx.set(ref, { spent: Math.round((spent + usd) * 100) / 100, cap: DAILY_CAP }, { merge: true });
    return true;
  });
}
