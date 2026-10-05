import DxfParser from "dxf-parser";
import type { Opening, OpeningKind, Pt, Wall } from "./types";
import { dist } from "./geometry";
import { wallsFromLines } from "./linework";

/* Import DXF (AutoCAD, ArchiCAD, Revit… exportent tous en DXF).
   1. on lit les traits (LINE, LWPOLYLINE, POLYLINE) des calques de murs s'ils sont nommés ainsi ;
   2. les murs sont dessinés en double trait : on apparie les traits parallèles proches → axe + épaisseur ;
   3. deux murs alignés séparés d'un vide → un mur avec une ouverture (porte si un arc d'ouverture est dessiné à côté). */

interface Seg { a: Pt; b: Pt; layer: string }


const WALL_LAYER = /mur|wall|cloison|ma[cç]onn|a-wall|voile/i;
const DOOR_BLOCK = /porte|door|^p\d|battant/i;
const WINDOW_BLOCK = /fen[eê]tre|window|chassis|châssis|baie|^f\d/i;
const UNIT: Record<number, number> = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 };

export interface DxfResult {
  walls: Wall[];
  openings: Opening[];
  texts: { p: Pt; text: string }[]; // noms de pièces éventuels
  report: { segments: number; layers: string[]; wallLayers: string[]; unit: string; paired: number; openings: number };
}

export function importDxf(text: string, height = 2.8): DxfResult {
  const parser = new DxfParser();
  const dxf = parser.parseSync(text);
  if (!dxf) throw new Error("Fichier DXF illisible.");

  const segs: Seg[] = [];
  const arcs: { c: Pt; r: number }[] = [];
  const inserts: { p: Pt; name: string }[] = [];
  const texts: { p: Pt; text: string }[] = [];
  for (const e of dxf.entities as unknown as Record<string, unknown>[]) {
    const layer = String(e.layer ?? "");
    const type = e.type as string;
    if (type === "LINE") {
      const v = e.vertices as { x: number; y: number }[];
      segs.push({ a: { x: v[0].x, y: v[0].y }, b: { x: v[1].x, y: v[1].y }, layer });
    } else if (type === "LWPOLYLINE" || type === "POLYLINE") {
      const v = (e.vertices as { x: number; y: number }[]) ?? [];
      for (let i = 0; i < v.length - 1; i++) segs.push({ a: v[i], b: v[i + 1], layer });
      if ((e.shape || e.closed) && v.length > 2) segs.push({ a: v[v.length - 1], b: v[0], layer });
    } else if (type === "TEXT" || type === "MTEXT") {
      const p = (e.startPoint ?? e.position) as { x: number; y: number } | undefined;
      const raw = String(e.text ?? "");
      // MTEXT : on retire les codes de mise en forme ({\fArial|b0;…}, \P…)
      const text = raw.replace(/\\P/g, " ").replace(/\{\\[^;{}]*;|[{}]/g, "").replace(/\\[A-Za-z][^;\\]*;/g, "").replace(/\s+/g, " ").trim();
      if (p && text) texts.push({ p: { x: p.x, y: p.y }, text });
    } else if (type === "INSERT") {
      const p = e.position as { x: number; y: number } | undefined;
      if (p) inserts.push({ p: { x: p.x, y: p.y }, name: String(e.name ?? "") });
    } else if (type === "ARC") {
      const c = e.center as { x: number; y: number };
      arcs.push({ c: { x: c.x, y: c.y }, r: e.radius as number });
    }
  }
  if (!segs.length) throw new Error("Aucun trait trouvé dans ce DXF.");

  // unité : en-tête $INSUNITS, sinon déduite de l'étendue du dessin
  const ext = segs.reduce((m, s) => Math.max(m, Math.abs(s.a.x), Math.abs(s.a.y), Math.abs(s.b.x), Math.abs(s.b.y)), 0);
  const insunits = Number((dxf.header as Record<string, unknown>)?.$INSUNITS ?? 0);
  const k = UNIT[insunits] ?? (ext > 2000 ? 0.001 : ext > 200 ? 0.01 : 1);
  const unit = k === 0.001 ? "mm" : k === 0.01 ? "cm" : k === 1 ? "m" : "pouces/pieds";

  const layers = [...new Set(segs.map((s) => s.layer))];
  const wallLayers = layers.filter((l) => WALL_LAYER.test(l));
  const used = (wallLayers.length ? segs.filter((s) => wallLayers.includes(s.layer)) : segs)
    .map((s) => ({ a: { x: s.a.x * k, y: -s.a.y * k }, b: { x: s.b.x * k, y: -s.b.y * k }, layer: s.layer })) // y vers le bas
    .filter((s) => dist(s.a, s.b) > 0.05);
  const arcsM = arcs.map((a) => ({ c: { x: a.c.x * k, y: -a.c.y * k }, r: a.r * k }));
  const insertsM = inserts.map((b) => ({ p: { x: b.p.x * k, y: -b.p.y * k }, name: b.name }));

  const classify = (center: Pt, gap: number): OpeningKind => {
    const hasArc = arcsM.some((a) => dist(a.c, center) < gap + 0.3 && a.r > gap * 0.5 && a.r < gap * 1.3);
    // bloc inséré à côté (porte / fenêtre de bibliothèque CAO) : son nom fait foi
    const block = insertsM.find((x) => dist(x.p, center) < gap / 2 + 0.6);
    if (block && DOOR_BLOCK.test(block.name)) return "door";
    if (block && WINDOW_BLOCK.test(block.name)) return gap >= 2 ? "baie" : "window";
    return hasArc ? "door" : gap >= 2 ? "baie" : "window";
  };
  const res = wallsFromLines(used, height, classify);
  let walls = res.walls;
  const { openings, paired } = res;

  // recadrage : le dessin commence à (1, 1)
  const xs = walls.flatMap((w) => [w.a.x, w.b.x]);
  const ys = walls.flatMap((w) => [w.a.y, w.b.y]);
  const ox = Math.min(...xs) - 1;
  const oy = Math.min(...ys) - 1;
  const shift = (p: Pt) => ({ x: Math.round((p.x - ox) * 1000) / 1000, y: Math.round((p.y - oy) * 1000) / 1000 });
  walls = walls.map((w) => ({ ...w, a: shift(w.a), b: shift(w.b) }));
  const textsM = texts.map((t) => ({ p: shift({ x: t.p.x * k, y: -t.p.y * k }), text: t.text }));

  return {
    walls,
    openings,
    texts: textsM,
    report: { segments: used.length, layers, wallLayers, unit, paired, openings: openings.length },
  };
}
