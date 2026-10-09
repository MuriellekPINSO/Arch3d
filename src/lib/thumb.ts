/* Vignette d'un projet pour « Mon espace » : le plan du rez-de-chaussée en SVG (pièces colorées, murs), quelques Ko. */
import { polygonArea } from "./geometry";
import type { Project, Room, Wall } from "./types";

const FILL: Record<string, string> = {
  salon: "#f3d9b8", chambre: "#d6e4d0", cuisine: "#f4e3a8", salle_de_bain: "#cfe3ec", wc: "#cfe3ec",
  salle_a_manger: "#f0d0c0", bureau: "#e2dcef", couloir: "#ece8df", terrasse: "#dfe8c8", garage: "#e0ddd6", escalier: "#e6e0f0", autre: "#e8e4dc",
};

/** tous les niveaux du projet (le niveau actif vit dans les champs du projet, les autres dans levels[i].data) */
function levelsOf(p: Project): { walls: Wall[]; rooms: Room[] }[] {
  if (!p.levels?.length) return [{ walls: p.walls, rooms: p.rooms }];
  return p.levels.map((L, i) => (i === (p.level ?? 0) ? { walls: p.walls, rooms: p.rooms } : { walls: L.data?.walls ?? [], rooms: L.data?.rooms ?? [] }));
}

export function projectStats(p: Project) {
  const levels = levelsOf(p);
  const rooms = levels.flatMap((L) => L.rooms);
  return { rooms: rooms.length, area: Math.round(rooms.reduce((s, r) => s + Math.abs(polygonArea(r.points)), 0) * 10) / 10, levels: levels.length };
}

export function projectThumb(p: Project): string {
  const L = levelsOf(p)[0];
  const pts = L.walls.flatMap((w) => [w.a, w.b]);
  if (!pts.length) return "";
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = Math.max(x1 - x0, y1 - y0) * 0.06;
  const r = (n: number) => Math.round(n * 100) / 100;
  const rooms = L.rooms
    .map((rm) => `<polygon points="${rm.points.map((q) => `${r(q.x)},${r(q.y)}`).join(" ")}" fill="${FILL[rm.type] ?? "#eee"}"/>`)
    .join("");
  const walls = L.walls
    .map((w) => `<line x1="${r(w.a.x)}" y1="${r(w.a.y)}" x2="${r(w.b.x)}" y2="${r(w.b.y)}" stroke-width="${r(Math.max(w.thickness, 0.12))}"/>`)
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(x0 - pad)} ${r(y0 - pad)} ${r(x1 - x0 + 2 * pad)} ${r(y1 - y0 + 2 * pad)}">` +
    `${rooms}<g stroke="#2a2620" stroke-linecap="square">${walls}</g></svg>`
  );
}
