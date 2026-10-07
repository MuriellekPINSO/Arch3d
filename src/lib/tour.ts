import type { Opening, Pt, Room, Wall } from "./types";
import type { Furniture } from "./furnish";
import { add, mul, openingSides, roomAnchor, sub } from "./geometry";
import { nearestRoom, type Flight } from "./levels";

/* Visite guidée : on part de l'entrée (porte donnant sur l'extérieur), on parcourt toutes les pièces
   en profondeur, en passant par les portes, avec un arrêt au centre de chaque pièce ; puis on prend
   l'escalier et on recommence à l'étage. */

export interface TourStop {
  index: number; // indice du point d'arrêt dans `points`
  roomId: string;
  name: string;
  look: Pt; // point regardé pendant l'arrêt
  level: number;
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

export interface TourPoint extends Pt {
  z: number; // altitude du plancher
}

export interface Tour {
  points: TourPoint[];
  stops: TourStop[];
}

/** Un niveau à parcourir. */
export interface TourLevel {
  rooms: Room[];
  walls: Wall[];
  openings: Opening[];
  furniture: Furniture[];
  z: number;
  flights: Flight[]; // volées qui montent au niveau suivant
}

interface Edge {
  to: string | null; // null = extérieur
  opening: Opening;
  center: Pt;
  near: Pt; // point devant la porte, côté pièce de départ
  far: Pt; // point devant la porte, côté arrivée
}

/** Pièces reliées par leurs portes et passages, et porte d'entrée (donnant sur l'extérieur). */
function doorGraph(rooms: Room[], walls: Wall[], openings: Opening[]) {
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
  return { graph, entrance, path };
}

export function buildTour(levels: TourLevel[]): Tour | null {
  if (!levels[0]?.rooms.length) return null;
  const points: TourPoint[] = [];
  const stops: TourStop[] = [];
  let arrival: Pt | null = null; // haut de l'escalier, en arrivant à l'étage

  for (let li = 0; li < levels.length; li++) {
    const L = levels[li];
    if (!L.rooms.length || (li > 0 && !arrival)) break; // pas d'escalier : on reste en bas
    const at = (p: Pt): TourPoint => ({ x: p.x, y: p.y, z: L.z });
    const { graph, entrance, path } = doorGraph(L.rooms, L.walls, L.openings);
    const byId = new Map(L.rooms.map((r) => [r.id, r]));
    const start = arrival
      ? nearestRoom(L.rooms, arrival)!.id
      : (entrance?.room ?? L.rooms.find((r) => r.type === "salon")?.id ?? L.rooms[0].id);

    // ordre de visite : parcours en profondeur depuis l'entrée (ou le haut de l'escalier)
    const order: string[] = [];
    const seen = new Set<string>();
    const dfs = (id: string) => {
      seen.add(id);
      order.push(id);
      for (const e of graph.get(id) ?? []) if (e.to && !seen.has(e.to)) dfs(e.to);
    };
    dfs(start);
    // pièces non reliées par une porte : visitées à la fin, en « sautant »
    L.rooms.forEach((r) => !seen.has(r.id) && order.push(r.id));

    const stopHere = (id: string) => {
      const r = byId.get(id)!;
      const p = points[points.length - 1];
      stops.push({ index: points.length - 1, roomId: id, name: r.name, look: lookFrom(p, r, L.furniture), level: li });
    };
    /** va de la pièce `from` à la pièce `to` par les portes ; s'arrête sur le seuil de `to` */
    const go = (from: string, to: string) => {
      points.push(at(roomAnchor(byId.get(from)!))); // on traverse la pièce où l'on est (par son centre) avant d'en ressortir
      const edges = path(from, to);
      if (!edges) return void points.push(at(roomAnchor(byId.get(to)!)));
      edges.forEach((e, k) => {
        const last = k === edges.length - 1;
        points.push(at(e.near), at(e.center), at(last ? deeper(e.center, e.far) : e.far));
        if (!last) points.push(at(roomAnchor(byId.get(e.to!)!)));
      });
    };

    let current = order[0];
    if (arrival) {
      stopHere(current); // on est déjà sur le palier
    } else if (entrance) {
      points.push(at(entrance.outside), at(entrance.center), at(deeper(entrance.center, entrance.inside)));
      stopHere(current);
    } else {
      points.push(at(roomAnchor(byId.get(current)!)));
      stopHere(current);
    }
    for (const id of order.slice(1)) {
      go(current, id);
      stopHere(id);
      current = id;
    }

    // puis l'escalier vers le niveau suivant
    arrival = null;
    const fl = L.flights[0];
    const next = levels[li + 1];
    if (fl && next?.rooms.length) {
      const foot = nearestRoom(L.rooms, fl.bottom)!;
      if (foot.id !== current) go(current, foot.id);
      const before = add(fl.bottom, mul(fl.dir, -0.6));
      const after = add(fl.top, mul(fl.dir, 0.7));
      points.push(at(before), at(fl.bottom), { ...fl.top, z: next.z }, { ...after, z: next.z });
      arrival = after;
    }
  }

  // supprime les doublons consécutifs (une spline ne les supporte pas)
  const clean: TourPoint[] = [];
  const remap = new Map<number, number>();
  points.forEach((p, i) => {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y, last.z - p.z) > 0.05) clean.push(p);
    remap.set(i, clean.length - 1);
  });
  return { points: clean, stops: stops.map((s) => ({ ...s, index: remap.get(s.index)! })) };
}
