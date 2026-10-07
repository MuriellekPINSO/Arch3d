import type { Opening, Pt, Room, Wall } from "./types";
import { bbox, pointAtWall, pointInPolygon } from "./geometry";

/* Ameublement automatique : une « recette » par type de pièce, posée contre les murs libres
   (sans gêner portes et passages) et sans chevauchement. Repère du plan, en mètres. */

export type FurnitureKind =
  | "lit_double" | "lit_simple" | "chevet" | "armoire" | "tapis"
  | "canape" | "fauteuil" | "table_basse" | "meuble_tv" | "lampadaire"
  | "table" | "chaise" | "plan_travail" | "frigo" | "ilot"
  | "douche" | "baignoire" | "vasque" | "wc"
  | "bureau" | "etagere" | "console" | "plante" | "transat"
  | "escalier" | "voiture";

export interface Furniture {
  id: string;
  roomId: string;
  kind: FurnitureKind;
  x: number; // centre, repère du plan
  y: number;
  w: number; // largeur (le long du mur)
  d: number; // profondeur
  rot: number; // angle (rad) : la face avant regarde (sin rot, cos rot) dans le plan
  upper?: boolean; // plan de travail : meubles hauts (pas devant une fenêtre)
  rise?: number; // escalier : hauteur à gravir (jusqu'au niveau du dessus)
}

interface Side {
  name: "N" | "S" | "E" | "W";
  origin: Pt; // début du côté
  dir: Pt; // direction le long du côté
  inward: Pt; // normale vers l'intérieur
  length: number;
  doors: [number, number][]; // intervalles occupés par portes/passages (le long du côté)
  windows: [number, number][];
}

interface Rect { x0: number; y0: number; x1: number; y1: number }

const facing = (n: Pt) => Math.atan2(n.x, n.y);

const overlaps = (r: Rect, o: Rect, margin: number) => r.x0 < o.x1 + margin && r.x1 > o.x0 - margin && r.y0 < o.y1 + margin && r.y1 > o.y0 - margin;

class Layout {
  sides: Side[];
  occupied: Rect[] = [];
  /** dégagement devant chaque porte : complet, et réduit à un pas de porte quand la pièce est trop encombrée */
  clearances: { full: Rect; small: Rect }[] = [];
  /** 0 = dégagements complets, 1 = réduits, 2 = ignorés (seuls les meubles et les portes du même mur comptent) */
  relax = 0;
  items: Furniture[] = [];
  b: ReturnType<typeof bbox>;
  constructor(public room: Room, walls: Wall[], openings: Opening[]) {
    const b = (this.b = bbox(room.points));
    this.sides = [
      { name: "N", origin: { x: b.minX, y: b.minY }, dir: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: b.w, doors: [], windows: [] },
      { name: "S", origin: { x: b.minX, y: b.maxY }, dir: { x: 1, y: 0 }, inward: { x: 0, y: -1 }, length: b.w, doors: [], windows: [] },
      { name: "W", origin: { x: b.minX, y: b.minY }, dir: { x: 0, y: 1 }, inward: { x: 1, y: 0 }, length: b.h, doors: [], windows: [] },
      { name: "E", origin: { x: b.maxX, y: b.minY }, dir: { x: 0, y: 1 }, inward: { x: -1, y: 0 }, length: b.h, doors: [], windows: [] },
    ];
    for (const o of openings) {
      const w = walls.find((x) => x.id === o.wallId);
      if (!w) continue;
      const c = pointAtWall(w, o.t);
      for (const s of this.sides) {
        // distance du centre de l'ouverture à la ligne du côté, et position le long du côté
        const along = (c.x - s.origin.x) * s.dir.x + (c.y - s.origin.y) * s.dir.y;
        const off = Math.abs((c.x - s.origin.x) * s.inward.x + (c.y - s.origin.y) * s.inward.y);
        if (off > w.thickness / 2 + 0.2 || along < -0.3 || along > s.length + 0.3) continue;
        const half = o.width / 2;
        if (o.kind === "window") s.windows.push([along - half, along + half]);
        else {
          s.doors.push([along - half - 0.15, along + half + 0.15]);
          // dégagement devant la porte : personne ne meuble ce carré
          const p = { x: s.origin.x + s.dir.x * along, y: s.origin.y + s.dir.y * along };
          const zone = (depth: number, margin: number) => {
            const far = { x: p.x + s.inward.x * depth, y: p.y + s.inward.y * depth };
            const a = { x: p.x - s.dir.x * (half + margin), y: p.y - s.dir.y * (half + margin) };
            const z = { x: far.x + s.dir.x * (half + margin), y: far.y + s.dir.y * (half + margin) };
            return { x0: Math.min(a.x, z.x), y0: Math.min(a.y, z.y), x1: Math.max(a.x, z.x), y1: Math.max(a.y, z.y) };
          };
          this.clearances.push({ full: zone(Math.min(1.3, Math.min(b.w, b.h) * 0.45), 0.1), small: zone(0.45, 0) });
        }
      }
    }
  }

  get minDim() {
    return Math.min(this.b.w, this.b.h);
  }

  rectOf(x: number, y: number, w: number, d: number, rot: number): Rect {
    const sideways = Math.abs(Math.sin(rot)) > 0.5;
    const hw = (sideways ? d : w) / 2;
    const hd = (sideways ? w : d) / 2;
    return { x0: x - hw, y0: y - hd, x1: x + hw, y1: y + hd };
  }

  /** le meuble tient dans la pièce elle-même, pas seulement dans son rectangle englobant (pièces en L) */
  inside(r: Rect) {
    const pts = this.room.points;
    const e = 0.02;
    const xs = [r.x0 + e, (r.x0 + r.x1) / 2, r.x1 - e];
    const ys = [r.y0 + e, (r.y0 + r.y1) / 2, r.y1 - e];
    return xs.every((x) => ys.every((y) => pointInPolygon({ x, y }, pts)));
  }

  free(r: Rect, margin = 0.04) {
    const { b } = this;
    if (r.x0 < b.minX - 1e-6 || r.y0 < b.minY - 1e-6 || r.x1 > b.maxX + 1e-6 || r.y1 > b.maxY + 1e-6) return false;
    if (!this.inside(r)) return false;
    if (this.occupied.some((o) => overlaps(r, o, margin))) return false;
    if (this.relax >= 2) return true;
    return !this.clearances.some((c) => overlaps(r, this.relax ? c.small : c.full, margin));
  }

  /** Essaie `place` avec des dégagements complets, puis réduits, puis sans : l'essentiel d'une pièce passe toujours
      s'il tient physiquement (petites pièces percées de portes et de passages de tous les côtés). */
  relaxed<T>(place: () => T | null, upTo = 2): T | null {
    try {
      for (this.relax = 0; this.relax <= upTo; this.relax++) {
        const got = place();
        if (got) return got;
      }
      return null;
    } finally {
      this.relax = 0;
    }
  }

  /** Contre un mur, la plus grande des tailles proposées qui tient, sur le côté le plus accueillant. */
  fit(kind: FurnitureKind, sizes: [number, number][], opts: { at?: number; tall?: boolean; gap?: number; sides?: Side[]; upTo?: number } = {}) {
    return this.relaxed(() => {
      for (const [w, d] of sizes)
        for (const s of opts.sides ?? this.rankedSides()) {
          if (w > s.length - 0.04) continue;
          const item = this.againstSide(s, kind, w, d, { ...opts, at: opts.at === undefined ? undefined : Math.min(opts.at, s.length - w / 2 - 0.02) });
          if (item) return { item, side: s };
        }
      return null;
    }, opts.upTo);
  }

  add(kind: FurnitureKind, x: number, y: number, w: number, d: number, rot: number, block = true) {
    const item: Furniture = { id: `${this.room.id}-${this.items.length}`, roomId: this.room.id, kind, x, y, w, d, rot };
    this.items.push(item);
    if (block) this.occupied.push(this.rectOf(x, y, w, d, rot));
    return item;
  }

  /** Pose contre un côté : cherche la position la plus proche du centre souhaité, sans porte ni chevauchement. */
  againstSide(s: Side, kind: FurnitureKind, w: number, d: number, opts: { at?: number; tall?: boolean; gap?: number } = {}) {
    const gap = opts.gap ?? 0.02;
    const want = opts.at ?? s.length / 2;
    const blocks = opts.tall ? [...s.doors, ...s.windows] : s.doors;
    for (let k = 0; k <= 60; k++) {
      const delta = Math.ceil(k / 2) * 0.1 * (k % 2 ? 1 : -1);
      const u = want + delta;
      if (u - w / 2 < 0.02 || u + w / 2 > s.length - 0.02) continue;
      if (blocks.some(([a, z]) => u + w / 2 > a && u - w / 2 < z)) continue;
      const x = s.origin.x + s.dir.x * u + s.inward.x * (d / 2 + gap);
      const y = s.origin.y + s.dir.y * u + s.inward.y * (d / 2 + gap);
      const rot = facing(s.inward);
      if (!this.free(this.rectOf(x, y, w, d, rot))) continue;
      return this.add(kind, x, y, w, d, rot);
    }
    return null;
  }

  /** Côtés classés du plus accueillant au moins accueillant (long, sans porte). */
  rankedSides(exclude: Side[] = []) {
    return this.sides
      .filter((s) => !exclude.includes(s))
      .map((s) => {
        const doorLen = s.doors.reduce((a, [x, y]) => a + (y - x), 0);
        return { s, score: s.length - doorLen * 2.5 - (s.doors.length ? 1 : 0) };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.s);
  }

  opposite(s: Side) {
    const o = { N: "S", S: "N", E: "W", W: "E" }[s.name];
    return this.sides.find((x) => x.name === o)!;
  }

  /** Pose devant un meuble existant (table basse devant le canapé…). */
  inFront(of: Furniture, kind: FurnitureKind, w: number, d: number, distance: number, block = true) {
    const f = { x: Math.sin(of.rot), y: Math.cos(of.rot) };
    const x = of.x + f.x * (of.d / 2 + distance + d / 2);
    const y = of.y + f.y * (of.d / 2 + distance + d / 2);
    if (block && !this.free(this.rectOf(x, y, w, d, of.rot), 0.02)) return null;
    if (!block && !this.inside(this.rectOf(x, y, w * 0.6, d * 0.6, of.rot))) return null; // tapis : au moins son cœur dans la pièce
    return this.add(kind, x, y, w, d, of.rot, block);
  }

  /** Pose à côté d'un meuble, le long du même mur. */
  beside(of: Furniture, kind: FurnitureKind, w: number, d: number, sideSign: 1 | -1, gap = 0.05) {
    const along = { x: Math.cos(of.rot), y: -Math.sin(of.rot) };
    const back = { x: -Math.sin(of.rot), y: -Math.cos(of.rot) };
    const shift = of.w / 2 + gap + w / 2;
    const x = of.x + along.x * shift * sideSign + back.x * (of.d / 2 - d / 2);
    const y = of.y + along.y * shift * sideSign + back.y * (of.d / 2 - d / 2);
    if (!this.free(this.rectOf(x, y, w, d, of.rot), 0.0)) return null;
    return this.add(kind, x, y, w, d, of.rot);
  }

  /** Coins libres pour les plantes. */
  corners(kind: FurnitureKind, size: number, max: number) {
    const { b } = this;
    const pts = [
      { x: b.minX + size / 2 + 0.05, y: b.minY + size / 2 + 0.05 },
      { x: b.maxX - size / 2 - 0.05, y: b.minY + size / 2 + 0.05 },
      { x: b.maxX - size / 2 - 0.05, y: b.maxY - size / 2 - 0.05 },
      { x: b.minX + size / 2 + 0.05, y: b.maxY - size / 2 - 0.05 },
    ];
    let n = 0;
    for (const p of pts) {
      if (n >= max) break;
      if (this.free(this.rectOf(p.x, p.y, size, size, 0))) {
        this.add(kind, p.x, p.y, size, size, 0);
        n++;
      }
    }
    return n;
  }

  diningSet(cx: number, cy: number, tw: number, td: number, along: "x" | "y") {
    const rot = along === "x" ? 0 : Math.PI / 2;
    const r = this.rectOf(cx, cy, tw + 1.1, td + 1.1, rot);
    if (!this.free(r, 0.0)) return false; // table et chaises comprises, dans la pièce
    this.add("table", cx, cy, tw, td, rot);
    const chairs = Math.max(2, Math.floor(tw / 0.6)) ;
    const perSide = Math.floor(chairs / 2);
    for (let i = 0; i < perSide; i++) {
      const u = -tw / 2 + (tw / perSide) * (i + 0.5);
      if (along === "x") {
        this.add("chaise", cx + u, cy - td / 2 - 0.3, 0.45, 0.45, 0, false);
        this.add("chaise", cx + u, cy + td / 2 + 0.3, 0.45, 0.45, Math.PI, false);
      } else {
        this.add("chaise", cx - td / 2 - 0.3, cy + u, 0.45, 0.45, Math.PI / 2, false);
        this.add("chaise", cx + td / 2 + 0.3, cy + u, 0.45, 0.45, -Math.PI / 2, false);
      }
    }
    return true;
  }
}

export function furnishRoom(room: Room, walls: Wall[], openings: Opening[]): Furniture[] {
  const L = new Layout(room, walls, openings);
  const { b } = L;
  const area = b.w * b.h;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;

  // escalier dessiné sur le plan : c'est de la structure (ajoutée par l'app), on lui laisse sa place
  if (room.stairs) {
    const st = room.stairs;
    L.occupied.push(L.rectOf(st.x, st.y, st.w, st.d, st.rot));
  }

  switch (room.type) {
    case "chambre": {
      const big = L.minDim >= 3;
      const bw = big ? 1.6 : 0.95;
      const bed = L.fit(big ? "lit_double" : "lit_simple", [[bw, 2.0], [0.9, 1.9]])?.item ?? null;
      if (bed) {
        L.beside(bed, "chevet", 0.45, 0.4, 1);
        if (big) L.beside(bed, "chevet", 0.45, 0.4, -1);
        if (area > 9) L.inFront(bed, "tapis", bw + 0.6, 0.9, -0.55, false);
      }
      const bedSide = L.sides.find((s) => bed && Math.abs(Math.atan2(s.inward.x, s.inward.y) - bed.rot) < 0.01);
      const others = L.rankedSides(bedSide ? [bedSide] : []);
      L.fit("armoire", [1.6, 1.2, 0.9].map((w): [number, number] => [w, 0.6]), { tall: true, sides: others, upTo: 1 });
      L.relaxed(() => (L.corners("plante", 0.45, 1) ? true : null), 1);
      break;
    }
    case "salon": {
      // le canapé va de préférence contre un mur qui laisse ~4 m jusqu'au mur d'en face (place de la télé)
      const depthOf = (x: { inward: Pt }) => (Math.abs(x.inward.x) > 0 ? b.w : b.h);
      const sides = L.rankedSides().sort((p, q) => Math.abs(depthOf(p) - 4) - Math.abs(depthOf(q) - 4));
      let sofa: Furniture | null = null;
      for (const s of sides) if ((sofa = L.againstSide(s, "canape", Math.min(2.4, s.length * 0.6), 0.95))) break;
      // pièce très ouverte (baies, passages sur tous les murs) : canapé posé dans la pièce, dos à un côté
      for (const s of sides) {
        if (sofa) break;
        const w = Math.min(2.2, s.length * 0.55);
        for (const back of [0.4, 0.8, 1.2, 1.6]) {
          for (const shift of [0, -0.6, 0.6, -1.2, 1.2]) {
            const u = s.length / 2 + shift;
            const x = s.origin.x + s.dir.x * u + s.inward.x * (back + 0.475);
            const y = s.origin.y + s.dir.y * u + s.inward.y * (back + 0.475);
            const rot = facing(s.inward);
            if (L.free(L.rectOf(x, y, w, 0.95, rot))) {
              sofa = L.add("canape", x, y, w, 0.95, rot);
              break;
            }
          }
          if (sofa) break;
        }
      }
      if (sofa) {
        const s0 = sofa;
        const sofaSide = sides.find((s) => Math.abs(facing(s.inward) - s0.rot) < 0.01);
        L.inFront(s0, "tapis", Math.min(2.6, s0.w + 0.4), 1.8, 0.05, false);
        L.relaxed(() => L.inFront(s0, "table_basse", 1.1, 0.6, 0.45) ?? L.inFront(s0, "table_basse", 0.9, 0.5, 0.35), 1);
        // la télé face au canapé : contre le mur d'en face, sinon posée devant, à bonne distance
        const opp = sofaSide ? L.opposite(sofaSide) : null;
        const depth = opp ? (Math.abs(opp.inward.x) > 0 ? b.w : b.h) : 99;
        const tv =
          (opp && depth < 5 && L.fit("meuble_tv", [Math.min(1.8, opp.length * 0.5), 1.4, 1.0].map((w): [number, number] => [w, 0.45]), { sides: [opp] })) ||
          L.relaxed(() => [2.6, 2.2, 3.0].reduce<Furniture | null>((acc, dist) => acc ?? L.inFront(s0, "meuble_tv", 1.6, 0.45, dist), null), 1);
        void tv;
        // le fauteuil d'abord (il compte plus), le lampadaire de l'autre côté s'il reste de la place
        L.relaxed(() => L.beside(s0, "fauteuil", 0.85, 0.85, -1, 0.35) ?? L.beside(s0, "fauteuil", 0.85, 0.85, 1, 0.35), 1);
        if (!L.beside(s0, "lampadaire", 0.35, 0.35, 1, 0.1)) L.beside(s0, "lampadaire", 0.35, 0.35, -1, 0.1);
      }
      // grand séjour : coin repas dans la partie restante
      if (area > 26) {
        const along = b.w >= b.h ? "x" : "y";
        const spots = along === "x"
          ? [{ x: b.minX + b.w * 0.78, y: cy }, { x: b.minX + b.w * 0.22, y: cy }]
          : [{ x: cx, y: b.minY + b.h * 0.78 }, { x: cx, y: b.minY + b.h * 0.22 }];
        for (const p of spots) if (L.diningSet(p.x, p.y, 1.8, 0.9, along)) break;
      }
      L.corners("plante", 0.5, 2);
      break;
    }
    case "cuisine": {
      // le plus long plan de travail qui tient (3,6 m à 1 m), sinon un plan plus court en assouplissant les dégagements
      const longest = Math.max(...L.sides.map((x) => x.length));
      const widths: [number, number][] = [];
      for (let w = Math.min(3.6, longest - 0.3); w >= 0.99; w -= 0.3) widths.push([Math.round(w * 10) / 10, 0.62]);
      const got = L.fit("plan_travail", widths);
      const counter = got?.item ?? null;
      if (got && counter) {
        // pas de meubles hauts devant une fenêtre
        const s = got.side;
        const u = (counter.x - s.origin.x) * s.dir.x + (counter.y - s.origin.y) * s.dir.y;
        counter.upper = !s.windows.some(([a, z]) => u + counter.w / 2 > a && u - counter.w / 2 < z);
      }
      const fridge =
        (counter && L.relaxed(() => L.beside(counter, "frigo", 0.7, 0.68, 1, 0.05) ?? L.beside(counter, "frigo", 0.7, 0.68, -1, 0.05), 1)) ||
        L.fit("frigo", [[0.7, 0.68], [0.6, 0.65]], { tall: true });
      void fridge;
      if (L.minDim >= 3.2) L.diningSet(cx, cy, 1.4, 0.8, b.w >= b.h ? "x" : "y");
      L.relaxed(() => (L.corners("plante", 0.4, 1) ? true : null), 1);
      break;
    }
    case "salle_de_bain": {
      const tub = L.minDim >= 1.9 && Math.max(b.w, b.h) >= 2.2;
      // baignoire ou douche (dans un coin), puis vasque et WC ; dans une petite salle d'eau, on serre
      const bath = tub ? L.fit("baignoire", [[1.7, 0.75]], { at: 0.95, upTo: 1 }) : null;
      if (!bath) L.fit("douche", [[0.9, 0.9], [0.8, 0.8]], { at: 0.5 });
      L.fit("vasque", [[1.0, 0.5], [0.8, 0.45], [0.6, 0.42]]);
      if (!/douche/i.test(room.name)) L.fit("wc", [[0.4, 0.65]]);
      break;
    }
    case "wc": {
      L.fit("wc", [[0.4, 0.65]]);
      L.fit("vasque", [[0.5, 0.38]], { upTo: 1 }); // lave-mains
      break;
    }
    case "salle_a_manger": {
      L.diningSet(cx, cy, Math.min(2.2, b.w - 1.4), 0.95, b.w >= b.h ? "x" : "y");
      L.corners("plante", 0.5, 2);
      break;
    }
    case "bureau": {
      const sides = L.rankedSides();
      for (const s of sides) {
        const desk = L.againstSide(s, "bureau", 1.4, 0.7);
        if (desk) {
          L.inFront(desk, "chaise", 0.5, 0.5, -0.25, false);
          break;
        }
      }
      for (const s of sides) if (L.againstSide(s, "etagere", 1.2, 0.35, { tall: true })) break;
      L.corners("plante", 0.45, 1);
      break;
    }
    case "couloir": {
      const sides = L.rankedSides();
      if (L.minDim >= 1.1) for (const s of sides) if (s.length > 2.5 && L.againstSide(s, "console", 1.0, 0.32)) break;
      L.relaxed(() => (L.corners("plante", 0.4, 2) ? true : null), 1);
      break;
    }
    case "escalier": {
      if (room.stairs) break; // escalier dessiné sur le plan : affiché à sa place exacte par l'app
      // volée droite le long du plus grand côté, en partant du bas ; plus courte si les portes gênent
      const longest = [...L.sides].sort((p, q) => q.length - p.length);
      const w = Math.min(1.0, L.minDim - 0.1);
      const lens = [4.2, 3.6, 3.0, 2.6].filter((x) => x <= longest[0].length - 0.2);
      L.fit("escalier", (lens.length ? lens : [longest[0].length - 0.2]).map((x): [number, number] => [x, w]), { gap: 0.02, sides: longest.slice(0, 2) });
      break;
    }
    case "garage": {
      // la voiture, dans le sens de la longueur
      const long = b.w >= b.h;
      const len = Math.min(4.6, Math.max(b.w, b.h) - 0.6);
      const wid = Math.min(1.85, Math.min(b.w, b.h) - 0.5);
      if (len > 3 && wid > 1.4) L.add("voiture", cx, cy, wid, len, long ? Math.PI / 2 : 0);
      break;
    }
    case "terrasse": {
      // les transats ne vont que sur une terrasse assez profonde ; une cour étroite reçoit des plantes
      if (L.minDim >= 1.9) {
        const a = L.fit("transat", [[0.7, 1.8]], { upTo: 1 })?.item;
        if (a) L.beside(a, "transat", 0.7, 1.8, 1, 0.4);
      }
      L.relaxed(() => (L.corners("plante", 0.6, 3) ? true : null), 1);
      break;
    }
    default:
      // pièce sans usage précis : une plante, pour qu'elle ne paraisse pas abandonnée
      if (area >= 2.5) L.relaxed(() => (L.corners("plante", 0.45, 1) ? true : null), 1);
      break;
  }
  return L.items;
}

export function furnish(rooms: Room[], walls: Wall[], openings: Opening[]): Furniture[] {
  return rooms.flatMap((r) => furnishRoom(r, walls, openings));
}

/* Catalogue du design d'espace : dimensions par défaut (m), regroupées par usage. */
export const CATALOG: { kind: FurnitureKind; label: string; w: number; d: number; group: string }[] = [
  { kind: "canape", label: "Canapé", w: 2.2, d: 0.95, group: "Salon" },
  { kind: "fauteuil", label: "Fauteuil", w: 0.85, d: 0.85, group: "Salon" },
  { kind: "table_basse", label: "Table basse", w: 1.1, d: 0.6, group: "Salon" },
  { kind: "meuble_tv", label: "Meuble TV", w: 1.8, d: 0.45, group: "Salon" },
  { kind: "tapis", label: "Tapis", w: 2.4, d: 1.7, group: "Salon" },
  { kind: "lampadaire", label: "Lampadaire", w: 0.35, d: 0.35, group: "Salon" },
  { kind: "lit_double", label: "Lit double", w: 1.6, d: 2.0, group: "Chambre" },
  { kind: "lit_simple", label: "Lit simple", w: 0.9, d: 2.0, group: "Chambre" },
  { kind: "chevet", label: "Chevet", w: 0.45, d: 0.4, group: "Chambre" },
  { kind: "armoire", label: "Armoire", w: 1.6, d: 0.6, group: "Chambre" },
  { kind: "table", label: "Table", w: 1.6, d: 0.9, group: "Repas" },
  { kind: "chaise", label: "Chaise", w: 0.45, d: 0.48, group: "Repas" },
  { kind: "plan_travail", label: "Plan de travail", w: 2.4, d: 0.62, group: "Cuisine" },
  { kind: "ilot", label: "Îlot", w: 1.6, d: 0.9, group: "Cuisine" },
  { kind: "frigo", label: "Réfrigérateur", w: 0.7, d: 0.68, group: "Cuisine" },
  { kind: "douche", label: "Douche", w: 0.9, d: 0.9, group: "Salle d'eau" },
  { kind: "baignoire", label: "Baignoire", w: 1.7, d: 0.75, group: "Salle d'eau" },
  { kind: "vasque", label: "Vasque", w: 0.8, d: 0.48, group: "Salle d'eau" },
  { kind: "wc", label: "WC", w: 0.4, d: 0.65, group: "Salle d'eau" },
  { kind: "bureau", label: "Bureau", w: 1.4, d: 0.7, group: "Travail" },
  { kind: "etagere", label: "Étagère", w: 1.2, d: 0.35, group: "Travail" },
  { kind: "console", label: "Console", w: 1.0, d: 0.32, group: "Déco" },
  { kind: "plante", label: "Plante", w: 0.5, d: 0.5, group: "Déco" },
  { kind: "transat", label: "Transat", w: 0.7, d: 1.8, group: "Extérieur" },
  { kind: "escalier", label: "Escalier", w: 3.0, d: 0.95, group: "Structure" },
  { kind: "voiture", label: "Voiture", w: 1.8, d: 4.4, group: "Extérieur" },
];

export const furnitureLabel = (k: FurnitureKind) => CATALOG.find((c) => c.kind === k)?.label ?? k;
