import type { Opening, OpeningKind, Project, Room, RoomType, Wall } from "./types";
import { OPENING_DEFAULTS } from "./types";
import { useLang } from "./i18n";

/* Villa d'exemple, 14 × 10 m : 3 chambres, salle de bain, couloir, séjour, cuisine. */

const EXT = 0.25;
const INT = 0.15;
const H = 2.8;

const wall = (id: string, ax: number, ay: number, bx: number, by: number, thickness = INT): Wall => ({
  id,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  thickness,
  height: H,
});

const op = (id: string, wallId: string, kind: OpeningKind, t: number, over: Partial<Opening> = {}): Opening => {
  const { width, height, sill } = OPENING_DEFAULTS[kind];
  return { id, wallId, kind, t, width, height, sill, ...over };
};

const rect = (id: string, name: string, type: RoomType, x0: number, y0: number, x1: number, y1: number): Room => ({
  id,
  name,
  type,
  points: [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ],
});

const e = EXT / 2;
const i = INT / 2;

export const SAMPLE_PROJECT: Project = {
  name: "Villa d'exemple — Fidjrossè",
  styleId: "contemporain",
  furnished: true,
  background: null,
  walls: [
    wall("w-top", 0, 0, 14, 0, EXT),
    wall("w-right", 14, 0, 14, 10, EXT),
    wall("w-bottom", 14, 10, 0, 10, EXT),
    wall("w-left", 0, 10, 0, 0, EXT),
    wall("w-nuit", 0, 4, 14, 4),
    wall("w-jour", 0, 5.4, 14, 5.4),
    wall("w-ch1", 4, 0, 4, 4),
    wall("w-sdb", 6.2, 0, 6.2, 4),
    wall("w-ch2", 10, 0, 10, 4),
    wall("w-cuisine", 9, 5.4, 9, 10),
  ],
  openings: [
    op("o-entree", "w-bottom", "door", 9.5, { width: 1.0 }),
    op("o-sejour-couloir", "w-jour", "passage", 6.4, { width: 1.6 }),
    op("o-cuisine-couloir", "w-jour", "door", 11.5),
    op("o-sejour-cuisine", "w-cuisine", "passage", 2.3, { width: 1.2 }),
    op("o-ch1", "w-nuit", "door", 2.0),
    op("o-sdb", "w-nuit", "door", 5.1, { width: 0.8 }),
    op("o-ch2", "w-nuit", "door", 8.0),
    op("o-parent", "w-nuit", "door", 11.0),
    op("f-ch1", "w-top", "window", 2.0, { width: 1.4 }),
    op("f-ch1b", "w-left", "window", 8.0),
    op("f-sdb", "w-top", "window", 5.1, { width: 0.6, height: 0.6, sill: 1.5 }),
    op("f-ch2", "w-top", "window", 8.1, { width: 1.4 }),
    op("f-parent", "w-top", "window", 12.0, { width: 1.6 }),
    op("f-parent-b", "w-right", "window", 2.0),
    op("f-salon-baie", "w-bottom", "baie", 12.0, { width: 2.6 }),
    op("f-salon", "w-left", "window", 2.4, { width: 1.6 }),
    op("f-cuisine", "w-right", "window", 7.7, { width: 1.4, sill: 1.1, height: 1.0 }),
    op("f-cuisine-b", "w-bottom", "window", 2.5),
  ],
  rooms: [
    rect("r-ch1", "Chambre 1", "chambre", e, e, 4 - i, 4 - i),
    rect("r-sdb", "Salle de bain", "salle_de_bain", 4 + i, e, 6.2 - i, 4 - i),
    rect("r-ch2", "Chambre 2", "chambre", 6.2 + i, e, 10 - i, 4 - i),
    rect("r-parent", "Chambre parentale", "chambre", 10 + i, e, 14 - e, 4 - i),
    rect("r-couloir", "Couloir", "couloir", e, 4 + i, 14 - e, 5.4 - i),
    rect("r-sejour", "Séjour", "salon", e, 5.4 + i, 9 - i, 10 - e),
    rect("r-cuisine", "Cuisine", "cuisine", 9 + i, 5.4 + i, 14 - e, 10 - e),
  ],
};

/* Duplex d'exemple : la villa, avec un escalier dans le séjour et un étage (2 chambres, salle d'eau, bureau,
   mezzanine au-dessus du séjour, terrasse au-dessus de la cuisine). */

const G = 1.1; // garde-corps de la terrasse
const poly = (id: string, name: string, type: RoomType, pts: [number, number][]): Room => ({
  id,
  name,
  type,
  points: pts.map(([x, y]) => ({ x, y })),
});

export const SAMPLE_DUPLEX: Project = {
  ...SAMPLE_PROJECT,
  name: "Duplex d'exemple — Fidjrossè",
  rooms: SAMPLE_PROJECT.rooms.map((r) =>
    // volée droite le long du mur du couloir, qui monte vers l'est
    r.id === "r-sejour" ? { ...r, stairs: { x: 2.6, y: 5.4 + i + 0.5, w: 4.2, d: 1.0, rot: 0 } } : r,
  ),
  level: 0,
  levels: [
    { name: "Rez-de-chaussée" },
    {
      name: "Étage",
      data: {
        background: null,
        walls: [
          wall("u-top", 0, 0, 14, 0, EXT),
          wall("u-right", 14, 0, 14, 6, EXT),
          wall("u-bottom", 8, 10, 0, 10, EXT),
          wall("u-left", 0, 10, 0, 0, EXT),
          { ...wall("u-garde-e", 14, 6, 14, 10, EXT), height: G },
          { ...wall("u-garde-s", 14, 10, 8, 10, EXT), height: G },
          wall("u-nuit", 0, 4, 14, 4),
          wall("u-ch3", 4.5, 0, 4.5, 4),
          wall("u-ch4", 9, 0, 9, 4),
          wall("u-sde", 11.5, 0, 11.5, 4),
          wall("u-terrasse-o", 8, 6, 8, 10, 0.2),
          wall("u-terrasse-n", 8, 6, 14, 6, 0.2),
        ],
        openings: [
          op("uo-ch3", "u-nuit", "door", 2.2),
          op("uo-ch4", "u-nuit", "door", 6.8),
          op("uo-sde", "u-nuit", "door", 10.2, { width: 0.8 }),
          op("uo-bureau", "u-nuit", "door", 12.7),
          op("uo-terrasse", "u-terrasse-o", "baie", 2.0, { width: 2.4 }),
          op("uf-ch3", "u-top", "window", 2.2, { width: 1.4 }),
          op("uf-ch4", "u-top", "window", 6.8, { width: 1.4 }),
          op("uf-sde", "u-top", "window", 10.2, { width: 0.6, height: 0.6, sill: 1.5 }),
          op("uf-bureau", "u-top", "window", 12.7),
          op("uf-bureau-b", "u-right", "window", 2.0),
          op("uf-ch3-b", "u-left", "window", 8.0),
          op("uf-mezz", "u-left", "window", 2.0, { width: 1.6 }),
          op("uf-mezz-b", "u-bottom", "window", 4.0, { width: 1.6 }),
        ],
        rooms: [
          rect("u-r-ch3", "Chambre 3", "chambre", e, e, 4.5 - i, 4 - i),
          rect("u-r-ch4", "Chambre 4", "chambre", 4.5 + i, e, 9 - i, 4 - i),
          rect("u-r-sde", "Salle d'eau", "salle_de_bain", 9 + i, e, 11.5 - i, 4 - i),
          rect("u-r-bureau", "Bureau", "bureau", 11.5 + i, e, 14 - e, 4 - i),
          poly("u-r-mezz", "Mezzanine", "salon", [
            [e, 4 + i],
            [14 - e, 4 + i],
            [14 - e, 6 - 0.1],
            [8 - 0.1, 6 - 0.1],
            [8 - 0.1, 10 - e],
            [e, 10 - e],
          ]),
          rect("u-r-terrasse", "Terrasse", "terrasse", 8 + 0.1, 6 + 0.1, 14 - e, 10 - e),
        ],
      },
    },
  ],
};

/* En anglais, les exemples s'ouvrent avec des noms anglais (projet, niveaux, pièces). */
const EN_NAMES: Record<string, string> = {
  "Villa d'exemple — Fidjrossè": "Sample villa, Fidjrossè",
  "Duplex d'exemple — Fidjrossè": "Sample duplex, Fidjrossè",
  "Rez-de-chaussée": "Ground floor",
  "Étage": "Upper floor",
  "Chambre 1": "Bedroom 1",
  "Chambre 2": "Bedroom 2",
  "Chambre 3": "Bedroom 3",
  "Chambre 4": "Bedroom 4",
  "Chambre parentale": "Master bedroom",
  "Salle de bain": "Bathroom",
  "Salle d'eau": "Shower room",
  Couloir: "Hallway",
  Séjour: "Living room",
  Cuisine: "Kitchen",
  Bureau: "Office",
  Mezzanine: "Mezzanine",
  Terrasse: "Terrace",
};

function inLang(p: Project): Project {
  if (useLang.getState().lang !== "en") return p;
  const t = (n: string) => EN_NAMES[n] ?? n;
  const named = (rooms: Room[]) => rooms.map((r) => ({ ...r, name: t(r.name) }));
  return {
    ...p,
    name: t(p.name),
    rooms: named(p.rooms),
    levels: p.levels?.map((l) => ({ ...l, name: t(l.name), ...(l.data ? { data: { ...l.data, rooms: named(l.data.rooms) } } : {}) })),
  };
}

/** Villa d'exemple, nommée dans la langue de l'interface. */
export const sampleProject = (): Project => inLang(SAMPLE_PROJECT);
/** Duplex d'exemple, nommé dans la langue de l'interface. */
export const sampleDuplex = (): Project => inLang(SAMPLE_DUPLEX);
