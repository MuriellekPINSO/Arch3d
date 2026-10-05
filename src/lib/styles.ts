import type { FloorKind, RoomType } from "./types";

/* Styles d'aménagement intérieur : matières du sol, teinte des murs, palette du mobilier. */

export type { FloorKind };

export interface InteriorStyle {
  id: string;
  name: string;
  description: string;
  wall: string; // peinture des murs intérieurs
  exterior: string; // enduit extérieur
  floors: Partial<Record<RoomType, { kind: FloorKind; color: string }>> & { default: { kind: FloorKind; color: string } };
  wood: string; // bois des meubles
  fabric: string; // canapés, lits
  accent: string; // coussins, tapis, objets
  accent2: string;
  metal: string;
}

export const STYLES: InteriorStyle[] = [
  {
    id: "contemporain",
    name: "Contemporain clair",
    description: "Murs blancs, parquet chêne, tissus gris et touches de noir.",
    wall: "#f4f1ea",
    exterior: "#e9e2d4",
    floors: {
      default: { kind: "parquet", color: "#c9a77c" },
      salle_de_bain: { kind: "carrelage", color: "#d9d6d0" },
      cuisine: { kind: "carrelage", color: "#cfcac2" },
      couloir: { kind: "parquet", color: "#c9a77c" },
    },
    wood: "#b58b5e",
    fabric: "#9aa0a6",
    accent: "#2f3437",
    accent2: "#d8c3a5",
    metal: "#1f2326",
  },
  {
    id: "afro-chic",
    name: "Afro-chic",
    description: "Terre cuite, bois sombre, moutarde et indigo, inspirés du wax.",
    wall: "#efe2cf",
    exterior: "#d9b48f",
    floors: {
      default: { kind: "terre_cuite", color: "#b8653f" },
      chambre: { kind: "parquet", color: "#7a4a2b" },
      salle_de_bain: { kind: "carrelage", color: "#e6d8c3" },
    },
    wood: "#5c3a24",
    fabric: "#d39b2a",
    accent: "#27407a",
    accent2: "#c2452d",
    metal: "#3a2a1e",
  },
  {
    id: "minimaliste",
    name: "Minimaliste béton",
    description: "Béton ciré, blanc pur, bois clair : épuré et lumineux.",
    wall: "#fbfbfa",
    exterior: "#d6d6d3",
    floors: { default: { kind: "beton", color: "#b9b7b2" } },
    wood: "#e2cfb3",
    fabric: "#f1efe9",
    accent: "#8d8a83",
    accent2: "#c9c4b9",
    metal: "#55524d",
  },
  {
    id: "tropical",
    name: "Tropical",
    description: "Pierre claire, rotin, verts profonds et beaucoup de plantes.",
    wall: "#f6f3ea",
    exterior: "#efe6d2",
    floors: {
      default: { kind: "pierre", color: "#d8cdb6" },
      chambre: { kind: "parquet", color: "#a77b4f" },
    },
    wood: "#c69a62",
    fabric: "#e8e1cf",
    accent: "#2f6b4f",
    accent2: "#e3a857",
    metal: "#4a4a42",
  },
];

export const styleById = (id: string) => STYLES.find((s) => s.id === id) ?? STYLES[0];

export const floorFor = (s: InteriorStyle, type: RoomType) =>
  s.floors[type] ?? (type === "garage" ? { kind: "beton" as const, color: "#b8b3aa" } : s.floors.default);
