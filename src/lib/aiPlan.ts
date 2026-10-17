"use client";
import type { Background, LevelContent, Opening, OpeningKind, Pt, Room, RoomType, Wall } from "./types";
import { OPENING_DEFAULTS, uid } from "./types";
import { roomLabel, tx, useLang } from "./i18n";
import { authHeader } from "./firebase";
import { add, dist, dot, lerp, mul, norm, pointInPolygon, pointSegDist, polygonArea, projectOnWall, sub, wallLength } from "./geometry";
import { fixInteriorOpenings, garageGates } from "./importers";
import type { AiOpeningKind, AiPt, AiRoomType, AiWall, PlanReading } from "./planReader";

/* Lecture d'un plan par l'IA, côté navigateur : l'image part au serveur (/api/plan), la lecture revient en pixels,
   on en fait des murs, des ouvertures, des pièces et des niveaux en mètres.
   Une feuille qui montre plusieurs niveaux est découpée : chaque niveau est relu seul, en pleine résolution,
   et garde son morceau d'image comme calque. */

const AI_MAX = 1568; // côté le plus long que l'IA voit en entier (au-delà, l'image est réduite chez elle)
const BG_MAX = 2400; // comme les plans importés (sauvegarde du navigateur)

export type ScaleFrom = "calibrage" | "surfaces" | "echelle" | "portes" | "estimee";

export interface AiLevel extends LevelContent {
  name: string;
  levelNo: number; // -1 sous-sol, 0 rez-de-chaussée, 1 R+1…
  background: Background;
  scaleFrom: ScaleFrom;
  named: number; // pièces nommées d'après le plan
}

export type AiResult = { ok: true; levels: AiLevel[] } | { ok: false; error: string; needLogin?: boolean };

/* ---------- de la lecture aux murs et aux pièces ---------- */

const TYPES: Record<AiRoomType, RoomType | null> = {
  living: "salon",
  dining: "salle_a_manger",
  kitchen: "cuisine",
  bedroom: "chambre",
  bathroom: "salle_de_bain",
  wc: "wc",
  hall: "couloir",
  corridor: "couloir",
  office: "bureau",
  storage: "autre",
  dressing: "autre",
  laundry: "autre",
  garage: "garage",
  stairs: "escalier",
  terrace: "terrasse",
  balcony: "terrasse",
  porch: "terrasse",
  pool: null, // piscine et jardin restent dessinés au sol (plan plaqué), ce ne sont pas des pièces
  garden: null,
  other: "autre",
};
const KINDS: Record<AiOpeningKind, OpeningKind> = { door: "door", window: "window", sliding: "baie", opening: "passage" };

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Nom d'un niveau : celui écrit sur la feuille, sinon d'après son numéro. */
function levelName(label: string, n: number) {
  let l = label.trim();
  // « REZ-DE-CHAUSSÉE » → « Rez-de-chaussée », en gardant R+1 et RDC
  if (l && l === l.toUpperCase()) l = l.toLowerCase().replace(/\br\+(\d)/g, "R+$1").replace(/\brdc\b/g, "RDC");
  if (l) return l[0].toUpperCase() + l.slice(1);
  return n < 0 ? tx("Sous-sol", "Basement") : n === 0 ? tx("Rez-de-chaussée", "Ground floor") : tx(`Étage ${n}`, `Floor ${n}`);
}

/** Plus petit rectangle qui contient les points (volée d'escalier) : centre, longueur w, largeur d, angle comme les meubles. */
function minRect(pts: Pt[]) {
  let best: { area: number; phi: number; c: Pt; w: number; d: number } | null = null;
  for (let deg = 0; deg < 180; deg++) {
    const phi = (deg * Math.PI) / 180;
    const [c, s] = [Math.cos(phi), Math.sin(phi)];
    const us = pts.map((p) => p.x * c + p.y * s);
    const vs = pts.map((p) => -p.x * s + p.y * c);
    const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
    const area = (u1 - u0) * (v1 - v0);
    if (best && area >= best.area) continue;
    const [um, vm] = [(u0 + u1) / 2, (v0 + v1) / 2];
    const long = u1 - u0 >= v1 - v0;
    best = { area, phi: long ? phi : phi + Math.PI / 2, c: { x: um * c - vm * s, y: um * s + vm * c }, w: Math.max(u1 - u0, v1 - v0), d: Math.min(u1 - u0, v1 - v0) };
  }
  const b = best!;
  // rotation-y des meubles : x local → (cos rot, -sin rot) sur le plan ; on garde l'angle dans ]-90°, 90°]
  let rot = -b.phi;
  while (rot <= -Math.PI / 2) rot += Math.PI;
  while (rot > Math.PI / 2) rot -= Math.PI;
  return { x: b.c.x, y: b.c.y, w: b.w, d: b.d, rot };
}

/** Bouts de murs voisins réunis (coins), puis bouts posés sur un autre mur (jonctions en T). */
function snapWalls(walls: Wall[], tol: number): Wall[] {
  const ends = walls.flatMap((w) => [w.a, w.b]);
  const group = ends.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
  for (let i = 0; i < ends.length; i++)
    for (let j = i + 1; j < ends.length; j++) if (dist(ends[i], ends[j]) < tol) group[root(i)] = root(j);
  const sums = new Map<number, { x: number; y: number; n: number }>();
  ends.forEach((p, i) => {
    const s = sums.get(root(i)) ?? { x: 0, y: 0, n: 0 };
    sums.set(root(i), { x: s.x + p.x, y: s.y + p.y, n: s.n + 1 });
  });
  const at = (i: number) => {
    const s = sums.get(root(i))!;
    return { x: s.x / s.n, y: s.y / s.n };
  };
  const out = walls.map((w, k) => ({ ...w, a: at(2 * k), b: at(2 * k + 1) }));
  for (const w of out)
    for (const end of ["a", "b"] as const) {
      const p = w[end];
      for (const o of out) {
        if (o === w || pointSegDist(p, o.a, o.b) >= tol) continue;
        const pr = projectOnWall(p, o);
        if (pr.t > tol && pr.t < wallLength(o) - tol) w[end] = pr.point;
      }
    }
  return out.filter((w) => wallLength(w) >= 0.15);
}

/** Côtés des pièces intérieures qui donnent dehors sans mur lu : la façade y est quand même.
    Entre deux pièces sans mur lu, on laisse ouvert (séjour ouvert sur le hall…). */
function missingFacades(rooms: Room[], walls: Wall[], height: number): Wall[] {
  const indoor = rooms.filter((r) => r.type !== "terrasse");
  const out: Wall[] = [];
  for (const r of indoor) {
    const pts = r.points;
    const sign = polygonArea(pts) > 0 ? 1 : -1; // sens de parcours, comme offsetPolygon
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length];
      if (dist(a, b) < 0.4) return;
      const dir = norm(sub(b, a));
      const outward = mul({ x: dir.y, y: -dir.x }, sign);
      let covered = 0;
      for (let s = 0; s < 8; s++) {
        const q = lerp(a, b, (s + 0.5) / 8);
        if ([...walls, ...out].some((w) => pointSegDist(q, w.a, w.b) < w.thickness / 2 + 0.25 && Math.abs(dot(norm(sub(w.b, w.a)), dir)) > 0.9)) covered++;
      }
      if (covered >= 5) return;
      const probe = add(lerp(a, b, 0.5), mul(outward, 0.45));
      if (indoor.some((o) => o !== r && pointInPolygon(probe, o.points))) return;
      const t = 0.2;
      const off = mul(outward, t / 2);
      out.push({ id: uid(), a: add(a, off), b: add(b, off), thickness: t, height });
    });
  }
  return out;
}

/** Un niveau de la lecture, en mètres. `toPx` ramène un point lu sur l'image du calque `bg` ; `k` = pixels du calque par pixel lu. */
export function buildLevel(R: PlanReading, plan: number, toPx: (p: AiPt) => Pt, k: number, bg: Background, height: number): AiLevel {
  const P = R.plans[plan];
  const rooms0 = R.rooms.filter((x) => x.plan === plan);
  const walls0 = R.walls.filter((x) => x.plan === plan);
  const ops0 = R.openings.filter((x) => x.plan === plan);
  const stairs0 = R.stairs.filter((x) => x.plan === plan);

  // ---- échelle, en mètres par pixel du calque : calibrage, sinon surfaces écrites, échelle graphique, portes
  const pxArea = (poly: AiPt[]) => Math.abs(polygonArea(poly.map(toPx)));
  let areas = rooms0.filter((r) => r.area).map((r) => Math.sqrt(r.area! / pxArea(r.polygon))).filter((v) => Number.isFinite(v) && v > 0);
  const m0 = median(areas);
  areas = areas.filter((v) => Math.abs(v / m0 - 1) < 0.25); // une surface mal lue ou une pièce mal tracée ne fausse pas tout
  const barPx = P.scale ? dist(toPx(P.scale.p1), toPx(P.scale.p2)) : 0;
  const doors = ops0.filter((o) => o.kind === "door").map((o) => dist(toPx(o.a), toPx(o.b)));
  const plausible = (mpp: number) => {
    const w = (P.bbox[2] - P.bbox[0]) * k * mpp; // largeur du plan en mètres
    return mpp > 0 && w > 3 && w < 300;
  };
  const candidates: [ScaleFrom, number][] = [
    ...(bg.calibrated ? [["calibrage", bg.scale] as [ScaleFrom, number]] : []),
    ...(areas.length >= 2 ? [["surfaces", median(areas)] as [ScaleFrom, number]] : []),
    ...(P.scale && barPx > 8 ? [["echelle", P.scale.meters / barPx] as [ScaleFrom, number]] : []),
    ...(areas.length === 1 ? [["surfaces", areas[0]] as [ScaleFrom, number]] : []),
    ...(doors.length ? [["portes", 0.85 / median(doors)] as [ScaleFrom, number]] : []),
  ];
  const [scaleFrom, mpp] = candidates.find(([, v]) => plausible(v)) ?? (["estimee", bg.scale] as [ScaleFrom, number]);
  const m = (q: AiPt): Pt => {
    const p = toPx(q);
    return { x: bg.x + p.x * mpp, y: bg.y + p.y * mpp };
  };

  // ---- pièces (les surfaces dehors : terrasses, porches, balcons ; ni jardin ni piscine)
  let named = 0;
  const rooms: Room[] = rooms0.flatMap((r) => {
    const type = TYPES[r.type];
    if (!type || (!r.indoor && type === "autre")) return [];
    const points = r.polygon.map(m).filter((p, i, l) => dist(p, l[(i + 1) % l.length]) > 0.02);
    if (points.length < 3 || Math.abs(polygonArea(points)) < 0.8) return [];
    if (r.name) named++;
    return [{ id: uid(), name: r.name || roomLabel(type), type, points }];
  });
  // escaliers : la volée prend place dans la pièce qui la contient, comme à la lecture sans IA
  for (const s of stairs0) {
    const pts = s.polygon.map(m);
    const st = minRect(pts);
    if (st.w < 0.6 || st.d < 0.5) continue;
    const host = rooms.find((r) => !r.stairs && pointInPolygon({ x: st.x, y: st.y }, r.points));
    if (!host) {
      rooms.push({ id: uid(), name: tx("Escalier", "Stairs"), type: "escalier", points: pts, stairs: st });
      continue;
    }
    host.stairs = st;
    if (host.type !== "escalier" && !/escalier|stair/i.test(host.name)) host.name = tx(`${host.name} et escalier`, `${host.name} and stairs`);
    host.type = "escalier";
  }

  // ---- murs : ceux lus (à n'importe quel angle), réunis aux coins, plus les façades oubliées
  const thick = (x: AiWall) => r2(clamp(x.thickness ? x.thickness * k * mpp : x.exterior ? 0.2 : 0.12, 0.07, 0.45));
  let walls: Wall[] = walls0.map((x) => ({ id: uid(), a: m(x.a), b: m(x.b), thickness: thick(x), height })).filter((w) => wallLength(w) >= 0.15);
  walls = snapWalls(walls, 0.2);
  walls = [...walls, ...missingFacades(rooms, walls, height)];

  // ---- portes et fenêtres : chacune sur le mur le plus proche qui lui est parallèle
  let openings: Opening[] = [];
  for (const o of ops0) {
    const a = m(o.a);
    const b = m(o.b);
    const mid = lerp(a, b, 0.5);
    let width = dist(a, b);
    if (width < 0.4) continue;
    const dir = norm(sub(b, a));
    let best: { w: Wall; d: number } | null = null;
    for (const w of walls) {
      const d = pointSegDist(mid, w.a, w.b);
      if (d > Math.max(0.35, w.thickness) || Math.abs(dot(norm(sub(w.b, w.a)), dir)) < 0.8) continue;
      if (!best || d < best.d) best = { w, d };
    }
    if (!best) continue;
    const L = wallLength(best.w);
    width = Math.min(width, L - 0.1);
    if (width < 0.4) continue;
    const t = clamp(projectOnWall(mid, best.w).t, width / 2, L - width / 2);
    const wid = best.w.id;
    if (openings.some((x) => x.wallId === wid && Math.abs(x.t - t) < (x.width + width) / 2)) continue;
    const kind = KINDS[o.kind];
    const d = OPENING_DEFAULTS[kind];
    openings.push({ id: uid(), wallId: wid, kind, t, width: r2(width), height: d.height, sill: d.sill });
  }
  openings = garageGates(fixInteriorOpenings(openings, walls, rooms, true), walls, rooms);

  return {
    name: levelName(P.label, P.level),
    levelNo: P.level,
    walls,
    openings,
    rooms,
    background: { ...bg, scale: mpp, auto: true, calibrated: bg.calibrated || scaleFrom === "surfaces" || scaleFrom === "echelle" },
    scaleFrom,
    named,
  };
}

/* ---------- échanges avec le serveur ---------- */

/** Morceau [x0, y0, x1, y1] d'une image (data URL), réduit à `max` pixels de côté au plus. */
async function crop(src: string, box: [number, number, number, number] | null, max: number) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const [x0, y0, x1, y1] = box ?? [0, 0, img.naturalWidth, img.naturalHeight];
  const [bw, bh] = [x1 - x0, y1 - y0];
  const s = Math.min(1, max / Math.max(bw, bh));
  const [w, h] = [Math.max(1, Math.round(bw * s)), Math.max(1, Math.round(bh * s))];
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.drawImage(img, x0, y0, bw, bh, 0, 0, w, h);
  return { src: cv.toDataURL("image/jpeg", 0.88), w, h };
}

async function ask(image: { src: string; w: number; h: number }, single: string | null): Promise<{ ok: true; reading: PlanReading } | { ok: false; error: string; needLogin?: boolean }> {
  const r = await fetch("/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-lang": useLang.getState().lang, ...(await authHeader()) },
    body: JSON.stringify({ image: image.src, w: image.w, h: image.h, single }),
  }).catch(() => null);
  if (!r) return { ok: false, error: tx("Serveur injoignable.", "Server unreachable.") };
  const j = (await r.json().catch(() => ({}))) as PlanReading & { error?: string; needLogin?: boolean };
  if (!r.ok) return { ok: false, error: j.error ?? `HTTP ${r.status}`, needLogin: j.needLogin };
  return { ok: true, reading: j };
}

/** Fait lire le plan du calque `bg` par l'IA : un niveau, ou plusieurs si la feuille en montre plusieurs (du plus bas au plus haut). */
export async function aiReadPlan(bg: Background, height: number, onStep: (m: string) => void = () => {}): Promise<AiResult> {
  onStep(tx("L'IA lit le plan… (20 à 60 s)", "The AI is reading the plan… (20 to 60 s)"));
  const first = await ask(await crop(bg.src, null, AI_MAX), null);
  if (!first.ok) return first;
  const R = first.reading;
  const k = bg.widthPx / R.w; // pixels du calque par pixel lu
  const scaled = (p: AiPt): Pt => ({ x: p[0] * k, y: p[1] * k });
  if (R.plans.length <= 1) return { ok: true, levels: [buildLevel(R, 0, scaled, k, bg, height)] };

  // plusieurs niveaux sur la feuille : chacun découpé (avec un peu de marge) et relu seul
  onStep(tx(`${R.plans.length} niveaux sur la feuille : l'IA lit chacun en détail…`, `${R.plans.length} floors on the sheet: the AI is reading each one in detail…`));
  const order = R.plans.map((p, i) => ({ p, i })).sort((a, b) => a.p.level - b.p.level || a.i - b.i);
  const levels = await Promise.all(
    order.map(async ({ p, i }) => {
      const [x0, y0, x1, y1] = p.bbox.map((v) => v * k);
      const mx = (x1 - x0) * 0.04;
      const my = (y1 - y0) * 0.04;
      const box: [number, number, number, number] = [
        Math.max(0, Math.floor(x0 - mx)),
        Math.max(0, Math.floor(y0 - my)),
        Math.min(bg.widthPx, Math.ceil(x1 + mx)),
        Math.min(bg.heightPx, Math.ceil(y1 + my)),
      ];
      const part = await crop(bg.src, box, BG_MAX);
      const lbg: Background = { ...bg, src: part.src, widthPx: part.w, heightPx: part.h, x: 0, y: 0 };
      const view = part.w > AI_MAX || part.h > AI_MAX ? await crop(part.src, null, AI_MAX) : part;
      const res = await ask(view, levelName(p.label, p.level));
      const toLevel = (lv: AiLevel) => ({ ...lv, name: levelName(p.label, p.level), levelNo: p.level });
      if (res.ok) {
        const kk = part.w / res.reading.w;
        return toLevel(buildLevel(res.reading, 0, (q) => ({ x: q[0] * kk, y: q[1] * kk }), kk, lbg, height));
      }
      // relecture impossible : on garde ce que la première lecture a vu de ce niveau
      const ks = part.w / (box[2] - box[0]);
      return toLevel(buildLevel(R, i, (q) => ({ x: (q[0] * k - box[0]) * ks, y: (q[1] * k - box[1]) * ks }), k * ks, lbg, height));
    }),
  );
  return { ok: true, levels };
}
