import type { Pt, Room } from "./types";
import { uid } from "./types";
import { bbox, pointInPolygon, roomAnchor, roomAt } from "./geometry";
import { CATALOG, type Furniture, type FurnitureKind } from "./furnish";

/* Design d'espace : opérations sur la liste de meubles (fonctions pures, le store garde l'historique). */

const rect = (f: Pick<Furniture, "x" | "y" | "w" | "d" | "rot">) => {
  const side = Math.abs(Math.sin(f.rot)) > 0.5;
  const hw = (side ? f.d : f.w) / 2;
  const hd = (side ? f.w : f.d) / 2;
  return { x0: f.x - hw, y0: f.y - hd, x1: f.x + hw, y1: f.y + hd };
};

const overlaps = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

export const moveF = (list: Furniture[], id: string, x: number, y: number, rooms: Room[]) =>
  list.map((f) => (f.id === id ? { ...f, x, y, roomId: roomAt({ x, y }, rooms)?.id ?? f.roomId } : f));

export const rotateF = (list: Furniture[], id: string, delta: number) =>
  list.map((f) => (f.id === id ? { ...f, rot: Math.round(((f.rot + delta) % (Math.PI * 2)) * 1000) / 1000 } : f));

export const resizeF = (list: Furniture[], id: string, w: number, d: number) => list.map((f) => (f.id === id ? { ...f, w, d } : f));

export const removeF = (list: Furniture[], id: string) => list.filter((f) => f.id !== id);

export function duplicateF(list: Furniture[], id: string): [Furniture[], string | null] {
  const f = list.find((x) => x.id === id);
  if (!f) return [list, null];
  const copy = { ...f, id: uid(), x: f.x + 0.3, y: f.y + 0.3 };
  return [[...list, copy], copy.id];
}

/** Ajoute un meuble du catalogue dans la pièce, à la première place libre en partant du centre. */
export function addF(list: Furniture[], kind: FurnitureKind, room: Room): [Furniture[], string] {
  const c = CATALOG.find((x) => x.kind === kind)!;
  const b = bbox(room.points);
  const center = roomAnchor(room);
  const others = list.filter((f) => f.roomId === room.id && f.kind !== "tapis").map(rect);
  let spot: Pt = center;
  search: for (let r = 0; r < 6; r += 0.25)
    for (let k = 0; k < Math.max(1, Math.round(r * 8)); k++) {
      const a = (k / Math.max(1, Math.round(r * 8))) * Math.PI * 2;
      const p = { x: Math.round((center.x + Math.cos(a) * r) * 20) / 20, y: Math.round((center.y + Math.sin(a) * r) * 20) / 20 };
      const box = rect({ x: p.x, y: p.y, w: c.w, d: c.d, rot: 0 });
      if (box.x0 < b.minX || box.x1 > b.maxX || box.y0 < b.minY || box.y1 > b.maxY) continue;
      if (!pointInPolygon(p, room.points)) continue;
      if (kind !== "tapis" && others.some((o) => overlaps(o, box))) continue;
      spot = p;
      break search;
    }
  const f: Furniture = { id: uid(), roomId: room.id, kind, x: spot.x, y: spot.y, w: c.w, d: c.d, rot: 0 };
  return [[...list, f], f.id];
}

/* palettes proposées pour les finitions */
export const FLOOR_OPTIONS = [
  { kind: "parquet", label: "Parquet", colors: ["#c9a77c", "#a87b4f", "#e0c9a6", "#6b4a33"] },
  { kind: "carrelage", label: "Carrelage", colors: ["#e7e3dc", "#cfcac2", "#b9b4ab", "#8f8a82"] },
  { kind: "beton", label: "Béton ciré", colors: ["#c7c3bc", "#a9a59e", "#8a8780"] },
  { kind: "terre_cuite", label: "Terre cuite", colors: ["#c4693d", "#b0573a", "#d98b5f"] },
  { kind: "pierre", label: "Pierre", colors: ["#d9cfbd", "#c2b59b", "#a89c86"] },
] as const;

export const WALL_COLORS = ["#f4f1ea", "#efe6d6", "#e8d9c4", "#d9b99b", "#c98b6b", "#b6c4b0", "#9fb4c7", "#e3c26b", "#2f3a4a"];
