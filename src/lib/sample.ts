import type { Opening, OpeningKind, Project, Room, RoomType, Wall } from "./types";
import { OPENING_DEFAULTS } from "./types";

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
