import type { Opening, Pt, Room, Wall } from "./types";
import type { Furniture } from "./furnish";
import { add, mul, openingSides, roomAnchor, sub } from "./geometry";

/* Visite guidée : on part de l'entrée (porte donnant sur l'extérieur), on parcourt toutes les pièces
   en profondeur, en passant par les portes, avec un arrêt au centre de chaque pièce. */

export interface TourStop {
  index: number; // indice du point d'arrêt dans `points`
  roomId: string;
  name: string;
  look: Pt; // point regardé pendant l'arrêt
}

/* Ce qu'on voit en entrant : depuis le seuil, on regarde vers le cœur de la pièce,
   c'est-à-dire là où sont les meubles s'il y en a. */
function lookFrom(p: Pt, room: Room, furniture: Furniture[] = []): Pt {
  const c = roomAnchor(room);
  const items = furniture.filter((f) => f.roomId === room.id && f.kind !== "tapis");
  let target = c;
  if (items.length) {
    let sw = 0, sx = 0, sy = 0;
    for (const f of items) {
      const w = f.w * f.d;
      sw += w; sx += f.x * w; sy += f.y * w;
    }
    target = { x: (sx / sw + c.x) / 2, y: (sy / sw + c.y) / 2 };
  }
  if (Math.hypot(target.x - p.x, target.y - p.y) > 1.2) return target;
  // trop près : on regarde vers le coin le plus éloigné
  let far = c;
  let best = -1;
  for (const v of room.points) {
    const d = Math.hypot(v.x - p.x, v.y - p.y);
    if (d > best) { best = d; far = v; }
  }
  return far;
}

const STOP = 1.15; // l'arrêt se fait à 1,15 m du seuil, dans le dégagement laissé libre devant la porte
const deeper = (center: Pt, near: Pt) => add(center, mul(sub(near, center), STOP / Math.max(0.01, Math.hypot(near.x - center.x, near.y - center.y))));

export const yawTowards = (from: Pt, to: Pt) => Math.atan2(-(to.x - from.x), -(to.y - from.y));

/** Point de vue pour « visiter » une pièce : sur le seuil de sa porte, tourné vers l'intérieur. */
export function roomViewpoint(room: Room, rooms: Room[], walls: Wall[], openings: Opening[], furniture: Furniture[] = []): { p: Pt; yaw: number } {
  const rank = { door: 0, passage: 1, baie: 2, window: 9 } as const;
  let best: { p: Pt; r: number } | null = null;
  for (const o of openings) {
    if (o.kind === "window") continue;
    const s = openingSides(o, walls, rooms);
    if (!s) continue;
    const sign = s.r1?.id === room.id ? 1 : s.r2?.id === room.id ? -1 : 0;
    if (!sign) continue;
    const w = walls.find((x) => x.id === o.wallId)!;
    const p = add(s.center, mul(s.normal, sign * Math.max(STOP, w.thickness / 2 + 0.6)));
    if (!best || rank[o.kind] < best.r) best = { p, r: rank[o.kind] };
  }
  const p = best?.p ?? roomAnchor(room);
  return { p, yaw: yawTowards(p, lookFrom(p, room, furniture)) };
}

export interface Tour {
  points: Pt[];
  stops: TourStop[];
}

interface Edge {
  to: string | null; // null = extérieur
  opening: Opening;
  center: Pt;
  near: Pt; // point devant la porte, côté pièce de départ
  far: Pt; // point devant la porte, côté arrivée
}

export function buildTour(rooms: Room[], walls: Wall[], openings: Opening[], furniture: Furniture[] = []): Tour | null {
  if (!rooms.length) return null;
  const graph = new Map<string, Edge[]>();
  rooms.forEach((r) => graph.set(r.id, []));
  let entrance: { room: string; outside: Pt; center: Pt; inside: Pt } | null = null;

  for (const o of openings) {
    if (o.kind === "window") continue;
    const s = openingSides(o, walls, rooms);
    if (!s) continue;
    const a = s.r1?.id ?? null;
    const b = s.r2?.id ?? null;
    if (a === b) continue;
    const p1 = add(s.center, mul(s.normal, 0.7));
    const p2 = add(s.center, mul(s.normal, -0.7));
    if (a) graph.get(a)!.push({ to: b, opening: o, center: s.center, near: p1, far: p2 });
    if (b) graph.get(b)!.push({ to: a, opening: o, center: s.center, near: p2, far: p1 });
    if ((!a || !b) && !entrance) {
      const room = (a ?? b)!;
      const outside = add(s.center, mul(s.normal, a ? -2.5 : 2.5));
      entrance = { room, outside, center: s.center, inside: a ? p1 : p2 };
    }
  }

  const byId = new Map(rooms.map((r) => [r.id, r]));
  const start = entrance?.room ?? rooms.find((r) => r.type === "salon")?.id ?? rooms[0].id;

  // ordre de visite : parcours en profondeur depuis l'entrée
  const order: string[] = [];
  const seen = new Set<string>();
  const dfs = (id: string) => {
    seen.add(id);
    order.push(id);
    const nexts = (graph.get(id) ?? []).filter((e) => e.to && !seen.has(e.to));
    for (const e of nexts) if (!seen.has(e.to!)) dfs(e.to!);
  };
  dfs(start);
  // pièces non reliées par une porte : visitées à la fin, en « sautant »
  rooms.forEach((r) => !seen.has(r.id) && order.push(r.id));

  // plus court chemin (en nombre de portes) entre deux pièces
  const path = (from: string, to: string): Edge[] | null => {
    const prev = new Map<string, { id: string; edge: Edge }>();
    const q = [from];
    const vis = new Set([from]);
    while (q.length) {
      const cur = q.shift()!;
      if (cur === to) break;
      for (const e of graph.get(cur) ?? []) {
        if (!e.to || vis.has(e.to)) continue;
        vis.add(e.to);
        prev.set(e.to, { id: cur, edge: e });
        q.push(e.to);
      }
    }
    if (!vis.has(to)) return null;
    const edges: Edge[] = [];
    let cur = to;
    while (cur !== from) {
      const p = prev.get(cur)!;
      edges.unshift(p.edge);
      cur = p.id;
    }
    return edges;
  };

  const points: Pt[] = [];
  const stops: TourStop[] = [];
  let current = order[0];
  const firstRoom = byId.get(current)!;
  if (entrance) {
    const at = deeper(entrance.center, entrance.inside);
    points.push(entrance.outside, entrance.center, at);
    stops.push({ index: points.length - 1, roomId: current, name: firstRoom.name, look: lookFrom(at, firstRoom, furniture) });
  } else {
    const a = roomAnchor(firstRoom);
    points.push(a);
    stops.push({ index: 0, roomId: current, name: firstRoom.name, look: lookFrom(a, firstRoom, furniture) });
  }

  for (const id of order.slice(1)) {
    // on traverse la pièce où l'on est (par son centre) avant d'en ressortir
    points.push(roomAnchor(byId.get(current)!));
    const edges = path(current, id);
    const r = byId.get(id)!;
    if (edges) {
      edges.forEach((e, k) => {
        const last = k === edges.length - 1;
        points.push(e.near, e.center, last ? deeper(e.center, e.far) : e.far);
        if (!last) points.push(roomAnchor(byId.get(e.to!)!));
      });
    } else {
      points.push(roomAnchor(r));
    }
    // arrêt sur le seuil de la pièce, regard vers son coin le plus éloigné
    const at = points[points.length - 1];
    stops.push({ index: points.length - 1, roomId: id, name: r.name, look: lookFrom(at, r, furniture) });
    current = id;
  }

  // supprime les doublons consécutifs (une spline ne les supporte pas)
  const clean: Pt[] = [];
  const remap = new Map<number, number>();
  points.forEach((p, i) => {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 0.05) clean.push(p);
    remap.set(i, clean.length - 1);
  });
  return { points: clean, stops: stops.map((s) => ({ ...s, index: remap.get(s.index)! })) };
}
