"use client";
/* Écran principal : 1 · Plan (import + tracé) → 2 · 3D (maquette, visite libre, visite guidée, VR) → 3 · Intérieur. */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight, Box, BrickWall, Check, Clapperboard, Sparkles, Columns2, Monitor, Smartphone, Square, DoorOpen, Download, FilePlus2, FolderOpen, Footprints, Glasses, Grid2x2,
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Hammer, House, Layers, Magnet, Maximize2, MousePointer2, PaintBucket, Pause, Play, Plus, Redo2, RotateCcw, Route, Ruler, Save, Scissors, Sofa,
  Tag, Trash2, Undo2, Upload, WandSparkles, X,
} from "lucide-react";
import type { Background, OpeningKind, Project, Pt, Room, RoomType } from "@/lib/types";
import { OPENING_DEFAULTS, ROOM_LABELS } from "@/lib/types";
import { EMPTY_PROJECT, useProject } from "@/lib/store";
import { SAMPLE_DUPLEX, SAMPLE_PROJECT } from "@/lib/sample";
import { STYLES } from "@/lib/styles";
import { moveF, removeF, rotateF } from "@/lib/design";
import DesignPanel from "./DesignPanel";
import RenduIA from "./RenduIA";
import type { CaptureAPI } from "./three/capture";
import { furnish } from "@/lib/furnish";
import { buildTour, roomViewpoint, yawTowards } from "@/lib/tour";
import {
  activeLevel, addLevel, alignOffset, defaultStairs, houseLevels, removeLevel, renameLevel, switchLevel, translateActive,
} from "@/lib/levels";
import { buildDuration } from "./three/build";
import { importDxf } from "@/lib/dxf";
import { detectAllRooms } from "@/lib/roomDetect";
import { autoReadPlan, fixInteriorOpenings, readImage, readPdf, roomsFromPolygons } from "@/lib/importers";
import { add, dist, fmt, fmtArea, mul, pointInPolygon, polygonArea, roomAnchor, wallDir, wallLength } from "@/lib/geometry";
import Editor2D, { type Tool } from "./editor/Editor2D";
import type { ViewMode, WalkStart } from "./three/Viewer3D";
import { getXRStore } from "./three/xrStore";

const Viewer3D = dynamic(() => import("./three/Viewer3D"), {
  ssr: false,
  loading: () => (
    <div className="grid size-full place-items-center text-sm text-muted">Construction de la maison en 3D…</div>
  ),
});

type Step = "plan" | "3d" | "interieur";

const STEPS: { id: Step; label: string; icon: typeof House }[] = [
  { id: "plan", label: "Plan", icon: Ruler },
  { id: "3d", label: "Maison 3D", icon: Box },
  { id: "interieur", label: "Intérieur", icon: Sofa },
];

const TOOLS: { id: Tool; label: string; icon: typeof House; key: string }[] = [
  { id: "select", label: "Sélection", icon: MousePointer2, key: "v" },
  { id: "wall", label: "Mur", icon: BrickWall, key: "m" },
  { id: "door", label: "Porte", icon: DoorOpen, key: "p" },
  { id: "window", label: "Fenêtre", icon: Grid2x2, key: "f" },
  { id: "baie", label: "Baie vitrée", icon: Columns2, key: "b" },
  { id: "passage", label: "Passage", icon: ArrowLeftRight, key: "o" },
  { id: "room", label: "Pièce", icon: PaintBucket, key: "r" },
  { id: "calibrate", label: "Échelle", icon: Ruler, key: "e" },
];

const HELP: Record<Tool, string> = {
  select: "Cliquez un mur, une ouverture ou une pièce pour le modifier. Glissez les poignées d'un mur pour le déplacer. Suppr pour effacer.",
  wall: "Cliquez pour poser chaque angle : les murs s'enchaînent. Double-clic ou Échap pour finir. Les angles droits et les extrémités s'accrochent.",
  door: "Cliquez sur un mur pour y placer une porte.",
  window: "Cliquez sur un mur pour y placer une fenêtre.",
  baie: "Cliquez sur un mur pour y placer une baie vitrée.",
  passage: "Cliquez sur un mur pour ouvrir un passage sans porte.",
  room: "Choisissez le type, puis cliquez à l'intérieur d'une pièce fermée par des murs.",
  calibrate: "Cliquez les deux extrémités d'une cote connue du plan (ex. une façade de 12 m), puis saisissez sa longueur réelle.",
};

/* ---------- petits composants ---------- */

function NumField({ label, value, onCommit, min = 0, suffix = "m" }: { label: string; value: number; onCommit: (n: number) => void; min?: number; suffix?: string }) {
  const [v, setV] = useState(value.toFixed(2));
  const done = () => {
    const n = parseFloat(v.replace(",", "."));
    if (Number.isFinite(n) && n >= min && Math.abs(n - value) > 1e-4) onCommit(n);
    else setV(value.toFixed(2));
  };
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          className="w-20 rounded-lg border border-line bg-white px-2 py-1 text-right tabular-nums outline-none focus:border-accent"
          inputMode="decimal"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={done}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <span className="w-4 text-xs text-muted">{suffix}</span>
      </span>
    </label>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-b border-line px-5 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-[13px] font-semibold uppercase tracking-wider text-muted">{title}</h3>
        {right}
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function TypeSelect({ value, onChange, className = "" }: { value: RoomType; onChange: (t: RoomType) => void; className?: string }) {
  return (
    <select
      className={`rounded-lg border border-line bg-white px-2 py-1 text-sm outline-none focus:border-accent ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value as RoomType)}
    >
      {Object.entries(ROOM_LABELS).map(([k, l]) => (
        <option key={k} value={k}>{l}</option>
      ))}
    </select>
  );
}

function RoomList({ rooms, level, onPick, pickLabel }: { rooms: Room[]; level?: number; onPick?: (r: Room) => void; pickLabel?: string }) {
  const updateRoomIn = useProject((s) => s.updateRoomIn);
  const updateRoom = (id: string, r: Partial<Room>) => updateRoomIn(level ?? useProject.getState().project.level ?? 0, id, r);
  if (!rooms.length) return <p className="text-sm text-muted">Aucune pièce. À l&apos;étape Plan, outil « Pièce » : cliquez dans chaque pièce.</p>;
  return (
    <ul className="space-y-2">
      {rooms.map((r) => (
        <li key={r.id} className="rounded-xl border border-line bg-white px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <input
              key={r.name}
              defaultValue={r.name}
              onBlur={(e) => e.target.value.trim() && e.target.value !== r.name && updateRoom(r.id, { name: e.target.value.trim() })}
              className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none"
            />
            <span className="shrink-0 text-xs tabular-nums text-muted">{fmtArea(Math.abs(polygonArea(r.points)))}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <TypeSelect value={r.type} onChange={(type) => updateRoom(r.id, { type })} className="flex-1 py-0.5 text-xs" />
            {onPick && (
              <button onClick={() => onPick(r)} className="shrink-0 rounded-lg bg-cream px-2 py-1 text-xs font-medium hover:bg-sand">
                {pickLabel}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

const btn = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition";

/* ---------- application ---------- */

export default function App() {
  const project = useProject((s) => s.project);
  const canUndo = useProject((s) => s.past.length > 0);
  const canRedo = useProject((s) => s.future.length > 0);
  const { commit, patch, undo, redo, load, setBackground, updateWall, updateOpening, updateRoom, remove } = useProject.getState();
  const { walls, openings, rooms, background } = project;

  const [step, setStep] = useState<Step>(() => (project.walls.length ? "3d" : "plan"));
  const [tool, setTool] = useState<Tool>("select");
  const [thickness, setThickness] = useState(0.2);
  const [height, setHeight] = useState(2.8);
  const [roomType, setRoomType] = useState<RoomType>("chambre");
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [calib, setCalib] = useState<{ a: Pt; b: Pt; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [mode, setMode] = useState<ViewMode>("maquette");
  const [cutaway, setCutaway] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [stopIdx, setStopIdx] = useState(-1);
  const [tourNonce, setTourNonce] = useState(0);
  const [walkAt, setWalkAt] = useState<WalkStart | null>(null);
  const exportRef = useRef<(() => void) | null>(null);
  // vidéo de la visite guidée
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const [rec, setRec] = useState<{ format: "paysage" | "vertical"; t0: number } | null>(null);
  const [recMenu, setRecMenu] = useState(false);
  const [recWhat, setRecWhat] = useState<"visite" | "construction">("visite");
  const [recTime, setRecTime] = useState(0);
  const [aiOpen, setAiOpen] = useState(false);
  const [roof, setRoof] = useState(false); // toit-terrasse (bouton Toit, et photo de façade)
  // valeurs à jour pour les captures qui s'enchaînent (film complet) : le panneau garde d'anciennes fonctions
  const live = useRef({ mode: "maquette" as ViewMode, roof: false });
  useEffect(() => {
    live.current = { mode, roof };
  });
  const shotRef = useRef<(() => () => void) | null>(null);
  const captureRef = useRef<CaptureAPI | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const say = useCallback((m: string) => setToast(m), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000 + toast.length * 45);
    return () => clearTimeout(t);
  }, [toast]);

  // tous les niveaux, avec leurs meubles (posés à la main, sinon automatiques) et les escaliers lus sur le plan
  const house = useMemo(() => houseLevels(project), [project]);
  const level = activeLevel(project);
  const multi = house.length > 1;
  const hasWalls = house.some((L) => L.walls.length > 0);
  const allRooms = useMemo(() => house.flatMap((L) => L.rooms), [house]);
  // à l'étage, le plan montre le niveau du dessous et la trémie de ses escaliers
  const below = level > 0 ? house[level - 1] : null;
  const ghost = useMemo(() => (below ? { walls: below.walls, stairs: below.furniture.filter((f) => f.kind === "escalier") } : undefined), [below]);
  // mobilier du niveau actif : celui placé à la main (design d'espace), sinon l'ameublement automatique
  const autoFurniture = useMemo(
    () => (project.furnished && !project.furniture ? furnish(rooms, walls, openings) : []),
    [project.furnished, project.furniture, rooms, walls, openings],
  );
  const furniture = project.furniture ?? autoFurniture;
  const [selectedF, setSelectedF] = useState<string | null>(null);
  const [designRoom, setDesignRoom] = useState<string | null>(null);
  // tourNonce : recrée la visite pour la relancer depuis le début
  const tour = useMemo(
    () => buildTour(house.map((L) => ({ rooms: L.rooms, walls: L.walls, openings: L.openings, furniture: L.furniture, z: L.z, flights: L.flights }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [house, tourNonce],
  );
  // film de présentation : les pièces de la visite guidée, sans les très petites (WC, douche, hall de moins de 3,5 m²)
  const filmRooms = useMemo(
    () =>
      (tour?.stops ?? [])
        .map((s) => allRooms.find((r) => r.id === s.roomId))
        .filter((r): r is Room => !!r && Math.abs(polygonArea(r.points)) >= 3.5 && r.type !== "wc")
        .map((r) => ({ id: r.id, name: r.name })),
    [tour, allRooms],
  );
  const walkStart = useMemo<WalkStart>(() => {
    if (walkAt) return walkAt;
    if (tour && tour.points.length > 1) {
      const [p, q] = tour.points;
      return { p, yaw: yawTowards(p, q), level: 0 };
    }
    const r = house[0]?.rooms[0];
    return { p: r ? roomAnchor(r) : { x: 5, y: 5 }, yaw: 0, level: 0 };
  }, [tour, house, walkAt]);
  /** point de vue sur le seuil d'une pièce, quel que soit son niveau */
  const visitRoom = (r: Room) => {
    const L = house.find((x) => x.rooms.some((y) => y.id === r.id)) ?? house[level];
    setWalkAt({ ...roomViewpoint(r, L.rooms, L.walls, L.openings, L.furniture), level: L.index });
    setMode("visite");
  };
  // niveau montré en maquette (au-dessus, rien) ; à l'étape Intérieur, c'est le niveau aménagé
  const [viewLevel, setViewLevel] = useState<number | null>(null);
  const shownLevel = step === "interieur" ? level : Math.min(viewLevel ?? house.length - 1, house.length - 1);
  const [labelsOn, setLabelsOn] = useState(true);
  // animation « la maison se construit »
  const [build, setBuild] = useState(0);
  const [building, setBuilding] = useState(false);
  const buildTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onBuilt = useRef<(() => void) | null>(null);
  const lastBuilt = useRef("");
  const builtDone = () => {
    if (buildTimer.current) clearTimeout(buildTimer.current);
    setBuilding(false);
    onBuilt.current?.();
    onBuilt.current = null;
  };
  const playBuild = (then?: () => void) => {
    setMode("maquette");
    setViewLevel(null);
    setBuild((b) => b + 1);
    setBuilding(true);
    onBuilt.current = then ?? null;
    // la 3D prévient à la fin ; filet de sécurité si elle a été quittée entre-temps
    if (buildTimer.current) clearTimeout(buildTimer.current);
    buildTimer.current = setTimeout(builtDone, buildDuration(house.length) * 1000 + 10_000);
  };
  useEffect(() => () => void (buildTimer.current && clearTimeout(buildTimer.current)), []);

  // raccourcis : annuler / rétablir, outils
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      // design d'espace : meuble sélectionné
      if (step === "interieur" && selectedF && !e.metaKey && !e.ctrlKey) {
        const list = useProject.getState().project.furniture ?? furniture;
        if (e.key === "Delete" || e.key === "Backspace") {
          commit(() => ({ furniture: removeF(list, selectedF) }));
          setSelectedF(null);
        } else if (e.key.toLowerCase() === "r") commit(() => ({ furniture: rotateF(list, selectedF, e.shiftKey ? -Math.PI / 2 : Math.PI / 2) }));
        else if (e.key === "Escape") setSelectedF(null);
        return;
      }
      if (step !== "plan" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t) setTool(t.id);
    };
    window.addEventListener("keydown", kd);
    return () => window.removeEventListener("keydown", kd);
  }, [step, undo, redo, selectedF, furniture, commit]);

  /* ----- fichiers ----- */
  const openFile = async (file: File) => {
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith(".json")) {
        const p = JSON.parse(await file.text()) as Project;
        if (!Array.isArray(p.walls)) throw new Error();
        load({ ...EMPTY_PROJECT, ...p });
        setFitKey((k) => k + 1);
        return say(`Projet « ${p.name} » ouvert.`);
      }
      if (name.endsWith(".dxf")) {
        setBusy("Lecture du DXF…");
        const res = importDxf(await file.text(), height);
        if (!res.walls.length) return say(`Aucun mur reconnu dans ce DXF (calques : ${res.report.layers.slice(0, 6).join(", ") || "aucun"}).`);
        const found = roomsFromPolygons(detectAllRooms(res.walls), res.texts);
        const ops = fixInteriorOpenings(res.openings, res.walls, found);
        commit(() => ({ walls: res.walls, openings: ops, rooms: found, background: null, furniture: undefined }));
        patch({ planFloor: false, furnished: true });
        if (level === 0) patch({ name: file.name.replace(/\.dxf$/i, "") });
        else alignBelow();
        setTool("select");
        setFitKey((k) => k + 1);
        const read = res.texts.length ? " (noms lus sur le plan)" : "";
        return say(`DXF importé : ${res.walls.length} murs, ${ops.length} ouvertures, ${found.length} pièces${read}. Vérifiez les types de pièces.`);
      }
      const isPdf = name.endsWith(".pdf") || file.type === "application/pdf";
      if (!isPdf && !file.type.startsWith("image/")) return say("Format non pris en charge : image (PNG, JPG), PDF, DXF ou projet .json.");
      setBusy(isPdf ? "Lecture du PDF…" : "Chargement de l'image…");
      let img: { src: string; w: number; h: number; pages?: number } = isPdf ? await readPdf(file) : await readImage(file);
      const pages = img.pages ?? 1;
      if (pages > 1) {
        // un plan par page (rez-de-chaussée, étage…) : on demande laquelle
        setBusy(null);
        const ans = prompt(`Ce PDF a ${pages} pages. Quelle page importer pour « ${house[level].name} » ?`, String(Math.min(level + 1, pages)));
        const page = parseInt(ans ?? "", 10);
        if (!page) return;
        setBusy("Lecture du PDF…");
        if (page !== 1) img = await readPdf(file, page);
      }
      const bg: Background = { src: img.src, widthPx: img.w, heightPx: img.h, scale: 15 / img.w, x: 0, y: 0, opacity: 0.4 };
      setBackground(bg);
      if (level === 0) patch({ name: file.name.replace(/\.[^.]+$/, "") });
      setStep("plan");
      setSelected(null);
      await readImagePlan(bg);
    } catch (err) {
      console.error(err);
      say("Impossible de lire ce fichier.");
    } finally {
      setBusy(null);
    }
  };

  /** lecture automatique des murs, ouvertures et pièces sur l'image du plan */
  const readImagePlan = async (bg: Background) => {
    setBusy("Lecture automatique du plan…");
    await new Promise((r) => setTimeout(r, 30)); // laisse le message s'afficher avant le calcul
    try {
      const res = await autoReadPlan(bg, height, setBusy);
      if (!res) {
        setTool("calibrate");
        setFitKey((k) => k + 1);
        return say("Je n'ai pas reconnu les murs sur cette image. Calibrez l'échelle sur une cote connue, puis tracez-les avec l'outil Mur.");
      }
      commit(() => ({
        background: { ...bg, scale: res.metersPerPx, auto: true, calibrated: bg.calibrated || res.scaleFrom === "surfaces" },
        walls: res.walls,
        openings: res.openings,
        rooms: res.rooms,
        furniture: undefined,
      }));
      // fidèle au plan : son dessin est plaqué au sol (meubles dessinés, jardin…), sans mobilier ajouté
      patch({ planFloor: true, furnished: false });
      if (activeLevel(useProject.getState().project) > 0) {
        const d = alignOffset(useProject.getState().project);
        if (d && Math.hypot(d.x, d.y) > 0.01) commit((p) => translateActive(p, d));
      }
      const count = (k: string) => res.openings.filter((o) => o.kind === k).length;
      setTool("select");
      setFitKey((k) => k + 1);
      say(
        `Plan lu : ${res.walls.length} murs, ${count("door")} portes, ${count("window") + count("baie")} fenêtres, ${res.rooms.length} pièces` +
          (res.named ? ` dont ${res.named} nommées d'après le plan.` : ".") +
          (res.scaleFrom === "surfaces"
            ? " Échelle réglée d'après les surfaces écrites sur le plan."
            : res.estimated
              ? " Échelle estimée : vérifiez-la avec l'outil Échelle sur une cote connue."
              : "") +
          " Complétez les murs manquants si besoin.",
      );
    } finally {
      setBusy(null);
    }
  };

  const saveJson = () => {
    const blob = new Blob([JSON.stringify(project)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${project.name.replace(/[^\p{L}\p{N}-]+/gu, "-") || "projet"}.plan3d.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const applyCalibration = () => {
    if (!calib) return;
    const real = parseFloat(calib.value.replace(",", "."));
    const measured = dist(calib.a, calib.b);
    if (!Number.isFinite(real) || real <= 0 || measured < 1e-6) return;
    const k = real / measured;
    commit((p) => {
      const o = p.background ? { x: p.background.x, y: p.background.y } : { x: 0, y: 0 };
      const sc = (q: Pt) => ({ x: o.x + (q.x - o.x) * k, y: o.y + (q.y - o.y) * k });
      // murs lus sur l'image : épaisseurs et largeurs d'ouvertures ont été mesurées sur l'image, elles suivent aussi
      const auto = !!p.background?.auto;
      return {
        background: p.background && { ...p.background, scale: p.background.scale * k, calibrated: true },
        walls: p.walls.map((w) => ({ ...w, a: sc(w.a), b: sc(w.b), thickness: auto ? Math.round(w.thickness * k * 100) / 100 : w.thickness })),
        openings: p.openings.map((x) => ({ ...x, t: x.t * k, width: auto ? Math.round(x.width * k * 100) / 100 : x.width })),
        rooms: p.rooms.map((r) => ({
          ...r,
          points: r.points.map(sc),
          stairs: r.stairs && { ...r.stairs, ...sc(r.stairs), w: r.stairs.w * k, d: r.stairs.d * k },
        })),
      };
    });
    setCalib(null);
    setFitKey((n) => n + 1);
    if (background?.auto) {
      setTool("select");
      say("Échelle réglée : le plan lu a été remis aux bonnes dimensions.");
    } else {
      setTool("wall");
      say("Échelle réglée. Tracez maintenant les murs par-dessus le plan.");
    }
  };

  /* ----- niveaux ----- */
  const gotoLevel = (i: number) => {
    patch(switchLevel(useProject.getState().project, i));
    setSelected(null);
    setSelectedF(null);
    setDesignRoom(null);
  };
  const newLevel = () => {
    commit((p) => addLevel(p));
    setSelected(null);
    setTool("select");
    say("Étage ajouté : ses façades reprennent celles du dessous. Importez son plan avec « Ouvrir », ou tracez ses cloisons.");
  };
  const dropLevel = (i: number) => {
    if (!confirm(`Supprimer « ${house[i].name} » et tout ce qu'il contient ?`)) return;
    commit((p) => removeLevel(p, i));
    setSelected(null);
  };
  /** pose le niveau actif sur celui du dessous (façades l'une sur l'autre) */
  const alignBelow = () => {
    const d = alignOffset(useProject.getState().project);
    if (!d) return say("Rien à caler : il faut des murs sur les deux niveaux.");
    if (Math.hypot(d.x, d.y) < 0.01) return say("Ce niveau est déjà calé sur celui du dessous.");
    commit((p) => translateActive(p, d));
    say(`Niveau calé sur celui du dessous (décalé de ${fmt(Math.hypot(d.x, d.y))}).`);
  };

  const autoRooms = () => {
    const polys = detectAllRooms(walls);
    if (!polys.length) return say("Aucune zone fermée : vérifiez que les murs se rejoignent.");
    // on garde les pièces déjà nommées, on ajoute les zones qui n'en ont pas
    const fresh = roomsFromPolygons(polys).filter((r) => {
      const c = roomAnchor(r);
      return !rooms.some((x) => pointInPolygon(c, x.points));
    });
    if (!fresh.length) return say("Toutes les pièces fermées sont déjà définies.");
    commit((p) => ({ rooms: [...p.rooms, ...fresh] }));
    say(`${fresh.length} pièce(s) détectée(s). Vérifiez leur type dans la liste.`);
  };

  const goto3d = (target: Step) => {
    if (target !== "plan" && !hasWalls) return say("Commencez par importer ou dessiner un plan.");
    if (target !== "plan" && !allRooms.length) say("Astuce : définissez les pièces (outil Pièce) pour avoir les sols, le mobilier et la visite guidée.");
    setStep(target);
    setSelected(null);
    if (target === "interieur" && mode !== "maquette") setMode("maquette");
    // en arrivant du plan, la maison se construit sous vos yeux (une fois par version du plan)
    if (target === "3d" && step === "plan") {
      const sig = house.map((L) => `${L.walls.length}:${L.walls[0]?.id ?? ""}:${L.rooms.length}`).join("|");
      if (sig !== lastBuilt.current) {
        lastBuilt.current = sig;
        playBuild();
      }
    }
  };

  const downloadBlob = (blob: Blob, name: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  /** Filme la visite guidée ou la construction de la maison (le canvas 3D seul, sans l'interface) et télécharge la vidéo à la fin. */
  const startRecording = (format: "paysage" | "vertical", what: "visite" | "construction" = "visite") => {
    setRecMenu(false);
    if (what === "visite" && !tour) return say("Définissez au moins une pièce pour générer la visite guidée.");
    if (typeof MediaRecorder === "undefined") return say("Ce navigateur ne permet pas d'enregistrer une vidéo. Essayez Chrome, Edge ou Safari récent.");
    setRec({ format, t0: 0 }); // le cadre change de format avant de filmer
    setMode(what === "visite" ? "guidee" : "maquette");
    setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) return setRec(null);
      const mime = ["video/mp4;codecs=avc3.42E01E", "video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
      const stream = canvas.captureStream(30);
      const r = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 8_000_000 });
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = r.mimeType || "video/webm";
        const blob = new Blob(chunks, { type });
        const slug = project.name.replace(/[^\p{L}\p{N}-]+/gu, "-") || "maison";
        downloadBlob(blob, `${what}-${slug}${format === "vertical" ? "-vertical" : ""}.${type.includes("mp4") ? "mp4" : "webm"}`);
        setRec(null);
        say(`Vidéo enregistrée (${(blob.size / 1e6).toFixed(1)} Mo).`);
      };
      if (what === "visite") {
        // la visite repart du début au moment où l'on filme
        setStopIdx(-1);
        setPlaying(true);
        setTourNonce((n) => n + 1);
      } else playBuild(() => setTimeout(stopRecording, 1200)); // on laisse voir la maison finie un instant
      r.start(1000);
      recorder.current = r;
      setRec({ format, t0: Date.now() });
    }, 450);
  };
  const stopRecording = () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
    recorder.current = null;
  };
  useEffect(() => {
    if (!rec?.t0) return;
    const id = setInterval(() => setRecTime(Date.now() - rec.t0), 500);
    return () => clearInterval(id);
  }, [rec?.t0]);

  const enterVR = async () => {
    const ok = typeof navigator !== "undefined" && "xr" in navigator && (await (navigator as Navigator & { xr: { isSessionSupported: (m: string) => Promise<boolean> } }).xr.isSessionSupported("immersive-vr").catch(() => false));
    if (!ok) return say("Casque VR non détecté. Ouvrez cette page dans le navigateur d'un casque (Meta Quest…) pour visiter en VR.");
    if (mode === "maquette") setMode("visite");
    getXRStore().enterVR();
  };

  const sel = useMemo(() => {
    if (!selected) return null;
    const w = walls.find((x) => x.id === selected);
    if (w) return { kind: "wall" as const, w };
    const o = openings.find((x) => x.id === selected);
    if (o) return { kind: "opening" as const, o };
    const r = rooms.find((x) => x.id === selected);
    if (r) return { kind: "room" as const, r };
    return null;
  }, [selected, walls, openings, rooms]);

  const empty = !multi && !walls.length && !background;

  return (
    <div className="flex h-dvh flex-col">
      {/* ---------- en-tête ---------- */}
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-paper px-4">
        <div className="flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-xl bg-ink text-paper">
            <House className="size-5" strokeWidth={1.8} />
          </div>
          <div className="leading-tight">
            <div className="font-display text-[17px] font-semibold">Plan3D</div>
            <input
              key={project.name}
              defaultValue={project.name}
              onBlur={(e) => e.target.value.trim() && patch({ name: e.target.value.trim() })}
              className="w-56 truncate bg-transparent text-xs text-muted outline-none focus:text-ink"
              aria-label="Nom du projet"
            />
          </div>
        </div>

        <nav className="mx-auto flex items-center rounded-full bg-cream p-1">
          {STEPS.map((s, i) => {
            const active = step === s.id;
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                onClick={() => goto3d(s.id)}
                className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${active ? "bg-ink text-paper shadow-sm" : "text-muted hover:text-ink"}`}
              >
                <span className={`grid size-5 place-items-center rounded-full text-[11px] ${active ? "bg-accent text-white" : "bg-sand text-ink"}`}>{i + 1}</span>
                <Icon className="size-4" />
                {s.label}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-1">
          <button onClick={undo} disabled={!canUndo} title="Annuler (⌘Z)" className={`${btn} px-2 text-ink hover:bg-cream disabled:opacity-30`}>
            <Undo2 className="size-4" />
          </button>
          <button onClick={redo} disabled={!canRedo} title="Rétablir (⇧⌘Z)" className={`${btn} px-2 text-ink hover:bg-cream disabled:opacity-30`}>
            <Redo2 className="size-4" />
          </button>
          <span className="mx-1 h-6 w-px bg-line" />
          <button onClick={() => fileRef.current?.click()} className={`${btn} text-ink hover:bg-cream`}>
            <FolderOpen className="size-4" /> Ouvrir
          </button>
          <button onClick={saveJson} disabled={empty} className={`${btn} text-ink hover:bg-cream disabled:opacity-30`}>
            <Save className="size-4" /> Enregistrer
          </button>
          <button
            onClick={() => {
              if (!empty && !confirm("Commencer un nouveau projet ? Le projet actuel sera remplacé (pensez à l'enregistrer).")) return;
              load(EMPTY_PROJECT);
              setStep("plan");
              setTool("select");
              setSelected(null);
              setFitKey((k) => k + 1);
            }}
            className={`${btn} text-ink hover:bg-cream`}
          >
            <FilePlus2 className="size-4" /> Nouveau
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept="image/*,.pdf,.dxf,.json,application/pdf"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) openFile(f);
          }}
        />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---------- barre d'outils du plan ---------- */}
        {step === "plan" && (
          <div className="flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-line bg-paper py-3">
            {TOOLS.map((t) => {
              const Icon = t.icon;
              const active = tool === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTool(t.id)}
                  title={`${t.label} (${t.key.toUpperCase()})`}
                  className={`flex w-16 flex-col items-center gap-1 rounded-xl py-2 text-[11px] font-medium transition ${active ? "bg-ink text-paper" : "text-muted hover:bg-cream hover:text-ink"}`}
                >
                  <Icon className="size-5" strokeWidth={1.7} />
                  {t.label}
                </button>
              );
            })}
            <div className="mt-auto flex flex-col items-center gap-1">
              <button onClick={() => setFitKey((k) => k + 1)} title="Recadrer" className="rounded-xl p-2.5 text-muted hover:bg-cream hover:text-ink">
                <Maximize2 className="size-5" strokeWidth={1.7} />
              </button>
            </div>
          </div>
        )}

        {/* ---------- zone centrale ---------- */}
        <main className="relative min-w-0 flex-1 overflow-hidden">
          {step === "plan" ? (
            <Editor2D
              tool={tool}
              wallThickness={thickness}
              wallHeight={height}
              roomType={roomType}
              selected={selected}
              onSelect={setSelected}
              onCalibrate={(a, b) => setCalib({ a, b, value: dist(a, b).toFixed(2) })}
              onMessage={say}
              fitKey={fitKey}
              ghost={ghost}
            />
          ) : hasWalls ? (
            <div className={rec?.format === "vertical" ? "absolute inset-0 flex justify-center" : "relative size-full"}>
            {/* cadre 9:16 pendant l'enregistrement vertical (Reels, TikTok) */}
            <div className={rec?.format === "vertical" ? "relative aspect-[9/16] h-full min-w-0 max-w-full overflow-hidden shadow-2xl" : "relative size-full"}>
            <Viewer3D
              project={project}
              levels={house}
              showLevel={shownLevel}
              labels={labelsOn}
              build={build}
              building={building}
              onBuildEnd={builtDone}
              mode={mode}
              cutaway={cutaway}
              tour={tour}
              playing={playing}
              walkStart={walkStart}
              onStop={setStopIdx}
              exportRef={exportRef}
              design={
                step === "interieur" && mode === "maquette"
                  ? {
                      level,
                      selectedId: selectedF,
                      onSelect: setSelectedF,
                      onCommit: (id, x, y) => commit(() => ({ furniture: moveF(furniture, id, x, y, rooms) })),
                      onPickRoom: (id) => id && setDesignRoom(id),
                    }
                  : undefined
              }
              canvasRef={canvasRef}
              roof={roof && mode === "maquette"}
              shotRef={shotRef}
              captureRef={captureRef}
              onTourEnd={() => recorder.current && setTimeout(stopRecording, 800)}
            />
            </div>
            </div>
          ) : null}

          {/* accueil : plan vide */}
          {step === "plan" && empty && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
              <div className="pointer-events-auto w-full max-w-xl rounded-3xl bg-paper/95 p-8 shadow-[0_20px_60px_-20px_rgba(42,38,32,0.35)] ring-1 ring-line backdrop-blur">
                <h1 className="font-display text-3xl font-semibold tracking-tight">Du plan à la visite 3D</h1>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">
                  Importez le plan de l&apos;architecte, obtenez la maison en 3D, visitez-la pièce par pièce puis aménagez l&apos;intérieur.
                </p>
                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  <button onClick={() => fileRef.current?.click()} className="group rounded-2xl bg-ink p-4 text-left text-paper transition hover:-translate-y-0.5">
                    <Upload className="size-5 text-accent" />
                    <div className="mt-3 font-medium">Importer un plan</div>
                    <div className="mt-0.5 text-xs text-paper/60">PDF, image ou DXF</div>
                  </button>
                  <button
                    onClick={() => {
                      load(SAMPLE_PROJECT);
                      setFitKey((k) => k + 1);
                      setTool("select");
                    }}
                    className="rounded-2xl bg-accent-soft p-4 text-left ring-1 ring-[#efc6ae] transition hover:-translate-y-0.5"
                  >
                    <House className="size-5 text-accent" />
                    <div className="mt-3 font-medium">Villa d&apos;exemple</div>
                    <div className="mt-0.5 text-xs text-muted">3 chambres, 140 m²</div>
                  </button>
                </div>
                <p className="mt-4 text-sm text-muted">
                  Maison à étage ?{" "}
                  <button
                    onClick={() => {
                      load(SAMPLE_DUPLEX);
                      setFitKey((k) => k + 1);
                      setTool("select");
                    }}
                    className="font-medium text-accent underline decoration-accent-soft underline-offset-2 hover:decoration-accent"
                  >
                    Ouvrir le duplex d&apos;exemple
                  </button>{" "}
                  (R+1 : escalier, mezzanine, terrasse).
                </p>
                <p className="mt-2 text-xs text-muted">
                  Pas de plan sous la main ? Plans d&apos;essai :{" "}
                  <a href="/exemples/maison-b.pdf" download className="font-medium text-ink underline decoration-sand underline-offset-2 hover:decoration-accent">PDF</a>
                  {" · "}
                  <a href="/exemples/maison-b.png" download className="font-medium text-ink underline decoration-sand underline-offset-2 hover:decoration-accent">image</a>
                  {" · "}
                  <a href="/exemples/maison-b.dxf" download className="font-medium text-ink underline decoration-sand underline-offset-2 hover:decoration-accent">DXF (AutoCAD)</a>
                </p>
              </div>
            </div>
          )}

          {/* calibrage */}
          {calib && (
            <div className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-3 rounded-2xl bg-paper px-4 py-3 shadow-lg ring-1 ring-line">
              <Ruler className="size-4 text-leaf" />
              <span className="text-sm">Longueur réelle de ce segment :</span>
              <input
                autoFocus
                value={calib.value}
                onChange={(e) => setCalib({ ...calib, value: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && applyCalibration()}
                className="w-20 rounded-lg border border-line bg-white px-2 py-1 text-right tabular-nums outline-none focus:border-leaf"
                inputMode="decimal"
              />
              <span className="text-sm text-muted">m</span>
              <button onClick={applyCalibration} className={`${btn} bg-leaf text-white`}>
                <Check className="size-4" /> Valider
              </button>
              <button onClick={() => setCalib(null)} className="rounded-full p-1.5 text-muted hover:bg-cream">
                <X className="size-4" />
              </button>
            </div>
          )}

          {/* ---------- commandes 3D ---------- */}
          {step !== "plan" && hasWalls && rec && (
            <div className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full bg-ink py-1.5 pl-4 pr-1.5 text-sm text-paper shadow-lg">
              <span className="size-2.5 animate-pulse rounded-full bg-red-500" />
              {rec.t0 ? (
                <span className="tabular-nums">
                  Enregistrement · {Math.floor(recTime / 60000)}:{String(Math.floor(recTime / 1000) % 60).padStart(2, "0")}
                </span>
              ) : (
                <span>Préparation…</span>
              )}
              <button onClick={stopRecording} className={`${btn} bg-paper text-ink hover:bg-cream`}>
                <Square className="size-3.5 fill-current" /> Arrêter et télécharger
              </button>
            </div>
          )}

          {step !== "plan" && hasWalls && !rec && (
            <>
              <div className="scroll-soft absolute left-1/2 top-4 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-full bg-paper/95 p-1 shadow-lg ring-1 ring-line backdrop-blur">
                {(
                  [
                    { id: "maquette", label: "Maquette", icon: Box },
                    { id: "visite", label: "Visite libre", icon: Footprints },
                    { id: "guidee", label: "Visite guidée", icon: Route },
                  ] as const
                ).map((m) => {
                  const Icon = m.icon;
                  const active = mode === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => {
                        if (m.id === "guidee") {
                          if (!tour) return say("Définissez au moins une pièce pour générer la visite guidée.");
                          setPlaying(true);
                          setStopIdx(-1);
                          setTourNonce((n) => n + 1);
                        }
                        if (m.id === "visite") setWalkAt(null);
                        setMode(m.id);
                      }}
                      className={`${btn} ${active ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}
                    >
                      <Icon className="size-4" /> {m.label}
                    </button>
                  );
                })}
                <span className="mx-1 h-6 w-px bg-line" />
                {mode === "maquette" && (
                  <>
                    <button
                      onClick={() => {
                        // la coupe montre l'intérieur : elle retire le toit
                        if (roof) {
                          setRoof(false);
                          setCutaway(true);
                        } else setCutaway((c) => !c);
                      }}
                      className={`${btn} ${cutaway && !roof ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"}`} title="Murs coupés à 1,10 m pour voir l'intérieur">
                      <Scissors className="size-4" /> Coupe
                    </button>
                    <button onClick={() => setRoof((v) => !v)} className={`${btn} ${roof ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"}`} title="Toit-terrasse sur la maison (vue de l'extérieur)">
                      <House className="size-4" /> Toit
                    </button>
                    <button onClick={() => setLabelsOn((v) => !v)} className={`${btn} ${labelsOn ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"}`} title="Nom et surface de chaque pièce">
                      <Tag className="size-4" /> Noms
                    </button>
                    <button onClick={() => playBuild()} disabled={building} className={`${btn} text-muted hover:text-ink disabled:opacity-40`} title="Voir la maison se construire depuis le plan">
                      <Hammer className="size-4" /> Construire
                    </button>
                  </>
                )}
                <button onClick={enterVR} className={`${btn} text-muted hover:text-ink`} title="Visiter avec un casque VR">
                  <Glasses className="size-4" /> VR
                </button>
                <button onClick={() => exportRef.current?.()} className={`${btn} text-muted hover:text-ink`} title="Télécharger le modèle 3D (GLB) pour SketchUp, Blender, Unreal…">
                  <Download className="size-4" /> GLB
                </button>
                <button
                  onClick={() => {
                    setAiOpen((v) => !v);
                    setRecMenu(false);
                  }}
                  className={`${btn} ${aiOpen ? "bg-accent text-white" : "text-accent hover:bg-accent-soft"}`}
                  title="Photo et vidéo réalistes (IA open source sur GPU)"
                >
                  <Sparkles className="size-4" /> Rendu IA
                </button>
                <button
                  onClick={() => {
                    setRecMenu((v) => !v);
                    setAiOpen(false);
                  }}
                  className={`${btn} ${recMenu ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"}`}
                  title="Filmer la visite guidée"
                >
                  <Clapperboard className="size-4" /> Vidéo
                </button>
              </div>

              {recMenu && (
                <div className="absolute left-1/2 top-[68px] z-10 w-[340px] -translate-x-1/2 rounded-2xl bg-paper p-3 shadow-xl ring-1 ring-line">
                  <div className="flex gap-1 rounded-full bg-cream p-1 text-xs font-medium">
                    {(
                      [
                        ["visite", "La visite guidée"],
                        ["construction", "La construction"],
                      ] as const
                    ).map(([k, l]) => (
                      <button key={k} onClick={() => setRecWhat(k)} className={`flex-1 rounded-full py-1.5 ${recWhat === k ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}>
                        {l}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <button onClick={() => startRecording("paysage", recWhat)} className="rounded-xl bg-white p-3 text-left ring-1 ring-line transition hover:ring-accent">
                      <Monitor className="size-5 text-accent" />
                      <div className="mt-2 text-sm font-medium">Paysage</div>
                      <div className="text-xs text-muted">YouTube, présentation client</div>
                    </button>
                    <button onClick={() => startRecording("vertical", recWhat)} className="rounded-xl bg-white p-3 text-left ring-1 ring-line transition hover:ring-accent">
                      <Smartphone className="size-5 text-accent" />
                      <div className="mt-2 text-sm font-medium">Vertical 9:16</div>
                      <div className="text-xs text-muted">Reels, TikTok, statuts</div>
                    </button>
                  </div>
                  <p className="px-1 pt-2 text-xs leading-relaxed text-muted">
                    {recWhat === "visite"
                      ? "La visite guidée repart du début et la vidéo se télécharge à la fin du parcours (ou quand vous l'arrêtez)."
                      : "La maison sort du plan, niveau par niveau, pendant que la caméra tourne autour. La vidéo se télécharge à la fin."}
                  </p>
                </div>
              )}

              {multi && mode === "maquette" && (
                <div className="absolute left-4 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1 rounded-2xl bg-paper/95 p-1.5 shadow-lg ring-1 ring-line backdrop-blur">
                  <div className="flex items-center justify-center gap-1 px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                    <Layers className="size-3" /> Niveaux
                  </div>
                  {[...house].reverse().map((L) => {
                    const on = L.index === shownLevel;
                    return (
                      <button
                        key={L.index}
                        onClick={() => {
                          if (step === "interieur") {
                            patch(switchLevel(useProject.getState().project, L.index));
                            setSelectedF(null);
                            setDesignRoom(null);
                          } else setViewLevel(L.index);
                        }}
                        className={`rounded-xl px-3 py-1.5 text-left text-xs font-medium transition ${on ? "bg-ink text-paper" : "text-muted hover:bg-cream hover:text-ink"}`}
                        title={step === "interieur" ? `Aménager : ${L.name}` : `Voir jusqu'à : ${L.name}`}
                      >
                        {L.name}
                      </button>
                    );
                  })}
                </div>
              )}

              {mode === "visite" && (
                <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-ink/80 px-4 py-2 text-sm text-paper backdrop-blur">
                  Glissez pour regarder · <b>Z Q S D</b> ou flèches pour avancer
                </div>
              )}

              {mode === "guidee" && tour && (
                <div className="absolute inset-x-0 bottom-5 flex flex-col items-center gap-3 px-6">
                  {stopIdx >= 0 && (
                    <div key={stopIdx} className="rounded-2xl bg-paper/95 px-5 py-2.5 text-center shadow-lg ring-1 ring-line">
                      <div className="text-[11px] uppercase tracking-wider text-muted">
                        Étape {stopIdx + 1} / {tour.stops.length}
                        {multi && ` · ${house[tour.stops[stopIdx].level]?.name ?? ""}`}
                      </div>
                      <div className="font-display text-xl font-semibold">{tour.stops[stopIdx].name}</div>
                      {(() => {
                        const r = allRooms.find((x) => x.id === tour.stops[stopIdx].roomId);
                        return r ? <div className="text-xs text-muted">{fmtArea(Math.abs(polygonArea(r.points)))}</div> : null;
                      })()}
                    </div>
                  )}
                  <div className="flex max-w-full items-center gap-2 rounded-full bg-ink/85 p-1.5 pr-3 text-paper backdrop-blur">
                    <button onClick={() => setPlaying((p) => !p)} className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-white">
                      {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
                    </button>
                    <button
                      onClick={() => {
                        setStopIdx(-1);
                        setPlaying(true);
                        setTourNonce((n) => n + 1);
                      }}
                      className="grid size-9 shrink-0 place-items-center rounded-full hover:bg-white/10"
                      title="Recommencer"
                    >
                      <RotateCcw className="size-4" />
                    </button>
                    <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                      {tour.stops.map((s, i) => (
                        <span key={s.roomId} className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${i === stopIdx ? "bg-paper text-ink" : i < stopIdx ? "text-paper/80" : "text-paper/45"}`}>
                          {s.name}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {step !== "plan" && !hasWalls && (
            <div className="grid size-full place-items-center">
              <div className="text-center">
                <p className="text-muted">Aucun plan pour l&apos;instant.</p>
                <button onClick={() => setStep("plan")} className={`${btn} mt-3 bg-ink text-paper`}>
                  <Ruler className="size-4" /> Aller au plan
                </button>
              </div>
            </div>
          )}

          {step !== "plan" && hasWalls && aiOpen && !rec && (
            <RenduIA
              canvasRef={canvasRef}
              capture={captureRef}
              stops={tour?.stops.map((s) => (multi ? `${house[s.level]?.name} · ${s.name}` : s.name)) ?? []}
              stopRooms={tour?.stops.map((s) => s.roomId) ?? []}
              filmRooms={filmRooms}
              currentStop={stopIdx}
              onClose={() => setAiOpen(false)}
              name={project.name.replace(/[^\p{L}\p{N}-]+/gu, "-") || "maison"}
              view={mode === "maquette" ? "maquette" : "interieur"}
              prepare={async (kind) => {
                // l'IA comprend mal le dessin du plan plaqué au sol et les pièces vides :
                // le temps de la capture, vrais sols et meubles, puis tout revient.
                // Façade : le toit et le cadrage restent, on voit ce qui a été envoyé (bouton Toit pour l'ôter).
                const p = useProject.getState().project;
                const prev = { planFloor: p.planFloor, furnished: p.furnished };
                patch({ planFloor: false, furnished: p.furniture ? p.furnished : true });
                const hadRoof = live.current.roof;
                const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
                // façade et vue en coupe : vue maquette ; pièces : vue intérieure (plafonds, tous les niveaux)
                const outside = kind !== "interieur";
                const wasMode = live.current.mode;
                if (outside && wasMode !== "maquette") {
                  setMode("maquette");
                  await wait(700);
                } else if (!outside && wasMode === "maquette") {
                  setMode("visite");
                  await wait(700);
                }
                if (kind === "facade") {
                  setRoof(true);
                  await wait(100);
                  shotRef.current?.();
                }
                if (kind === "aerien") setRoof(false); // vue en coupe : sans toit
                await wait(900);
                return () => {
                  if (kind === "aerien" && hadRoof) setRoof(true);
                  // une pièce filmée depuis la maquette : on y revient
                  if (!outside && wasMode === "maquette") setMode("maquette");
                  patch(prev);
                };
              }}
            />
          )}

          {(toast || busy) && (
            <div className="pointer-events-none absolute bottom-5 left-5 max-w-md rounded-2xl bg-ink px-4 py-3 text-sm text-paper shadow-lg">{busy ?? toast}</div>
          )}
        </main>

        {/* ---------- panneau latéral ---------- */}
        <aside className="scroll-soft w-[320px] shrink-0 overflow-y-auto border-l border-line bg-paper">
          {step === "plan" && (
            <>
              <Section
                title="Niveaux"
                right={
                  <button onClick={newLevel} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft" title="Ajouter un étage au-dessus">
                    <Plus className="size-3.5" /> Étage
                  </button>
                }
              >
                <div className="space-y-1">
                  {[...house].reverse().map((L) => {
                    const on = L.index === level;
                    return (
                      <div key={L.index} className={`flex items-center gap-2 rounded-xl px-2.5 py-1.5 ${on ? "bg-ink text-paper" : "bg-white ring-1 ring-line"}`}>
                        {on ? (
                          <input
                            key={L.name}
                            defaultValue={L.name}
                            onBlur={(e) => e.target.value.trim() && e.target.value !== L.name && commit((p) => renameLevel(p, L.index, e.target.value.trim()))}
                            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                            className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none"
                            aria-label="Nom du niveau"
                          />
                        ) : (
                          <button onClick={() => gotoLevel(L.index)} className="min-w-0 flex-1 truncate text-left text-sm font-medium">
                            {L.name}
                          </button>
                        )}
                        <span className="shrink-0 text-[11px] tabular-nums opacity-70">{L.z > 0 ? `+${fmt(L.z)}` : "sol"}</span>
                        {multi && (
                          <button onClick={() => dropLevel(L.index)} className="shrink-0 rounded-md p-0.5 opacity-60 hover:opacity-100" title="Supprimer ce niveau">
                            <Trash2 className="size-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {level > 0 && (
                  <div className="space-y-2 rounded-xl bg-cream/70 p-2.5">
                    <p className="text-xs leading-relaxed text-muted">
                      Le niveau du dessous apparaît en gris. Importez le plan de cet étage avec « Ouvrir » : il est calé dessus automatiquement.
                    </p>
                    <div className="flex items-center gap-1">
                      <button onClick={() => alignBelow()} className={`${btn} flex-1 justify-center bg-white px-2 text-xs text-ink ring-1 ring-line hover:bg-sand`} title="Poser les façades de cet étage sur celles du dessous">
                        <Magnet className="size-3.5" /> Caler
                      </button>
                      {(
                        [
                          [ArrowLeft, -0.1, 0],
                          [ArrowUp, 0, -0.1],
                          [ArrowDown, 0, 0.1],
                          [ArrowRight, 0.1, 0],
                        ] as const
                      ).map(([Icon, dx, dy], k) => (
                        <button key={k} onClick={() => commit((p) => translateActive(p, { x: dx, y: dy }))} className="grid size-7 place-items-center rounded-lg bg-white ring-1 ring-line hover:bg-sand" title="Décaler de 10 cm">
                          <Icon className="size-3.5" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </Section>

              <Section title={TOOLS.find((t) => t.id === tool)?.label ?? ""}>
                <p className="text-sm leading-relaxed text-muted">{HELP[tool]}</p>
                {tool === "wall" && (
                  <div className="space-y-2 pt-1">
                    <NumField key={`t${thickness}`} label="Épaisseur" value={thickness} min={0.05} onCommit={setThickness} />
                    <NumField key={`h${height}`} label="Hauteur" value={height} min={1} onCommit={setHeight} />
                    <div className="flex gap-1.5 pt-1">
                      {[
                        ["Porteur", 0.25],
                        ["Standard", 0.2],
                        ["Cloison", 0.1],
                      ].map(([l, v]) => (
                        <button
                          key={l}
                          onClick={() => setThickness(v as number)}
                          className={`flex-1 rounded-lg py-1 text-xs font-medium ${thickness === v ? "bg-ink text-paper" : "bg-cream text-muted hover:text-ink"}`}
                        >
                          {l} · {Math.round((v as number) * 100)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {tool === "room" && (
                  <div className="flex items-center justify-between gap-3 pt-1 text-sm">
                    <span className="text-muted">Type</span>
                    <TypeSelect value={roomType} onChange={setRoomType} className="flex-1" />
                  </div>
                )}
                {(["door", "window", "baie", "passage"] as Tool[]).includes(tool) && (
                  <p className="text-xs text-muted">
                    Taille par défaut : {fmt(OPENING_DEFAULTS[tool as OpeningKind].width)} × {fmt(OPENING_DEFAULTS[tool as OpeningKind].height)}, modifiable ensuite avec l&apos;outil Sélection.
                  </p>
                )}
              </Section>

              {sel && (
                <Section
                  title={sel.kind === "wall" ? "Mur sélectionné" : sel.kind === "opening" ? OPENING_DEFAULTS[sel.o.kind].label : "Pièce"}
                  right={
                    <button
                      onClick={() => {
                        remove(selected!);
                        setSelected(null);
                      }}
                      className="rounded-lg p-1.5 text-muted hover:bg-accent-soft hover:text-accent"
                      title="Supprimer"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  }
                >
                  {sel.kind === "wall" && (
                    <>
                      <NumField
                        key={`L${sel.w.id}${wallLength(sel.w)}`}
                        label="Longueur"
                        value={wallLength(sel.w)}
                        min={0.1}
                        onCommit={(L) => updateWall(sel.w.id, { b: add(sel.w.a, mul(wallDir(sel.w), L)) })}
                      />
                      <NumField key={`T${sel.w.id}${sel.w.thickness}`} label="Épaisseur" value={sel.w.thickness} min={0.05} onCommit={(v) => updateWall(sel.w.id, { thickness: v })} />
                      <NumField key={`H${sel.w.id}${sel.w.height}`} label="Hauteur" value={sel.w.height} min={1} onCommit={(v) => updateWall(sel.w.id, { height: v })} />
                    </>
                  )}
                  {sel.kind === "opening" && (
                    <>
                      <div className="grid grid-cols-4 gap-1">
                        {(Object.keys(OPENING_DEFAULTS) as OpeningKind[]).map((k) => (
                          <button
                            key={k}
                            onClick={() => updateOpening(sel.o.id, { kind: k, height: OPENING_DEFAULTS[k].height, sill: OPENING_DEFAULTS[k].sill })}
                            className={`rounded-lg py-1 text-[11px] font-medium ${sel.o.kind === k ? "bg-ink text-paper" : "bg-cream text-muted hover:text-ink"}`}
                          >
                            {OPENING_DEFAULTS[k].label}
                          </button>
                        ))}
                      </div>
                      <NumField key={`W${sel.o.id}${sel.o.width}`} label="Largeur" value={sel.o.width} min={0.3} onCommit={(v) => updateOpening(sel.o.id, { width: v })} />
                      <NumField key={`Hh${sel.o.id}${sel.o.height}`} label="Hauteur" value={sel.o.height} min={0.3} onCommit={(v) => updateOpening(sel.o.id, { height: v })} />
                      {sel.o.kind === "window" && (
                        <NumField key={`S${sel.o.id}${sel.o.sill}`} label="Allège" value={sel.o.sill} onCommit={(v) => updateOpening(sel.o.id, { sill: v })} />
                      )}
                      <NumField key={`P${sel.o.id}${sel.o.t}`} label="Position sur le mur" value={sel.o.t} onCommit={(v) => updateOpening(sel.o.id, { t: v })} />
                    </>
                  )}
                  {sel.kind === "room" && (
                    <>
                      <label className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-muted">Nom</span>
                        <input
                          key={sel.r.id + sel.r.name}
                          defaultValue={sel.r.name}
                          onBlur={(e) => e.target.value.trim() && updateRoom(sel.r.id, { name: e.target.value.trim() })}
                          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                          className="w-40 rounded-lg border border-line bg-white px-2 py-1 outline-none focus:border-accent"
                        />
                      </label>
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-muted">Type</span>
                        <TypeSelect value={sel.r.type} onChange={(type) => updateRoom(sel.r.id, { type })} className="w-40" />
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted">Surface</span>
                        <span className="tabular-nums">{fmtArea(Math.abs(polygonArea(sel.r.points)))}</span>
                      </div>
                      {!sel.r.stairs && (
                        <button
                          onClick={() => updateRoom(sel.r.id, { stairs: defaultStairs(sel.r) })}
                          className={`${btn} w-full justify-center bg-cream text-xs text-ink hover:bg-sand`}
                          title="Volée droite le long du plus grand côté ; elle relie ce niveau à celui du dessus"
                        >
                          <Plus className="size-3.5" /> Ajouter un escalier
                        </button>
                      )}
                      {sel.r.stairs && (
                        <div className="flex gap-1.5 pt-1">
                          <button
                            onClick={() => updateRoom(sel.r.id, { stairs: { ...sel.r.stairs!, rot: sel.r.stairs!.rot + Math.PI } })}
                            className={`${btn} flex-1 justify-center bg-cream px-2 text-xs text-ink hover:bg-sand`}
                            title="L'escalier monte dans l'autre sens"
                          >
                            <ArrowLeftRight className="size-3.5" /> Sens de l&apos;escalier
                          </button>
                          <button onClick={() => updateRoom(sel.r.id, { stairs: undefined })} className={`${btn} justify-center bg-cream px-2 text-xs text-ink hover:bg-sand`} title="Retirer l'escalier lu sur le plan">
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </Section>
              )}

              {background && (
                <Section
                  title="Plan importé"
                  right={
                    <button onClick={() => setBackground(null)} className="rounded-lg p-1.5 text-muted hover:bg-accent-soft hover:text-accent" title="Retirer le plan">
                      <Trash2 className="size-4" />
                    </button>
                  }
                >
                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted">Opacité</span>
                    <input
                      type="range"
                      min={0.1}
                      max={1}
                      step={0.05}
                      value={background.opacity}
                      onChange={(e) => patch({ background: { ...background, opacity: +e.target.value } })}
                      className="w-40 accent-[#d9622b]"
                    />
                  </label>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">Taille du plan</span>
                    <span className="tabular-nums">
                      {fmt(background.widthPx * background.scale)} × {fmt(background.heightPx * background.scale)}
                    </span>
                  </div>
                  {background.auto && !background.calibrated && (
                    <p className="rounded-xl bg-accent-soft px-3 py-2 text-xs leading-relaxed text-ink">
                      Échelle <b>estimée</b> d&apos;après l&apos;épaisseur des murs. Pour des dimensions exactes, cliquez les deux bouts
                      d&apos;une cote connue.
                    </p>
                  )}
                  <button onClick={() => setTool("calibrate")} className={`${btn} w-full justify-center bg-cream text-ink hover:bg-sand`}>
                    <Ruler className="size-4" /> {background.calibrated ? "Recalibrer l'échelle" : "Calibrer l'échelle"}
                  </button>
                  <button
                    onClick={() => {
                      if (walls.length && !confirm("Relire le plan remplace les murs, ouvertures et pièces actuels. Continuer ?")) return;
                      readImagePlan(background);
                    }}
                    className={`${btn} w-full justify-center bg-cream text-ink hover:bg-sand`}
                  >
                    <WandSparkles className="size-4" /> Relire le plan automatiquement
                  </button>
                </Section>
              )}

              <Section
                title={`Pièces · ${rooms.length}`}
                right={
                  walls.length > 0 && (
                    <button onClick={autoRooms} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft" title="Détecter toutes les pièces fermées">
                      <WandSparkles className="size-3.5" /> Détecter
                    </button>
                  )
                }
              >
                <RoomList rooms={rooms} />
              </Section>

              <div className="p-5">
                <button
                  onClick={() => goto3d("3d")}
                  disabled={!hasWalls}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3 font-medium text-white shadow-sm transition hover:brightness-105 disabled:opacity-40"
                >
                  <Box className="size-5" /> Voir la maison en 3D
                </button>
                <p className="mt-3 text-center text-xs text-muted">
                  {walls.length} murs · {openings.length} ouvertures · {fmtArea(rooms.reduce((s, r) => s + Math.abs(polygonArea(r.points)), 0))} habitables
                </p>
              </div>
            </>
          )}

          {step === "3d" && (
            <>
              <Section title="La maison">
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    [allRooms.length, "pièces"],
                    [fmtArea(allRooms.reduce((s, r) => s + Math.abs(polygonArea(r.points)), 0)).replace(" m²", ""), "m² habitables"],
                    [house.reduce((n, L) => n + L.openings.filter((o) => o.kind !== "passage").length, 0), "ouvertures"],
                  ].map(([v, l]) => (
                    <div key={l as string} className="rounded-xl bg-cream px-2 py-3">
                      <div className="font-display text-xl font-semibold tabular-nums">{v}</div>
                      <div className="text-[11px] text-muted">{l}</div>
                    </div>
                  ))}
                </div>
              </Section>
              <Section title="Visiter une pièce">
                {house.map((L) => (
                  <div key={L.index} className="space-y-2">
                    {multi && <div className="pt-1 text-xs font-semibold text-muted">{L.name}</div>}
                    <RoomList rooms={L.rooms} level={L.index} pickLabel="Y aller" onPick={visitRoom} />
                  </div>
                ))}
              </Section>
              <div className="p-5">
                <button
                  onClick={() => goto3d("interieur")}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3 font-medium text-white shadow-sm transition hover:brightness-105"
                >
                  <Sofa className="size-5" /> Aménager l&apos;intérieur
                </button>
              </div>
            </>
          )}

          {step === "interieur" && (
            <>
              <Section title="Style d'aménagement">
                <div className="grid grid-cols-2 gap-2">
                  {STYLES.map((s) => {
                    const active = project.styleId === s.id;
                    return (
                      <button
                        key={s.id}
                        onClick={() => patch({ styleId: s.id })}
                        className={`rounded-2xl p-2.5 text-left transition ${active ? "bg-white ring-2 ring-accent" : "bg-white ring-1 ring-line hover:ring-sand"}`}
                      >
                        <div className="flex h-12 overflow-hidden rounded-lg">
                          <span className="flex-[3]" style={{ background: s.wall }} />
                          <span className="flex-[3]" style={{ background: s.floors.default.color }} />
                          <span className="flex-[2]" style={{ background: s.fabric }} />
                          <span className="flex-1" style={{ background: s.accent }} />
                          <span className="flex-1" style={{ background: s.accent2 }} />
                        </div>
                        <div className="mt-2 text-[13px] font-semibold leading-tight">{s.name}</div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs leading-relaxed text-muted">{STYLES.find((s) => s.id === project.styleId)?.description}</p>
              </Section>
              <DesignPanel
                project={project}
                furniture={furniture}
                selectedId={selectedF}
                setSelectedId={setSelectedF}
                roomId={designRoom}
                setRoomId={setDesignRoom}
                onVisit={(r) => {
                  visitRoom(r);
                }}
              />
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
