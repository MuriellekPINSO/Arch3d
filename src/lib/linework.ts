import type { Opening, OpeningKind, Pt, Wall } from "./types";
import { OPENING_DEFAULTS, uid } from "./types";
import { dist, dot, len, norm, sub } from "./geometry";

/* Des traits aux murs — commun à l'import DXF et à la lecture des images de plan.
   1. les murs sont dessinés en double trait : on apparie les traits parallèles proches → axe + épaisseur ;
   2. deux murs alignés séparés d'un vide → un mur avec une ouverture, dont le type est décidé par `classify` ;
   3. les extrémités sont prolongées jusqu'à l'axe du mur voisin (angles et T propres).
   Tout est en mètres, y vers le bas. */

export interface Line {
  a: Pt;
  b: Pt;
}

export type Classify = (center: Pt, gap: number, dir: Pt, thickness: number) => OpeningKind;

export interface LineworkOptions {
  minGap?: number; // plus petit vide considéré comme une ouverture (m)
  maxGap?: number;
  minOffset?: number; // épaisseurs de mur admises (m)
  maxOffset?: number;
  singleLineFallback?: boolean;
}

export function wallsFromLines(used: Line[], height: number, classify: Classify, opts: LineworkOptions = {}) {
  const minGap = opts.minGap ?? 0.45;
  const maxGap = opts.maxGap ?? 3.2;
  const minOff = opts.minOffset ?? 0.05;
  const maxOff = opts.maxOffset ?? 0.5;
  // 2. appariement des doubles traits. Un trait peut longer plusieurs traits de l'autre face
  //    (face intérieure coupée par les cloisons) : on garde, de chaque côté, le voisin parallèle le plus proche,
  //    et le mur existe là où les deux faces se recouvrent.
  const cands: { i: number; j: number; off: number; u0: number; u1: number }[] = [];
  const nearest = used.map(() => ({ plus: Infinity, minus: Infinity }));
  for (let i = 0; i < used.length; i++) {
    const s = used[i];
    const d = norm(sub(s.b, s.a));
    const n = { x: -d.y, y: d.x };
    const Ls = len(sub(s.b, s.a));
    for (let j = 0; j < used.length; j++) {
      if (j === i) continue;
      const t = used[j];
      const dt = norm(sub(t.b, t.a));
      if (Math.abs(Math.abs(dot(d, dt)) - 1) > 0.002) continue; // parallèle à ~3°
      const off = dot(sub(t.a, s.a), n);
      if (Math.abs(off) < minOff || Math.abs(off) > maxOff) continue;
      const ub = [dot(sub(t.a, s.a), d), dot(sub(t.b, s.a), d)].sort((x, y) => x - y);
      const u0 = Math.max(0, ub[0]);
      const u1 = Math.min(Ls, ub[1]);
      // recouvrement suffisant, et plus long que l'épaisseur (sinon ce sont deux bouts de mur face à face)
      if (u1 - u0 < Math.max(0.2, Math.abs(off))) continue;
      const side = off > 0 ? "plus" : "minus";
      nearest[i][side] = Math.min(nearest[i][side], Math.abs(off));
      if (i < j) cands.push({ i, j, off, u0, u1 });
    }
  }
  const paired = new Set<number>();
  let walls: Wall[] = [];
  for (const c of cands) {
    const sideI = c.off > 0 ? "plus" : "minus";
    const sideJ = c.off > 0 ? "minus" : "plus"; // vu depuis j, i est de l'autre côté (si même sens)
    const s = used[c.i];
    const t = used[c.j];
    const d = norm(sub(s.b, s.a));
    const same = dot(d, norm(sub(t.b, t.a))) > 0;
    const sj = same ? sideJ : sideI;
    if (Math.abs(nearest[c.i][sideI] - Math.abs(c.off)) > 1e-6 || Math.abs(nearest[c.j][sj] - Math.abs(c.off)) > 1e-6) continue;
    paired.add(c.i);
    paired.add(c.j);
    const n = { x: -d.y, y: d.x };
    const mid = (u: number) => ({ x: s.a.x + d.x * u + (n.x * c.off) / 2, y: s.a.y + d.y * u + (n.y * c.off) / 2 });
    walls.push({ id: uid(), a: mid(c.u0), b: mid(c.u1), thickness: Math.round(Math.abs(c.off) * 100) / 100, height });
  }
  // dessin en simple trait : chaque trait devient un mur
  if (!walls.length && opts.singleLineFallback !== false)
    walls = used.filter((s) => dist(s.a, s.b) > 0.3).map((s) => ({ id: uid(), a: s.a, b: s.b, thickness: 0.2, height }));

  const joined = joinWalls(walls, classify, { minGap, maxGap });
  return { ...joined, paired: paired.size / 2 };
}

/** Étapes 2 et 3 : fusion des murs alignés (vides → ouvertures) et raccords d'angles. */
export function joinWalls(
  input: Wall[],
  classify: Classify,
  opts: { minGap?: number; maxGap?: number; collinear?: number; openings?: Opening[] } = {},
) {
  const minGap = opts.minGap ?? 0.45;
  const maxGap = opts.maxGap ?? 3.2;
  const collinear = opts.collinear ?? 0.04;
  let walls = input;
  // 3. murs alignés séparés d'un vide → ouverture
  const openings: Opening[] = (opts.openings ?? []).map((o) => ({ ...o })); // ouvertures déjà connues, suivies lors des fusions
  // on part de chaque mur et on regarde le mur suivant sur la même ligne (le plus proche seulement)
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < walls.length && !merged; i++) {
      const A = walls[i];
      const d = norm(sub(A.b, A.a));
      const n = { x: -d.y, y: d.x };
      const LA = len(sub(A.b, A.a));
      let next: { j: number; ub: number[] } | null = null;
      for (let j = 0; j < walls.length; j++) {
        if (i === j) continue;
        const B = walls[j];
        if (Math.abs(A.thickness - B.thickness) > 0.06) continue;
        const dB = norm(sub(B.b, B.a));
        if (Math.abs(Math.abs(dot(d, dB)) - 1) > 0.002) continue;
        if (Math.abs(dot(sub(B.a, A.a), n)) > collinear) continue; // pas sur la même ligne
        const ub = [dot(sub(B.a, A.a), d), dot(sub(B.b, A.a), d)].sort((x, y) => x - y);
        if (ub[0] < LA - 0.01) continue; // B n'est pas après A
        if (!next || ub[0] < next.ub[0]) next = { j, ub };
      }
      if (!next) continue;
      const { j, ub } = next;
      const B = walls[j];
      const gap = ub[0] - LA;
      if (gap > maxGap) continue;
      // les ouvertures déjà portées par B suivent le mur fusionné (B peut être tracé dans l'autre sens)
      const bStart = dot(sub(B.a, A.a), d);
      const sameDir = dot(d, norm(sub(B.b, B.a))) > 0;
      for (const o of openings) {
        if (o.wallId !== B.id) continue;
        o.wallId = A.id;
        o.t = sameDir ? bStart + o.t : bStart - o.t;
      }
      // petit vide (passage d'une cloison, trait interrompu) : simple raccord ; sinon, une ouverture
      if (gap >= minGap) {
        const center = { x: A.a.x + d.x * (LA + gap / 2), y: A.a.y + d.y * (LA + gap / 2) };
        const kind = classify(center, gap, d, A.thickness);
        const { height: h, sill } = OPENING_DEFAULTS[kind];
        openings.push({ id: uid(), wallId: A.id, kind, t: LA + gap / 2, width: Math.round(gap * 100) / 100, height: h, sill });
      }
      const end = { x: A.a.x + d.x * ub[1], y: A.a.y + d.y * ub[1] };
      walls = walls.filter((_, x) => x !== j).map((w) => (w.id === A.id ? { ...A, b: end } : w));
      merged = true;
    }
  }

  // 4. raccords : on prolonge chaque extrémité jusqu'à l'axe du mur voisin (angles et T propres)
  walls = walls.map((w) => {
    const fix = (p: Pt, other: Pt): Pt => {
      let best: Pt = p;
      let bestD = 0.45;
      for (const v of walls) {
        if (v.id === w.id) continue;
        const r = norm(sub(w.b, w.a));
        const s = norm(sub(v.b, v.a));
        const den = r.x * s.y - r.y * s.x;
        if (Math.abs(den) < 0.2) continue;
        const qp = sub(v.a, w.a);
        const t = (qp.x * s.y - qp.y * s.x) / den;
        const q = { x: w.a.x + r.x * t, y: w.a.y + r.y * t };
        const along = dot(sub(q, v.a), s);
        if (along < -0.45 || along > len(sub(v.b, v.a)) + 0.45) continue;
        const dq = dist(q, p);
        if (dq < bestD && dist(q, other) > dist(p, other) - 0.5) { best = q; bestD = dq; }
      }
      return best;
    };
    const a = fix(w.a, w.b);
    // a recule ou avance le long du mur : les positions des ouvertures (mesurées depuis a) suivent
    const delta = dot(sub(w.a, a), norm(sub(w.b, w.a)));
    if (Math.abs(delta) > 1e-6) for (const o of openings) if (o.wallId === w.id) o.t += delta;
    return { ...w, a, b: fix(w.b, w.a) };
  });

  return { walls, openings };
}

/** Bouts de murs libres : une porte ou une fenêtre placée dans un angle laisse le mur s'arrêter avant le mur qu'il
    rejoint (perpendiculaire, ou dans son prolongement). On le prolonge jusque-là, au plus `maxGap` m, et le morceau
    ajouté devient une ouverture (porte, fenêtre ou simple passage selon le dessin) : les pièces se ferment. */
export function closeOpenEnds(input: Wall[], openingsIn: Opening[], classify: Classify, maxGap = 2.6) {
  const segDist = (p: Pt, a: Pt, b: Pt) => {
    const ab = sub(b, a);
    const L2 = dot(ab, ab) || 1e-9;
    const k = Math.max(0, Math.min(1, dot(sub(p, a), ab) / L2));
    return dist(p, { x: a.x + ab.x * k, y: a.y + ab.y * k });
  };
  const touches = (p: Pt, w: Wall, list: Wall[]) => list.some((v) => v.id !== w.id && segDist(p, v.a, v.b) <= (v.thickness + w.thickness) / 2 + 0.05);
  const short = (w: Wall) => len(sub(w.b, w.a)) < Math.max(0.6, 3 * w.thickness);
  // bouts de mur courts reliés à aucun vrai mur : des chiffres de cote ou des lettres pris pour des murs
  // (les deux « 0 » de « 3,00 » se touchent entre eux, pas un mur)
  const real = input.filter((w) => !short(w));
  const walls = input.filter((w) => !short(w) || touches(w.a, w, real) || touches(w.b, w, real)).map((w) => ({ ...w }));
  const kept = new Set(walls.map((w) => w.id));
  const openings = openingsIn.filter((o) => kept.has(o.wallId)).map((o) => ({ ...o }));
  for (const w of walls) {
    if (len(sub(w.b, w.a)) < Math.max(0.8, 4 * w.thickness)) continue; // on ne prolonge que de vrais murs
    for (const end of ["a", "b"] as const) {
      const p = w[end];
      const other = end === "a" ? w.b : w.a;
      // bout déjà raccordé à un autre mur
      if (touches(p, w, walls)) continue;
      const d = norm(sub(p, other)); // vers l'extérieur du mur
      let best: { s: number; face: number } | null = null;
      for (const v of walls) {
        if (v.id === w.id || len(sub(v.b, v.a)) < 0.8) continue;
        const sv = norm(sub(v.b, v.a));
        const den = d.x * sv.y - d.y * sv.x;
        if (Math.abs(den) >= 0.7) {
          // mur à peu près perpendiculaire : on vise son axe
          const qp = sub(v.a, p);
          const s = (qp.x * sv.y - qp.y * sv.x) / den;
          const q = { x: p.x + d.x * s, y: p.y + d.y * s };
          const along = dot(sub(q, v.a), sv);
          if (along < -v.thickness || along > len(sub(v.b, v.a)) + v.thickness) continue;
          const face = s - v.thickness / 2;
          if (face <= 0.05 || face > maxGap) continue;
          if (!best || s < best.s) best = { s, face };
        } else if (Math.abs(Math.abs(dot(d, sv)) - 1) < 0.002 && Math.abs(w.thickness - v.thickness) < 0.08) {
          // mur dans le prolongement : on vise son bout le plus proche
          const n = { x: -d.y, y: d.x };
          if (Math.abs(dot(sub(v.a, p), n)) > Math.max(0.04, w.thickness * 0.5)) continue;
          const s = Math.min(dot(sub(v.a, p), d), dot(sub(v.b, p), d));
          if (s <= 0.05 || s > maxGap) continue;
          if (!best || s < best.s) best = { s, face: s };
        }
      }
      if (!best) continue;
      const q = { x: p.x + d.x * best.s, y: p.y + d.y * best.s };
      const center = { x: p.x + (d.x * best.face) / 2, y: p.y + (d.y * best.face) / 2 };
      const kind = classify(center, best.face, norm(sub(w.b, w.a)), w.thickness);
      // rien de dessiné dans le vide (ni battant, ni vitrage) : seulement s'il a la largeur d'une porte
      if (kind === "passage" && best.face > 1.6) continue;
      const { height, sill } = OPENING_DEFAULTS[kind];
      if (end === "a") {
        // a recule : les positions mesurées depuis a avancent d'autant
        for (const o of openings) if (o.wallId === w.id) o.t += best.s;
        w.a = q;
        openings.push({ id: uid(), wallId: w.id, kind, t: best.face / 2, width: Math.round(best.face * 100) / 100, height, sill });
      } else {
        const L = len(sub(w.b, w.a));
        w.b = q;
        openings.push({ id: uid(), wallId: w.id, kind, t: L + best.face / 2, width: Math.round(best.face * 100) / 100, height, sill });
      }
    }
  }
  // murs alignés séparés d'un vide (porte entre deux murs dans le prolongement l'un de l'autre), même si chacun
  // de leurs bouts touche déjà un mur perpendiculaire : on prolonge le premier jusqu'au second
  const crosses = (p: Pt, q: Pt, skip: Wall[]) =>
    walls.some((v) => {
      if (skip.includes(v)) return false;
      const r = sub(q, p);
      const sv = sub(v.b, v.a);
      const den = r.x * sv.y - r.y * sv.x;
      if (Math.abs(den) < 1e-9) return false;
      const qp = sub(v.a, p);
      const t = (qp.x * sv.y - qp.y * sv.x) / den;
      const u = (qp.x * r.y - qp.y * r.x) / den;
      return t > 0.02 && t < 0.98 && u >= 0 && u <= 1;
    });
  for (const A of walls) {
    if (len(sub(A.b, A.a)) < Math.max(0.8, 4 * A.thickness)) continue;
    const d = norm(sub(A.b, A.a));
    const n = { x: -d.y, y: d.x };
    const LA = len(sub(A.b, A.a));
    let next: { B: Wall; s: number } | null = null;
    for (const B of walls) {
      if (B === A || len(sub(B.b, B.a)) < 0.8 || Math.abs(A.thickness - B.thickness) > 0.08) continue;
      if (Math.abs(Math.abs(dot(d, norm(sub(B.b, B.a)))) - 1) > 0.002) continue;
      if (Math.abs(dot(sub(B.a, A.a), n)) > Math.max(0.05, Math.max(A.thickness, B.thickness) * 0.5)) continue;
      const s = Math.min(dot(sub(B.a, A.a), d), dot(sub(B.b, A.a), d)) - LA; // vide entre A et B
      if (s < 0.3 || s > maxGap) continue;
      if (!next || s < next.s) next = { B, s };
    }
    if (!next) continue;
    const p = A.b;
    const q = { x: p.x + d.x * next.s, y: p.y + d.y * next.s };
    if (crosses(p, q, [A, next.B])) continue; // un mur passe dans le vide : ce ne sont pas les deux bords d'une ouverture
    const center = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    const kind = classify(center, next.s, d, A.thickness);
    if (kind === "passage" && next.s > 1.6) continue;
    const { height, sill } = OPENING_DEFAULTS[kind];
    A.b = q;
    openings.push({ id: uid(), wallId: A.id, kind, t: LA + next.s / 2, width: Math.round(next.s * 100) / 100, height, sill });
  }
  return { walls, openings };
}
