import type { Opening, Pt, Room, Wall } from "./types";
import { useLang } from "./i18n";

export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const len = (a: Pt) => Math.hypot(a.x, a.y);
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
export const norm = (a: Pt): Pt => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
export const perp = (a: Pt): Pt => ({ x: -a.y, y: a.x });
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export const wallLength = (w: Wall) => dist(w.a, w.b);
export const wallDir = (w: Wall) => norm(sub(w.b, w.a));

/** Projection d'un point sur un segment : position t (en mètres depuis a), point projeté, distance. */
export function projectOnWall(p: Pt, w: Wall) {
  const d = sub(w.b, w.a);
  const L = len(d) || 1e-9;
  const u = Math.max(0, Math.min(1, dot(sub(p, w.a), d) / (L * L)));
  const point = lerp(w.a, w.b, u);
  return { t: u * L, point, d: dist(p, point) };
}

export function pointAtWall(w: Wall, t: number): Pt {
  return lerp(w.a, w.b, t / (wallLength(w) || 1));
}

/** Morceaux pleins d'un mur une fois les ouvertures découpées : [début, fin, bas, haut] le long du mur. */
export function wallPieces(w: Wall, openings: Opening[]) {
  const L = wallLength(w);
  const ops = openings
    .filter((o) => o.wallId === w.id)
    .map((o) => ({ ...o, s: Math.max(0, o.t - o.width / 2), e: Math.min(L, o.t + o.width / 2) }))
    .sort((a, b) => a.s - b.s);
  const pieces: { s: number; e: number; y0: number; y1: number }[] = [];
  let cursor = 0;
  for (const o of ops) {
    if (o.s > cursor) pieces.push({ s: cursor, e: o.s, y0: 0, y1: w.height });
    if (o.sill > 0) pieces.push({ s: o.s, e: o.e, y0: 0, y1: o.sill }); // allège
    const top = o.sill + o.height;
    if (top < w.height) pieces.push({ s: o.s, e: o.e, y0: top, y1: w.height }); // linteau
    cursor = Math.max(cursor, o.e);
  }
  if (cursor < L) pieces.push({ s: cursor, e: L, y0: 0, y1: w.height });
  return pieces.filter((p) => p.e - p.s > 0.005 && p.y1 - p.y0 > 0.005);
}

export function polygonArea(pts: Pt[]) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function polygonCentroid(pts: Pt[]): Pt {
  const A = polygonArea(pts);
  if (Math.abs(A) < 1e-9) {
    const s = pts.reduce((acc, p) => add(acc, p), { x: 0, y: 0 });
    return mul(s, 1 / Math.max(1, pts.length));
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * A), y: cy / (6 * A) };
}

export function pointInPolygon(p: Pt, pts: Pt[]) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function bbox(pts: Pt[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Point « représentatif » d'une pièce : le centroïde s'il est dedans, sinon un point intérieur. */
export function roomAnchor(room: Room): Pt {
  const c = polygonCentroid(room.points);
  if (pointInPolygon(c, room.points)) return c;
  const b = bbox(room.points);
  for (let i = 1; i < 10; i++)
    for (let j = 1; j < 10; j++) {
      const p = { x: b.minX + (b.w * i) / 10, y: b.minY + (b.h * j) / 10 };
      if (pointInPolygon(p, room.points)) return p;
    }
  return c;
}

export function roomAt(p: Pt, rooms: Room[]) {
  return rooms.find((r) => pointInPolygon(p, r.points)) ?? null;
}

/** Les deux pièces de part et d'autre d'une ouverture (null = extérieur). */
export function openingSides(o: Opening, walls: Wall[], rooms: Room[]) {
  const w = walls.find((x) => x.id === o.wallId);
  if (!w) return null;
  const c = pointAtWall(w, o.t);
  const n = perp(wallDir(w));
  const off = w.thickness / 2 + 0.25;
  const p1 = add(c, mul(n, off));
  const p2 = add(c, mul(n, -off));
  return { center: c, normal: n, p1, p2, r1: roomAt(p1, rooms), r2: roomAt(p2, rooms) };
}

/** Ramer–Douglas–Peucker. */
export function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  let idx = -1;
  let maxD = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointSegDist(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const l = simplify(pts.slice(0, idx + 1), eps);
    const r = simplify(pts.slice(idx), eps);
    return [...l.slice(0, -1), ...r];
  }
  return [a, b];
}

export function pointSegDist(p: Pt, a: Pt, b: Pt) {
  const d = sub(b, a);
  const L2 = dot(d, d);
  if (L2 < 1e-12) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), d) / L2));
  return dist(p, lerp(a, b, t));
}

// virgule décimale en français, point en anglais
const dec = (s: string) => (useLang.getState().lang === "en" ? s : s.replace(".", ","));
export const fmt = (m: number) => `${dec(m.toFixed(2))} m`;
export const fmtArea = (m2: number) => `${dec(m2.toFixed(1))} m²`;

/** Polygone décalé de d vers l'extérieur (côtés repoussés le long de leur normale, sommets recalculés). */
export function offsetPolygon(pts: Pt[], d: number): Pt[] {
  const n = pts.length;
  const sign = polygonArea(pts) > 0 ? 1 : -1; // sens de parcours
  const lines = pts.map((a, i) => {
    const b = pts[(i + 1) % n];
    const dir = norm(sub(b, a));
    const out = mul({ x: dir.y, y: -dir.x }, sign * d);
    return { p: add(a, out), d: dir };
  });
  return lines.map((L, i) => {
    const P = lines[(i - 1 + n) % n];
    const den = P.d.x * L.d.y - P.d.y * L.d.x;
    if (Math.abs(den) < 1e-9) return L.p;
    const t = ((L.p.x - P.p.x) * L.d.y - (L.p.y - P.p.y) * L.d.x) / den;
    return add(P.p, mul(P.d, t));
  });
}
