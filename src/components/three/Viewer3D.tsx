"use client";
/* Visionneuse 3D : maquette (orbite), visite libre (à hauteur d'yeux, collisions) et visite guidée. */
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { ContactShadows, Environment, Lightformer, OrbitControls } from "@react-three/drei";
import { XR, XROrigin } from "@react-three/xr";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { Opening, Project, Pt, Wall } from "@/lib/types";
import { fmtArea, polygonArea, projectOnWall, roomAnchor } from "@/lib/geometry";
import type { Furniture } from "@/lib/furnish";
import { onFlight, type HouseLevel } from "@/lib/levels";
import type { Tour } from "@/lib/tour";
import { EYE, PITCH, TOUR_FOV, TourPlayer } from "@/lib/tourPlayer";
import House3D from "./House3D";
import { createCapture, type CaptureAPI } from "./capture";
import { BuildClock, buildDuration } from "./build";
import { getXRStore } from "./xrStore";

export type ViewMode = "maquette" | "visite" | "guidee";


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
export type WalkStart = { p: Pt; yaw: number; level: number };

function WalkControls({ start, levels, origin }: { start: WalkStart; levels: HouseLevel[]; origin: React.RefObject<THREE.Group | null> }) {
  const gl = useThree((s) => s.gl);
  const st = useRef({ x: start.p.x, z: start.p.y, yaw: start.yaw, pitch: 0, lvl: start.level, drag: false, px: 0, py: 0 });
  const keys = useRef(new Set<string>());

  useEffect(() => {
    Object.assign(st.current, { x: start.p.x, z: start.p.y, yaw: start.yaw, pitch: 0, lvl: start.level });
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
    const L = levels[Math.min(s.lvl, levels.length - 1)];
    if (!L) return;
    const f = (k.has("z") || k.has("w") || k.has("arrowup") ? 1 : 0) - (k.has("s") || k.has("arrowdown") ? 1 : 0);
    const r = (k.has("d") || k.has("arrowright") ? 1 : 0) - (k.has("q") || k.has("a") || k.has("arrowleft") ? 1 : 0);
    if (f || r) {
      const sp = 1.7 * Math.min(dt, 0.05);
      const fx = -Math.sin(s.yaw);
      const fz = -Math.cos(s.yaw);
      const nx = s.x + (fx * f - fz * r) * sp;
      const nz = s.z + (fz * f + fx * r) * sp;
      if (!blocked({ x: nx, y: s.z }, L.walls, L.openings)) s.x = nx;
      if (!blocked({ x: s.x, y: nz }, L.walls, L.openings)) s.z = nz;
    }
    // hauteur du sol : celle du niveau, ou le long de l'escalier qui part d'ici (ou qui arrive ici d'en bas)
    let y = L.z;
    stairs: for (const li of [s.lvl, s.lvl - 1]) {
      const from = levels[li];
      const to = levels[li + 1];
      if (!from || !to) continue;
      for (const fl of from.flights) {
        const t = onFlight(fl, { x: s.x, y: s.z });
        if (t === null) continue;
        y = from.z + t * (to.z - from.z);
        s.lvl = t > 0.5 ? li + 1 : li;
        break stairs;
      }
    }
    if (gl.xr.isPresenting) {
      origin.current?.position.set(s.x, y, s.z);
      return;
    }
    camera.position.set(s.x, y + EYE, s.z);
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
  const player = useMemo(() => new TourPlayer(tour), [tour]);
  const stopRef = useRef(onStop);
  const endRef = useRef(onEnd);
  useEffect(() => {
    stopRef.current = onStop;
    endRef.current = onEnd;
  });

  useFrame(({ camera }, dt) => {
    const ev = player.step(dt, playing);
    if (ev === "fin") endRef.current?.();
    else if (ev !== null) stopRef.current(ev);
    const p = player.position;
    if (gl.xr.isPresenting) {
      origin.current?.position.set(p.x, 0, p.z);
      return;
    }
    camera.position.copy(p);
    camera.rotation.set(PITCH, player.yaw, 0, "YXZ");
  });
  return null;
}

/* ---------- caméra selon le mode ---------- */
function CameraMode({ mode, overview }: { mode: ViewMode; overview: [number, number, number] }) {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const { camera, set } = get();
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = mode === "maquette" ? 40 : TOUR_FOV;
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
  elevation,
}: {
  elevation: number;
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
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), -elevation);
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
  }, [camera, gl, controls, startRef, onMove, onEnd, elevation]);
  return null;
}

/* ---------- cadrage « photo de façade » pour les rendus IA ---------- */
function ShotCamera({ shotRef, c }: { shotRef: React.RefObject<(() => () => void) | null>; c: { x: number; z: number; r: number; top: number } }) {
  const get = useThree((s) => s.get);
  useEffect(() => {
    shotRef.current = () => {
      const { camera } = get();
      const controls = get().controls as unknown as { target: THREE.Vector3; update: () => void } | null;
      const saved = { pos: camera.position.clone(), target: controls?.target.clone() };
      // trois quarts face, un peu en hauteur, la maison remplit l'image
      const az = 0.62;
      const elev = 0.32;
      const dist = Math.max(c.r * 1.25 + 3, c.top * 2.6);
      const aim = Math.max(1.4, c.top * 0.42);
      camera.position.set(c.x + Math.sin(az) * Math.cos(elev) * dist, Math.sin(elev) * dist + aim, c.z + Math.cos(az) * Math.cos(elev) * dist);
      if (controls) {
        controls.target.set(c.x, aim, c.z);
        controls.update();
      } else camera.lookAt(c.x, aim, c.z);
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
  }, [shotRef, get, c.x, c.z, c.r, c.top]);
  return null;
}

/* ---------- captures pour l'IA (profondeur, plans de la visite) ---------- */
function Capturer({ captureRef, bounds, tour, levels }: { captureRef: React.RefObject<CaptureAPI | null>; bounds: THREE.Box3; tour: Tour | null; levels: HouseLevel[] }) {
  const get = useThree((s) => s.get);
  const latest = useRef({ bounds, tour, levels });
  useEffect(() => {
    latest.current = { bounds, tour, levels };
  });
  useEffect(() => {
    captureRef.current = createCapture(get, () => latest.current.bounds, () => latest.current.tour, () => latest.current.levels);
    return () => {
      captureRef.current = null;
    };
  }, [captureRef, get]);
  return null;
}

/* ---------- noms des pièces ---------- */
type Label = { id: string; name: string; area: string; at: THREE.Vector3 };

/** Place les étiquettes (simples div au-dessus du canvas) sur leur pièce, à chaque image. Pas de composant Html de drei :
    ses racines React imbriquées supportent mal les démontages pendant un rendu. */
function LabelProjector({ labels, overlayRef }: { labels: Label[]; overlayRef: React.RefObject<HTMLDivElement | null> }) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const box = overlayRef.current;
    if (!box) return;
    labels.forEach((l, i) => {
      const el = box.children[i] as HTMLElement | undefined;
      if (!el) return;
      v.copy(l.at).project(camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      el.style.display = visible ? "block" : "none";
      if (visible) el.style.transform = `translate(-50%, -50%) translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px)`;
    });
  });
  return null;
}

/* ---------- animation de construction ---------- */
/** Démarre l'horloge quelques images après la demande (le temps que la scène soit compilée et affichée),
    et prévient à la fin. Avant le départ, tout est caché (horloge à l'infini). */
function BuildDriver({ clockRef, build, levels, onEnd }: { clockRef: React.RefObject<number | null>; build: number; levels: number; onEnd?: () => void }) {
  const wait = useRef(0);
  const endRef = useRef(onEnd);
  useEffect(() => {
    endRef.current = onEnd;
  });
  useEffect(() => {
    if (!build) return;
    clockRef.current = Infinity;
    wait.current = 3;
  }, [build, clockRef]);
  useFrame(() => {
    if (wait.current > 0 && --wait.current === 0) clockRef.current = performance.now() / 1000;
    const t0 = clockRef.current;
    if (t0 != null && Number.isFinite(t0) && performance.now() / 1000 - t0 > buildDuration(levels)) {
      clockRef.current = null;
      endRef.current?.();
    }
  });
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
  levels,
  showLevel,
  labels,
  build,
  building,
  onBuildEnd,
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
  captureRef,
}: {
  project: Project;
  /** tous les niveaux de la maison, avec leurs meubles */
  levels: HouseLevel[];
  /** vue maquette : niveaux affichés jusqu'à celui-ci (coupé si « Coupe » est active) */
  showLevel: number;
  /** noms des pièces sur la maquette */
  labels: boolean;
  /** change pour relancer l'animation de construction */
  build: number;
  building: boolean;
  /** fin de l'animation de construction */
  onBuildEnd?: () => void;
  mode: ViewMode;
  cutaway: boolean;
  tour: Tour | null;
  playing: boolean;
  walkStart: WalkStart;
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
  /** reçoit de quoi produire les cartes de profondeur et les plans de la visite pour les rendus IA */
  captureRef?: React.RefObject<CaptureAPI | null>;
  /** design d'espace (étape Intérieur, vue maquette) : sélection et déplacement des meubles du niveau `level`, choix de la pièce */
  design?: {
    level: number;
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
  // meuble en cours de déplacement
  const shownLevels = useMemo(
    () =>
      dragPos && design
        ? levels.map((L) => (L.index === design.level ? { ...L, furniture: L.furniture.map((f) => (f.id === dragPos.id ? { ...f, x: dragPos.x, y: dragPos.y } : f)) } : L))
        : levels,
    [levels, dragPos, design],
  );
  // horloge de l'animation de construction (voir BuildDriver)
  const buildClock = useRef<number | null>(null);

  const originRef = useRef<THREE.Group>(null);
  const store = getXRStore();
  const xs = levels.flatMap((L) => L.walls.flatMap((w) => [w.a.x, w.b.x]));
  const ys = levels.flatMap((L) => L.walls.flatMap((w) => [w.a.y, w.b.y]));
  const last = levels[levels.length - 1];
  const top = last ? last.z + last.height : 2.8;
  const c = xs.length
    ? {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        z: (Math.min(...ys) + Math.max(...ys)) / 2,
        r: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)),
        top,
      }
    : { x: 5, z: 5, r: 10, top };
  const interior = mode !== "maquette";
  const bounds = useMemo(
    () =>
      xs.length
        ? new THREE.Box3(new THREE.Vector3(Math.min(...xs), 0, Math.min(...ys)), new THREE.Vector3(Math.max(...xs), top, Math.max(...ys)))
        : new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 3, 10)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [levels, top],
  );
  const overview = useMemo<[number, number, number]>(() => [c.x + c.r * 0.9, c.r * 1.05 + c.top * 0.3, c.z + c.r * 1.1], [c.x, c.z, c.r, c.top]);
  const shown = mode === "maquette" && !roof ? Math.min(showLevel, levels.length - 1) : levels.length - 1;
  const floorY = levels[shown]?.z ?? 0;
  // noms des pièces du niveau regardé, au-dessus des murs coupés (ou entiers)
  const labelOverlay = useRef<HTMLDivElement>(null);
  const cutNow = mode === "maquette" && cutaway && !roof;
  const roomLabels = useMemo<Label[]>(() => {
    const L = levels[shown];
    if (!L || mode !== "maquette" || !labels || roof || building) return [];
    const y = L.z + (cutNow ? 1.45 : L.height + 0.45);
    return L.rooms.map((r) => {
      const c = roomAnchor(r);
      return { id: r.id, name: r.name, area: fmtArea(Math.abs(polygonArea(r.points))), at: new THREE.Vector3(c.x, y, c.y) };
    });
  }, [levels, shown, mode, labels, roof, building, cutNow]);

  return (
    <div className="relative size-full">
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
        <XROrigin ref={originRef} position={[walkStart.p.x, levels[walkStart.level]?.z ?? 0, walkStart.p.y]} />
        <hemisphereLight args={["#fff8ec", "#b9b29c", interior ? 0.55 : 0.9]} />
        <directionalLight
          position={[c.x + 12, 18 + c.top, c.z + 8]}
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
        <BuildClock.Provider value={buildClock}>
          <group ref={houseRef}>
            <House3D
              styleId={project.styleId}
              levels={shownLevels}
              options={{
                cutLevel: mode === "maquette" && cutaway && !roof ? shown : null,
                showUpTo: shown,
                roof,
                ceilings: interior,
                planGround: !!project.planFloor,
                designLevel: design?.level,
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
        </BuildClock.Provider>
        {mode === "maquette" && (
          <>
            <ContactShadows position={[c.x, 0.001, c.z]} scale={c.r * 2.4} opacity={0.25} blur={2.4} far={4} />
            <OrbitControls
              target={[c.x, floorY, c.z]}
              maxPolarAngle={Math.PI / 2.1}
              minDistance={3}
              maxDistance={c.r * 4}
              enableDamping
              autoRotate={building}
              autoRotateSpeed={1.2}
              makeDefault
            />
          </>
        )}
        {mode === "visite" && <WalkControls start={walkStart} levels={levels} origin={originRef} />}
        {mode === "guidee" && tour && <TourControls tour={tour} playing={playing} onStop={onStop} onEnd={onTourEnd} origin={originRef} />}
        <CameraMode mode={mode} overview={overview} />
        {shotRef && mode === "maquette" && <ShotCamera shotRef={shotRef} c={c} />}
        {design && mode === "maquette" && <DesignDrag startRef={startDrag} onMove={onDragMove} onEnd={onDragEnd} elevation={levels[design.level]?.z ?? 0} />}
        <BuildDriver clockRef={buildClock} build={build} levels={levels.length} onEnd={onBuildEnd} />
        <Exporter target={houseRef} exportRef={exportRef} />
        {captureRef && <Capturer captureRef={captureRef} bounds={bounds} tour={tour} levels={levels} />}
        <LabelProjector labels={roomLabels} overlayRef={labelOverlay} />
      </XR>
    </Canvas>
      <div ref={labelOverlay} className="pointer-events-none absolute inset-0 overflow-hidden">
        {roomLabels.map((l) => (
          <div key={l.id} className="absolute left-0 top-0 hidden whitespace-nowrap rounded-full bg-paper/95 px-2.5 py-1 text-center text-[11px] leading-tight shadow-md ring-1 ring-line">
            <div className="font-semibold text-ink">{l.name}</div>
            <div className="text-[10px] tabular-nums text-muted">{l.area}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
