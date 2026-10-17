/* De l'idée au plan, sans IA : Xwé dessine trois maisons à partir des réglages lus dans la phrase (idea.ts).

   Une maison = des rangées de pièces rectangulaires : la nuit au fond, un couloir, le jour devant (côté rue).
   On cherche la largeur et la répartition des pièces qui tiennent dans le terrain (reculs compris), au plus près
   des surfaces visées ; la maison peut aussi être « tournée » (rangées dans la profondeur) pour un terrain long.
   À étage : une entrée avec l'escalier au rez-de-chaussée, et juste au-dessus un palier qui donne sur le couloir.
   Murs, portes, fenêtres et contours des pièces se déduisent ensuite des rectangles (format de sample.ts). */
import type { IdeaBrief } from "./idea";
import { useLang, type Lang } from "./i18n";
import { openingSides, polygonArea, pointInPolygon } from "./geometry";
import { flightOf } from "./levels";
import type { LevelContent, Opening, OpeningKind, Project, Pt, Room, RoomType, Wall } from "./types";
import { OPENING_DEFAULTS } from "./types";

export const EXT = 0.25; // mur extérieur
export const INT = 0.15; // cloison
export const H = 2.8; // hauteur sous plafond
const LOW = 0.5; // muret de la terrasse
const LOW_T = 0.2;
/* profondeurs des rangées (entre axes) : fond (chambres), couloir, devant (séjour ; plus profond avec un garage,
   une voiture fait ~4,7 m) ; la version serrée et la version sans couloir servent aux petits terrains */
interface Depths {
  db: number;
  c: number;
  df: number;
  dfg: number;
  cost: number;
  tag: string;
}
const DEPTHS: Depths[] = [
  { db: 3.9, c: 1.3, df: 5.0, dfg: 5.8, cost: 0, tag: "" },
  { db: 3.6, c: 1.2, df: 4.6, dfg: 5.5, cost: 0.4, tag: "s" },
  { db: 3.6, c: 0, df: 4.6, dfg: 5.5, cost: 0.6, tag: "n" }, // sans couloir : les chambres donnent sur le séjour
  { db: 3.4, c: 1.2, df: 4.4, dfg: 5.5, cost: 0.9, tag: "e" }, // très serrée : terrain étroit
];
export const TERRACE_D = 2.6; // profondeur de la terrasse, dans le recul de devant
export const SETBACK = { side: 1.5, back: 1.5, front: 3 }; // reculs (les côtés tombent à 0 si la maison est mitoyenne)
const FLIGHT = { w: 4.2, d: 1.0 }; // volée droite : 17 marches pour 3 m

/* ---------- les pièces à placer ---------- */

type Key =
  | "parent" | "chambre" | "amis" | "sdb" | "sde" | "wc" | "sejour" | "cuisine" | "bureau"
  | "garage" | "hall" | "palier" | "couloir" | "buanderie" | "dressing" | "sam" | "mezz" | "terrasse";

interface Item {
  key: Key;
  type: RoomType;
  name: string;
  min: number; // largeur le long de la rangée, entre axes des murs
  ideal: number;
  max: number;
  flex?: boolean; // absorbe la place qui reste (le séjour)
}

const W_OF: Record<Key, [number, number, number]> = {
  parent: [3.4, 3.9, 4.8],
  chambre: [3.0, 3.3, 4.4],
  amis: [3.0, 3.2, 4.2],
  sdb: [1.9, 2.2, 2.8],
  sde: [1.8, 2.0, 2.6],
  wc: [1.5, 1.6, 1.7],
  sejour: [4.6, 6.0, 10],
  cuisine: [2.8, 3.2, 4.6],
  bureau: [2.6, 2.9, 3.8],
  garage: [3.3, 3.5, 4.2], // dans la rangée de devant (en largeur)
  hall: [2.6, 2.7, 3.0],
  palier: [2.6, 2.7, 3.0],
  couloir: [0, 0, 0],
  buanderie: [1.6, 2.2, 3.4],
  dressing: [1.6, 2.0, 3.0],
  sam: [2.8, 3.4, 5.0],
  mezz: [2.6, 3.4, 8],
  terrasse: [0, 0, 0],
};

const NAMES: Record<Key, [string, string, RoomType]> = {
  parent: ["Chambre parentale", "Master bedroom", "chambre"],
  chambre: ["Chambre", "Bedroom", "chambre"],
  amis: ["Chambre d'amis", "Guest room", "chambre"],
  sdb: ["Salle de bain", "Bathroom", "salle_de_bain"],
  sde: ["Salle d'eau", "Shower room", "salle_de_bain"],
  wc: ["WC", "Toilet", "wc"],
  sejour: ["Séjour", "Living room", "salon"],
  cuisine: ["Cuisine", "Kitchen", "cuisine"],
  bureau: ["Bureau", "Office", "bureau"],
  garage: ["Garage", "Garage", "garage"],
  hall: ["Entrée", "Entrance hall", "couloir"],
  palier: ["Palier", "Landing", "couloir"],
  couloir: ["Couloir", "Hallway", "couloir"],
  buanderie: ["Buanderie", "Laundry", "autre"],
  dressing: ["Dressing", "Walk-in closet", "autre"],
  sam: ["Salle à manger", "Dining room", "salle_a_manger"],
  mezz: ["Coin salon", "Sitting area", "salon"],
  terrasse: ["Terrasse", "Terrace", "terrasse"],
};

const item = (key: Key, lang: Lang, n?: number): Item => {
  const [fr, en, type] = NAMES[key];
  const [min, ideal, max] = W_OF[key];
  const base = lang === "en" ? en : fr;
  return { key, type, name: n ? `${base} ${n}` : base, min, ideal, max, flex: key === "sejour" };
};

/* ---------- remplir une rangée ---------- */

interface Fill {
  items: Item[];
  widths: number[];
  cost: number;
}

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

/** Largeurs des pièces d'une rangée de longueur `span` : au plus près de l'idéal, le séjour prend le surplus ;
    une pièce d'appoint (buanderie, dressing…) comble ce qui reste. null si ça ne tient pas. */
function fitRow(items: Item[], span: number, fillers: Item[]): Fill | null {
  const attempt = (list: Item[]): Fill | null => {
    if (!list.length) return null;
    const mn = sum(list.map((i) => i.min));
    const mx = sum(list.map((i) => i.max));
    const id = sum(list.map((i) => i.ideal));
    if (span < mn - 1e-6 || span > mx + 1e-6) return null;
    let widths: number[];
    if (span <= id) {
      const k = id - mn > 1e-9 ? (id - span) / (id - mn) : 0;
      widths = list.map((i) => i.ideal - (i.ideal - i.min) * k);
    } else {
      widths = list.map((i) => i.ideal);
      let rest = span - id;
      for (const group of [list.map((i, n) => (i.flex ? n : -1)), list.map((i, n) => (i.flex ? -1 : n))]) {
        const idx = group.filter((n) => n >= 0);
        const room = sum(idx.map((n) => list[n].max - widths[n]));
        if (room <= 1e-9 || rest <= 1e-9) continue;
        const k = Math.min(1, rest / room);
        for (const n of idx) widths[n] += (list[n].max - widths[n]) * k;
        rest -= room * k;
      }
    }
    const cost = sum(list.map((i, n) => Math.abs(widths[n] - i.ideal) / i.ideal));
    return { items: list, widths, cost };
  };
  let best = attempt(items);
  // une ou deux pièces d'appoint au bout de la rangée, mais jamais à la place du garage (il garde son coin sur rue)
  const g = items.length - 1;
  const withF = (fs: Item[]) => (g > 0 && items[g].key === "garage" ? [...items.slice(0, g), ...fs, items[g]] : [...items, ...fs]);
  for (const fs of [...fillers.map((f) => [f]), ...(best ? [] : fillers.flatMap((f, i) => fillers.slice(i + 1).map((h) => [f, h])))]) {
    const r = attempt(withF(fs));
    const cost = r ? r.cost + 0.6 * fs.length : Infinity;
    if (r && (!best || cost < best.cost)) best = { ...r, cost };
  }
  return best;
}

/* ---------- une maison « abstraite » : u le long des rangées, v du fond vers l'avant ---------- */

interface ACell {
  item: Item;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

interface Layout {
  mode: "H" | "V"; // H : rangées en largeur (rue en bas) ; V : rangées dans la profondeur
  mirror: boolean;
  W: number; // longueur des rangées
  Vt: number; // profondeur totale (fond + couloir + devant)
  levels: ACell[][];
  hall?: ACell; // entrée avec l'escalier (maison à étage)
  sejour: ACell;
  cost: number;
  mitoyen: boolean;
  split: string; // signature de la répartition (pour des variantes vraiment différentes)
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function row(fill: Fill, u0: number, v0: number, v1: number): ACell[] {
  const out: ACell[] = [];
  let u = u0;
  fill.items.forEach((it, n) => {
    const u1 = n === fill.items.length - 1 ? u0 + sum(fill.widths) : u + fill.widths[n];
    out.push({ item: it, u0: round(u), u1: round(u1), v0, v1 });
    u = u1;
  });
  return out;
}

interface Need {
  lang: Lang;
  bedrooms: Item[]; // la parentale d'abord
  baths: Item[];
  office: boolean;
  garage: boolean;
  openKitchen: boolean;
}

function needs(b: IdeaBrief, lang: Lang): Need {
  const bedrooms = [item("parent", lang), ...Array.from({ length: Math.max(0, b.bedrooms - 1) }, (_, k) => item("chambre", lang, k + 2))];
  const baths = Array.from({ length: b.bathrooms }, (_, k) => (k === 0 ? item("sdb", lang) : item("sde", lang, b.bathrooms > 2 ? k : undefined)));
  return { lang, bedrooms, baths, office: b.office, garage: b.garage, openKitchen: b.openKitchen };
}

/** Pièces de nuit dans l'ordre où elles se rangent : une salle de bain près de la parentale, l'autre plus loin. */
function nightList(bedrooms: Item[], baths: Item[]): Item[] {
  const out: Item[] = [];
  const b = [...baths];
  bedrooms.forEach((r, k) => {
    out.push(r);
    if (k === 0 && b.length) out.push(b.shift()!);
    if (k === 2 && b.length) out.push(b.shift()!);
  });
  return [...out, ...b];
}

/** Toutes les maisons possibles (un mode, une symétrie) pour ce brief, avec leur coût. */
function layouts(n: Need, levels: 1 | 2, mode: "H" | "V", maxU: number, maxV: number, mitoyen: boolean): Layout[] {
  const L = n.lang;
  const out: Layout[] = [];
  const garageFront = n.garage && mode === "H";
  const garageBack = n.garage && mode === "V";
  for (const dp of DEPTHS) {
  // sans couloir : seulement une petite maison de plain-pied
  if (!dp.c && (levels === 2 || n.bedrooms.length > 2)) continue;
  const Df = garageFront ? dp.dfg : dp.df;
  const Vt = round(dp.db + dp.c + Df);
  if (Vt > maxV + 1e-6) continue;
  const vB = [0, dp.db];
  const vC = [dp.db, round(dp.db + dp.c)];
  const vF = [round(dp.db + dp.c), Vt];
  const garageItem = (): Item => (garageBack ? { ...item("garage", L), min: 5.8, ideal: 6.0, max: 6.6 } : item("garage", L));
  const corridor = (W: number): ACell[] => (dp.c ? [{ item: item("couloir", L), u0: 0, u1: W, v0: vC[0], v1: vC[1] }] : []);

  for (let W = 5; W <= maxU + 1e-6; W = round(W + 0.2)) {
    if (levels === 1) {
      const night = nightList(n.bedrooms, n.baths);
      if (n.office) night.push(item("bureau", L));
      // k premières pièces de nuit au fond, les autres devant à côté du séjour
      for (let k = night.length; k >= 1; k--) {
        const back = [...(garageBack ? [garageItem()] : []), ...night.slice(0, k)];
        const front = [item("sejour", L), item("cuisine", L), ...night.slice(k), ...(garageFront ? [garageItem()] : [])];
        const fb = fitRow(back, W, [item("dressing", L), item("buanderie", L)]);
        if (!fb) continue;
        const ff = fitRow(front, W, [item("sam", L), item("buanderie", L)]);
        if (!ff) continue;
        const cells = [...row(fb, 0, vB[0], vB[1]), ...corridor(W), ...row(ff, 0, vF[0], vF[1])];
        const sejour = cells.find((c) => c.item.key === "sejour")!;
        out.push({ mode, mirror: false, W, Vt, levels: [cells], sejour, cost: fb.cost + ff.cost + dp.cost, mitoyen, split: `${mode}${dp.tag}${k}` });
      }
    } else {
      // rez-de-chaussée : le jour, l'entrée avec l'escalier, une salle d'eau ou un WC, le bureau, une chambre d'amis s'il le faut
      const upNight = nightList(n.bedrooms, n.baths.length > 1 ? [n.baths[0], ...n.baths.slice(2)] : n.baths);
      for (const officeUp of n.office ? [false, true] : [false]) {
      const groundBack0: Item[] = [
        ...(garageBack ? [garageItem()] : []),
        ...(n.openKitchen ? [] : [item("cuisine", L)]),
        n.baths.length > 1 ? n.baths[1] : item("wc", L),
        ...(n.office && !officeUp ? [item("bureau", L)] : []),
      ];
      const front: Item[] = [item("sejour", L), ...(n.openKitchen ? [item("cuisine", L)] : []), item("hall", L), ...(garageFront ? [garageItem()] : [])];
      const ff = fitRow(front, W, [item("sam", L)]);
      if (!ff) continue;
      const frontCells = row(ff, 0, vF[0], vF[1]);
      const hall = frontCells.find((c) => c.item.key === "hall")!;
      // une chambre d'amis en bas si l'étage est trop petit pour toutes les chambres
      for (const guest of n.bedrooms.length >= 3 ? [false, true] : [false]) {
        const groundBack = guest ? [...groundBack0, item("amis", L)] : groundBack0;
        const fb = fitRow(groundBack, W, [item("sam", L), item("buanderie", L)]);
        if (!fb) continue;
        const ground = [...row(fb, 0, vB[0], vB[1]), ...corridor(W), ...frontCells];
        // étage : la même emprise ; le palier au-dessus de l'entrée, des chambres au fond et devant
        const list = [...(guest ? upNight.filter((r) => r !== n.bedrooms[n.bedrooms.length - 1]) : upNight), ...(officeUp ? [item("bureau", L)] : [])];
        let spanA = hall.u0;
        let spanB = round(W - hall.u1);
        const palier: ACell = { item: item("palier", L), u0: hall.u0, u1: hall.u1, v0: vF[0], v1: vF[1] };
        // trop étroit pour une pièce : le palier s'élargit jusqu'à la façade
        if (spanA > 0 && spanA < 1.6) [palier.u0, spanA] = [0, 0];
        if (spanB > 0 && spanB < 1.6) [palier.u1, spanB] = [W, 0];
        for (let k = list.length; k >= 0; k--) {
          const fb2 = fitRow(list.slice(0, k), W, [item("dressing", L), item("mezz", L)]);
          if (!fb2) continue;
          const rest = list.slice(k);
          let bestJ: Layout | null = null;
          for (let j = rest.length; j >= 0; j--) {
            const a = rest.slice(0, j);
            const b = rest.slice(j);
            const fa = spanA > 0 ? fitRow(a, spanA, [item("mezz", L), item("dressing", L)]) : a.length ? null : { items: [], widths: [], cost: 0 };
            if (!fa) continue;
            const fbb = spanB > 0 ? fitRow(b, spanB, [item("mezz", L), item("dressing", L)]) : b.length ? null : { items: [], widths: [], cost: 0 };
            if (!fbb) continue;
            const upper = [
              ...row(fb2, 0, vB[0], vB[1]),
              ...corridor(W),
              ...(spanA > 0 ? row(fa, 0, vF[0], vF[1]) : []),
              palier,
              ...(spanB > 0 ? row(fbb, hall.u1, vF[0], vF[1]) : []),
            ];
            const sejour = ground.find((c) => c.item.key === "sejour")!;
            const cost = ff.cost + fb.cost + fb2.cost + fa.cost + fbb.cost + (guest ? 0.3 : 0) + dp.cost;
            // pour chaque largeur, on ne garde que la meilleure répartition devant / derrière le palier
            if (!bestJ || cost < bestJ.cost)
              bestJ = { mode, mirror: false, W, Vt, levels: [ground, upper], hall, sejour, cost, mitoyen, split: `${mode}${dp.tag}${guest ? "g" : ""}${officeUp ? "b" : ""}${k}` };
          }
          if (bestJ) out.push(bestJ);
        }
      }
      }
    }
  }
  }
  return out;
}

/* ---------- de l'abstrait au plan : rectangles, murs, ouvertures ---------- */

interface PCell {
  id: string;
  key: Key;
  type: RoomType;
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  outside?: boolean; // terrasse
}

type Kind = "int" | "ext" | "low";
interface Run {
  wall: Wall;
  horiz: boolean;
  c: number; // y d'un mur horizontal, x d'un mur vertical
  s0: number;
  s1: number;
  kind: Kind;
}

interface Seg {
  horiz: boolean;
  c: number;
  s0: number;
  s1: number;
}

const EPS = 1e-4;

function toPlan(l: Layout, a: { u0: number; u1: number; v0: number; v1: number }) {
  const X = (u: number, v: number) => (l.mode === "H" ? (l.mirror ? l.W - u : u) : l.mirror ? l.Vt - v : v);
  const Y = (u: number, v: number) => (l.mode === "H" ? v : l.W - u);
  const xs = [X(a.u0, a.v0), X(a.u1, a.v1)];
  const ys = [Y(a.u0, a.v0), Y(a.u1, a.v1)];
  return { x0: round(Math.min(...xs)), x1: round(Math.max(...xs)), y0: round(Math.min(...ys)), y1: round(Math.max(...ys)) };
}

/** Une direction abstraite (du, dv) dans le repère du plan. */
const dirToPlan = (l: Layout, du: number, dv: number): Pt =>
  l.mode === "H" ? { x: l.mirror ? -du : du, y: dv } : { x: l.mirror ? -dv : dv, y: -du };

class Builder {
  walls: Wall[] = [];
  runs: Run[] = [];
  openings: Opening[] = [];
  used = new Map<string, [number, number][]>();
  n = 0;

  constructor(public cells: PCell[]) {
    const house = cells.filter((c) => !c.outside);
    const terr = cells.filter((c) => c.outside);
    const lines = (horiz: boolean) => {
      const at = new Set<number>();
      for (const c of cells) for (const v of horiz ? [c.y0, c.y1] : [c.x0, c.x1]) at.add(v);
      return [...at].sort((a, b) => a - b);
    };
    for (const horiz of [true, false]) {
      for (const c of lines(horiz)) {
        const on = cells.filter((k) => (horiz ? k.y0 === c || k.y1 === c : k.x0 === c || k.x1 === c));
        const bp = [...new Set(on.flatMap((k) => (horiz ? [k.x0, k.x1] : [k.y0, k.y1])))].sort((a, b) => a - b);
        let cur: { s0: number; s1: number; kind: Kind } | null = null;
        const flush = () => {
          if (cur) this.addRun(horiz, c, cur.s0, cur.s1, cur.kind);
          cur = null;
        };
        for (let i = 0; i < bp.length - 1; i++) {
          const a = bp[i];
          const b = bp[i + 1];
          const covers = (list: PCell[], side: -1 | 1) =>
            list.some((k) => (horiz ? (side < 0 ? k.y1 === c : k.y0 === c) && k.x0 <= a + EPS && k.x1 >= b - EPS : (side < 0 ? k.x1 === c : k.x0 === c) && k.y0 <= a + EPS && k.y1 >= b - EPS));
          const h1 = covers(house, -1);
          const h2 = covers(house, 1);
          const t = covers(terr, -1) || covers(terr, 1);
          const kind: Kind | null = h1 && h2 ? "int" : h1 || h2 ? "ext" : t ? "low" : null;
          const curRun = cur as { s0: number; s1: number; kind: Kind } | null;
          if (kind && curRun && curRun.kind === kind && Math.abs(curRun.s1 - a) < EPS) curRun.s1 = b;
          else {
            flush();
            if (kind) cur = { s0: a, s1: b, kind };
          }
        }
        flush();
      }
    }
  }

  addRun(horiz: boolean, c: number, s0: number, s1: number, kind: Kind) {
    // muret de devant de la terrasse : un passage d'1,2 m au milieu pour descendre au jardin
    const terr = this.cells.find((k) => k.outside);
    if (kind === "low" && horiz && terr && c === terr.y1 && s1 - s0 > 2.4) {
      const m = (s0 + s1) / 2;
      this.addRun(horiz, c, s0, round(m - 0.6), kind);
      this.addRun(horiz, c, round(m + 0.6), s1, kind);
      return;
    }
    const id = `w${++this.n}`;
    const a = horiz ? { x: s0, y: c } : { x: c, y: s0 };
    const b = horiz ? { x: s1, y: c } : { x: c, y: s1 };
    const wall: Wall = { id, a, b, thickness: kind === "ext" ? EXT : kind === "int" ? INT : LOW_T, height: kind === "low" ? LOW : H };
    this.walls.push(wall);
    this.runs.push({ wall, horiz, c, s0, s1, kind });
  }

  /** Demi-épaisseur des murs le long d'un côté d'une pièce (le plus épais). */
  half(horiz: boolean, c: number, s0: number, s1: number) {
    let h = 0;
    for (const r of this.runs) if (r.horiz === horiz && Math.abs(r.c - c) < EPS && r.s0 < s1 - EPS && r.s1 > s0 + EPS) h = Math.max(h, r.wall.thickness / 2);
    return h || INT / 2;
  }

  room(k: PCell, extra: Partial<Room> = {}): Room {
    const l = k.x0 + this.half(false, k.x0, k.y0, k.y1);
    const r = k.x1 - this.half(false, k.x1, k.y0, k.y1);
    const t = k.y0 + this.half(true, k.y0, k.x0, k.x1);
    const b = k.y1 - this.half(true, k.y1, k.x0, k.x1);
    return {
      id: k.id,
      name: k.name,
      type: k.type,
      points: [
        { x: round(l), y: round(t) },
        { x: round(r), y: round(t) },
        { x: round(r), y: round(b) },
        { x: round(l), y: round(b) },
      ],
      ...extra,
    };
  }

  /** Le segment commun à deux pièces voisines. */
  shared(a: PCell, b: PCell): Seg | null {
    const ov = (p0: number, p1: number, q0: number, q1: number) => [Math.max(p0, q0), Math.min(p1, q1)];
    if (Math.abs(a.x1 - b.x0) < EPS || Math.abs(a.x0 - b.x1) < EPS) {
      const [s0, s1] = ov(a.y0, a.y1, b.y0, b.y1);
      if (s1 - s0 > 0.5) return { horiz: false, c: Math.abs(a.x1 - b.x0) < EPS ? a.x1 : a.x0, s0, s1 };
    }
    if (Math.abs(a.y1 - b.y0) < EPS || Math.abs(a.y0 - b.y1) < EPS) {
      const [s0, s1] = ov(a.x0, a.x1, b.x0, b.x1);
      if (s1 - s0 > 0.5) return { horiz: true, c: Math.abs(a.y1 - b.y0) < EPS ? a.y1 : a.y0, s0, s1 };
    }
    return null;
  }

  /** Les morceaux de façade d'une pièce (murs extérieurs), du plus long au plus court. */
  facades(k: PCell): Seg[] {
    const out: Seg[] = [];
    const sides: Seg[] = [
      { horiz: true, c: k.y0, s0: k.x0, s1: k.x1 },
      { horiz: true, c: k.y1, s0: k.x0, s1: k.x1 },
      { horiz: false, c: k.x0, s0: k.y0, s1: k.y1 },
      { horiz: false, c: k.x1, s0: k.y0, s1: k.y1 },
    ];
    for (const s of sides)
      for (const r of this.runs)
        if (r.kind === "ext" && r.horiz === s.horiz && Math.abs(r.c - s.c) < EPS) {
          const s0 = Math.max(r.s0, s.s0);
          const s1 = Math.min(r.s1, s.s1);
          if (s1 - s0 > 0.6) out.push({ horiz: s.horiz, c: s.c, s0, s1 });
        }
    return out.sort((a, b) => b.s1 - b.s0 - (a.s1 - a.s0));
  }

  block(seg: Seg, s0: number, s1: number) {
    const r = this.runOf(seg);
    if (!r) return;
    const list = this.used.get(r.wall.id) ?? [];
    list.push([s0 - r.s0, s1 - r.s0]);
    this.used.set(r.wall.id, list);
  }

  runOf(seg: Seg) {
    const m = (seg.s0 + seg.s1) / 2;
    return this.runs.find((r) => r.horiz === seg.horiz && Math.abs(r.c - seg.c) < EPS && r.s0 <= m && r.s1 >= m) ?? null;
  }

  /** Pose une ouverture sur un segment : à la place voulue si elle est libre, sinon la plus proche. */
  place(seg: Seg, kind: OpeningKind, width: number, at: "start" | "center" | "end" | number = "center", over: Partial<Opening> = {}, margin = 0.32): boolean {
    const r = this.runOf(seg);
    if (!r) return false;
    const lo = Math.max(seg.s0, r.s0) + margin + width / 2;
    const hi = Math.min(seg.s1, r.s1) - margin - width / 2;
    if (hi < lo - EPS) return false;
    const want = at === "start" ? lo : at === "end" ? hi : at === "center" ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, at));
    const used = this.used.get(r.wall.id) ?? [];
    const free = (p: number) => used.every(([a, b]) => p - width / 2 - r.s0 >= b + 0.2 || p + width / 2 - r.s0 <= a - 0.2);
    for (let d = 0; d <= hi - lo + 0.05; d += 0.05)
      for (const p of [want + d, want - d]) {
        if (p < lo - EPS || p > hi + EPS || !free(p)) continue;
        const { height, sill } = OPENING_DEFAULTS[kind];
        this.openings.push({ id: `o${this.openings.length + 1}`, wallId: r.wall.id, kind, t: round(p - r.s0), width, height, sill, ...over });
        used.push([p - width / 2 - r.s0, p + width / 2 - r.s0]);
        this.used.set(r.wall.id, used);
        return true;
      }
    return false;
  }
}

const WINDOW: Partial<Record<RoomType, { width: number; over?: Partial<Opening>; two?: number }>> = {
  chambre: { width: 1.4, two: 1.0 },
  salon: { width: 1.8, two: 1.4 },
  salle_a_manger: { width: 1.4 },
  cuisine: { width: 1.2, over: { sill: 1.1, height: 1.0 } },
  bureau: { width: 1.2, two: 0.9 },
  salle_de_bain: { width: 0.6, over: { height: 0.6, sill: 1.5 } },
  wc: { width: 0.5, over: { height: 0.5, sill: 1.6 } },
  couloir: { width: 0.8 },
  autre: { width: 0.6, over: { height: 0.6, sill: 1.5 } },
};

/** Ordre de préférence des pièces vers lesquelles ouvrir une porte. */
const LINKS: Partial<Record<Key, Key[]>> = {
  parent: ["couloir", "palier", "sejour", "mezz"],
  chambre: ["couloir", "palier", "sejour", "mezz"],
  amis: ["couloir", "sejour"],
  sdb: ["couloir", "palier", "parent", "chambre"],
  sde: ["couloir", "palier", "amis", "chambre", "parent"],
  wc: ["couloir", "hall", "sejour"],
  bureau: ["couloir", "sejour", "palier"],
  cuisine: ["sejour", "couloir", "sam"],
  sam: ["sejour", "cuisine", "couloir"],
  garage: ["cuisine", "couloir", "buanderie", "sejour"],
  buanderie: ["cuisine", "couloir", "garage", "palier"],
  dressing: ["parent", "couloir", "palier", "chambre"],
  mezz: ["palier", "couloir"],
};

/** Construit un niveau : murs, pièces, portes et fenêtres. */
function buildLevel(l: Layout, cells: ACell[], level: number, terrace: boolean, n: Need): { content: LevelContent; stairs?: Room["stairs"] } {
  const pc: PCell[] = cells.map((c, i) => ({ id: `n${level}-${i}-${c.item.key}`, key: c.item.key, type: c.item.type, name: c.item.name, ...toPlan(l, c) }));
  const sej = pc.find((c) => c.key === "sejour");
  const H_ = Math.max(...pc.map((c) => c.y1));
  // on entre par l'entrée de l'escalier si elle donne sur la rue, sinon par le séjour
  const hallCell = pc.find((c) => c.key === "hall");
  const enterSej = level === 0 && !!sej && !(hallCell && Math.abs(hallCell.y1 - H_) < EPS);
  const planW = Math.max(...pc.map((c) => c.x1));
  // la porte d'entrée garde 1,8 m de façade hors de la terrasse, du côté du milieu de la maison
  const doorLeft = !!sej && sej.x1 > planW - EPS && sej.x0 > EPS;
  const doorSeg: Seg | null = enterSej && sej ? { horiz: true, c: H_, s0: doorLeft ? sej.x0 : round(sej.x1 - 1.8), s1: doorLeft ? round(sej.x0 + 1.8) : sej.x1 } : null;
  if (terrace && sej) {
    // la terrasse devant le séjour, côté rue (dans le recul de devant)
    const x0 = doorSeg && doorLeft ? doorSeg.s1 : sej.x0;
    const x1 = doorSeg && !doorLeft ? doorSeg.s0 : sej.x1;
    pc.push({ id: `n${level}-terrasse`, key: "terrasse", type: "terrasse", name: item("terrasse", n.lang).name, x0, x1, y0: H_, y1: round(H_ + TERRACE_D), outside: true });
  }
  const B = new Builder(pc);
  const by = (k: Key) => pc.filter((c) => c.key === k);
  const corridor = by("couloir")[0];
  const linked = new Set<string>();
  const link = (a: PCell, b: PCell, kind: OpeningKind, width: number, at: "start" | "center" | "end" | number = "start") => {
    const s = B.shared(a, b);
    if (!s || !B.place(s, kind, width, at)) return false;
    linked.add(a.id);
    linked.add(b.id);
    return true;
  };

  // l'escalier : dans l'entrée (rez-de-chaussée), son trou dans le palier (étage), le long du côté opposé au séjour
  let stairs: Room["stairs"] | undefined;
  const stairCell = level === 0 ? by("hall")[0] : by("palier")[0];
  let topSeg: Seg | null = null;
  if (l.hall && stairCell) {
    const hc = l.hall;
    const tu1 = hc.u1 >= l.W - EPS ? EXT : INT;
    const v0i = hc.v0 + INT / 2;
    const v1i = hc.v1 - EXT / 2;
    const w = Math.min(FLIGHT.w, v1i - v0i - 0.35);
    const uC = hc.u1 - tu1 / 2 - 0.03 - FLIGHT.d / 2;
    const vC = v0i + 0.03 + w / 2;
    const c = toPlan(l, { u0: uC, u1: uC, v0: vC, v1: vC });
    const dir = dirToPlan(l, 0, -1); // les marches montent vers le couloir
    stairs = { x: c.x0, y: c.y0, w: round(w), d: FLIGHT.d, rot: round(Math.atan2(-dir.y, dir.x)) };
    const fl = flightOf(stairs);
    const xs = fl.corners.map((p) => p.x);
    const ys = fl.corners.map((p) => p.y);
    const fb = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    // pas de porte ni de fenêtre contre la volée (ni de porte qui s'ouvrirait sur la trémie, à l'étage)
    const k = stairCell;
    for (const s of [
      { horiz: true, c: k.y0, s0: k.x0, s1: k.x1 },
      { horiz: true, c: k.y1, s0: k.x0, s1: k.x1 },
      { horiz: false, c: k.x0, s0: k.y0, s1: k.y1 },
      { horiz: false, c: k.x1, s0: k.y0, s1: k.y1 },
    ] as Seg[]) {
      const near = s.horiz ? Math.min(Math.abs(s.c - fb.y0), Math.abs(s.c - fb.y1)) : Math.min(Math.abs(s.c - fb.x0), Math.abs(s.c - fb.x1));
      if (near > 0.8) continue;
      const touchesTop = Math.hypot(s.horiz ? 0 : s.c - fl.top.x, s.horiz ? s.c - fl.top.y : 0) < 0.3;
      if (touchesTop) {
        topSeg = s; // le haut de la volée : c'est par là qu'on rejoint le couloir
        continue;
      }
      B.block(s, s.horiz ? fb.x0 - 0.05 : fb.y0 - 0.05, s.horiz ? fb.x1 + 0.05 : fb.y1 + 0.05);
    }
    if (level === 1) stairs = undefined; // à l'étage, seul le trou compte (il vient de la volée du dessous)
    // l'entrée (ou le palier) s'ouvre en grand sur le couloir, au droit du haut de la volée
    if (corridor && topSeg) {
      const s = B.shared(k, corridor);
      if (s) {
        const width = Math.min(1.8, s.s1 - s.s0 - 0.7);
        const top = s.horiz ? fl.top.x : fl.top.y;
        if (B.place(s, "passage", round(width), top)) {
          linked.add(k.id);
          linked.add(corridor.id);
        }
      }
    }
  }

  // entrée de la maison : porte sur rue (dans l'entrée à étage si elle donne sur la rue, sinon dans le séjour)
  const street = (k: PCell): Seg | null => (Math.abs(k.y1 - H_) < EPS ? { horiz: true, c: H_, s0: k.x0, s1: k.x1 } : null);
  const hall = by("hall")[0];
  // l'entrée qui ne donne pas sur la rue n'est qu'un dégagement pour l'escalier (on entre par le séjour)
  if (hall && enterSej) hall.name = T(n.lang, "Escalier", "Stairs");
  if (level === 0) {
    const s = enterSej ? doorSeg : hall && street(hall);
    if (s) B.place(s, "door", enterSej ? 1.0 : 0.9, "center");
  }
  // la baie vitrée du séjour sur la terrasse
  const terr = pc.find((c) => c.outside);
  if (terr && sej) {
    const s = B.shared(sej, terr);
    if (s) B.place(s, "baie", Math.min(2.4, s.s1 - s.s0 - 1.9), "center");
    linked.add(terr.id);
  }
  // le garage : grand portail sur rue
  for (const g of by("garage")) {
    const s = street(g);
    if (s) B.place(s, "passage", Math.min(2.6, s.s1 - s.s0 - 0.7), "center", { height: 2.2 });
  }

  // couloir ↔ séjour, entrée ↔ séjour, cuisine ouverte ↔ séjour
  if (corridor && sej) link(sej, corridor, "passage", 1.4, "end");
  if (hall && sej) link(hall, sej, "door", 0.9);
  const kitchen = by("cuisine")[0];
  if (kitchen && sej && n.openKitchen) link(kitchen, sej, "passage", Math.min(1.8, Math.max(1.0, (kitchen.y1 - kitchen.y0) - 1.2)), "center");

  // chaque pièce : une porte vers la première voisine de sa liste
  const order: Key[] = ["parent", "chambre", "amis", "sdb", "sde", "wc", "bureau", "cuisine", "sam", "garage", "buanderie", "dressing", "mezz"];
  for (const key of order)
    for (const c of by(key)) {
      if (linked.has(c.id) && key !== "garage") continue;
      const prefs = LINKS[key] ?? ["couloir"];
      const small = c.type === "salle_de_bain" || c.type === "wc" || c.key === "dressing";
      let ok = false;
      for (const p of prefs) {
        for (const t of by(p)) {
          if (t === c) continue;
          if (link(c, t, "door", small ? 0.8 : 0.9)) {
            ok = true;
            break;
          }
        }
        if (ok) break;
      }
    }

  // fenêtres : chaque pièce sur ses façades
  for (const c of pc) {
    if (c.outside || c.type === "garage") continue;
    const spec = WINDOW[c.type];
    if (!spec) continue;
    const segs = B.facades(c);
    if (!segs.length) continue;
    // le séjour à étage a déjà la baie : une fenêtre de plus sur le côté
    const first = segs.find((s) => !(c === sej && terr && s.horiz && Math.abs(s.c - H_) < EPS)) ?? segs[0];
    const w1 = Math.min(spec.width, first.s1 - first.s0 - 0.8);
    if (w1 >= 0.45) B.place(first, "window", round(w1), "center", spec.over, 0.4);
    if (spec.two && segs.length > 1) {
      const other = segs.find((s) => s !== first && (s.horiz !== first.horiz || Math.abs(s.c - first.c) > EPS));
      if (other) {
        const w2 = Math.min(spec.two, other.s1 - other.s0 - 0.8);
        if (w2 >= 0.6) B.place(other, "window", round(w2), "center", spec.over, 0.4);
      }
    }
  }

  const rooms = pc.map((c) => B.room(c, level === 0 && c === by("hall")[0] && stairs ? { stairs } : {}));
  return { content: { walls: B.walls, openings: B.openings, rooms, background: null }, stairs };
}

/* ---------- les trois variantes ---------- */

export interface IdeaPlan {
  project: Project;
  title: string;
  summary: string;
}

const T = (lang: Lang, fr: string, en: string) => (lang === "en" ? en : fr);

/** Deux pièces d'appoint du même genre dans la maison : la seconde prend un autre nom. */
const SECOND: Record<string, [string, string, RoomType]> = {
  "Coin salon": ["Salle de jeux", "Playroom", "salon"],
  "Sitting area": ["Salle de jeux", "Playroom", "salon"],
  "Salle à manger": ["Salon TV", "TV room", "salon"],
  "Dining room": ["Salon TV", "TV room", "salon"],
  Dressing: ["Rangement", "Storage", "autre"],
  "Walk-in closet": ["Rangement", "Storage", "autre"],
  Buanderie: ["Cellier", "Pantry", "autre"],
  Laundry: ["Cellier", "Pantry", "autre"],
};

function toProject(l: Layout, b: IdeaBrief, n: Need): Project {
  const lv = l.levels.map((cells, i) => buildLevel(l, cells, i, i === 0 && b.terrace, n).content);
  const seen = new Set<string>();
  for (const c of lv)
    c.rooms = c.rooms.map((r) => {
      const alt = SECOND[r.name];
      if (seen.has(r.name) && alt) return { ...r, name: T(n.lang, alt[0], alt[1]), type: alt[2] };
      seen.add(r.name);
      return r;
    });
  const name = T(n.lang, `Ma maison, ${b.bedrooms} chambre${b.bedrooms > 1 ? "s" : ""}`, `My home, ${b.bedrooms} bedroom${b.bedrooms > 1 ? "s" : ""}`);
  const base = { name, styleId: b.styleId, furnished: true, ...lv[0] };
  if (lv.length === 1) return base;
  return {
    ...base,
    level: 0,
    levels: [{ name: T(n.lang, "Rez-de-chaussée", "Ground floor") }, { name: T(n.lang, "Étage", "Upper floor"), data: lv[1] }],
  };
}

const livingArea = (p: Project) =>
  [p, ...(p.levels ?? []).map((l) => l.data).filter(Boolean)].reduce(
    (s, lv) => s + (lv as LevelContent).rooms.filter((r) => r.type !== "terrasse" && r.type !== "garage").reduce((t, r) => t + Math.abs(polygonArea(r.points)), 0),
    0,
  );

/** Les trois variantes parmi les maisons possibles : chacune est construite puis vérifiée (checkPlan) ;
    une maison qui échoue cède la place à la suivante. */
function choose(found: Layout[], brief: IdeaBrief, n: Need, tooSmall: boolean) {
  const area = (l: Layout) => l.W * l.Vt;
  const sejW = (l: Layout) => l.sejour.u1 - l.sejour.u0;
  const rejected = new Set<Layout>();
  const pick = (score: (l: Layout) => number, avoid: Layout[], mirror: boolean): { l: Layout; project: Project } | null => {
    const far = (l: Layout) => !avoid.some((a) => a.split === l.split && Math.abs(a.W - l.W) < 1.2);
    for (const pool of [found.filter(far), found.filter((l) => !avoid.includes(l))]) {
      const ranked = pool.map((l) => [score(l), l] as const).sort((p, q) => p[0] - q[0]);
      let tries = 0;
      for (const [, l] of ranked) {
        if (rejected.has(l)) continue;
        if (++tries > 25) break;
        const v = { ...l, mirror };
        const project = toProject(v, brief, n);
        if (!checkPlan(project, tooSmall ? undefined : brief).length) return { l: v, project };
        rejected.add(l);
      }
    }
    return null;
  };
  const chosen: { l: Layout; project: Project; title: [string, string] }[] = [];
  const same = (l: Layout) => chosen.some((c) => c.l.split === l.split && c.l.W === l.W && c.l.mode === l.mode);
  const a = pick((l) => l.cost + 0.03 * area(l), [], false);
  if (!a) return chosen;
  chosen.push({ ...a, title: ["Compacte", "Compact"] });
  const b = pick((l) => l.cost + 0.6 * Math.max(0, 8 - sejW(l)) + 0.01 * area(l) - (l.mode === a.l.mode ? 0 : 0.2), [...chosen.map((c) => c.l), ...found.filter(same)], true);
  if (b) chosen.push({ ...b, title: ["Grand séjour", "Big living room"] });
  const otherMode = found.some((l) => l.mode !== a.l.mode);
  const c = pick(
    (l) => l.cost + 0.02 * area(l) + (otherMode && l.mode === a.l.mode ? 5 : 0) + (l.split === a.l.split ? 2 : 0),
    [...chosen.map((x) => x.l), ...found.filter(same)],
    false,
  );
  if (c) chosen.push({ ...c, title: ["Familiale", "Family"] });
  // les titres disent ce qui distingue vraiment chaque maison : la plus petite emprise, le plus grand séjour,
  // et pour la troisième, son orientation si elle est la seule à l'avoir
  const sejArea = (p: Project) => Math.abs(polygonArea(p.rooms.find((r) => r.type === "salon")?.points ?? []));
  const rest = [...chosen];
  const take = (best: (x: (typeof chosen)[number]) => number) => rest.splice(rest.indexOf(rest.reduce((m, x) => (best(x) < best(m) ? x : m))), 1)[0];
  const compact = take((x) => area(x.l));
  compact.title = ["Compacte", "Compact"];
  if (rest.length) take((x) => -sejArea(x.project)).title = ["Grand séjour", "Big living room"];
  if (rest.length) {
    const last = rest[0];
    const alone = chosen.every((x) => x === last || x.l.mode !== last.l.mode);
    last.title = alone ? (last.l.mode === "V" ? ["Tout en profondeur", "Long and deep"] : ["Tout en largeur", "Wide"]) : ["Familiale", "Family"];
  }
  const rank = (x: (typeof chosen)[number]) => (x === compact ? 0 : x.title[0] === "Grand séjour" ? 1 : 2);
  return chosen.sort((p, q) => rank(p) - rank(q));
}

/** Trois maisons nettement différentes pour ce brief (dans la langue de l'interface si `lang` n'est pas donné). */
export function generatePlans(brief: IdeaBrief, lang: Lang = useLang.getState().lang): IdeaPlan[] {
  const n = needs(brief, lang);
  const plotW = brief.plotW;
  const plotD = brief.plotD;
  const all = (levels: 1 | 2, mitoyen: boolean) => {
    const maxW = plotW - (mitoyen ? 0 : 2 * SETBACK.side);
    const maxD = plotD - SETBACK.front - SETBACK.back;
    return [...layouts(n, levels, "H", maxW, maxD, mitoyen), ...layouts(n, levels, "V", maxD, maxW, mitoyen)];
  };
  // d'abord avec les reculs, puis mitoyenne, puis à étage, et en dernier recours une maison qui déborde
  const stages: { levels: 1 | 2; found: () => Layout[]; tooSmall?: boolean }[] = [
    { levels: brief.levels, found: () => all(brief.levels, false) },
    { levels: brief.levels, found: () => all(brief.levels, true) },
    ...(brief.levels === 1 ? [{ levels: 2 as const, found: () => all(2, false) }, { levels: 2 as const, found: () => all(2, true) }] : []),
    { levels: brief.levels, found: () => layouts(n, brief.levels, "H", plotW + 8, plotD + 4, true), tooSmall: true },
  ];
  let chosen: { l: Layout; project: Project; title: [string, string] }[] = [];
  let tooSmall = false;
  for (const st of stages) {
    if (chosen.length >= 3 || (st.tooSmall && chosen.length)) break;
    const found = st.found();
    if (!found.length) continue;
    tooSmall = !!st.tooSmall;
    const more = choose(found, { ...brief, levels: st.levels }, n, tooSmall);
    if (!chosen.length) chosen = more;
    else {
      // moins de trois maisons à la première étape : on complète avec l'étape suivante (mitoyenne, à étage…)
      for (const m of more) if (chosen.length < 3) chosen.push({ ...m, title: m.l.levels.length === 2 ? ["À étage", "Two storeys"] : ["Mitoyenne", "Semi-detached"] });
    }
  }
  if (!chosen.length) return [];

  return chosen.map(({ l, project, title }) => {
    const levels = l.levels.length;
    const switched = levels !== brief.levels && !chosen.some((c) => c.l.levels.length === brief.levels);
    const planW = l.mode === "H" ? l.W : l.Vt;
    const planD = l.mode === "H" ? l.Vt : l.W;
    const rooms = [project, ...(project.levels ?? []).map((x) => x.data).filter(Boolean)].reduce((s, lv) => s + (lv as LevelContent).rooms.filter((r) => r.type !== "couloir").length, 0);
    const f = (x: number) => x.toFixed(1).replace(".0", "").replace(".", lang === "en" ? "." : ",");
    const notes = [
      T(lang, `${Math.round(livingArea(project))} m² habitables`, `${Math.round(livingArea(project))} m² living space`),
      T(lang, `${rooms} pièces`, `${rooms} rooms`),
      T(lang, `${f(planW)} × ${f(planD)} m au sol`, `${f(planW)} × ${f(planD)} m footprint`),
      levels === 2 ? T(lang, "à étage", "two storeys") : T(lang, "plain-pied", "single storey"),
      ...(l.mitoyen ? [T(lang, "mitoyenne (sans recul sur les côtés)", "semi-detached (no side setback)")] : []),
      ...(switched ? [T(lang, "tout ne tenait pas de plain-pied", "it did not all fit on one level")] : []),
      ...(tooSmall ? [T(lang, "terrain un peu petit : la maison déborde des reculs", "plot a bit small: the house goes past the setbacks")] : []),
    ];
    return { project, title: T(lang, title[0], title[1]), summary: notes.join(" · ") };
  });
}

/* ---------- vérification d'un plan ---------- */

const RANGE: Partial<Record<RoomType, [number, number, number]>> = {
  // surface mini, surface maxi, plus petit côté (m)
  chambre: [8.5, 22, 2.6],
  salle_de_bain: [3.2, 10, 1.5],
  wc: [1.2, 6.5, 1.0],
  cuisine: [6, 20, 2.3],
  salon: [6, 60, 2.3],
  salle_a_manger: [7, 25, 2.5],
  bureau: [6, 16, 2.3],
  couloir: [1, 40, 1.0],
  garage: [15, 30, 2.9],
  terrasse: [4, 40, 2.0],
  autre: [1.5, 16, 1.3],
};
const NEEDS_WINDOW: RoomType[] = ["chambre", "salon", "cuisine", "bureau", "salle_a_manger", "salle_de_bain"];

/** Problèmes d'un plan (liste vide si tout va bien) : emprise, chevauchements, portes, fenêtres, surfaces, escalier. */
export function checkPlan(p: Project, brief?: IdeaBrief): string[] {
  const out: string[] = [];
  const lvs: LevelContent[] = [p, ...(p.levels ?? []).slice(1).map((l) => l.data!).filter(Boolean)];
  const box = (pts: Pt[]) => ({ x0: Math.min(...pts.map((q) => q.x)), x1: Math.max(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), y1: Math.max(...pts.map((q) => q.y)) });
  lvs.forEach((lv, li) => {
    const tag = lvs.length > 1 ? `[niveau ${li}] ` : "";
    const full = lv.walls.filter((w) => w.height > 1.5);
    const fp = box(full.flatMap((w) => [w.a, w.b]));
    // pièces dans l'emprise, sans chevauchement, surfaces et dimensions
    lv.rooms.forEach((r, i) => {
      const b = box(r.points);
      const a = Math.abs(polygonArea(r.points));
      if (r.type !== "terrasse" && (b.x0 < fp.x0 - EPS || b.x1 > fp.x1 + EPS || b.y0 < fp.y0 - EPS || b.y1 > fp.y1 + EPS)) out.push(`${tag}${r.name} sort de l'emprise`);
      const rg = RANGE[r.type];
      if (rg && (a < rg[0] || a > rg[1])) out.push(`${tag}${r.name} : ${a.toFixed(1)} m² (attendu ${rg[0]}–${rg[1]})`);
      if (rg && Math.min(b.x1 - b.x0, b.y1 - b.y0) < rg[2]) out.push(`${tag}${r.name} trop étroite (${Math.min(b.x1 - b.x0, b.y1 - b.y0).toFixed(2)} m)`);
      lv.rooms.slice(i + 1).forEach((q) => {
        const c = box(q.points);
        const ox = Math.min(b.x1, c.x1) - Math.max(b.x0, c.x0);
        const oy = Math.min(b.y1, c.y1) - Math.max(b.y0, c.y0);
        if (ox > 0.01 && oy > 0.01) out.push(`${tag}${r.name} chevauche ${q.name}`);
      });
    });
    // ouvertures : sur le mur, sans se chevaucher, pas dans un muret
    const byWall = new Map<string, Opening[]>();
    for (const o of lv.openings) {
      const w = lv.walls.find((x) => x.id === o.wallId);
      if (!w) {
        out.push(`${tag}ouverture ${o.id} sans mur`);
        continue;
      }
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (o.t - o.width / 2 < 0.2 || o.t + o.width / 2 > L - 0.2) out.push(`${tag}ouverture ${o.id} trop près d'un angle`);
      if (w.height < 1.5) out.push(`${tag}ouverture ${o.id} dans un muret`);
      byWall.set(w.id, [...(byWall.get(w.id) ?? []), o]);
    }
    for (const list of byWall.values()) {
      list.sort((a, b) => a.t - b.t);
      for (let i = 1; i < list.length; i++) if (list[i].t - list[i].width / 2 < list[i - 1].t + list[i - 1].width / 2 + 0.1) out.push(`${tag}ouvertures ${list[i - 1].id} et ${list[i].id} se chevauchent`);
    }
    // portes : chaque pièce est desservie, et on y arrive depuis l'entrée (ou depuis l'escalier, à l'étage)
    const adj = new Map<string, Set<string>>();
    const edge = (a: string, b: string) => {
      adj.set(a, (adj.get(a) ?? new Set()).add(b));
      adj.set(b, (adj.get(b) ?? new Set()).add(a));
    };
    const windows = new Set<string>();
    for (const o of lv.openings) {
      const s = openingSides(o, lv.walls, lv.rooms);
      if (!s) continue;
      const a = s.r1?.id ?? "dehors";
      const b = s.r2?.id ?? "dehors";
      if (o.kind === "window") {
        if (a === "dehors" && s.r2) windows.add(s.r2.id);
        if (b === "dehors" && s.r1) windows.add(s.r1.id);
        // une fenêtre qui donne sur la terrasse donne aussi dehors
        if (s.r1?.type === "terrasse" && s.r2) windows.add(s.r2.id);
        if (s.r2?.type === "terrasse" && s.r1) windows.add(s.r1.id);
      } else {
        edge(a, b);
        if (o.kind === "baie") {
          if (s.r1 && s.r2?.type === "terrasse") windows.add(s.r1.id);
          if (s.r2 && s.r1?.type === "terrasse") windows.add(s.r2.id);
        }
      }
    }
    // la terrasse s'ouvre sur le jardin (muret percé)
    for (const r of lv.rooms) if (r.type === "terrasse") edge(r.id, "dehors");
    const below = li > 0 ? houseFlights(lvs[li - 1]) : [];
    const start = li === 0 ? "dehors" : lv.rooms.find((r) => below.some((fl) => pointInPolygon(fl.top, r.points)))?.id;
    if (li > 0 && !start) out.push(`${tag}l'escalier n'arrive dans aucune pièce`);
    const seen = new Set<string>(start ? [start] : []);
    const queue = start ? [start] : [];
    while (queue.length)
      for (const x of adj.get(queue.shift()!) ?? [])
        if (!seen.has(x)) {
          seen.add(x);
          queue.push(x);
        }
    for (const r of lv.rooms) {
      if (!adj.has(r.id)) out.push(`${tag}${r.name} n'a pas de porte`);
      else if (!seen.has(r.id)) out.push(`${tag}${r.name} est inaccessible`);
      if (NEEDS_WINDOW.includes(r.type) && !windows.has(r.id)) out.push(`${tag}${r.name} n'a pas de fenêtre`);
    }
    // l'escalier : la volée tient dans sa pièce, et sa trémie tombe entièrement dans une seule pièce de l'étage
    if (li < lvs.length - 1)
      for (const fl of houseFlights(lv)) {
        const host = lv.rooms.find((r) => r.stairs);
        if (host && !fl.corners.every((q) => pointInPolygon(q, host.points))) out.push(`${tag}la volée dépasse de ${host.name}`);
        const up = lvs[li + 1].rooms.find((r) => pointInPolygon(fl.top, r.points));
        if (!up || !fl.corners.every((q) => pointInPolygon(q, up.points))) out.push(`${tag}la trémie déborde de la pièce du dessus`);
        else if (up.type !== "couloir") out.push(`${tag}l'escalier arrive dans ${up.name}`);
      }
  });
  if (brief) {
    const fp = box(p.walls.filter((w) => w.height > 1.5).flatMap((w) => [w.a, w.b]));
    if (fp.x1 - fp.x0 > brief.plotW + EPS) out.push(`maison plus large que le terrain (${(fp.x1 - fp.x0).toFixed(1)} > ${brief.plotW} m)`);
    if (fp.y1 - fp.y0 > brief.plotD - SETBACK.front - SETBACK.back + EPS) out.push(`maison trop profonde pour le terrain (${(fp.y1 - fp.y0).toFixed(1)} m)`);
  }
  return out;
}

const houseFlights = (lv: LevelContent) => lv.rooms.filter((r) => r.stairs).map((r) => flightOf(r.stairs!));
