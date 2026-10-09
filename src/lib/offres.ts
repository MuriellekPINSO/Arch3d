/* Crédits : les packs qu'on achète (payés par FedaPay, en FCFA) et le prix de chaque rendu.
   Ce fichier ne contient aucun secret : l'interface l'utilise aussi pour afficher les prix.
   La maison 3D, la visite et l'aménagement tournent dans le navigateur : ils ne coûtent rien et restent gratuits. */

/** crédits offerts à l'ouverture d'un compte */
export const FREE_CREDITS = 20;

export type PackId = "essai" | "pro" | "agence";
export type Pack = { id: PackId; credits: number; xof: number; name: [string, string]; note?: [string, string]; best?: boolean };

// 1 crédit ≈ 30 FCFA (≈ 0,05 $) ; le pack Agence offre 100 crédits de plus
export const PACKS: Pack[] = [
  { id: "essai", credits: 60, xof: 2000, name: ["Essai", "Starter"] },
  { id: "pro", credits: 200, xof: 6000, name: ["Pro", "Pro"], note: ["≈ 10 $ · le plus choisi", "≈ $10 · most popular"], best: true },
  { id: "agence", credits: 700, xof: 18000, name: ["Agence", "Studio"], note: ["100 crédits offerts", "100 bonus credits"] },
];

export type Quality = "rapide" | "hd" | "max";
export type RenderMode = "photo" | "video" | "visite" | "anime" | "film";

/** une photo réaliste */
export const PHOTO_COST = 2;
/** une vidéo de 5 s (avec sa première image), selon la qualité */
export const CLIP_COST: Record<Quality, number> = { rapide: 10, hd: 20, max: 30 };

/** prix d'un rendu ; le film complet compte une vidéo par plan */
export function renderCost(mode: RenderMode, size: Quality = "hd", shots = 1) {
  if (mode === "photo") return PHOTO_COST;
  const clip = CLIP_COST[size] ?? CLIP_COST.hd;
  return mode === "film" ? clip * Math.max(1, shots) : clip;
}

export const formatXof = (n: number) => `${n.toLocaleString("fr-FR").replace(/ | /g, " ")} FCFA`;
