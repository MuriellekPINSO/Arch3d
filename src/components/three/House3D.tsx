"use client";
/* La maison en 3D, générée à partir du plan : murs découpés autour des ouvertures, sols texturés,
   portes et fenêtres, plafonds (en visite) et mobilier. Repère : x = x du plan, z = y du plan. */
import { useEffect, useMemo } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import type { Background, Opening, Project, Room, Wall } from "@/lib/types";
import { add, mul, offsetPolygon, perp, pointAtWall, roomAnchor, roomAt, wallDir, wallLength, wallPieces } from "@/lib/geometry";
import { floorFor, styleById, type InteriorStyle } from "@/lib/styles";
import { floorTexture } from "@/lib/textures";
import type { Furniture } from "@/lib/furnish";
import Furniture3D from "./Furniture3D";

export interface HouseOptions {
  cutaway: boolean; // murs coupés à 1,1 m (vue maquette)
  ceilings: boolean;
  furniture: Furniture[];
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

function WallMesh({ w, openings, rooms, style, cutaway, roof }: { w: Wall; openings: Opening[]; rooms: Room[]; style: InteriorStyle; cutaway: boolean; roof?: boolean }) {
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
  const mats = useMemo(() => {
    const inner = new THREE.MeshStandardMaterial({ color: style.wall, roughness: 0.9 });
    const outer = new THREE.MeshStandardMaterial({ color: style.exterior, roughness: 0.95 });
    const top = new THREE.MeshStandardMaterial({ color: roof ? ROOF : "#2b2b2b", roughness: 1 });
    const face = (c: string | null) => (c ? new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }) : outer);
    return [inner, inner, top, inner, face(plusColor), face(minusColor)];
  }, [style.wall, style.exterior, plusColor, minusColor, roof]);

  // acrotère : les murs de façade dépassent du toit de 60 cm
  const exterior = zPlusIsOutside || zMinusIsOutside;
  const maxH = cutaway ? Math.min(1.1, w.height) : roof && exterior ? w.height + 0.2 + 0.6 : w.height;
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

function Floor({ room, style, onClick }: { room: Room; style: InteriorStyle; onClick?: (e: ThreeEvent<MouseEvent>) => void }) {
  const f = room.finish?.floor ?? floorFor(style, room.type);
  const geo = useMemo(() => {
    const shape = new THREE.Shape(room.points.map((p) => new THREE.Vector2(p.x, -p.y)));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    return g;
  }, [room.points]);
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

/** Dalle de toit d'une pièce, élargie pour recouvrir le haut des murs. */
function RoofSlab({ room, height }: { room: Room; height: number }) {
  const geo = useMemo(() => {
    const pts = offsetPolygon(room.points, 0.14);
    const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.y)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: false });
    g.rotateX(-Math.PI / 2); // extrusion vers le haut
    return g;
  }, [room.points]);
  return (
    <mesh geometry={geo} position-y={height} castShadow receiveShadow>
      <meshStandardMaterial color={ROOF} roughness={0.95} />
    </mesh>
  );
}

function Ceiling({ room, height }: { room: Room; height: number }) {
  const geo = useMemo(() => {
    const shape = new THREE.Shape(room.points.map((p) => new THREE.Vector2(p.x, -p.y)));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(Math.PI / 2); // face vers le bas
    g.scale(1, 1, -1);
    return g;
  }, [room.points]);
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

export default function House3D({ project, options }: { project: Project; options: HouseOptions }) {
  const style = styleById(project.styleId);
  const { walls, openings, rooms } = project;
  const height = walls.reduce((m, w) => Math.max(m, w.height), 2.7);
  const b = useMemo(() => {
    const xs = walls.flatMap((w) => [w.a.x, w.b.x]);
    const ys = walls.flatMap((w) => [w.a.y, w.b.y]);
    return xs.length ? { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } : { x0: 0, x1: 10, y0: 0, y1: 10 };
  }, [walls]);
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const planGround = !!(project.planFloor && project.background);
  const floorClick = options.onFloorClick
    ? (e: ThreeEvent<MouseEvent>) => {
        if (e.delta > 4) return; // c'était un glisser (rotation de la vue)
        options.onFloorClick!(roomAt({ x: e.point.x, y: e.point.z }, rooms)?.id ?? null);
      }
    : undefined;

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

      {planGround ? (
        <PlanGround bg={project.background!} onClick={floorClick} />
      ) : (
        rooms.map((r) => <Floor key={r.id} room={r} style={style} onClick={floorClick} />)
      )}
      {walls.map((w) => <WallMesh key={w.id} w={w} openings={openings} rooms={rooms} style={style} cutaway={options.cutaway} roof={options.roof} />)}
      {options.roof && rooms.filter((r) => !OPEN_AIR.has(r.type)).map((r) => <RoofSlab key={`toit-${r.id}`} room={r} height={height} />)}
      {openings.map((o) => {
        const w = walls.find((x) => x.id === o.wallId);
        return w ? <OpeningMesh key={o.id} o={o} w={w} style={style} cutaway={options.cutaway} /> : null;
      })}
      {options.ceilings && rooms.map((r) => <Ceiling key={r.id} room={r} height={height} />)}
      {options.furniture.map((f) => (
        <Furniture3D
          key={f.id}
          f={f}
          style={style}
          selected={f.id === options.selectedId}
          onPointerDown={options.onFurnitureDown && ((e) => options.onFurnitureDown!(f, e))}
        />
      ))}
    </group>
  );
}
