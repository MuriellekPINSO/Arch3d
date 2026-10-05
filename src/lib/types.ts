/* Modèle d'un projet : tout est en mètres, repère du plan (x vers la droite, y vers le bas).
   En 3D, x reste x et y du plan devient z. */

export interface Pt {
  x: number;
  y: number;
}

export interface Wall {
  id: string;
  a: Pt;
  b: Pt;
  thickness: number;
  height: number;
}

export type OpeningKind = "door" | "window" | "baie" | "passage";

export interface Opening {
  id: string;
  wallId: string;
  kind: OpeningKind;
  t: number; // position du centre le long du mur, en mètres depuis a
  width: number;
  height: number;
  sill: number; // hauteur d'allège (0 pour une porte)
}

export type RoomType =
  | "salon"
  | "chambre"
  | "cuisine"
  | "salle_de_bain"
  | "wc"
  | "salle_a_manger"
  | "bureau"
  | "couloir"
  | "terrasse"
  | "garage"
  | "escalier"
  | "autre";

export type FloorKind = "parquet" | "carrelage" | "beton" | "terre_cuite" | "pierre";

export interface RoomFinish {
  floor?: { kind: FloorKind; color: string }; // revêtement de sol choisi pour cette pièce
  wall?: string; // peinture des murs (côté pièce)
}

export interface Room {
  id: string;
  name: string;
  type: RoomType;
  points: Pt[]; // contour intérieur (sol)
  finish?: RoomFinish;
  /** escalier dessiné sur le plan : position exacte de la volée (centre, longueur w, largeur d, angle) */
  stairs?: { x: number; y: number; w: number; d: number; rot: number };
}

export interface Background {
  src: string; // data URL de l'image du plan
  widthPx: number;
  heightPx: number;
  scale: number; // mètres par pixel
  x: number; // position du coin haut-gauche, en mètres
  y: number;
  opacity: number;
  auto?: boolean; // murs lus automatiquement sur l'image
  calibrated?: boolean; // échelle réglée sur une cote connue (sinon estimée)
}

export interface Project {
  name: string;
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
  background: Background | null;
  styleId: string;
  furnished: boolean;
  /** mobilier placé à la main (design d'espace) ; absent = ameublement automatique */
  furniture?: import("./furnish").Furniture[];
  /** le dessin du plan est plaqué au sol en 3D (meubles dessinés, jardin, voiture…) */
  planFloor?: boolean;
}

export const ROOM_LABELS: Record<RoomType, string> = {
  salon: "Salon",
  chambre: "Chambre",
  cuisine: "Cuisine",
  salle_de_bain: "Salle de bain",
  wc: "WC",
  salle_a_manger: "Salle à manger",
  bureau: "Bureau",
  couloir: "Couloir / entrée",
  terrasse: "Terrasse",
  garage: "Garage",
  escalier: "Escalier",
  autre: "Autre",
};

export const OPENING_DEFAULTS: Record<OpeningKind, { width: number; height: number; sill: number; label: string }> = {
  door: { width: 0.9, height: 2.1, sill: 0, label: "Porte" },
  window: { width: 1.2, height: 1.2, sill: 1.0, label: "Fenêtre" },
  baie: { width: 2.4, height: 2.2, sill: 0, label: "Baie vitrée" },
  passage: { width: 1.4, height: 2.2, sill: 0, label: "Passage" },
};

export const uid = () => Math.random().toString(36).slice(2, 10);
