/* Lecture d'un plan par l'IA (Claude, par OpenRouter chez fal.ai), côté serveur uniquement.
   L'IA lit le plan comme un architecte : niveaux dessinés sur la feuille, pièces (nom écrit, type, surface, contour,
   dedans ou dehors), murs à n'importe quel angle, portes et fenêtres, escaliers, échelle. Les coordonnées sont des
   pixels de l'image envoyée ; le navigateur les ramène sur son image du plan et en fait murs, pièces et niveaux. */

const KEY = process.env.FAL_KEY ?? "";
export const PLAN_AI_READY = KEY.length > 0;
// modèle réglable sans toucher au code (OpenRouter : « fournisseur/modèle »)
const MODEL = process.env.PLAN_AI_MODEL || "anthropic/claude-opus-5.5";
const ENDPOINT = "https://fal.run/openrouter/router/vision";

export type AiPt = [number, number];
export type AiRoomType =
  | "living" | "dining" | "kitchen" | "bedroom" | "bathroom" | "wc" | "hall" | "corridor" | "office" | "storage" | "dressing"
  | "laundry" | "garage" | "stairs" | "terrace" | "balcony" | "porch" | "pool" | "garden" | "other";
export type AiOpeningKind = "door" | "window" | "sliding" | "opening";

export interface AiPlan {
  label: string;
  level: number; // -1 sous-sol, 0 rez-de-chaussée, 1 R+1…
  bbox: [number, number, number, number];
  scale: { p1: AiPt; p2: AiPt; meters: number } | null;
}
export interface AiRoom { plan: number; name: string; type: AiRoomType; indoor: boolean; area: number | null; label: AiPt; polygon: AiPt[] }
export interface AiWall { plan: number; a: AiPt; b: AiPt; thickness: number | null; exterior: boolean }
export interface AiOpening { plan: number; kind: AiOpeningKind; a: AiPt; b: AiPt }
export interface AiStairs { plan: number; polygon: AiPt[] }

/** Ce que l'IA a lu, en pixels de l'image envoyée (w × h). */
export interface PlanReading {
  w: number;
  h: number;
  plans: AiPlan[];
  rooms: AiRoom[];
  walls: AiWall[];
  openings: AiOpening[];
  stairs: AiStairs[];
}

const ROOM_TYPES: AiRoomType[] = [
  "living", "dining", "kitchen", "bedroom", "bathroom", "wc", "hall", "corridor", "office", "storage", "dressing",
  "laundry", "garage", "stairs", "terrace", "balcony", "porch", "pool", "garden", "other",
];
const OPENING_KINDS: AiOpeningKind[] = ["door", "window", "sliding", "opening"];

const SYSTEM = "You are an expert architect who converts 2D floor plan drawings into precise structured data for 3D reconstruction. Answer with one JSON object only, no markdown, no commentary.";

function prompt(w: number, h: number, single: string | null) {
  const sheet = single
    ? `This image shows ONE floor plan only (${JSON.stringify(single)}), cropped from a larger sheet. Return exactly one entry in "plans", ignore any part of another plan cut at the edges.`
    : "The sheet may show several floor plans side by side (basement, ground floor, upper floors…): return one entry per plan in \"plans\". Ignore sections, elevations, site plans and title blocks.";
  return `This image is ${w} x ${h} pixels. Coordinates are pixel coordinates [x, y] in this image, origin at the top-left corner, x to the right, y downwards. Be as precise as possible: put wall coordinates on the centre line of the drawn wall. Room polygons of neighbouring rooms must share the same wall line.
${sheet}

Read the floor plan and return:
{
  "plans": [ { "label": "name written on the sheet (e.g. Rez-de-chaussée, R+1, Étage 2, Sous-sol), or inferred", "level": 0, "bbox": [x0, y0, x1, y1], "scale": { "p1": [x, y], "p2": [x, y], "meters": number } } ],   // level: -1 basement, 0 ground floor, 1 first floor (R+1), 2 second floor… "scale": two points whose real distance is known (scale bar or a written dimension line), or null
  "rooms": [ { "plan": 0, "name": "exact text written on the plan, original language, without the area", "type": "${ROOM_TYPES.join("|")}", "indoor": true, "area_written": number or null, "label": [x, y], "polygon": [[x, y], ...] } ],   // every enclosed space and every outdoor area (terrace, balcony, porch, pool, garden: indoor=false). Polygon follows the inner faces of the walls, clockwise, any angle allowed (walls are not always horizontal/vertical). area_written = the surface written in the room (m²), null if none.
  "walls": [ { "plan": 0, "a": [x, y], "b": [x, y], "thickness_px": number, "exterior": true } ],   // EVERY wall segment: exterior walls AND every interior partition between two rooms, including diagonal ones; curved walls as several short segments. Walls must meet exactly at corners and T-junctions (same coordinates). Openings do not split walls: give the full wall from corner to corner. No wall where two spaces are open to each other.
  "openings": [ { "plan": 0, "kind": "${OPENING_KINDS.join("|")}", "a": [x, y], "b": [x, y] } ],   // a and b = the two ends of the opening, on the wall line. Doors are drawn as an arc (quarter circle) next to a gap; windows as thin double/triple lines inside the wall; sliding = sliding glass doors / large bay windows; list every one.
  "stairs": [ { "plan": 0, "polygon": [[x, y], ...] } ]   // outline of each flight of stairs
}`;
}

/* ---------- vérification de la réponse ---------- */

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseReading(raw: string, w: number, h: number): PlanReading {
  const text = raw.replace(/```(?:json)?/g, "");
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  if (i < 0 || j <= i) throw new Error("réponse sans JSON");
  const d = JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(d[k]) ? (d[k] as Record<string, unknown>[]).filter((x) => x && typeof x === "object") : []);
  // un point dans l'image (un peu de marge : un contour peut déborder d'un pixel ou deux)
  const pt = (v: unknown): AiPt | null => {
    if (!Array.isArray(v) || v.length < 2) return null;
    const [x, y] = [num(v[0]), num(v[1])];
    if (x === null || y === null || x < -0.05 * w || x > 1.05 * w || y < -0.05 * h || y > 1.05 * h) return null;
    return [x, y];
  };
  const poly = (v: unknown) => (Array.isArray(v) ? v.map(pt).filter((p): p is AiPt => !!p) : []);

  const plans: AiPlan[] = list("plans").map((p, k) => {
    const b = Array.isArray(p.bbox) ? p.bbox.map(num) : [];
    const bbox: AiPlan["bbox"] = b.length === 4 && b.every((x) => x !== null) ? (b as AiPlan["bbox"]) : [0, 0, w, h];
    const s = p.scale as Record<string, unknown> | null | undefined;
    const p1 = s && pt(s.p1);
    const p2 = s && pt(s.p2);
    const meters = s ? num(s.meters) : null;
    return {
      label: typeof p.label === "string" ? p.label.trim().slice(0, 40) : "",
      level: Math.round(num(p.level) ?? k),
      bbox,
      scale: p1 && p2 && meters && meters > 0 ? { p1, p2, meters } : null,
    };
  });
  if (!plans.length) plans.push({ label: "", level: 0, bbox: [0, 0, w, h], scale: null });
  // l'ancienne forme (une seule échelle pour la feuille) : elle vaut pour le premier plan
  const top = d.scale as Record<string, unknown> | undefined;
  if (!plans[0].scale && top) {
    const p1 = pt(top.p1);
    const p2 = pt(top.p2);
    const meters = num(top.meters);
    if (p1 && p2 && meters && meters > 0) plans[0].scale = { p1, p2, meters };
  }
  const planOf = (v: unknown) => {
    const n = num(v);
    return n !== null && Number.isInteger(n) && n >= 0 && n < plans.length ? n : 0;
  };

  const rooms: AiRoom[] = list("rooms")
    .map((r) => ({
      plan: planOf(r.plan),
      name: typeof r.name === "string" ? r.name.trim().slice(0, 40) : "",
      type: ROOM_TYPES.includes(r.type as AiRoomType) ? (r.type as AiRoomType) : "other",
      indoor: r.indoor !== false,
      area: (() => {
        const a = num(r.area_written);
        return a && a > 0.3 && a < 2000 ? a : null;
      })(),
      label: pt(r.label) ?? [0, 0],
      polygon: poly(r.polygon),
    }))
    .filter((r) => r.polygon.length >= 3);
  const walls: AiWall[] = list("walls").flatMap((x) => {
    const a = pt(x.a);
    const b = pt(x.b);
    if (!a || !b) return [];
    const t = num(x.thickness_px);
    return [{ plan: planOf(x.plan), a, b, thickness: t && t > 0 ? t : null, exterior: x.exterior === true }];
  });
  const openings: AiOpening[] = list("openings").flatMap((x) => {
    const a = pt(x.a);
    const b = pt(x.b);
    if (!a || !b) return [];
    return [{ plan: planOf(x.plan), kind: OPENING_KINDS.includes(x.kind as AiOpeningKind) ? (x.kind as AiOpeningKind) : "opening", a, b }];
  });
  const stairs: AiStairs[] = list("stairs")
    .map((x) => ({ plan: planOf(x.plan), polygon: poly(x.polygon) }))
    .filter((x) => x.polygon.length >= 3);
  return { w, h, plans, rooms, walls, openings, stairs };
}

/** Fait lire le plan (image en data URL, w × h pixels). `single` : nom du niveau quand l'image n'en montre qu'un. */
export async function readPlan(image: string, w: number, h: number, single: string | null): Promise<PlanReading & { cost: number | null }> {
  let last: Error | null = null;
  // une seconde chance si la réponse arrive coupée ou mal formée
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Key ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        system_prompt: SYSTEM,
        prompt: prompt(w, h, single),
        image_urls: [image],
        reasoning: true, // obligatoire pour ce modèle
        temperature: 0,
        max_tokens: 32000,
      }),
      signal: AbortSignal.timeout(170_000),
    });
    const j = (await r.json().catch(() => ({}))) as { output?: string; usage?: { cost?: number }; detail?: unknown };
    if (!r.ok) throw new Error(`fal : ${typeof j.detail === "string" ? j.detail : `HTTP ${r.status}`}`);
    try {
      return { ...parseReading(String(j.output ?? ""), w, h), cost: num(j.usage?.cost) };
    } catch (e) {
      last = e as Error;
    }
  }
  throw new Error(`lecture illisible (${last?.message})`);
}
