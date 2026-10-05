"use client";
/* Visionneuse 3D : maquette (orbite), visite libre (à hauteur d'yeux, collisions) et visite guidée. */
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { ContactShadows, Environment, Lightformer, OrbitControls } from "@react-three/drei";
import { XR, XROrigin } from "@react-three/xr";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { Opening, Project, Pt, Wall } from "@/lib/types";
import { projectOnWall } from "@/lib/geometry";
import type { Furniture } from "@/lib/furnish";
import type { Tour } from "@/lib/tour";
import House3D from "./House3D";
import { getXRStore } from "./xrStore";

export type ViewMode = "maquette" | "visite" | "guidee";
const EYE = 1.6;
const PAUSE = 5; // secondes d'arrêt dans chaque pièce


function blocked(p: Pt, walls: Wall[], openings: Opening[]) {
  for (const w of walls) {
    const pr = projectOnWall(p, w);
    if (pr.d >= w.thickness / 2 + 0.22) continue;
    const passable = openings.some(
      (o) => o.wallId === w.id && o.kind !== "window" && o.sill < 0.1 && Math.abs(pr.t - o.t) < o.width / 2 - 0.12,
    );
    if (!passable) return true;
  }
  return false;
}

/* ---------- visite libre ---------- */
function WalkControls({ start, walls, openings, origin }: { start: { p: Pt; yaw: number }; walls: Wall[]; openings: Opening[]; origin: React.RefObject<THREE.Group | null> }) {
  const gl = useThree((s) => s.gl);
  const st = useRef({ x: start.p.x, z: start.p.y, yaw: start.yaw, pitch: 0, drag: false, px: 0, py: 0 });
  const keys = useRef(new Set<string>());

  useEffect(() => {
    Object.assign(st.current, { x: start.p.x, z: start.p.y, yaw: start.yaw, pitch: 0 });
  }, [start]);

  useEffect(() => {
    const el = gl.domElement;
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      keys.current.add(e.key.toLowerCase());
    };
    const ku = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    const down = (e: PointerEvent) => Object.assign(st.current, { drag: true, px: e.clientX, py: e.clientY });
    const move = (e: PointerEvent) => {
      const s = st.current;
      if (!s.drag) return;
      s.yaw -= (e.clientX - s.px) * 0.004;
      s.pitch = Math.max(-1.2, Math.min(1.2, s.pitch - (e.clientY - s.py) * 0.004));
      s.px = e.clientX;
      s.py = e.clientY;
    };
    const up = () => (st.current.drag = false);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [gl]);

  useFrame(({ camera }, dt) => {
    const s = st.current;
    const k = keys.current;
    const f = (k.has("z") || k.has("w") || k.has("arrowup") ? 1 : 0) - (k.has("s") || k.has("arrowdown") ? 1 : 0);
    const r = (k.has("d") || k.has("arrowright") ? 1 : 0) - (k.has("q") || k.has("a") || k.has("arrowleft") ? 1 : 0);
    if (f || r) {
      const sp = 1.7 * Math.min(dt, 0.05);
      const fx = -Math.sin(s.yaw);
      const fz = -Math.cos(s.yaw);
      const nx = s.x + (fx * f - fz * r) * sp;
      const nz = s.z + (fz * f + fx * r) * sp;
      if (!blocked({ x: nx, y: s.z }, walls, openings)) s.x = nx;
      if (!blocked({ x: s.x, y: nz }, walls, openings)) s.z = nz;
    }
    if (gl.xr.isPresenting) {
      origin.current?.position.set(s.x, 0, s.z);
      return;
    }
    camera.position.set(s.x, EYE, s.z);
    camera.rotation.set(s.pitch, s.yaw, 0, "YXZ");
  });
  return null;
}

/* ---------- visite guidée ---------- */
function TourControls({
  tour,
  playing,
  onStop,
  onEnd,
  origin,
}: {
  tour: Tour;
  playing: boolean;
  onStop: (i: number) => void;
  onEnd?: () => void;
  origin: React.RefObject<THREE.Group | null>;
}) {
  const gl = useThree((s) => s.gl);
  const data = useMemo(() => {
    const pts = tour.points.map((p) => new THREE.Vector3(p.x, EYE, p.y));
    if (pts.length < 2) pts.push(pts[0].clone().add(new THREE.Vector3(0.01, 0, 0)));
    const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.3);
    // table distance ↔ paramètre
    const N = (pts.length - 1) * 40;
    const ts: number[] = [];
    const ds: number[] = [];
    let total = 0;
    let prev = curve.getPoint(0);
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = curve.getPoint(t);
      total += p.distanceTo(prev);
      prev = p;
      ts.push(t);
      ds.push(total);
    }
    const tAt = (d: number) => {
      let lo = 0;
      let hi = ds.length - 1;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (ds[m] < d) lo = m + 1;
        else hi = m;
      }
      return ts[lo];
    };
    const stopDist = tour.stops.map((s) => ds[Math.round((s.index / (pts.length - 1)) * N)]);
    return { curve, total, tAt, stopDist };
  }, [tour]);
  const st = useRef({ d: 0, pause: 0, nextStop: 0, cur: -1, yaw: 0, ended: false });
  const stopRef = useRef(onStop);
  const endRef = useRef(onEnd);
  useEffect(() => {
    stopRef.current = onStop;
    endRef.current = onEnd;
  });

  useEffect(() => {
    st.current = { d: 0, pause: 0, nextStop: 0, cur: -1, yaw: 0, ended: false };
  }, [data]);

  useFrame(({ camera }, dt) => {
    const s = st.current;
    const { curve, total, tAt, stopDist } = data;
    const step = Math.min(dt, 0.05);
    let sweep = 0;
    if (playing) {
      if (s.pause > 0) {
        s.pause -= step;
        sweep = Math.sin((1 - s.pause / PAUSE) * Math.PI * 2) * 0.55; // regard qui balaie la pièce
      } else if (s.d < total) {
        s.d = Math.min(total, s.d + 1.05 * step);
        if (s.nextStop < stopDist.length && s.d >= stopDist[s.nextStop]) {
          s.d = stopDist[s.nextStop];
          s.pause = PAUSE;
          s.cur = s.nextStop;
          stopRef.current(s.nextStop);
          s.nextStop++;
        }
      } else if (!s.ended) {
        // fin du parcours (dernier arrêt terminé)
        s.ended = true;
        endRef.current?.();
      }
    }
    const t = tAt(s.d);
    const p = curve.getPoint(t);
    const ahead = curve.getPoint(Math.min(1, tAt(Math.min(total, s.d + 0.8))));
    let yaw = Math.atan2(-(ahead.x - p.x), -(ahead.z - p.z));
    if (ahead.distanceTo(p) < 0.05) yaw = s.yaw;
    if (s.pause > 0 && s.cur >= 0) {
      const L = tour.stops[s.cur].look;
      yaw = Math.atan2(-(L.x - p.x), -(L.y - p.z)) + sweep;
    }
    // lissage de l'orientation
    let diff = yaw - s.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    s.yaw += diff * Math.min(1, step * 2.5);
    if (gl.xr.isPresenting) {
      origin.current?.position.set(p.x, 0, p.z);
      return;
    }
    camera.position.copy(p);
    camera.rotation.set(-0.05, s.yaw, 0, "YXZ");
  });
  return null;
}

/* ---------- caméra selon le mode ---------- */
function CameraMode({ mode, overview }: { mode: ViewMode; overview: [number, number, number] }) {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const { camera, set } = get();
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = mode === "maquette" ? 40 : 70;
    if (mode === "maquette") {
      cam.position.set(...overview);
      cam.rotation.order = "XYZ";
    }
    cam.updateProjectionMatrix();
    set({});
  }, [mode, overview, get]);
  return null;
}

/* ---------- design d'espace : glisser un meuble sur le sol ---------- */
type Drag = { id: string; ox: number; oy: number; x0: number; y0: number; x: number; y: number; moved: boolean };

function DesignDrag({
  startRef,
  onMove,
  onEnd,
}: {
  startRef: React.RefObject<((f: Furniture, e: ThreeEvent<PointerEvent>) => void) | null>;
  onMove: (id: string, x: number, y: number) => void;
  onEnd: (d: Drag) => void;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;
  const drag = useRef<Drag | null>(null);
  useEffect(() => {
    startRef.current = (f, e) => {
      e.stopPropagation();
      drag.current = { id: f.id, ox: f.x - e.point.x, oy: f.y - e.point.z, x0: f.x, y0: f.y, x: f.x, y: f.y, moved: false };
      if (controls) controls.enabled = false; // la vue ne tourne pas pendant qu'on déplace un meuble
    };
    const ray = new THREE.Raycaster();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const r = gl.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      if (!ray.ray.intersectPlane(ground, hit)) return;
      const x = Math.round((hit.x + d.ox) * 20) / 20; // pas de 5 cm
      const y = Math.round((hit.z + d.oy) * 20) / 20;
      if (x === d.x && y === d.y) return;
      d.x = x;
      d.y = y;
      d.moved ||= Math.hypot(x - d.x0, y - d.y0) > 0.04;
      onMove(d.id, x, y);
    };
    const up = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      if (controls) controls.enabled = true;
      onEnd(d);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      startRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [camera, gl, controls, startRef, onMove, onEnd]);
  return null;
}

/* ---------- cadrage « photo de façade » pour les rendus IA ---------- */
function ShotCamera({ shotRef, c }: { shotRef: React.RefObject<(() => () => void) | null>; c: { x: number; z: number; r: number } }) {
  const get = useThree((s) => s.get);
  useEffect(() => {
    shotRef.current = () => {
      const { camera } = get();
      const controls = get().controls as unknown as { target: THREE.Vector3; update: () => void } | null;
      const saved = { pos: camera.position.clone(), target: controls?.target.clone() };
      // trois quarts face, un peu en hauteur, la maison remplit l'image
      const az = 0.62;
      const elev = 0.32;
      const dist = c.r * 1.25 + 3;
      camera.position.set(c.x + Math.sin(az) * Math.cos(elev) * dist, Math.sin(elev) * dist + 1.5, c.z + Math.cos(az) * Math.cos(elev) * dist);
      if (controls) {
        controls.target.set(c.x, 1.4, c.z);
        controls.update();
      } else camera.lookAt(c.x, 1.4, c.z);
      return () => {
        camera.position.copy(saved.pos);
        if (controls && saved.target) {
          controls.target.copy(saved.target);
          controls.update();
        }
      };
    };
    return () => {
      shotRef.current = null;
    };
  }, [shotRef, get, c.x, c.z, c.r]);
  return null;
}

/* ---------- export GLB ---------- */
function Exporter({ target, exportRef }: { target: React.RefObject<THREE.Group | null>; exportRef: React.RefObject<(() => void) | null> }) {
  useEffect(() => {
    exportRef.current = () => {
      if (!target.current) return;
      new GLTFExporter().parse(
        target.current,
        (res) => {
          const blob = new Blob([res as ArrayBuffer], { type: "model/gltf-binary" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "maison.glb";
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        },
        (err) => console.error(err),
        { binary: true },
      );
    };
    return () => {
      exportRef.current = null;
    };
  }, [target, exportRef]);
  return null;
}

export default function Viewer3D({
  project,
  furniture,
  mode,
  cutaway,
  tour,
  playing,
  walkStart,
  onStop,
  exportRef,
  design,
  onTourEnd,
  canvasRef,
  roof = false,
  shotRef,
}: {
  project: Project;
  furniture: Furniture[];
  mode: ViewMode;
  cutaway: boolean;
  tour: Tour | null;
  playing: boolean;
  walkStart: { p: Pt; yaw: number };
  onStop: (i: number) => void;
  exportRef: React.RefObject<(() => void) | null>;
  /** fin de la visite guidée (pour arrêter un enregistrement vidéo) */
  onTourEnd?: () => void;
  /** toit-terrasse (vue façade pour le rendu IA) */
  roof?: boolean;
  /** cadre la maison pour une photo de façade ; la fonction rendue rétablit la caméra */
  shotRef?: React.RefObject<(() => () => void) | null>;
  /** reçoit le canvas WebGL (capture vidéo) */
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /** design d'espace (étape Intérieur, vue maquette) : sélection et déplacement des meubles, choix de la pièce */
  design?: {
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onCommit: (id: string, x: number, y: number) => void;
    onPickRoom: (roomId: string | null) => void;
  };
}) {
  const houseRef = useRef<THREE.Group>(null);
  const startDrag = useRef<((f: Furniture, e: ThreeEvent<PointerEvent>) => void) | null>(null);
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  const onDragMove = useCallback((id: string, x: number, y: number) => setDragPos({ id, x, y }), []);
  const designRef = useRef(design);
  useEffect(() => {
    designRef.current = design;
  });
  const onDragEnd = useCallback((d: Drag) => {
    setDragPos(null);
    if (d.moved) designRef.current?.onCommit(d.id, d.x, d.y);
  }, []);
  const shown = dragPos ? furniture.map((f) => (f.id === dragPos.id ? { ...f, x: dragPos.x, y: dragPos.y } : f)) : furniture;
  const originRef = useRef<THREE.Group>(null);
  const store = getXRStore();
  const xs = project.walls.flatMap((w) => [w.a.x, w.b.x]);
  const ys = project.walls.flatMap((w) => [w.a.y, w.b.y]);
  const c = xs.length
    ? { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...ys) + Math.max(...ys)) / 2, r: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) }
    : { x: 5, z: 5, r: 10 };
  const interior = mode !== "maquette";
  const overview = useMemo<[number, number, number]>(() => [c.x + c.r * 0.9, c.r * 1.05, c.z + c.r * 1.1], [c.x, c.z, c.r]);

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: overview, fov: 40, near: 0.05, far: 500 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      onCreated={({ scene, gl }) => {
        scene.background = new THREE.Color("#ebe6da");
        if (canvasRef) canvasRef.current = gl.domElement;
      }}
    >
      <XR store={store}>
        <XROrigin ref={originRef} position={[walkStart.p.x, 0, walkStart.p.y]} />
        <hemisphereLight args={["#fff8ec", "#b9b29c", interior ? 0.55 : 0.9]} />
        <directionalLight
          position={[c.x + 12, 18, c.z + 8]}
          intensity={interior ? 1.2 : 2.2}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-c.r}
          shadow-camera-right={c.r}
          shadow-camera-top={c.r}
          shadow-camera-bottom={-c.r}
          shadow-bias={-0.0004}
          target-position={[c.x, 0, c.z]}
        />
        <Environment resolution={128}>
          <Lightformer intensity={1.4} position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[12, 12, 1]} />
          <Lightformer intensity={0.6} color="#ffe9c7" position={[-8, 3, -6]} scale={[8, 4, 1]} />
        </Environment>
        <group ref={houseRef}>
          <House3D
            project={project}
            options={{
              cutaway: mode === "maquette" && cutaway && !roof,
              roof,
              ceilings: interior,
              furniture: shown,
              selectedId: design?.selectedId,
              onFurnitureDown: design
                ? (f, e) => {
                    design.onSelect(f.id);
                    startDrag.current?.(f, e);
                  }
                : undefined,
              onFloorClick: design
                ? (roomId) => {
                    design.onSelect(null);
                    design.onPickRoom(roomId);
                  }
                : undefined,
            }}
          />
        </group>
        {mode === "maquette" && (
          <>
            <ContactShadows position={[c.x, 0.001, c.z]} scale={c.r * 2.4} opacity={0.25} blur={2.4} far={4} />
            <OrbitControls target={[c.x, 0, c.z]} maxPolarAngle={Math.PI / 2.1} minDistance={3} maxDistance={c.r * 4} enableDamping makeDefault />
          </>
        )}
        {mode === "visite" && <WalkControls start={walkStart} walls={project.walls} openings={project.openings} origin={originRef} />}
        {mode === "guidee" && tour && <TourControls tour={tour} playing={playing} onStop={onStop} onEnd={onTourEnd} origin={originRef} />}
        <CameraMode mode={mode} overview={overview} />
        {shotRef && mode === "maquette" && <ShotCamera shotRef={shotRef} c={c} />}
        {design && mode === "maquette" && <DesignDrag startRef={startDrag} onMove={onDragMove} onEnd={onDragEnd} />}
        <Exporter target={houseRef} exportRef={exportRef} />
      </XR>
    </Canvas>
  );
}
