"use client";
import type { Background, Opening, Pt, Room, RoomType, Wall } from "./types";
import { OPENING_DEFAULTS, uid } from "./types";
import { roomLabel, tx } from "./i18n";
import { bbox, openingSides, pointInPolygon, polygonArea } from "./geometry";
import { pruneOutdoor, readPlanImage } from "./raster";
import { detectAllRooms } from "./roomDetect";
import { labelRooms, readWords, type OcrWord } from "./ocr";

/* Lecture des fichiers de plan : image (PNG, JPG…) ou PDF (1re page), réduits à 2400 px
   pour tenir dans la sauvegarde locale du navigateur. */

export interface PlanImage {
  src: string;
  w: number;
  h: number;
}

const MAX = 2400;

function toJpeg(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number): PlanImage {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  draw(g, w, h);
  return { src: cv.toDataURL("image/jpeg", 0.85), w, h };
}

export async function readImage(file: File): Promise<PlanImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k);
    const h = Math.round(img.naturalHeight * k);
    return toJpeg((g) => g.drawImage(img, 0, 0, w, h), w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function readPdf(file: File, pageNumber = 1): Promise<PlanImage & { pages: number }> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages));
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: MAX / Math.max(base.width, base.height) });
  const w = Math.round(viewport.width);
  const h = Math.round(viewport.height);
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  await page.render({ canvas: cv, viewport, background: "#ffffff" }).promise;
  const out = toJpeg((g) => g.drawImage(cv, 0, 0), w, h);
  const pages = doc.numPages;
  await task.destroy();
  return { ...out, pages };
}

const KEYWORDS: [RegExp, RoomType][] = [
  [/s[ée]jour|salon|living|^s[ée]j|lounge|family room/i, "salon"],
  [/salle [àa] manger|repas|dining/i, "salle_a_manger"],
  [/cuisine|kitchen/i, "cuisine"],
  [/\bwc\b|toilette|toilet|restroom|powder room/i, "wc"],
  [/sdb|sde|salle d.?eau|salle de bain|bain|douche|bath/i, "salle_de_bain"],
  [/chambre|^ch\.?\s*\d|bedroom|suite/i, "chambre"],
  [/bureau|office|study/i, "bureau"],
  [/couloir|d[ée]gagement|hall|entr[ée]e|circulation|palier|corridor|entrance|entry|foyer|landing/i, "couloir"],
  [/terrasse|balcon|v[ée]randa|loggia|terrace|porch|patio|deck/i, "terrasse"],
];

const typeFromText = (t: string) => KEYWORDS.find(([re]) => re.test(t))?.[1] ?? null;

/* Type de pièce : lu dans les textes du plan s'il y en a (« Séjour », « Ch. 2 »…),
   sinon deviné d'après la surface et la forme — un point de départ que l'architecte corrige. */
export function roomsFromPolygons(polys: Pt[][], texts: { p: Pt; text: string }[] = []): Room[] {
  const sorted = [...polys].sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  const count: Partial<Record<RoomType, number>> = {};
  const named = sorted.map((points) => {
    const t = texts.find((x) => pointInPolygon(x.p, points) && typeFromText(x.text));
    return t ? { name: t.text.slice(0, 40), type: typeFromText(t.text)! } : null;
  });
  const hasSalon = named.some((n) => n?.type === "salon");
  return sorted.map((points, i) => {
    const label = named[i];
    if (label) return { id: uid(), name: label.name, type: label.type, points };
    const a = Math.abs(polygonArea(points));
    const b = bbox(points);
    const short = Math.min(b.w, b.h);
    const aspect = Math.max(b.w, b.h) / Math.max(0.1, short);
    let type: RoomType = "chambre";
    if (i === 0 && !hasSalon) type = "salon";
    else if (a < 2.5) type = "wc";
    else if (aspect > 2.6 && short < 1.7) type = "couloir";
    else if (a < 6.5) type = "salle_de_bain";
    count[type] = (count[type] ?? 0) + 1;
    const n = count[type]!;
    const single = type === "salon" || type === "couloir";
    return { id: uid(), name: single && n === 1 ? roomLabel(type) : `${roomLabel(type)} ${n}`, type, points };
  });
}

/* Entre deux pièces, il n'y a pas de fenêtre : c'est un passage, ou une porte si `doors` (plan en image,
   où le seuil d'une porte ressemble à un vitrage). */
export function fixInteriorOpenings(openings: Opening[], walls: Wall[], rooms: Room[], doors = false): Opening[] {
  return openings.map((o) => {
    if (o.kind !== "window" && o.kind !== "baie") return o;
    const s = openingSides(o, walls, rooms);
    if (!s?.r1 || !s?.r2 || s.r1.id === s.r2.id) return o;
    const kind = doors && o.width <= 1.3 ? "door" : "passage";
    const d = OPENING_DEFAULTS[kind];
    return { ...o, kind, height: d.height, sill: d.sill };
  });
}

/** Pixels d'une image (data URL) */
export async function imagePixels(src: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const g = cv.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, cv.width, cv.height);
}

/** Lecture automatique d'un plan en image : murs, ouvertures, pièces, puis noms et surfaces écrits (OCR).
    L'échelle est celle du calque si elle a été calibrée ; sinon elle est déduite des surfaces écrites
    sur le plan, ou à défaut estimée d'après l'épaisseur des murs. */
/** Efface du plan les mots lus (noms, surfaces, cotes) : leurs lettres, soudées par la recherche des hachures,
    passeraient pour des bouts de mur. Un mot traversé par un long trait (un mur) est laissé tel quel. */
function eraseWords(px: { data: Uint8ClampedArray; width: number; height: number }, words: OcrWord[]) {
  const { width: W, height: H } = px;
  const data = new Uint8ClampedArray(px.data);
  const dark = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 < 170;
  };
  for (const w of words) {
    // de vrais mots seulement : lettres, ou nombres à virgule (cotes, surfaces) — pas un motif de hachures lu comme du texte
    if (w.conf < 60 || !(/[a-zà-ÿ]{3,}/i.test(w.text) || /\d[,.]\d/.test(w.text) || /^m[2²]$/i.test(w.text))) continue;
    const [bw, bh] = w.vertical ? [w.h, w.w] : [w.w, w.h];
    const x0 = Math.max(0, Math.floor(w.c.x - bw / 2 - 1));
    const x1 = Math.min(W - 1, Math.ceil(w.c.x + bw / 2 + 1));
    const y0 = Math.max(0, Math.floor(w.c.y - bh / 2 - 1));
    const y1 = Math.min(H - 1, Math.ceil(w.c.y + bh / 2 + 1));
    // un trait qui traverse toute la boîte et continue au-delà : c'est un mur
    const crossedRow = (y: number) => dark(Math.max(0, x0 - 2), y) && dark(Math.min(W - 1, x1 + 2), y) && [...Array(x1 - x0 + 1).keys()].every((k) => dark(x0 + k, y));
    const crossedCol = (x: number) => dark(x, Math.max(0, y0 - 2)) && dark(x, Math.min(H - 1, y1 + 2)) && [...Array(y1 - y0 + 1).keys()].every((k) => dark(x, y0 + k));
    let wall = false;
    for (let y = y0; y <= y1 && !wall; y++) wall = crossedRow(y);
    for (let x = x0; x <= x1 && !wall; x++) wall = crossedCol(x);
    if (wall) continue;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = (y * W + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255;
      }
  }
  return { data, width: W, height: H };
}

export async function autoReadPlan(bg: Background, wallHeight: number, onStep: (m: string) => void = () => {}) {
  const px = await imagePixels(bg.src);
  // le texte d'abord : il sert à nommer les pièces, et on l'efface avant de chercher les murs
  onStep(tx("Lecture des noms des pièces…", "Reading room names…"));
  let words: OcrWord[] = [];
  try {
    words = await readWords(bg.src, px);
  } catch (e) {
    console.warn("OCR indisponible", e);
  }
  onStep(tx("Lecture des murs…", "Reading walls…"));
  const res = readPlanImage(eraseWords(px, words), { metersPerPx: bg.calibrated ? bg.scale : undefined, origin: { x: bg.x, y: bg.y }, wallHeight });
  if (!res || res.walls.length < 3) return null;
  const toPx = (p: Pt) => ({ x: (p.x - bg.x) / res.metersPerPx, y: (p.y - bg.y) / res.metersPerPx });
  const toPlan = (p: Pt) => ({ x: bg.x + p.x * res.metersPerPx, y: bg.y + p.y * res.metersPerPx });
  const found = roomsFromPolygons(detectAllRooms(res.walls));
  const pr = pruneOutdoor(found, res.walls, res.openings, res.raster, toPx);
  let rooms = roomsFromPolygons(pr.rooms.map((r) => r.points));
  // escaliers dessinés (marches) : la pièce qui les contient devient un escalier, volée à sa place exacte
  const withStairs = (list: Room[]) =>
    list.map((r) => {
      const st = res.stairs.find((x) => pointInPolygon({ x: x.x, y: x.y }, r.points));
      return st ? { ...r, stairs: st, type: "escalier" as const } : r;
    });
  rooms = withStairs(rooms).map((r) => (r.stairs ? { ...r, name: tx("Escalier", "Stairs") } : r));
  let walls = pr.walls;
  let openings = pr.openings;
  let mpp = res.metersPerPx;
  let scaleFrom: "calibrage" | "surfaces" | "murs" = res.estimated ? "murs" : "calibrage";
  let named = 0;

  // noms et surfaces écrits sur le plan
  try {
    const lab = labelRooms(rooms, words, toPlan);
    named = lab.named;
    rooms = lab.rooms;
    // la plupart des pièces sont nommées : les autres ne gardent pas un type deviné (souvent faux)
    if (named >= rooms.length / 2) {
      let n = 0;
      rooms = rooms.map((r) => {
        if (lab.namedIds.has(r.id)) return r;
        n++;
        return { ...r, name: tx(`Pièce ${n}`, `Room ${n}`), type: "autre" as const };
      });
    }
    if (lab.scale && res.estimated && Math.abs(lab.scale - 1) > 0.005) {
      // les surfaces écrites donnent la vraie échelle : on remet tout aux bonnes dimensions
      const k = lab.scale;
      const sc = (p: Pt) => ({ x: bg.x + (p.x - bg.x) * k, y: bg.y + (p.y - bg.y) * k });
      walls = walls.map((w) => ({ ...w, a: sc(w.a), b: sc(w.b), thickness: Math.round(w.thickness * k * 100) / 100 }));
      openings = openings.map((o) => ({ ...o, t: o.t * k, width: Math.round(o.width * k * 100) / 100 }));
      rooms = rooms.map((r) => ({
        ...r,
        points: r.points.map(sc),
        stairs: r.stairs && { ...r.stairs, ...sc(r.stairs), w: r.stairs.w * k, d: r.stairs.d * k },
      }));
      mpp *= k;
      scaleFrom = "surfaces";
    } else if (lab.scale && res.estimated) scaleFrom = "surfaces";
  } catch (err) {
    console.warn("OCR indisponible", err);
  }

  // l'OCR a pu renommer la pièce (« Hall » quand l'escalier donne dans le hall) : l'escalier reste
  rooms = rooms.map((r) => {
    if (!r.stairs) return r;
    const name = /escalier|stair/i.test(r.name)
      ? r.name
      : /^(Pièce|Room) \d+$/.test(r.name)
        ? tx("Escalier", "Stairs")
        : tx(`${r.name} et escalier`, `${r.name} and stairs`);
    return { ...r, name, type: "escalier" as const };
  });
  openings = fixInteriorOpenings(openings, walls, rooms, true);
  // grande ouverture d'un garage vers l'extérieur : c'est le portail, pas une baie vitrée
  openings = openings.map((o) => {
    if (o.width < 2) return o;
    const s = openingSides(o, walls, rooms);
    const garage = s && [s.r1, s.r2].some((r) => r?.type === "garage") && (!s.r1 || !s.r2);
    return garage ? { ...o, kind: "passage" as const, height: 2.4, sill: 0 } : o;
  });
  return { walls, openings, rooms, metersPerPx: mpp, estimated: scaleFrom === "murs", scaleFrom, named };
}
