import type { Pt, Wall } from "./types";
import { add, dot, lerp, mul, norm, perp, pointSegDist, polygonArea, simplify, sub, wallDir, wallLength } from "./geometry";

interface Grid {
  W: number;
  H: number;
  minX: number;
  minY: number;
  cell: number;
  blocked: Uint8Array;
}

/* Les murs sont « peints » sur une grille de 5 cm (les ouvertures ne coupent pas les murs ici,
   une porte ne relie donc pas deux pièces). */
function rasterize(walls: Wall[], cell: number): Grid | null {
  if (!walls.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of walls)
    for (const q of [w.a, w.b]) {
      minX = Math.min(minX, q.x); minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y);
    }
  const margin = 1;
  minX -= margin; minY -= margin; maxX += margin; maxY += margin;
  const W = Math.ceil((maxX - minX) / cell);
  const H = Math.ceil((maxY - minY) / cell);
  if (W * H > 4_000_000) return null;

  const blocked = new Uint8Array(W * H);
  for (const w of walls) {
    const r = w.thickness / 2 + cell * 0.5;
    const i0 = Math.max(0, Math.floor((Math.min(w.a.x, w.b.x) - r - minX) / cell));
    const i1 = Math.min(W - 1, Math.ceil((Math.max(w.a.x, w.b.x) + r - minX) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(w.a.y, w.b.y) - r - minY) / cell));
    const j1 = Math.min(H - 1, Math.ceil((Math.max(w.a.y, w.b.y) + r - minY) / cell));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = { x: minX + (i + 0.5) * cell, y: minY + (j + 0.5) * cell };
        if (pointSegDist(c, w.a, w.b) <= r) blocked[j * W + i] = 1;
      }
  }
  return { W, H, minX, minY, cell, blocked };
}

/** Remplit depuis la cellule k ; renvoie false si la zone touche le bord de la grille (zone ouverte). */
function fill(g: Grid, k: number, filled: Uint8Array) {
  const { W, H, blocked } = g;
  const stack = [k];
  filled[k] = 1;
  let closed = true;
  while (stack.length) {
    const c = stack.pop()!;
    const i = c % W;
    const j = (c - i) / W;
    if (i === 0 || j === 0 || i === W - 1 || j === H - 1) {
      closed = false;
      continue;
    }
    for (const n of [c - 1, c + 1, c - W, c + W]) {
      if (!filled[n] && !blocked[n]) {
        filled[n] = 1;
        stack.push(n);
      }
    }
  }
  return closed;
}

/** Contour (simplifié) des cellules marquées `id` dans `mask`. */
function trace(g: Grid, mask: Uint8Array | Int32Array, id: number): Pt[] | null {
  const { W, H, minX, minY, cell } = g;
  // arêtes orientées du bord des cellules remplies
  const next = new Map<string, string[]>();
  const push = (a: string, b: string) => {
    const l = next.get(a);
    if (l) l.push(b);
    else next.set(a, [b]);
  };
  const key = (x: number, y: number) => `${x},${y}`;
  const isF = (i: number, j: number) => i >= 0 && j >= 0 && i < W && j < H && mask[j * W + i] === id;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      if (mask[j * W + i] !== id) continue;
      if (!isF(i, j - 1)) push(key(i + 1, j), key(i, j));
      if (!isF(i, j + 1)) push(key(i, j + 1), key(i + 1, j + 1));
      if (!isF(i - 1, j)) push(key(i, j), key(i, j + 1));
      if (!isF(i + 1, j)) push(key(i + 1, j + 1), key(i + 1, j));
    }

  // chaînage en boucles, on garde la plus grande (contour extérieur de la pièce)
  let best: Pt[] = [];
  let bestArea = 0;
  while (next.size) {
    const start = next.keys().next().value as string;
    const loop: string[] = [];
    let cur = start;
    for (let guard = 0; guard < W * H * 4; guard++) {
      const outs = next.get(cur);
      if (!outs || !outs.length) break;
      const nxt = outs.pop()!;
      if (!outs.length) next.delete(cur);
      loop.push(cur);
      cur = nxt;
      if (cur === start) break;
    }
    const pts = loop.map((s) => {
      const [x, y] = s.split(",").map(Number);
      return { x: minX + x * cell, y: minY + y * cell };
    });
    const a = Math.abs(polygonArea(pts));
    if (a > bestArea) {
      bestArea = a;
      best = pts;
    }
  }
  if (best.length < 4) return null;

  // simplification (boucle fermée : on la coupe en deux chaînes)
  const half = Math.floor(best.length / 2);
  const s1 = simplify(best.slice(0, half + 1), cell * 1.2);
  const s2 = simplify([...best.slice(half), best[0]], cell * 1.2);
  let poly = [...s1.slice(0, -1), ...s2.slice(0, -1)];
  // retire les points alignés
  poly = poly.filter((q, i) => {
    const a = poly[(i - 1 + poly.length) % poly.length];
    const b = poly[(i + 1) % poly.length];
    const cross = (q.x - a.x) * (b.y - a.y) - (q.y - a.y) * (b.x - a.x);
    return Math.abs(cross) > 1e-4;
  });
  return poly.map((q) => ({ x: Math.round(q.x * 1000) / 1000, y: Math.round(q.y * 1000) / 1000 }));
}

/** Recale chaque côté du contour sur la face de mur parallèle la plus proche (< 8 cm) :
   la grille de 5 cm donne une forme approchée, les faces des murs donnent les vraies cotes. */
function snapToWalls(poly: Pt[], walls: Wall[]): Pt[] {
  const n = poly.length;
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n];
    const d = norm(sub(b, a));
    const mid = lerp(a, b, 0.5);
    let best: { p: Pt; d: Pt; off: number } | null = null;
    for (const w of walls) {
      const wd = wallDir(w);
      const c = dot(wd, d);
      if (Math.abs(Math.abs(c) - 1) > 0.01) continue;
      const along = dot(sub(mid, w.a), wd);
      if (along < -w.thickness || along > wallLength(w) + w.thickness) continue;
      const wn = perp(wd);
      for (const side of [1, -1]) {
        const face = add(w.a, mul(wn, (side * w.thickness) / 2));
        const off = dot(sub(mid, face), wn);
        if (Math.abs(off) < 0.08 && (!best || Math.abs(off) < best.off))
          best = { p: sub(mid, mul(wn, off)), d: c > 0 ? wd : mul(wd, -1), off: Math.abs(off) };
      }
    }
    return best ? { p: best.p, d: best.d } : { p: mid, d };
  });
  const out: Pt[] = [];
  lines.forEach((L, i) => {
    const P = lines[(i - 1 + n) % n];
    const den = P.d.x * L.d.y - P.d.y * L.d.x;
    if (Math.abs(den) < 1e-6) return; // deux côtés sur la même ligne : le sommet disparaît
    const t = ((L.p.x - P.p.x) * L.d.y - (L.p.y - P.p.y) * L.d.x) / den;
    out.push(add(P.p, mul(P.d, t)));
  });
  return out.length >= 3 ? out.map((q) => ({ x: Math.round(q.x * 1000) / 1000, y: Math.round(q.y * 1000) / 1000 })) : poly;
}

/** Clic dans une zone fermée par des murs → contour de la pièce (face intérieure des murs).
   Renvoie null si la zone n'est pas fermée. */
export function detectRoom(p: Pt, walls: Wall[], cell = 0.05): Pt[] | null {
  const g = rasterize(walls, cell);
  if (!g) return null;
  const si = Math.floor((p.x - g.minX) / cell);
  const sj = Math.floor((p.y - g.minY) / cell);
  if (si < 0 || sj < 0 || si >= g.W || sj >= g.H || g.blocked[sj * g.W + si]) return null;
  const filled = new Uint8Array(g.W * g.H);
  if (!fill(g, sj * g.W + si, filled)) return null;
  const poly = trace(g, filled, 1);
  return poly && snapToWalls(poly, walls);
}

/** Toutes les zones fermées du plan (plus de `minArea` m²), en une seule passe. */
export function detectAllRooms(walls: Wall[], minArea = 1.2, cell = 0.05): Pt[][] {
  const g = rasterize(walls, cell);
  if (!g) return [];
  const { W, H, blocked } = g;
  const seen = new Uint8Array(W * H);
  const out: Pt[][] = [];
  const minCells = minArea / (cell * cell);
  for (let k = 0; k < W * H; k++) {
    if (seen[k] || blocked[k]) continue;
    const filled = new Uint8Array(W * H);
    const closed = fill(g, k, filled);
    let n = 0;
    for (let c = 0; c < filled.length; c++)
      if (filled[c]) {
        seen[c] = 1;
        n++;
      }
    if (!closed || n < minCells) continue;
    const poly = trace(g, filled, 1);
    if (poly && Math.abs(polygonArea(poly)) >= minArea) out.push(snapToWalls(poly, walls));
  }
  return out;
}
