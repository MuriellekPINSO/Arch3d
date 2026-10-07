"use client";
/* La maison en 3D, générée à partir du plan : murs découpés autour des ouvertures, sols texturés,
   portes et fenêtres, plafonds (en visite) et mobilier ; un groupe par niveau, posé à son altitude.
   Repère : x = x du plan, z = y du plan. */
import { useEffect, useMemo } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import type { Background, Opening, Pt, Room, Wall } from "@/lib/types";
import {
  add, mul, offsetPolygon, perp, pointAtWall, pointInPolygon, roomAnchor, roomAt, wallDir, wallLength, wallPieces,
} from "@/lib/geometry";
import { floorFor, styleById, type InteriorStyle } from "@/lib/styles";
import { floorTexture } from "@/lib/textures";
import type { Furniture } from "@/lib/furnish";
import { SLAB, type Flight, type HouseLevel } from "@/lib/levels";
import Furniture3D from "./Furniture3D";
import { During, Grow, LEVEL_TIME } from "./build";

export interface HouseOptions {
  /** niveau dont les murs sont coupés à 1,1 m (vue maquette), null = aucun */
  cutLevel: number | null;
  /** niveaux affichés : du rez-de-chaussée à celui-ci */
  showUpTo: number;
  ceilings: boolean;
  /** dessin du plan plaqué au sol (meubles dessinés, jardin…) */
  planGround: boolean;
  /** design d'espace : niveau dont on touche les meubles et les sols */
  designLevel?: number;
  selectedId?: string | null;
  /** design d'espace : appui sur un meuble (sélection / déplacement) */
  onFurnitureDown?: (f: Furniture, e: ThreeEvent<PointerEvent>) => void;
  /** toit-terrasse avec acrotère sur les murs extérieurs (vue façade réaliste) */
  roof?: boolean;
  /** clic sur le sol : pièce choisie (ou null hors pièce) */
  onFloorClick?: (roomId: string | null) => void;
}

const angleOf = (w: Wall) => -Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x);

const ROOF = "#d9d4ca";
const OPEN_AIR = new Set(["terrasse"]); // pièces sans toit

/** Une pièce est couverte par le niveau du dessus si son cœur est sous une de ses pièces. */
const covered = (p: Pt, above: Room[] | null) => !!above?.some((r) => pointInPolygon(p, r.points));

function WallMesh({
  w,
  openings,
  rooms,
  style,
  cutaway,
  roof,
  slab,
  above,
}: {
  w: Wall;
  openings: Opening[];
  rooms: Room[];
  style: InteriorStyle;
  cutaway: boolean;
  roof?: boolean;
  slab: number; // le mur monte jusque sous le plancher du niveau du dessus
  above: Room[] | null;
}) {
  const L = wallLength(w);
  const dir = wallDir(w);
  const n = perp(dir);
  const mid = pointAtWall(w, L / 2);
  // face extérieure : celle qui ne donne sur aucune pièce
  const off = w.thickness / 2 + 0.3;
  const sidePlus = roomAt(add(mid, mul(n, off)), rooms);
  const sideMinus = roomAt(add(mid, mul(n, -off)), rooms);
  // en local, la face +z de la boîte regarde le côté +n du plan (rotation de -angle autour de y)
  const zPlusIsOutside = !sidePlus && !!sideMinus;
  const zMinusIsOutside = !sideMinus && !!sidePlus;
  // chaque face prend la peinture de la pièce qu'elle regarde (finition choisie, sinon celle du style)
  const plusColor = zPlusIsOutside ? null : (sidePlus?.finish?.wall ?? style.wall);
  const minusColor = zMinusIsOutside ? null : (sideMinus?.finish?.wall ?? style.wall);
  // acrotère : les murs de façade dépassent du toit de 60 cm (sauf sous un étage)
  const exterior = zPlusIsOutside || zMinusIsOutside;
  const inward = mul(n, zPlusIsOutside ? -0.5 : 0.5);
  const parapet = roof && exterior && w.height > 2 && !covered(add(mid, inward), above); // pas sur un garde-corps

  const mats = useMemo(() => {
    const inner = new THREE.MeshStandardMaterial({ color: style.wall, roughness: 0.9 });
    const outer = new THREE.MeshStandardMaterial({ color: style.exterior, roughness: 0.95 });
    const top = new THREE.MeshStandardMaterial({ color: roof ? ROOF : "#2b2b2b", roughness: 1 });
    const face = (c: string | null) => (c ? new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }) : outer);
    return [inner, inner, top, inner, face(plusColor), face(minusColor)];
  }, [style.wall, style.exterior, plusColor, minusColor, roof]);

  const maxH = cutaway ? Math.min(1.1, w.height) : parapet ? w.height + 0.2 + 0.6 : w.height + slab;
  const pieces = wallPieces(w, openings)
    .map((p) => ({ ...p, y1: p.y1 >= w.height - 1e-3 ? maxH : Math.min(p.y1, maxH) }))
    .filter((p) => p.y1 - p.y0 > 0.01);
  // prolongement aux extrémités pour fermer les angles
  const ext = w.thickness / 2;
  return (
    <group position={[w.a.x, 0, w.a.y]} rotation-y={angleOf(w)}>
      {pieces.map((p, i) => {
        const s = p.s <= 0.001 ? p.s - ext : p.s;
        const e = p.e >= L - 0.001 ? p.e + ext : p.e;
        return (
          <mesh key={i} position={[(s + e) / 2, (p.y0 + p.y1) / 2, 0]} material={mats} castShadow receiveShadow>
            <boxGeometry args={[e - s, p.y1 - p.y0, w.thickness]} />
          </mesh>
        );
      })}
    </group>
  );
}

function OpeningMesh({ o, w, style, cutaway }: { o: Opening; w: Wall; style: InteriorStyle; cutaway: boolean }) {
  const frame = { color: style.id === "minimaliste" ? "#2d2d2d" : "#f2efe8", roughness: 0.5 };
  const glass = <meshStandardMaterial color="#cfe6f2" transparent opacity={0.28} roughness={0.05} metalness={0.1} />;
  const fw = 0.05;
  const top = o.sill + o.height;
  if (cutaway && o.sill >= 1.1) return null;
  const h = cutaway ? Math.min(top, 1.1) - o.sill : o.height;
  return (
    <group position={[w.a.x, 0, w.a.y]} rotation-y={angleOf(w)}>
      <group position={[o.t, o.sill, 0]}>
        {/* encadrement */}
        {[-1, 1].map((k) => (
          <mesh key={k} position={[k * (o.width / 2 - fw / 2), h / 2, 0]} castShadow>
            <boxGeometry args={[fw, h, w.thickness + 0.02]} />
            <meshStandardMaterial {...frame} />
          </mesh>
        ))}
        {o.kind === "window" && (
          <>
            {!cutaway && (
              <mesh position={[0, h - fw / 2, 0]}>
                <boxGeometry args={[o.width, fw, w.thickness + 0.02]} />
                <meshStandardMaterial {...frame} />
              </mesh>
            )}
            <mesh position={[0, fw / 2, 0]}>
              <boxGeometry args={[o.width, fw, w.thickness + 0.04]} />
              <meshStandardMaterial {...frame} />
            </mesh>
            <mesh position={[0, h / 2, 0]}>
              <boxGeometry args={[o.width - fw * 2, h - fw, 0.02]} />
              {glass}
            </mesh>
          </>
        )}
        {o.kind === "baie" &&
          [-1, 1].map((k) => (
            <mesh key={k} position={[k * (o.width / 4), h / 2, k * 0.02]}>
              <boxGeometry args={[o.width / 2 - fw, h - fw, 0.02]} />
              {glass}
            </mesh>
          ))}
        {o.kind === "door" && (
          // battant grand ouvert, charnière côté gauche
          <group position={[-o.width / 2 + fw, 0, 0]} rotation-y={-1.5}>
            <mesh position={[(o.width - fw * 2) / 2, h / 2, 0]} castShadow>
              <boxGeometry args={[o.width - fw * 2, h - 0.02, 0.04]} />
              <meshStandardMaterial color={style.id === "afro-chic" ? "#6b4226" : "#e8e2d6"} roughness={0.6} />
            </mesh>
            <mesh position={[o.width - fw * 2 - 0.08, h * 0.48, 0.04]}>
              <boxGeometry args={[0.12, 0.02, 0.03]} />
              <meshStandardMaterial color={style.metal} metalness={0.7} roughness={0.3} />
            </mesh>
          </group>
        )}
      </group>
    </group>
  );
}

/* contour d'une pièce, percé des trémies d'escalier qui la traversent (rentrées d'un cm : un trou ne doit pas toucher le bord) */
function roomShape(room: Room, holes: Flight[]) {
  const shape = new THREE.Shape(room.points.map((p) => new THREE.Vector2(p.x, -p.y)));
  for (const fl of holes) {
    if (!pointInPolygon(fl.center, room.points)) continue;
    const pts = offsetPolygon(fl.corners, -0.01);
    shape.holes.push(new THREE.Path(pts.map((p) => new THREE.Vector2(p.x, -p.y))));
  }
  return shape;
}

function Floor({ room, style, holes, onClick }: { room: Room; style: InteriorStyle; holes: Flight[]; onClick?: (e: ThreeEvent<MouseEvent>) => void }) {
  const f = room.finish?.floor ?? floorFor(style, room.type);
  const geo = useMemo(() => {
    const g = new THREE.ShapeGeometry(roomShape(room, holes));
    g.rotateX(-Math.PI / 2);
    return g;
  }, [room, holes]);
  const map = useMemo(() => floorTexture(f.kind, f.color), [f.kind, f.color]);
  return (
    <mesh geometry={geo} position-y={0.002} receiveShadow onClick={onClick}>
      <meshStandardMaterial map={map} roughness={f.kind === "carrelage" || f.kind === "beton" ? 0.35 : 0.75} />
    </mesh>
  );
}

/** Le dessin du plan plaqué au sol, à l'échelle : on retrouve en 3D tout ce qui est dessiné (meubles, jardin…). */
function PlanGround({ bg, onClick }: { bg: Background; onClick?: (e: ThreeEvent<MouseEvent>) => void }) {
  const tex = useMemo(() => {
    const t = new THREE.TextureLoader().load(bg.src);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [bg.src]);
  useEffect(() => () => tex.dispose(), [tex]);
  const w = bg.widthPx * bg.scale;
  const h = bg.heightPx * bg.scale;
  return (
    <mesh rotation-x={-Math.PI / 2} position={[bg.x + w / 2, 0.003, bg.y + h / 2]} receiveShadow onClick={onClick}>
      <planeGeometry args={[w, h]} />
      <meshStandardMaterial map={tex} roughness={0.95} />
    </mesh>
  );
}

/** Sol d'une pièce d'étage habillé du dessin du plan (à l'étage, le plan entier flotterait au-dessus du vide). */
function PlanFloor({ room, bg, holes, onClick }: { room: Room; bg: Background; holes: Flight[]; onClick?: (e: ThreeEvent<MouseEvent>) => void }) {
  const tex = useMemo(() => {
    const t = new THREE.TextureLoader().load(bg.src);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [bg.src]);
  useEffect(() => () => tex.dispose(), [tex]);
  const geo = useMemo(() => {
    const g = new THREE.ShapeGeometry(roomShape(room, holes));
    // coordonnées de texture d'après la position sur le plan importé
    const W = bg.widthPx * bg.scale;
    const H = bg.heightPx * bg.scale;
    const pos = g.getAttribute("position");
    const uv = g.getAttribute("uv");
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - bg.x) / W, 1 + (pos.getY(i) + bg.y) / H);
    g.rotateX(-Math.PI / 2);
    return g;
  }, [room, holes, bg.x, bg.y, bg.widthPx, bg.heightPx, bg.scale]);
  return (
    <mesh geometry={geo} position-y={0.002} receiveShadow onClick={onClick}>
      <meshStandardMaterial map={tex} roughness={0.95} />
    </mesh>
  );
}

/** Dalle de toit d'une pièce, élargie pour recouvrir le haut des murs ; percée là où l'escalier débouche. */
function RoofSlab({ room, height, holes }: { room: Room; height: number; holes: Flight[] }) {
  const geo = useMemo(() => {
    const pts = offsetPolygon(room.points, 0.14);
    const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.y)));
    for (const fl of holes) {
      if (!pointInPolygon(fl.center, room.points)) continue;
      shape.holes.push(new THREE.Path(offsetPolygon(fl.corners, -0.01).map((p) => new THREE.Vector2(p.x, -p.y))));
    }
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: false });
    g.rotateX(-Math.PI / 2); // extrusion vers le haut
    return g;
  }, [room.points, holes]);
  return (
    <mesh geometry={geo} position-y={height} castShadow receiveShadow>
      <meshStandardMaterial color={ROOF} roughness={0.95} />
    </mesh>
  );
}

/** Garde-corps autour de la trémie, sur le toit-terrasse : on y arrive par le haut de la volée, les trois autres côtés
    sont fermés. */
function RoofRail({ fl, y }: { fl: Flight; y: number }) {
  const H = 1.0;
  const sides: [Pt, Pt][] = [
    [fl.corners[0], fl.corners[1]],
    [fl.corners[3], fl.corners[2]],
    [fl.corners[0], fl.corners[3]], // côté du départ de la volée
  ];
  const metal = <meshStandardMaterial color="#3a3a3a" metalness={0.6} roughness={0.4} />;
  return (
    <group position-y={y}>
      {sides.map(([a, b], k) => {
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        const n = Math.max(2, Math.round(L / 0.9) + 1);
        const ang = -Math.atan2(b.y - a.y, b.x - a.x);
        return (
          <group key={k} position={[a.x, 0, a.y]} rotation-y={ang}>
            <mesh position={[L / 2, H, 0]}>
              <boxGeometry args={[L + 0.04, 0.04, 0.04]} />
              {metal}
            </mesh>
            {Array.from({ length: n }, (_, i) => (
              <mesh key={i} position={[(L * i) / (n - 1), H / 2, 0]}>
                <boxGeometry args={[0.035, H, 0.035]} />
                {metal}
              </mesh>
            ))}
          </group>
        );
      })}
    </group>
  );
}

function Ceiling({ room, height, holes }: { room: Room; height: number; holes: Flight[] }) {
  const geo = useMemo(() => {
    const g = new THREE.ShapeGeometry(roomShape(room, holes));
    g.rotateX(Math.PI / 2); // face vers le bas
    g.scale(1, 1, -1);
    return g;
  }, [room, holes]);
  const c = roomAnchor(room);
  return (
    <group>
      <mesh geometry={geo} position-y={height - 0.001}>
        <meshStandardMaterial color="#fbfaf7" roughness={1} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[c.x, height - 0.03, c.y]}>
        <cylinderGeometry args={[0.18, 0.18, 0.04, 24]} />
        <meshStandardMaterial color="#fff6e0" emissive="#ffe7b5" emissiveIntensity={1.2} />
      </mesh>
      <pointLight position={[c.x, height - 0.3, c.y]} intensity={3.2} distance={9} decay={1.6} color="#fff1d6" />
    </group>
  );
}

/* ordre d'apparition des murs : en balayant autour du centre de la maison */
function sweepOrder(walls: Wall[]) {
  if (!walls.length) return new Map<string, number>();
  const cx = walls.reduce((s, w) => s + w.a.x + w.b.x, 0) / (walls.length * 2);
  const cy = walls.reduce((s, w) => s + w.a.y + w.b.y, 0) / (walls.length * 2);
  const ang = (w: Wall) => Math.atan2((w.a.y + w.b.y) / 2 - cy, (w.a.x + w.b.x) / 2 - cx);
  const sorted = [...walls].sort((a, b) => ang(a) - ang(b));
  return new Map(sorted.map((w, i) => [w.id, i / Math.max(1, walls.length - 1)]));
}

function LevelMesh({
  level: L,
  above,
  below,
  style,
  options,
}: {
  level: HouseLevel;
  above: HouseLevel | null;
  below: HouseLevel | null;
  style: InteriorStyle;
  options: HouseOptions;
}) {
  const { walls, openings, rooms, background } = L;
  const i = L.index;
  const cutaway = options.cutLevel === i;
  const design = options.designLevel === i;
  const t0 = i * LEVEL_TIME; // début de la construction de ce niveau
  const order = useMemo(() => sweepOrder(walls), [walls]);
  const center = useMemo<[number, number, number]>(() => {
    const pts = walls.flatMap((w) => [w.a, w.b]);
    return pts.length ? [pts.reduce((s, q) => s + q.x, 0) / pts.length, 0, pts.reduce((s, q) => s + q.y, 0) / pts.length] : [0, 0, 0];
  }, [walls]);
  const holesBelow = below?.flights ?? []; // trémies : l'escalier du dessous arrive ici
  const holesHere = L.flights; // l'escalier monte : trémie dans le plafond (vers l'étage ou le toit-terrasse)
  const aboveRooms = above?.rooms ?? null;
  const floorClick =
    design && options.onFloorClick
      ? (e: ThreeEvent<MouseEvent>) => {
          if (e.delta > 4) return; // c'était un glisser (rotation de la vue)
          options.onFloorClick!(roomAt({ x: e.point.x, y: e.point.z }, rooms)?.id ?? null);
        }
      : undefined;
  const plan = options.planGround && background;
  // au rez-de-chaussée, les sols arrivent une fois les murs montés (on part du plan) ; à l'étage, le plancher d'abord
  const floorsAt = i === 0 ? t0 + 2.2 : t0;

  return (
    <group>
      {i === 0 && background && (
        <During until={floorsAt + 0.3}>
          <PlanGround bg={background} />
        </During>
      )}
      <Grow at={floorsAt} dur={0.5} mode="pop" pivot={center}>
        {plan && i === 0 ? (
          <PlanGround bg={background} onClick={floorClick} />
        ) : (
          rooms.map((r) =>
            plan ? (
              <PlanFloor key={r.id} room={r} bg={background} holes={holesBelow} onClick={floorClick} />
            ) : (
              <Floor key={r.id} room={r} style={style} holes={holesBelow} onClick={floorClick} />
            ),
          )
        )}
      </Grow>
      {walls.map((w) => (
        <Grow key={w.id} at={t0 + 0.2 + (order.get(w.id) ?? 0) * 1.5} dur={0.7}>
          <WallMesh w={w} openings={openings} rooms={rooms} style={style} cutaway={cutaway} roof={options.roof} slab={above ? SLAB : 0} above={aboveRooms} />
        </Grow>
      ))}
      {options.roof &&
        rooms
          .filter((r) => !OPEN_AIR.has(r.type) && !covered(roomAnchor(r), aboveRooms))
          .map((r) => <RoofSlab key={`toit-${r.id}`} room={r} height={L.height} holes={above ? [] : L.flights} />)}
      {/* dernier niveau : l'escalier débouche sur le toit-terrasse, protégé par un garde-corps */}
      {options.roof && !above && L.flights.map((fl, k) => <RoofRail key={`garde-${k}`} fl={fl} y={L.height + 0.2} />)}
      {openings.map((o) => {
        const w = walls.find((x) => x.id === o.wallId);
        if (!w) return null;
        const at = pointAtWall(w, o.t);
        return (
          <Grow key={o.id} at={t0 + 1.9 + (order.get(w.id) ?? 0) * 0.4} dur={0.35} mode="pop" pivot={[at.x, o.sill, at.y]}>
            <OpeningMesh o={o} w={w} style={style} cutaway={cutaway} />
          </Grow>
        );
      })}
      {options.ceilings && rooms.map((r) => <Ceiling key={r.id} room={r} height={L.height} holes={holesHere} />)}
      {L.furniture.map((f, k) => (
        <Grow key={f.id} at={t0 + 2.3 + (k / Math.max(1, L.furniture.length)) * 0.7} dur={0.4} mode="pop" pivot={[f.x, 0, f.y]}>
          <Furniture3D
            f={f}
            style={style}
            selected={design && f.id === options.selectedId}
            onPointerDown={design && options.onFurnitureDown ? (e) => options.onFurnitureDown!(f, e) : undefined}
          />
        </Grow>
      ))}
    </group>
  );
}

export default function House3D({ styleId, levels, options }: { styleId: string; levels: HouseLevel[]; options: HouseOptions }) {
  const style = styleById(styleId);
  const b = useMemo(() => {
    const xs = levels.flatMap((l) => l.walls.flatMap((w) => [w.a.x, w.b.x]));
    const ys = levels.flatMap((l) => l.walls.flatMap((w) => [w.a.y, w.b.y]));
    return xs.length ? { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } : { x0: 0, x1: 10, y0: 0, y1: 10 };
  }, [levels]);
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;

  return (
    <group>
      {/* terrain et dalle */}
      <mesh rotation-x={-Math.PI / 2} position={[cx, -0.02, cy]} receiveShadow>
        <circleGeometry args={[Math.max(b.x1 - b.x0, b.y1 - b.y0) * 1.6 + 12, 64]} />
        <meshStandardMaterial color="#c9c09f" roughness={1} />
      </mesh>
      <mesh position={[cx, -0.01, cy]} receiveShadow>
        <boxGeometry args={[b.x1 - b.x0 + 1.2, 0.02, b.y1 - b.y0 + 1.2]} />
        <meshStandardMaterial color="#d8d2c4" roughness={0.9} />
      </mesh>
      {/* niveaux au-dessus de celui qu'on regarde : cachés mais gardés (pas de reconstruction à chaque changement) */}
      {levels.map((L, i) => (
        <group key={i} position-y={L.z} visible={i <= options.showUpTo}>
          <LevelMesh level={L} above={levels[i + 1] ?? null} below={levels[i - 1] ?? null} style={style} options={options} />
        </group>
      ))}
    </group>
  );
}
