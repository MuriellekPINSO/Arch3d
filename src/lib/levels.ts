import type { Level, LevelContent, Project, Pt, Room, Wall } from "./types";
import { uid } from "./types";
import { add, mul, perp, pointAtWall, pointInPolygon, pointSegDist, roomAt, roomAnchor, wallDir, wallLength } from "./geometry";
import { furnish, type Furniture } from "./furnish";

/* Maisons à étages. Le niveau actif vit dans walls / openings / rooms / background / furniture du projet (tout l'éditeur
   travaille dessus sans rien savoir des étages) ; les autres niveaux sont rangés dans `levels[i].data`. */

export const SLAB = 0.2; // épaisseur du plancher entre deux niveaux
export const GROUND = "Rez-de-chaussée";

export interface LevelView extends LevelContent {
  name: string;
  index: number;
}

const contentOf = (p: Project): LevelContent => ({
  walls: p.walls,
  openings: p.openings,
  rooms: p.rooms,
  background: p.background,
  furniture: p.furniture,
});

const levelList = (p: Project): Level[] => p.levels ?? [{ name: GROUND }];
const active = (p: Project) => Math.min(p.level ?? 0, levelList(p).length - 1);

/** Tous les niveaux, du rez-de-chaussée au dernier. */
export function levelsOf(p: Project): LevelView[] {
  const cur = active(p);
  return levelList(p).map((l, i) => ({ ...(i === cur ? contentOf(p) : l.data!), name: l.name, index: i }));
}

export const levelCount = (p: Project) => levelList(p).length;
export const activeLevel = active;

/** Change de niveau actif (hors historique : l'annulation ramène aussi au bon niveau). */
export function switchLevel(p: Project, i: number): Partial<Project> {
  const cur = active(p);
  if (i === cur) return {};
  const list = levelList(p).map((l) => ({ ...l }));
  list[cur] = { name: list[cur].name, data: contentOf(p) };
  const next = list[i].data!;
  list[i] = { name: list[i].name };
  return { levels: list, level: i, ...next, furniture: next.furniture };
}

/** Murs de façade : un côté donne sur une pièce, l'autre sur l'extérieur (tous les murs s'il n'y a pas de pièces). */
export function exteriorWalls(walls: Wall[], rooms: Room[]): Wall[] {
  if (!rooms.length) return walls;
  return walls.filter((w) => {
    const mid = pointAtWall(w, wallLength(w) / 2);
    const n = perp(wallDir(w));
    const off = w.thickness / 2 + 0.3;
    return !roomAt(add(mid, mul(n, off)), rooms) !== !roomAt(add(mid, mul(n, -off)), rooms);
  });
}

/** Ajoute un étage au-dessus du dernier niveau, en reprenant ses murs de façade, et le rend actif. */
export function addLevel(p: Project): Partial<Project> {
  const all = levelsOf(p);
  const top = all[all.length - 1];
  const walls = exteriorWalls(top.walls, top.rooms).map((w) => ({ ...w, id: uid() }));
  const n = all.length;
  const list: Level[] = [...levelList(p), { name: n === 1 ? "Étage" : `Étage ${n}`, data: { walls, openings: [], rooms: [], background: null } }];
  return switchLevel({ ...p, levels: list }, n);
}

export function removeLevel(p: Project, i: number): Partial<Project> {
  const list = levelList(p);
  if (list.length < 2) return {};
  const cur = active(p);
  // on se place d'abord sur un autre niveau, puis on retire celui-ci
  const target = i === cur ? (i > 0 ? i - 1 : 1) : cur;
  const moved = { ...p, ...switchLevel(p, target) } as Project;
  const levels = moved.levels!.filter((_, k) => k !== i);
  return { ...moved, levels, level: target > i ? target - 1 : target };
}

export function renameLevel(p: Project, i: number, name: string): Partial<Project> {
  return { levels: levelList(p).map((l, k) => (k === i ? { ...l, name } : l)) };
}

/* ---------- position d'un niveau sur celui du dessous ---------- */

const shift = (q: Pt, d: Pt) => ({ x: q.x + d.x, y: q.y + d.y });

/** Déplace tout le niveau actif (murs, pièces, meubles, plan importé). */
export function translateActive(p: Project, d: Pt): Partial<Project> {
  return {
    walls: p.walls.map((w) => ({ ...w, a: shift(w.a, d), b: shift(w.b, d) })),
    rooms: p.rooms.map((r) => ({ ...r, points: r.points.map((q) => shift(q, d)), stairs: r.stairs && { ...r.stairs, ...shift(r.stairs, d) } })),
    furniture: p.furniture?.map((f) => ({ ...f, ...shift(f, d) })),
    background: p.background && { ...p.background, x: p.background.x + d.x, y: p.background.y + d.y },
  };
}

/** Décalage qui pose au mieux les façades du niveau actif sur celles du dessous (coins ou centres des emprises). */
export function alignOffset(p: Project): Pt | null {
  const cur = active(p);
  if (cur === 0) return null;
  const below = levelsOf(p)[cur - 1];
  const mine = exteriorWalls(p.walls, p.rooms);
  const ref = exteriorWalls(below.walls, below.rooms);
  if (!mine.length || !ref.length) return null;
  const box = (ws: Wall[]) => {
    const xs = ws.flatMap((w) => [w.a.x, w.b.x]);
    const ys = ws.flatMap((w) => [w.a.y, w.b.y]);
    return { x: [Math.min(...xs), (Math.min(...xs) + Math.max(...xs)) / 2, Math.max(...xs)], y: [Math.min(...ys), (Math.min(...ys) + Math.max(...ys)) / 2, Math.max(...ys)] };
  };
  const a = box(mine);
  const b = box(ref);
  // écart des points de façade du niveau actif aux façades du dessous, après décalage
  const samples = mine.flatMap((w) => [0.1, 0.5, 0.9].map((t) => pointAtWall(w, wallLength(w) * t)));
  const score = (d: Pt) =>
    samples.reduce((s, q) => {
      const m = shift(q, d);
      return s + Math.min(1, ...ref.map((w) => pointSegDist(m, w.a, w.b)));
    }, 0);
  let best: { d: Pt; s: number } | null = null;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const d = { x: b.x[i] - a.x[i], y: b.y[j] - a.y[j] };
      const s = score(d);
      if (!best || s < best.s - 1e-6) best = { d, s };
    }
  return best!.d;
}

/* ---------- hauteurs et escaliers ---------- */

export const levelHeight = (lv: LevelContent) => lv.walls.reduce((m, w) => Math.max(m, w.height), lv.walls.length ? 0 : 2.8);

/** Altitude du plancher de chaque niveau. */
export function elevations(levels: LevelContent[]) {
  const z: number[] = [];
  levels.forEach((lv, i) => z.push(i ? z[i - 1] + levelHeight(levels[i - 1]) + SLAB : 0));
  return z;
}

/** Une volée d'escalier : rectangle au sol et sens de la montée (du bas vers le haut). */
export interface Flight {
  center: Pt;
  w: number; // longueur (sens de la montée)
  d: number; // largeur
  dir: Pt; // vers le haut de la volée
  side: Pt; // en travers
  bottom: Pt;
  top: Pt;
  corners: Pt[];
}

/** Volée d'un meuble « escalier » : les marches montent le long de son axe local x. */
export function flightOf(f: Pick<Furniture, "x" | "y" | "w" | "d" | "rot">): Flight {
  const dir = { x: Math.cos(f.rot), y: -Math.sin(f.rot) };
  const side = { x: Math.sin(f.rot), y: Math.cos(f.rot) };
  const c = { x: f.x, y: f.y };
  const at = (u: number, v: number) => ({ x: c.x + dir.x * u + side.x * v, y: c.y + dir.y * u + side.y * v });
  return {
    center: c,
    w: f.w,
    d: f.d,
    dir,
    side,
    bottom: at(-f.w / 2, 0),
    top: at(f.w / 2, 0),
    corners: [at(-f.w / 2, -f.d / 2), at(f.w / 2, -f.d / 2), at(f.w / 2, f.d / 2), at(-f.w / 2, f.d / 2)],
  };
}

/** Position le long d'une volée (0 en bas, 1 en haut), ou null si le point n'est pas dessus. */
export function onFlight(fl: Flight, p: Pt, margin = 0.1) {
  const rel = { x: p.x - fl.center.x, y: p.y - fl.center.y };
  const u = rel.x * fl.dir.x + rel.y * fl.dir.y;
  const v = rel.x * fl.side.x + rel.y * fl.side.y;
  if (Math.abs(v) > fl.d / 2 || Math.abs(u) > fl.w / 2 + margin) return null;
  return Math.min(1, Math.max(0, (u + fl.w / 2) / fl.w));
}

/* mobilier automatique, recalculé seulement quand le niveau change */
const furnishCache = new WeakMap<Room[], { walls: Wall[]; openings: LevelContent["openings"]; out: Furniture[] }>();
function furnishCached(lv: LevelContent) {
  const hit = furnishCache.get(lv.rooms);
  if (hit && hit.walls === lv.walls && hit.openings === lv.openings) return hit.out;
  const out = furnish(lv.rooms, lv.walls, lv.openings);
  furnishCache.set(lv.rooms, { walls: lv.walls, openings: lv.openings, out });
  return out;
}

/** Meubles affichés d'un niveau : ceux posés à la main, sinon l'ameublement automatique ; plus les escaliers lus sur le plan. */
export function levelFurniture(lv: LevelContent, furnished: boolean): Furniture[] {
  const list = lv.furniture ?? (furnished ? furnishCached(lv) : []);
  const stairs = lv.rooms.filter((r) => r.stairs).map((r): Furniture => ({ id: `escalier-${r.id}`, roomId: r.id, kind: "escalier", ...r.stairs! }));
  return stairs.length ? [...list, ...stairs] : list;
}

/** Tout ce qu'il faut pour dessiner et parcourir la maison : niveaux, altitudes, meubles, volées entre niveaux. */
export interface HouseLevel extends LevelView {
  z: number; // altitude du plancher
  height: number; // hauteur des murs
  furniture: Furniture[];
  /** volées qui montent de ce niveau au suivant (ou au toit-terrasse pour le dernier) */
  flights: Flight[];
}

export function houseLevels(p: Project): HouseLevel[] {
  const all = levelsOf(p);
  const z = elevations(all);
  return all.map((lv, i) => {
    // l'escalier monte au niveau du dessus ; au dernier niveau, il débouche sur le toit-terrasse
    const rise = i < all.length - 1 ? z[i + 1] - z[i] : levelHeight(lv) + SLAB;
    const furniture = levelFurniture(lv, p.furnished).map((f) => (f.kind === "escalier" ? { ...f, rise } : f));
    return {
      ...lv,
      z: z[i],
      height: levelHeight(lv),
      furniture,
      flights: furniture.filter((f) => f.kind === "escalier").map(flightOf),
    };
  });
}

/** Volée droite posée le long du plus grand côté d'une pièce (à retourner ensuite si elle monte dans le mauvais sens). */
export function defaultStairs(room: Room): NonNullable<Room["stairs"]> {
  const xs = room.points.map((p) => p.x);
  const ys = room.points.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const alongX = x1 - x0 >= y1 - y0;
  const len = Math.min(4.2, (alongX ? x1 - x0 : y1 - y0) - 0.4);
  const d = Math.min(1.0, (alongX ? y1 - y0 : x1 - x0) - 0.1);
  return alongX
    ? { x: x0 + 0.2 + len / 2, y: y0 + d / 2 + 0.02, w: len, d, rot: 0 }
    : { x: x0 + d / 2 + 0.02, y: y0 + 0.2 + len / 2, w: len, d, rot: -Math.PI / 2 };
}

/** La pièce d'un niveau la plus proche d'un point (celle qui le contient si possible). */
export function nearestRoom(rooms: Room[], p: Pt): Room | null {
  const inside = rooms.find((r) => pointInPolygon(p, r.points));
  if (inside) return inside;
  let best: Room | null = null;
  let d = Infinity;
  for (const r of rooms) {
    const c = roomAnchor(r);
    const k = Math.hypot(c.x - p.x, c.y - p.y);
    if (k < d) {
      d = k;
      best = r;
    }
  }
  return best;
}
