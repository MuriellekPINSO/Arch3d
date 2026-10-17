/* Brief de maison lu directement dans la phrase de l'utilisateur, sans IA ni réseau.
   Comprend le français et l'anglais : nombre de chambres (chiffres et lettres), salles de bain,
   niveaux (« R+1 », « duplex »…), terrain, garage, terrasse, bureau, cuisine ouverte, style. */
import type { Lang } from "./i18n";
import { STYLES } from "./styles";

export interface IdeaBrief {
  bedrooms: number; // 1 à 6
  bathrooms: number; // 1 à 4
  levels: 1 | 2;
  plotW: number; // largeur du terrain, en m
  plotD: number; // profondeur du terrain, en m
  garage: boolean;
  terrace: boolean;
  office: boolean;
  openKitchen: boolean;
  styleId: string; // un id de STYLES
}

export const DEFAULT_BRIEF: IdeaBrief = {
  bedrooms: 3,
  bathrooms: 1,
  levels: 1,
  plotW: 15,
  plotD: 20,
  garage: false,
  terrace: true,
  office: false,
  openKitchen: true,
  styleId: STYLES[0].id, // contemporain (crème, clair, chaleureux)
};

/** minuscules, sans accents, tirets cadratins devenus des espaces */
const clean = (t: string) =>
  t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[–—✱]/g, " ");

/* ---------- nombres : chiffres et lettres ---------- */
const WORDS: Record<string, number> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9, ten: 10,
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Nombre (chiffres ou lettres) accolé au mot-clé : « 3 chambres », « three bedrooms », « chambres : 2 ». */
function countNear(t: string, re: RegExp, fallback: number, min: number, max: number): number {
  const num = (v: string) => (/^\d+$/.test(v) ? parseInt(v, 10) : WORDS[v]);
  const src = `(?:${re.source})`;
  // le nombre juste avant le mot-clé, sans rien entre les deux (« 4 chambres », « three bedrooms »)
  let m = new RegExp(`(\\d+|[a-zéèêàôûç]+)\\s+${src}`).exec(t);
  if (m) {
    const n = num(m[1]);
    if (n !== undefined && n >= min) return clamp(n, min, max);
  }
  // sinon, juste après (« chambres : 3 »)
  m = new RegExp(`${src}\\D{0,6}?(\\d+|[a-zéèêàôûç]+)`).exec(t);
  if (m) {
    const n = num(m[1]);
    if (n !== undefined && n >= min) return clamp(n, min, max);
  }
  // sinon, jusqu'à deux mots entre (« trois grandes chambres »)
  m = new RegExp(`(\\d+|[a-zéèêàôûç]+)\\s+(?:\\w+\\s+){1,2}?${src}`).exec(t);
  if (m) {
    const n = num(m[1]);
    if (n !== undefined && n >= min) return clamp(n, min, max);
  }
  // rien trouvé : la valeur par défaut
  return clamp(Math.max(min, fallback), min, max);
}

/* ---------- terrain / dimensions ---------- */
const parseDims = (t: string): { w: number; d: number } | null => {
  // « 15 × 20 m », « 15x20 », « 15 par 20 »
  const m = /(\d{1,3}(?:[.,]\d+)?)\s*(?:m)?\s*(?:x|×|\*)\s*(\d{1,3}(?:[.,]\d+)?)\s*(?:m)?/.exec(t)
    ?? /(\d{1,3}(?:[.,]\d+)?)\s*(?:par|by)\s*(\d{1,3}(?:[.,]\d+)?)\s*m?/.exec(t);
  if (m) {
    const a = parseFloat(m[1].replace(",", "."));
    const b = parseFloat(m[2].replace(",", "."));
    if (a >= 5 && b >= 5 && a <= 40 && b <= 40) return { w: a, d: b };
  }
  // « terrain de 300 m² »
  const area = /(\d{2,4})\s*(?:m2|m²|metres? carres?|square metres?)/.exec(t);
  if (area) {
    const n = parseInt(area[1], 10);
    if (n >= 50 && n <= 1600) {
      const side = Math.round(Math.sqrt(n));
      return { w: side, d: side };
    }
  }
  return null;
};

/* ---------- style ---------- */
const STYLE_HINTS: [RegExp, string][] = [
  [/afro|wax|africain|african|terracotte|bois sombre/, "afro-chic"],
  [/tropical|rotin|exotique|exotic|verdoi/, "tropical"],
  [/minimalis|epure|beton|\bbrut\b|minimal/, "minimaliste"],
  [/contemporain|moderne|clair|creme|sable|beige|chaleureux|lumin/, "contemporain"],
];

export const styleFromIdea = (raw: string): string => {
  for (const [re, id] of STYLE_HINTS) if (re.test(raw)) return id;
  return DEFAULT_BRIEF.styleId;
};

/** Lit la description et renvoie les réglages de la maison. Ne jette jamais : en cas de doute, les réglages par défaut. */
export function parseIdea(text: string, lang: Lang): IdeaBrief {
  void lang; // la lecture est indépendante de la langue choisie : elle détecte elle-même FR/EN
  const t = clean(text);
  const flat = t.replace(/\s+/g, " ");
  const brief: IdeaBrief = { ...DEFAULT_BRIEF };

  /* niveaux : « R+1 », « duplex », « étage », « two-storey » → 2 ; « plain-pied », « single-storey » → 1 */
  const up = /\b(r\s*\+\s*[12]|duplex|etages?|deux etages|two[- ]stor(?:e?y)|double[- ]stor(?:e?y)|three[- ]stor(?:e?y)|two levels|deux niveaux)\b/.test(flat);
  const down = /\b(plain[- ]?pied|de plain|one[- ]stor(?:e?y)|single[- ]stor(?:e?y)|bungalow|un seul niveau|un niveau|one level)\b/.test(flat);
  brief.levels = up && !down ? 2 : 1;

  brief.bedrooms = countNear(t, /chambres?\b|bedrooms?\b|bedrooms\b/, DEFAULT_BRIEF.bedrooms, 1, 6);
  const baths = countNear(t, /salles? de bains?\b|sdb\b|bathrooms?\b|douches?\b|shower\s?rooms?\b/, 0, 1, 4);
  brief.bathrooms = baths || (/\bsalle de bain|bathroom|douches?\b/.test(t) ? 1 : DEFAULT_BRIEF.bathrooms);

  const dims = parseDims(flat);
  if (dims) {
    brief.plotW = dims.w;
    brief.plotD = dims.d;
  } else if (brief.levels === 2) {
    // étage : on a besoin de moins d'emprise, un terrain carré moyen suffit
    brief.plotW = 16;
    brief.plotD = 18;
  }

  brief.garage = /\b(garage|carports?|car ports?|parking couvert|garage box)\b/.test(t);
  brief.terrace = /\b(terrasses?|terraces?|patios?|verandas?|porches?)\b/.test(t);
  brief.office = /\b(bureaux?|offices?|workspace|work room|study room|study\b)/.test(t);
  const fermee = /\b(cuisine (?:fermee|separee)|closed kitchen|separate kitchen)\b/.test(t);
  const ouverte = /\b(cuisine (?:ouverte|americaine)|open(?:[- ]plan)? kitchen|kitchen(?: is)? open|american kitchen)\b/.test(t);
  brief.openKitchen = fermee ? false : ouverte || brief.openKitchen;

  brief.styleId = styleFromIdea(t);

  brief.bedrooms = clamp(brief.bedrooms, 1, 6);
  brief.bathrooms = clamp(brief.bathrooms, 1, 4);
  brief.plotW = clamp(brief.plotW, 8, 40);
  brief.plotD = clamp(brief.plotD, 8, 40);
  return brief;
}
