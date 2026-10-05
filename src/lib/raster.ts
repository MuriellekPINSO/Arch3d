import type { Opening, OpeningKind, Pt, Room, Wall } from "./types";
import { OPENING_DEFAULTS, uid } from "./types";
import { joinWalls } from "./linework";
import { pointInPolygon, pointSegDist } from "./geometry";

/* Lecture d'un plan en image (PNG, JPG, page de PDF) — sans IA.
   Sur un plan d'architecte, les murs coupés sont des bandes d'épaisseur constante, pleines ou hachurées :
   1. « encre » = pixels nettement plus sombres que leur voisinage (les aplats de couleur des pièces n'en sont pas) ;
   2. on bouche les hachures le long de chaque direction, puis on cherche les bandes horizontales et verticales
      d'épaisseur régulière ; l'épaisseur la plus fréquente est celle des murs ;
   3. les bandes deviennent des murs, les vides entre bandes alignées des ouvertures (fenêtre si des traits fins
      traversent le vide, porte si un arc d'ouverture est dessiné à côté, passage sinon). */

export interface RasterInput {
  data: Uint8ClampedArray; // RVBA
  width: number;
  height: number;
}

export interface RasterResult {
  walls: Wall[];
  openings: Opening[];
  thicknessPx: number; // épaisseur dessinée des murs, en pixels
  metersPerPx: number; // échelle utilisée
  estimated: boolean; // échelle déduite de l'épaisseur des murs (pas de calibrage)
}

/* épaisseur dessinée d'un mur courant (15 cm + traits de contour) : sert à deviner l'échelle */
const ASSUMED_WALL = 0.18;

export class PlanRaster {
  W: number;
  H: number;
  ink: Uint8Array;
  private rgba: Uint8ClampedArray;

  constructor(img: RasterInput, inkContrast = 60) {
    const { width: W, height: H, data } = img;
    this.W = W;
    this.H = H;
    this.rgba = data;
    const L = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) L[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
    // fond local = pixel le plus clair à ±4 px (blanc du papier ou aplat de couleur de la pièce)
    const bg = maxFilter(L, W, H, 4);
    const ink = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) ink[i] = bg[i] - L[i] > inkContrast || L[i] < 90 ? 1 : 0;
    this.ink = ink;
  }

  inkAt(x: number, y: number) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < this.W && yi < this.H ? this.ink[yi * this.W + xi] : 0;
  }

  /** encre à moins de r px */
  inkNear(x: number, y: number, r = 1) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (this.inkAt(x + dx, y + dy)) return true;
    return false;
  }

  /** part de pixels « verts » (jardin, pelouse) dans un polygone en pixels */
  greenShare(poly: Pt[]) {
    let n = 0;
    let g = 0;
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(this.W - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(this.H - 1, Math.ceil(Math.max(...ys)));
    const step = Math.max(2, Math.round(Math.max(x1 - x0, y1 - y0) / 60));
    for (let y = y0; y <= y1; y += step)
      for (let x = x0; x <= x1; x += step) {
        if (!pointInPolygon({ x, y }, poly)) continue;
        const i = (y * this.W + x) * 4;
        const [r, gg, b] = [this.rgba[i], this.rgba[i + 1], this.rgba[i + 2]];
        n++;
        if (gg > r + 30 && gg > b + 30) g++;
      }
    return n ? g / n : 0;
  }
}

/* ---------- filtres ---------- */

function maxFilter(src: Uint8Array, W: number, H: number, r: number) {
  const tmp = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) m = Math.max(m, src[y * W + k]);
      tmp[y * W + x] = m;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) m = Math.max(m, tmp[k * W + x]);
      out[y * W + x] = m;
    }
  return out;
}

/** fermeture morphologique 1D (dilatation puis érosion) le long de x (dir = 0) ou de y (dir = 1) */
export function close1D(src: Uint8Array, W: number, H: number, r: number, dir: 0 | 1) {
  const n = dir === 0 ? W : H; // longueur d'une ligne
  const m = dir === 0 ? H : W; // nombre de lignes
  const at = (line: number, k: number) => (dir === 0 ? line * W + k : k * W + line);
  const dil = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  const pre = new Int32Array(n + 1);
  for (let line = 0; line < m; line++) {
    for (let k = 0; k < n; k++) pre[k + 1] = pre[k] + src[at(line, k)];
    for (let k = 0; k < n; k++) dil[at(line, k)] = pre[Math.min(n, k + r + 1)] - pre[Math.max(0, k - r)] > 0 ? 1 : 0;
    for (let k = 0; k < n; k++) pre[k + 1] = pre[k] + dil[at(line, k)];
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - r);
      const b = Math.min(n, k + r + 1);
      out[at(line, k)] = pre[b] - pre[a] === b - a ? 1 : 0;
    }
  }
  return out;
}

/* ---------- bandes ---------- */

interface Band {
  horizontal: boolean;
  u0: number; // début le long de la bande (px)
  u1: number; // fin (exclue)
  c: number; // position de l'axe, en travers (px)
  t: number; // épaisseur (px)
}

/** Bandes parallèles à x (horizontal) : on parcourt les colonnes, chaque colonne coupe la bande en un segment
    vertical d'épaisseur t ; des colonnes voisines aux segments alignés forment une bande. */
export function bands(mask: Uint8Array, W: number, H: number, horizontal: boolean, tMin: number, tMax: number): Band[] {
  const along = horizontal ? W : H;
  const across = horizontal ? H : W;
  const at = (u: number, v: number) => (horizontal ? mask[v * W + u] : mask[u * W + v]);
  type Open = { u0: number; a: number; b: number; sa: number; sb: number; n: number };
  let open: Open[] = [];
  const done: Band[] = [];
  const close = (o: Open, u1: number) => {
    const a = o.sa / o.n;
    const b = o.sb / o.n;
    done.push({ horizontal, u0: o.u0, u1, c: (a + b) / 2, t: b - a });
  };
  for (let u = 0; u < along; u++) {
    const runs: [number, number][] = [];
    let s = -1;
    for (let v = 0; v <= across; v++) {
      const on = v < across && at(u, v) === 1;
      if (on && s < 0) s = v;
      else if (!on && s >= 0) {
        if (v - s >= tMin && v - s <= tMax) runs.push([s, v]);
        s = -1;
      }
    }
    const next: Open[] = [];
    const used = new Set<number>();
    for (const o of open) {
      const k = runs.findIndex(([a, b], i) => !used.has(i) && Math.abs(a - o.a) <= 2 && Math.abs(b - o.b) <= 2);
      if (k < 0) {
        close(o, u);
        continue;
      }
      used.add(k);
      const [a, b] = runs[k];
      next.push({ ...o, a, b, sa: o.sa + a, sb: o.sb + b, n: o.n + 1 });
    }
    runs.forEach(([a, b], i) => !used.has(i) && next.push({ u0: u, a, b, sa: a, sb: b, n: 1 }));
    open = next;
  }
  open.forEach((o) => close(o, along));
  return done;
}

/** Un mur a deux contours continus sur toute sa longueur (ou est plein) ; un mot, un meuble non. */
export function edgeCover(b: Band, ink: Uint8Array, W: number, H: number): [number, number] {
  const L = b.u1 - b.u0;
  if (L <= 0) return [0, 0];
  const cover = (v: number) => {
    let n = 0;
    for (let u = b.u0; u < b.u1; u++) {
      const x = b.horizontal ? u : v;
      const y = b.horizontal ? v : u;
      if (x >= 0 && y >= 0 && x < W && y < H && ink[y * W + x]) n++;
    }
    return n / L;
  };
  const edge = (v0: number) => {
    let best = 0;
    for (let dv = -2; dv <= 2; dv++) best = Math.max(best, cover(Math.round(v0 + dv)));
    return best;
  };
  return [edge(b.c - b.t / 2 + 0.5), edge(b.c + b.t / 2 - 0.5)];
}

function hasEdges(b: Band, ink: Uint8Array, W: number, H: number) {
  const [a, z] = edgeCover(b, ink, W, H);
  // un tronçon court doit être impeccable (sinon c'est souvent un chiffre de cote)
  const min = b.u1 - b.u0 < 3 * b.t ? 0.98 : 0.9;
  return a >= min && z >= min;
}

/** épaisseur des murs : celle qui totalise la plus grande longueur de bandes bien allongées */
function dominantThickness(all: Band[]) {
  const score = new Float64Array(121);
  for (const b of all) {
    const len = b.u1 - b.u0;
    if (len < 4 * b.t) continue;
    const t = Math.round(b.t);
    if (t >= 6 && t <= 120) score[t] += len;
  }
  let best = 0;
  let bestT = 0;
  for (let t = 6; t <= 118; t++) {
    const s = score[t - 1] + score[t] + score[t + 1];
    if (s > best) {
      best = s;
      bestT = t;
    }
  }
  return bestT;
}

/* ---------- lecture complète ---------- */

export function readPlanImage(
  img: RasterInput,
  opts: { metersPerPx?: number; origin?: Pt; wallHeight?: number } = {},
): (RasterResult & { raster: PlanRaster; stairs: { x: number; y: number; w: number; d: number; rot: number }[] }) | null {
  const raster = new PlanRaster(img, 40);
  const { W, H, ink } = raster;
  const R = Math.max(4, Math.round(Math.max(W, H) / 200)); // bouche les hachures (≈ 8 px sur 1600 px)
  const maskH = close1D(ink, W, H, R, 0);
  const maskV = close1D(ink, W, H, R, 1);

  // 1er passage large pour trouver l'épaisseur des murs, 2e passage resserré autour
  const loose = [...bands(maskH, W, H, true, 5, 80), ...bands(maskV, W, H, false, 5, 80)].filter((b) =>
    hasEdges(b, ink, W, H),
  );
  const t = dominantThickness(loose);
  if (!t) return null;
  const tMin = Math.max(4, Math.floor(t * 0.4)); // cloisons de 10 cm à côté de murs de 20
  const tMax = Math.ceil(t * 2.5);
  const found = [...bands(maskH, W, H, true, tMin, tMax), ...bands(maskV, W, H, false, tMin, tMax)].filter(
    (b) => b.u1 - b.u0 >= Math.max(1.4 * t, 10) && hasEdges(b, ink, W, H),
  );
  if (!found.length) return null;

  const estimated = !opts.metersPerPx;
  const mpp = opts.metersPerPx ?? ASSUMED_WALL / t;
  const o = opts.origin ?? { x: 0, y: 0 };
  const toM = (p: Pt): Pt => ({ x: o.x + p.x * mpp, y: o.y + p.y * mpp });
  const toPx = (p: Pt): Pt => ({ x: (p.x - o.x) / mpp, y: (p.y - o.y) / mpp });
  const height = opts.wallHeight ?? 2.8;

  // 4. lignes de murs : tronçons alignés regroupés, puis suivis pixel par pixel à travers
  //    les fenêtres (plusieurs traits fins parallèles) et les portes (vide court entre deux tronçons)
  type WallLine = { horizontal: boolean; c: number; t: number; pieces: [number, number][] };
  const wlines: WallLine[] = [];
  for (const bd of [...found].sort((p, q) => q.u1 - q.u0 - (p.u1 - p.u0))) {
    const l = wlines.find(
      (x) => x.horizontal === bd.horizontal && Math.abs(x.c - bd.c) <= Math.max(2, t * 0.3) && Math.abs(x.t - bd.t) <= t * 0.4,
    );
    if (l) l.pieces.push([bd.u0, bd.u1]);
    else wlines.push({ horizontal: bd.horizontal, c: bd.c, t: bd.t, pieces: [[bd.u0, bd.u1]] });
  }

  /** arc de battant : quart de cercle de rayon ≈ largeur, centré sur un tableau, d'un côté ou de l'autre du mur */
  const doorArc = (center: Pt, gap: number, dir: Pt, thickness: number) => {
    if (gap < 0.55 || gap > 1.3) return false; // une porte, pas une baie
    const c = toPx(center);
    const g = gap / mpp;
    const th = thickness / mpp;
    const n = { x: -dir.y, y: dir.x };
    for (const hinge of [-1, 1])
      for (const side of [-1, 1]) {
        const hx = c.x + dir.x * (hinge * g) / 2 + n.x * side * (th / 2);
        const hy = c.y + dir.y * (hinge * g) / 2 + n.y * side * (th / 2);
        const at = (deg: number, R: number) => {
          const r = (deg * Math.PI) / 180;
          return {
            x: hx + (-hinge * dir.x * Math.cos(r) + side * n.x * Math.sin(r)) * R,
            y: hy + (-hinge * dir.y * Math.cos(r) + side * n.y * Math.sin(r)) * R,
          };
        };
        let onArc = 0;
        let inside = 0;
        let tot = 0;
        for (let deg = 15; deg <= 75; deg += 5) {
          tot++;
          if ([0.93, 1, 1.07].some((k) => {
            const p = at(deg, g * k);
            return raster.inkNear(p.x, p.y, 1);
          })) onArc++;
          const q = at(deg, g * 0.6);
          if (raster.inkAt(q.x, q.y)) inside++;
        }
        // un trait courbe continu au bon rayon, et du vide à l'intérieur du débattement
        if (onArc / tot >= 0.8 && inside / tot <= 0.3) return true;
      }
    return false;
  };

  // type d'ouverture d'après le dessin dans le vide et autour
  const classify = (center: Pt, gap: number, dir: Pt, thickness: number): OpeningKind => {
    const c = toPx(center);
    const g = gap / mpp;
    const th = thickness / mpp;
    const n = { x: -dir.y, y: dir.x };
    // traits fins qui traversent tout le vide, parallèles au mur → vitrage
    let lines = 0;
    let prev = false;
    for (let v = -th / 2 - 1; v <= th / 2 + 1; v += 1) {
      let hit = 0;
      let tot = 0;
      for (let u = -g / 2 + 2; u <= g / 2 - 2; u += 1) {
        tot++;
        if (raster.inkAt(c.x + dir.x * u + n.x * v, c.y + dir.y * u + n.y * v)) hit++;
      }
      const on = tot > 0 && hit / tot > 0.75;
      if (on && !prev) lines++;
      prev = on;
    }
    if (lines >= 2) return gap >= 2 ? "baie" : "window";
    return doorArc(center, gap, dir, thickness) ? "door" : "passage";
  };


  const minOpening = 0.4 / mpp;
  const maxWindow = 6 / mpp;
  const maxDoor = 1.6 / mpp;
  const join = 0.3 / mpp;
  const walls: Wall[] = [];
  const openings: Opening[] = [];
  for (const l of wlines) {
    const along = l.horizontal ? W : H;
    const across = l.horizontal ? H : W;
    const mask = l.horizontal ? maskH : maskV;
    const px = (u: number, v: number) => (l.horizontal ? v * W + u : u * W + v);
    const v0 = Math.round(l.c - l.t / 2);
    const v1 = Math.round(l.c + l.t / 2);
    // mur plein à la position u (bande bouchée sur toute l'épaisseur) — y compris un mur perpendiculaire qui croise
    const solid = new Uint8Array(along);
    for (let u = 0; u < along; u++) {
      let full = 0;
      let n = 0;
      for (let v = v0 + 1; v <= v1 - 1; v++) {
        if (v < 0 || v >= across) continue;
        n++;
        full += mask[px(u, v)];
      }
      solid[u] = n && full / n >= 0.85 ? 1 : 0;
    }
    // un simple trait qui croise n'est pas un mur : il faut au moins une demi-épaisseur de plein
    for (let u = 0; u < along; ) {
      if (!solid[u]) {
        u++;
        continue;
      }
      let e = u;
      while (e < along && solid[e]) e++;
      if (e - u < l.t * 0.5) solid.fill(0, u, e);
      u = e;
    }
    const solidNear = (u: number) => {
      for (let k = -3; k <= 3; k++) if (u + k >= 0 && u + k < along && solid[u + k]) return true;
      return false;
    };
    /** vitrage depuis `from` vers `step` : au moins deux traits fins continus dans l'épaisseur du mur */
    const glazing = (from: number, step: 1 | -1) => {
      const lens: number[] = [];
      for (let v = v0 - 1; v <= v1 + 1; v++) {
        if (v < 0 || v >= across) continue;
        let u = from;
        let gap = 0;
        let last = from;
        while (Math.abs(u - from) < maxWindow && u + step >= 0 && u + step < along) {
          u += step;
          if (ink[px(u, v)]) {
            last = u;
            gap = 0;
          } else if (++gap > 2) break;
        }
        lens.push(Math.abs(last - from));
      }
      lens.sort((x, y) => y - x);
      return lens[1] ?? 0;
    };
    /** fin de mur plein en partant de u (dans le sens step) */
    const solidEnd = (u: number, step: 1 | -1) => {
      while (u + step >= 0 && u + step < along && solid[u + step]) u += step;
      return u;
    };

    const pieces = l.pieces.sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const pc of pieces) {
      const last = merged[merged.length - 1];
      if (last && pc[0] <= last[1] + 2) last[1] = Math.max(last[1], pc[1]);
      else merged.push([...pc]);
    }
    type Op = { u0: number; u1: number; kind: "glass" | "gap" };
    let seg: { U0: number; U1: number; ops: Op[] } | null = null;
    const flush = () => {
      if (!seg) return;
      const { U0, U1, ops } = seg;
      seg = null;
      if (U1 - U0 < 1.4 * t) return;
      const a = l.horizontal ? { x: U0, y: l.c } : { x: l.c, y: U0 };
      const z = l.horizontal ? { x: U1, y: l.c } : { x: l.c, y: U1 };
      const wall: Wall = { id: uid(), a: toM(a), b: toM(z), thickness: Math.round(l.t * mpp * 100) / 100, height };
      walls.push(wall);
      const dir = l.horizontal ? { x: 1, y: 0 } : { x: 0, y: 1 };
      for (const op of ops) {
        const len = op.u1 - op.u0;
        if (len < minOpening) continue;
        const mid = (op.u0 + op.u1) / 2;
        const center = toM(l.horizontal ? { x: mid, y: l.c } : { x: l.c, y: mid });
        // l'arc d'un battant prime : un seuil de porte est souvent dessiné en traits fins, comme un vitrage
        const kind: OpeningKind = doorArc(center, len * mpp, dir, wall.thickness)
          ? "door"
          : op.kind === "glass"
            ? len * mpp >= 1.8 ? "baie" : "window"
            : "passage";
        const d = OPENING_DEFAULTS[kind];
        openings.push({ id: uid(), wallId: wall.id, kind, t: (mid - U0) * mpp, width: Math.round(len * mpp * 100) / 100, height: d.height, sill: d.sill });
      }
    };
    /** prolonge un bout de mur vers l'extérieur, de proche en proche : vitrage, mur qui croise, vitrage… */
    const extend = (from: number, step: 1 | -1, ops: Op[]) => {
      let end = from;
      for (let iter = 0; iter < 12; iter++) {
        const g = glazing(end, step);
        // vitrage : doubles traits dans l'alignement du mur, qui aboutissent à un mur (sinon c'est un meuble)
        if (g >= minOpening && solidNear(end + step * g)) {
          ops.push({ u0: Math.min(end, end + step * g), u1: Math.max(end, end + step * g), kind: "glass" });
          end = solidEnd(end + step * g, step);
          continue;
        }
        let k = 1;
        while (k <= join && !(end + step * k >= 0 && end + step * k < along && solid[end + step * k])) k++;
        if (k > join) break;
        const next = solidEnd(end + step * k, step);
        if (next === end) break;
        end = next;
      }
      return end;
    };
    for (let i = 0; i < merged.length; i++) {
      const [p0, p1] = merged[i];
      if (!seg) {
        const ops: Op[] = [];
        seg = { U0: extend(p0, -1, ops), U1: p1, ops };
      } else {
        const gap = p0 - seg.U1;
        const g = glazing(seg.U1, 1);
        if (gap <= join) seg.U1 = p1;
        else if (g >= gap - 3 && gap <= maxWindow) {
          seg.ops.push({ u0: seg.U1, u1: p0, kind: "glass" });
          seg.U1 = p1;
        } else if (gap <= maxDoor) {
          seg.ops.push({ u0: seg.U1, u1: p0, kind: "gap" });
          seg.U1 = p1;
        } else {
          seg.U1 = extend(seg.U1, 1, seg.ops);
          flush();
          const ops: Op[] = [];
          seg = { U0: extend(p0, -1, ops), U1: p1, ops };
        }
      }
      // la suite après ce tronçon peut être un vitrage qui mène au tronçon suivant, ou au bout du mur
      seg.U1 = Math.max(seg.U1, p1);
    }
    if (seg) {
      const sg = seg as { U0: number; U1: number; ops: Op[] };
      sg.U1 = extend(sg.U1, 1, sg.ops);
      flush();
    }
  }

  // raccords d'angles ; les murs alignés presque bout à bout sont fusionnés (les ouvertures suivent)
  const { walls: joined, openings: all } = joinWalls(walls, classify, {
    minGap: 0.31,
    maxGap: 0.3,
    collinear: Math.max(0.04, t * mpp * 0.5),
    openings,
  });

  // 5. traits fins tendus d'un mur à un mur parallèle :
  //    - 2 à 4 traits serrés = une porte ou une fenêtre sans mur autour (cadre de porte d'entrée…) ;
  //    - 5 traits ou plus, espacés régulièrement de 18 à 38 cm = les marches d'un escalier.
  const stairs: { x: number; y: number; w: number; d: number; rot: number }[] = [];
  const axisOf = (w: Wall) => (Math.abs(w.a.y - w.b.y) < 1e-6 ? "h" : Math.abs(w.a.x - w.b.x) < 1e-6 ? "v" : null);
  for (let i = 0; i < joined.length; i++)
    for (let j = 0; j < joined.length; j++) {
      const A = joined[i];
      const B = joined[j];
      const ax = axisOf(A);
      if (!ax || ax !== axisOf(B) || i === j) continue;
      // A d'un côté, B de l'autre (A avant B en travers)
      const cA = toPx(A.a)[ax === "h" ? "y" : "x"];
      const cB = toPx(B.a)[ax === "h" ? "y" : "x"];
      if (cB <= cA) continue;
      const tA = A.thickness / mpp / 2;
      const tB = B.thickness / mpp / 2;
      const from = Math.ceil(cA + tA + 1);
      const to = Math.floor(cB - tB - 1);
      const gap = (to - from) * mpp;
      if (gap < 0.5 || gap > 4) continue;
      const rangeA = [toPx(A.a), toPx(A.b)].map((p) => p[ax === "h" ? "x" : "y"]).sort((p, q) => p - q);
      const rangeB = [toPx(B.a), toPx(B.b)].map((p) => p[ax === "h" ? "x" : "y"]).sort((p, q) => p - q);
      const u0 = Math.ceil(Math.max(rangeA[0], rangeB[0]));
      const u1 = Math.floor(Math.min(rangeA[1], rangeB[1]));
      if (u1 - u0 < 0.5 / mpp) continue;
      // un mur perpendiculaire déjà détecté entre A et B : rien à ajouter à cet endroit
      const crossed = (u: number) =>
        joined.some((w) => {
          if (axisOf(w) === ax || axisOf(w) === null) return false;
          const c = toPx(w.a)[ax === "h" ? "x" : "y"];
          const span = [toPx(w.a), toPx(w.b)].map((p) => p[ax === "h" ? "y" : "x"]).sort((p, q) => p - q);
          return Math.abs(c - u) < w.thickness / mpp / 2 + 2 && span[0] < from + 3 && span[1] > to - 3;
        });
      // taux d'encre en travers, entre A et B, pour chaque position u
      const cov: number[] = [];
      for (let u = u0; u <= u1; u++) {
        let hit = 0;
        for (let v = from; v <= to; v++) if (ax === "h" ? raster.inkNear(u, v, 0) : raster.inkNear(v, u, 0)) hit++;
        cov.push(hit / (to - from + 1));
      }
      // traits : positions consécutives assez encrées (les marches au-dessus du plan de coupe sont en pointillés)
      const lines: { c: number; w: number; cov: number }[] = [];
      for (let k = 0; k < cov.length; ) {
        if (cov[k] < 0.45) {
          k++;
          continue;
        }
        let e = k;
        let best = cov[k];
        while (e + 1 < cov.length && cov[e + 1] >= 0.45) best = Math.max(best, cov[++e]);
        lines.push({ c: u0 + (k + e) / 2, w: e - k + 1, cov: best });
        k = e + 1;
      }
      const thinAll = lines.filter((l) => l.w <= Math.max(3, t * 0.35) && !crossed(l.c));
      const thin = thinAll.filter((l) => l.cov >= 0.92); // traits continus : cadres de porte
      // escalier : traits fins réguliers
      const steps = thinAll.filter((l, k) => k === 0 || (l.c - thinAll[k - 1].c) * mpp > 0.12);
      const gaps = steps.slice(1).map((l, k) => (l.c - steps[k].c) * mpp);
      const regular = gaps.filter((g) => g >= 0.18 && g <= 0.38);
      if (regular.length >= 4) {
        const g = regular.slice().sort((p, q) => p - q)[Math.floor(regular.length / 2)];
        const run = steps.filter((l, k) => (k > 0 && Math.abs(gaps[k - 1] - g) < 0.06) || (k < gaps.length && Math.abs(gaps[k] - g) < 0.06));
        if (run.length >= 5) {
          const a = run[0].c - g / mpp / 2;
          const b = run[run.length - 1].c + g / mpp / 2;
          const mid = (a + b) / 2;
          const across = (from + to) / 2;
          const center = toM(ax === "h" ? { x: mid, y: across } : { x: across, y: mid });
          // marches perpendiculaires à A et B : la volée monte le long des murs
          stairs.push({ x: center.x, y: center.y, w: (b - a) * mpp, d: gap, rot: ax === "h" ? 0 : Math.PI / 2 });
          continue;
        }
      }
      // ouverture orpheline : 2 à 4 traits fins dans une bande d'à peu près une épaisseur de mur
      for (let k = 0; k < thin.length; k++) {
        let e = k;
        while (e + 1 < thin.length && thin[e + 1].c - thin[k].c <= t * 1.6) e++;
        const n = e - k + 1;
        const width = thin[e].c - thin[k].c;
        if (n >= 2 && n <= 4 && width >= t * 0.3) {
          const c = (thin[k].c + thin[e].c) / 2;
          const a = toM(ax === "h" ? { x: c, y: cA } : { x: cA, y: c });
          const b = toM(ax === "h" ? { x: c, y: cB } : { x: cB, y: c });
          const wall: Wall = { id: uid(), a, b, thickness: Math.round(t * mpp * 100) / 100, height };
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          const opening = gap; // le vide entre les deux murs
          const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const dir = ax === "h" ? { x: 0, y: 1 } : { x: 1, y: 0 };
          const kind: OpeningKind = doorArc(center, opening, dir, wall.thickness) ? "door" : opening >= 1.8 ? "baie" : "door";
          const d = OPENING_DEFAULTS[kind];
          joined.push(wall);
          all.push({ id: uid(), wallId: wall.id, kind, t: len / 2, width: Math.round(opening * 100) / 100, height: d.height, sill: d.sill });
        }
        k = e;
      }
    }

  // un même escalier vu entre plusieurs paires de murs : on garde la paire la plus serrée
  stairs.sort((p, q) => p.d - q.d);
  for (let k = stairs.length - 1; k >= 0; k--) {
    const s1 = stairs[k];
    const inside = stairs.some((s0, m) => {
      if (m >= k) return false;
      const along = s0.rot ? Math.abs(s1.y - s0.y) < s0.w / 2 + 0.3 : Math.abs(s1.x - s0.x) < s0.w / 2 + 0.3;
      const across = s0.rot ? Math.abs(s1.x - s0.x) < s1.d / 2 + 0.3 : Math.abs(s1.y - s0.y) < s1.d / 2 + 0.3;
      return along && across;
    });
    if (inside) stairs.splice(k, 1);
  }

  // bandes isolées (texte, mobilier) : courtes et sans mur voisin
  const kept = joined.filter((w) => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (L >= 1.2) return true;
    const near = (p: Pt) => joined.some((v) => v.id !== w.id && pointSegDist(p, v.a, v.b) < v.thickness / 2 + 0.25);
    return near(w.a) || near(w.b);
  });
  const ids = new Set(kept.map((w) => w.id));
  return {
    stairs,
    walls: kept,
    openings: all.filter((x) => ids.has(x.wallId)),
    thicknessPx: t,
    metersPerPx: mpp,
    estimated,
    raster,
  };
}

/** Retire les zones vertes (jardin) des pièces détectées, puis les murs qui ne bordent plus aucune pièce
    (clôture, limite de terrain). */
export function pruneOutdoor(rooms: Room[], walls: Wall[], openings: Opening[], raster: PlanRaster, toPx: (p: Pt) => Pt) {
  const indoor = rooms.filter((r) => raster.greenShare(r.points.map(toPx)) < 0.35);
  const touches = (w: Wall) =>
    indoor.some((r) => {
      const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
      const n = { x: -(w.b.y - w.a.y), y: w.b.x - w.a.x };
      const L = Math.hypot(n.x, n.y) || 1;
      const off = w.thickness / 2 + 0.2;
      // on teste plusieurs points le long du mur (un mur peut longer plusieurs pièces)
      for (const k of [0.15, 0.5, 0.85]) {
        const p = { x: w.a.x + (w.b.x - w.a.x) * k, y: w.a.y + (w.b.y - w.a.y) * k };
        for (const s of [1, -1]) if (pointInPolygon({ x: p.x + (n.x / L) * off * s, y: p.y + (n.y / L) * off * s }, r.points)) return true;
      }
      return pointInPolygon(mid, r.points);
    });
  const keptWalls = walls.filter(touches);
  const ids = new Set(keptWalls.map((w) => w.id));
  return { rooms: indoor, walls: keptWalls, openings: openings.filter((o) => ids.has(o.wallId)) };
}
