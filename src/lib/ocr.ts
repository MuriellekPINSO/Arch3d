"use client";
import type { Pt, Room, RoomType } from "./types";
import { pointInPolygon, polygonArea } from "./geometry";

/* Lecture des textes du plan (OCR Tesseract, dans le navigateur) : noms des pièces et surfaces écrites.
   Trois passes : l'image telle quelle, l'encre noire seule agrandie ×2 (les aplats de couleur gênent l'OCR),
   et la même tournée d'un quart de tour pour les textes verticaux. */

export interface OcrWord {
  text: string;
  conf: number;
  c: Pt; // centre, en pixels de l'image d'origine
  h: number; // hauteur du mot, en pixels
  w: number; // largeur
  vertical?: boolean;
}

type Px = { data: Uint8ClampedArray; width: number; height: number };

function inkCanvas(px: Px, scale: number, rotate: boolean) {
  const { data, width: W, height: H } = px;
  const src = document.createElement("canvas");
  src.width = W;
  src.height = H;
  const g = src.getContext("2d")!;
  const out = g.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4];
    const gg = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const L = (r * 299 + gg * 587 + b * 114) / 1000;
    const sat = Math.max(r, gg, b) - Math.min(r, gg, b);
    const v = L < 110 && sat < 80 ? 0 : 255; // texte noir seulement
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  const cv = document.createElement("canvas");
  cv.width = (rotate ? H : W) * scale;
  cv.height = (rotate ? W : H) * scale;
  const c = cv.getContext("2d")!;
  c.fillStyle = "#fff";
  c.fillRect(0, 0, cv.width, cv.height);
  c.imageSmoothingQuality = "high";
  if (rotate) {
    // quart de tour dans le sens horaire : les textes écrits de bas en haut deviennent horizontaux
    c.translate(cv.width, 0);
    c.rotate(Math.PI / 2);
  }
  c.drawImage(src, 0, 0, W * scale, H * scale);
  return cv;
}

interface TWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export async function readWords(src: string, px: Px): Promise<OcrWord[]> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("fra");
  const words: OcrWord[] = [];
  const run = async (image: string | HTMLCanvasElement, map: (x: number, y: number) => Pt, scale: number, vertical = false) => {
    const { data } = await worker.recognize(image, {}, { blocks: true });
    const blocks = (data as unknown as { blocks?: { paragraphs: { lines: { words: TWord[] }[] }[] }[] }).blocks ?? [];
    for (const b of blocks)
      for (const p of b.paragraphs)
        for (const l of p.lines)
          for (const w of l.words) {
            const text = w.text.trim();
            if (w.confidence < 45 || (text.length < 2 && !/^[\d!lI|]$/.test(text))) continue; // un chiffre seul : numéro de chambre
            const { x0, y0, x1, y1 } = w.bbox;
            words.push({
              text,
              conf: w.confidence,
              c: map((x0 + x1) / 2, (y0 + y1) / 2),
              // passe tournée : le mot est vertical dans l'image d'origine
              h: (y1 - y0) / scale,
              w: (x1 - x0) / scale,
              vertical,
            });
          }
  };
  try {
    await run(src, (x, y) => ({ x, y }), 1);
    await run(inkCanvas(px, 2, false), (x, y) => ({ x: x / 2, y: y / 2 }), 2);
    // image tournée de 90° horaire : (x', y') → (y', H·2 − x') dans l'image agrandie
    await run(inkCanvas(px, 2, true), (x, y) => ({ x: y / 2, y: (px.height * 2 - x) / 2 }), 2, true);
  } finally {
    await worker.terminate();
  }
  return words;
}

/* ---------- des mots aux pièces ---------- */

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9,.\- ]/g, "");

/** vocabulaire des plans : forme du mot → nom affiché et type de pièce */
const VOCAB: { words: string[]; name: string; type: RoomType }[] = [
  { words: ["sejour", "salon", "living", "sejours"], name: "Séjour", type: "salon" },
  { words: ["chambre", "chbre", "ch"], name: "Chambre", type: "chambre" },
  { words: ["cuisine", "kitchenette"], name: "Cuisine", type: "cuisine" },
  { words: ["douche", "sdb", "sde", "bain", "bains"], name: "Douche", type: "salle_de_bain" },
  { words: ["toil", "toilette", "toilettes", "wc"], name: "Toilettes", type: "wc" },
  { words: ["sas"], name: "SAS", type: "couloir" },
  { words: ["hall", "entree", "accueil"], name: "Hall", type: "couloir" },
  { words: ["degagement", "couloir", "circulation", "palier"], name: "Dégagement", type: "couloir" },
  { words: ["escalier", "escaliers"], name: "Escalier", type: "escalier" },
  { words: ["garage", "parking"], name: "Garage", type: "garage" },
  { words: ["terrasse", "balcon", "veranda", "loggia"], name: "Terrasse", type: "terrasse" },
  { words: ["arriere-cour", "cour", "patio"], name: "Arrière-cour", type: "terrasse" },
  { words: ["bureau"], name: "Bureau", type: "bureau" },
  { words: ["magasin", "debarras", "buanderie", "rangement", "dressing", "cellier"], name: "Rangement", type: "autre" },
  { words: ["manger", "repas"], name: "Salle à manger", type: "salle_a_manger" },
];

function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** mot reconnu (tolère une ou deux fautes d'OCR selon la longueur) */
function vocabOf(text: string) {
  const w = norm(text).replace(/[,.]/g, "");
  if (w.length < 2) return null;
  let best: { v: (typeof VOCAB)[number]; d: number } | null = null;
  for (const v of VOCAB)
    for (const ref of v.words) {
      if (ref.length <= 3 ? w !== ref : false) continue;
      const d = lev(w, ref);
      const tol = ref.length >= 7 ? 2 : ref.length >= 4 ? 1 : 0;
      if (d <= tol && (!best || d < best.d)) best = { v, d };
    }
  return best?.v ?? null;
}

const AREA = /^(\d{1,3})[,.](\d{1,2})$/;

export interface Labelled {
  rooms: Room[];
  namedIds: Set<string>;
  scale: number | null; // facteur d'échelle déduit des surfaces écrites (1 = juste), null si incertain
  named: number;
}

/** Nomme les pièces d'après les mots situés à l'intérieur, et compare les surfaces écrites aux surfaces mesurées. */
export function labelRooms(rooms: Room[], words: OcrWord[], toPlan: (p: Pt) => Pt): Labelled {
  const ratios: number[] = [];
  const count: Partial<Record<string, number>> = {};
  let named = 0;
  const namedIds = new Set<string>();
  const usedNums = new Set<string>();
  const out = rooms.map((r) => {
    const inside = words.filter((w) => pointInPolygon(toPlan(w.c), r.points));
    // nom : le mot du vocabulaire le plus sûr ; un chiffre juste après (« Chambre 2 ») est gardé
    let label: { v: (typeof VOCAB)[number]; w: OcrWord } | null = null;
    for (const w of inside) {
      const v = vocabOf(w.text);
      if (v && (!label || w.conf > label.w.conf)) label = { v, w };
    }
    // surface écrite : « 11,17 m² » — un nombre suivi de m² (sans « m² », c'est une cote)
    const isUnit = (t: string) => /^m[2²°?3]?$/.test(norm(t).replace(/[^a-z0-9°?²]/g, ""));
    const areaWords = inside.filter((w) => {
      const t = norm(w.text);
      if (/^\d{1,3}[,.]\d{1,2}m/.test(t)) return true; // « 11,17m² » collé
      if (!AREA.test(t)) return false;
      return inside.some((u) => {
        if (!isUnit(u.text) || !!u.vertical !== !!w.vertical) return false;
        // repère du mot : « à droite » = x croissant, ou y décroissant pour un texte vertical (lu de bas en haut)
        const along = w.vertical ? w.c.y - u.c.y : u.c.x - w.c.x;
        const across = w.vertical ? u.c.x - w.c.x : u.c.y - w.c.y;
        return Math.abs(across) < w.h * 0.8 && along > 0 && along < w.w + 3 * w.h;
      });
    });
    const best = areaWords.sort((a, b) => b.conf - a.conf)[0];
    const m = best && /^(\d{1,3})[,.](\d{1,2})/.exec(norm(best.text));
    const area = m ? parseFloat(`${m[1]}.${m[2]}`) : 0;
    if (area >= 1) {
      const measured = Math.abs(polygonArea(r.points));
      if (measured > 0.5) ratios.push(Math.sqrt(area / measured));
    }
    if (!label) return r;
    named++;
    namedIds.add(r.id);
    const { v, w } = label;
    let name = v.name;
    if (v.type === "chambre") {
      // numéro juste à droite du mot (« Chambre 2 ») ou collé (« Chambre2 ») ; « l », « I », « ! » sont des 1 mal lus
      const asDigit = (t: string) => (/^\d$/.test(t) ? t : /^[!lI|]$/.test(t) ? "1" : null);
      const glued = /(\d)$/.exec(w.text);
      const next = inside.find(
        (x) => asDigit(x.text) && Math.abs(x.c.y - w.c.y) < w.h * 0.6 && x.c.x > w.c.x && x.c.x - (w.c.x + w.w / 2) < 1.5 * w.h,
      );
      let num = glued ? glued[1] : next ? asDigit(next.text) : null;
      if (num && usedNums.has(num)) num = null; // deux « Chambre 2 » : le second est mal lu
      if (!num) {
        let k = 1;
        while (usedNums.has(String(k))) k++;
        num = String(k);
      }
      usedNums.add(num);
      name = `Chambre ${num}`;
    } else {
      count[v.name] = (count[v.name] ?? 0) + 1;
      if (count[v.name]! > 1) name = `${v.name} ${count[v.name]}`;
    }
    return { ...r, name, type: v.type };
  });
  // échelle : médiane des rapports, gardée seulement si plusieurs pièces sont d'accord
  let scale: number | null = null;
  if (ratios.length >= 2) {
    const s = [...ratios].sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    const agree = s.filter((x) => Math.abs(x / med - 1) < 0.06);
    if (agree.length >= 2) scale = agree.reduce((a, b) => a + b, 0) / agree.length;
  }
  return { rooms: out, namedIds, scale, named };
}
