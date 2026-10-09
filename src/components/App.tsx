"use client";
/* Écran principal : 1 · Plan (import + tracé) → 2 · 3D (maquette, visite libre, visite guidée, VR) → 3 · Intérieur. */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight, Box, BrickWall, Check, Clapperboard, Sparkles, Columns2, Monitor, Smartphone, Square, DoorOpen, Download, FilePlus2, FolderOpen, Footprints, Glasses, Grid2x2,
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Hammer, House, Layers, Magnet, Maximize2, MousePointer2, PaintBucket, Pause, Play, Plus, Redo2, RotateCcw, Route, Ruler, Save, Scissors, Sofa,
  Tag, Trash2, Undo2, Upload, WandSparkles, X, Ellipsis, ChevronUp, ChevronDown, Coins, LogOut, UserRound, Cloud, CloudOff, Loader2, LayoutGrid,
} from "lucide-react";
import type { Background, OpeningKind, Project, Pt, Room, RoomType } from "@/lib/types";
import { OPENING_DEFAULTS, OPENING_LABELS_EN, ROOM_LABELS, ROOM_LABELS_EN } from "@/lib/types";
import { useLang, useTr } from "@/lib/i18n";
import { EMPTY_PROJECT, useProject } from "@/lib/store";
import { sampleDuplex, sampleProject } from "@/lib/sample";
import { STYLES } from "@/lib/styles";
import { moveF, removeF, rotateF } from "@/lib/design";
import DesignPanel from "./DesignPanel";
import RenduIA from "./RenduIA";
import Logo from "./Logo";
import { BuyCredits } from "./Credits";
import { AccountArea, LoginDialog, VerifyNotice } from "./Account";
import MySpace from "./MySpace";
import { markSaved, openProject, useAutosave } from "@/lib/cloud";
import { useCredits } from "@/lib/creditsStore";
import { FIREBASE_READY } from "@/lib/firebase";
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
    <div className="grid size-full place-items-center text-sm text-muted">
      {useLang.getState().lang === "en" ? "Building the house in 3D…" : "Construction de la maison en 3D…"}
    </div>
  ),
});

type Step = "plan" | "3d" | "interieur";

const STEPS: { id: Step; label: string; en: string; icon: typeof House }[] = [
  { id: "plan", label: "Plan", en: "Plan", icon: Ruler },
  { id: "3d", label: "Maison 3D", en: "3D house", icon: Box },
  { id: "interieur", label: "Intérieur", en: "Interior", icon: Sofa },
];

const TOOLS: { id: Tool; label: string; en: string; icon: typeof House; key: string }[] = [
  { id: "select", label: "Sélection", en: "Select", icon: MousePointer2, key: "v" },
  { id: "wall", label: "Mur", en: "Wall", icon: BrickWall, key: "m" },
  { id: "door", label: "Porte", en: "Door", icon: DoorOpen, key: "p" },
  { id: "window", label: "Fenêtre", en: "Window", icon: Grid2x2, key: "f" },
  { id: "baie", label: "Baie vitrée", en: "Glass door", icon: Columns2, key: "b" },
  { id: "passage", label: "Passage", en: "Opening", icon: ArrowLeftRight, key: "o" },
  { id: "room", label: "Pièce", en: "Room", icon: PaintBucket, key: "r" },
  { id: "calibrate", label: "Échelle", en: "Scale", icon: Ruler, key: "e" },
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

const HELP_EN: Record<Tool, string> = {
  select: "Click a wall, an opening or a room to edit it. Drag a wall's handles to move it. Delete to remove.",
  wall: "Click to place each corner: walls follow one another. Double-click or Esc to finish. Right angles and wall ends snap.",
  door: "Click a wall to place a door.",
  window: "Click a wall to place a window.",
  baie: "Click a wall to place a glass door.",
  passage: "Click a wall to open a doorless passage.",
  room: "Choose the type, then click inside a room closed by walls.",
  calibrate: "Click both ends of a known dimension on the plan (e.g. a 12 m façade), then enter its real length.",
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
  const tr = useTr();
  return (
    <select
      className={`rounded-lg border border-line bg-white px-2 py-1 text-sm outline-none focus:border-accent ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value as RoomType)}
    >
      {(Object.keys(ROOM_LABELS) as RoomType[]).map((k) => (
        <option key={k} value={k}>{tr(ROOM_LABELS[k], ROOM_LABELS_EN[k])}</option>
      ))}
    </select>
  );
}

function RoomList({ rooms, level, onPick, pickLabel }: { rooms: Room[]; level?: number; onPick?: (r: Room) => void; pickLabel?: string }) {
  const tr = useTr();
  const updateRoomIn = useProject((s) => s.updateRoomIn);
  const updateRoom = (id: string, r: Partial<Room>) => updateRoomIn(level ?? useProject.getState().project.level ?? 0, id, r);
  if (!rooms.length)
    return <p className="text-sm text-muted">{tr("Aucune pièce. À l'étape Plan, outil « Pièce » : cliquez dans chaque pièce.", "No rooms yet. In the Plan step, use the Room tool and click inside each room.")}</p>;
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
const menuItem = "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium hover:bg-cream disabled:opacity-30";

/** Visite libre sur écran tactile : on regarde en glissant le doigt, on avance avec ces flèches (elles jouent le rôle du clavier). */
function TouchPad({ hint }: { hint: string }) {
  const tr = useTr();
  const key = (k: string, down: boolean) => window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { key: k }));
  // une flèche ne doit jamais rester enfoncée si le panneau disparaît sous le doigt
  useEffect(() => () => ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].forEach((k) => key(k, false)), []);
  const pads: [string, typeof ArrowUp, string, string][] = [
    ["ArrowUp", ArrowUp, "col-start-2", tr("Avancer", "Forward")],
    ["ArrowLeft", ArrowLeft, "col-start-1 row-start-2", tr("Pas à gauche", "Step left")],
    ["ArrowDown", ArrowDown, "col-start-2 row-start-2", tr("Reculer", "Back")],
    ["ArrowRight", ArrowRight, "col-start-3 row-start-2", tr("Pas à droite", "Step right")],
  ];
  return (
    <>
      <div className="pointer-events-none absolute left-1/2 top-[7.25rem] -translate-x-1/2 whitespace-nowrap rounded-full bg-ink/80 px-4 py-2 text-sm text-paper backdrop-blur sm:top-16">
        {hint}
      </div>
      <div className="absolute bottom-4 right-4 z-10 grid grid-cols-3 gap-1.5">
        {pads.map(([k, Icon, cls, label]) => (
          <button
            key={k}
            aria-label={label}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              key(k, true);
            }}
            onPointerUp={() => key(k, false)}
            onPointerCancel={() => key(k, false)}
            onContextMenu={(e) => e.preventDefault()}
            className={`grid size-14 touch-none select-none place-items-center rounded-2xl bg-ink/75 text-paper backdrop-blur active:bg-accent ${cls}`}
          >
            <Icon className="size-6" />
          </button>
        ))}
      </div>
    </>
  );
}

/** Bascule français / anglais */
function LangToggle() {
  const tr = useTr();
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  return (
    <div className="mr-1 flex items-center rounded-full bg-cream p-0.5 text-xs font-semibold" role="group" aria-label={tr("Langue", "Language")}>
      {(["fr", "en"] as const).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          title={l === "fr" ? "Français" : "English"}
          className={`rounded-full px-2.5 py-1 uppercase transition ${lang === l ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/* ---------- application ---------- */

export default function App() {
  const tr = useTr();
  const lang = useLang((s) => s.lang);
  const [menu, setMenu] = useState(false); // menu de l'en-tête (téléphone, tablette)
  const credits = useCredits((s) => s.credits);
  const user = useCredits((s) => s.user);
  const authReady = useCredits((s) => s.authReady);
  const accountsOn = FIREBASE_READY;
  const saveStatus = useAutosave();
  const [sheet, setSheet] = useState(false); // panneau ouvert en bas d'écran (téléphone, tablette)
  // écran tactile, sans clavier : boutons pour avancer en visite libre
  const [coarse] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
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
    const q = new URLSearchParams(window.location.search);
    const back = q.get("paiement");
    const n = q.get("credits");
    if (back) window.history.replaceState(null, "", window.location.pathname);
    // connexion Firebase, puis solde
    useCredits.getState().init();
    if (back)
      Promise.resolve().then(() => {
        if (back === "ok") say(tr(`Paiement confirmé : +${n} crédits.`, `Payment confirmed: +${n} credits.`));
        else if (back === "attente")
          say(tr("Paiement en cours de validation : vos crédits arrivent dès que FedaPay le confirme.", "Payment being validated: your credits arrive as soon as FedaPay confirms it."));
        else if (back === "echec") say(tr("Paiement annulé ou refusé : aucun crédit ajouté.", "Payment canceled or declined: no credits added."));
      });
    // une seule fois, au chargement
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000 + toast.length * 45);
    return () => clearTimeout(t);
  }, [toast]);

  // tous les niveaux, avec leurs meubles (posés à la main, sinon automatiques) et les escaliers lus sur le plan
  // la langue change le nom par défaut du rez-de-chaussée
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const house = useMemo(() => houseLevels(project), [project, lang]);
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
    const epoch = useProject.getState().epoch;
    try {
      if (name.endsWith(".json")) {
        const p = JSON.parse(await file.text()) as Project;
        if (!Array.isArray(p.walls)) throw new Error();
        load({ ...EMPTY_PROJECT, ...p, id: undefined });
        setFitKey((k) => k + 1);
        return say(tr(`Projet « ${p.name} » ouvert.`, `Project “${p.name}” opened.`));
      }
      if (name.endsWith(".dxf")) {
        setBusy(tr("Lecture du DXF…", "Reading the DXF…"));
        const res = importDxf(await file.text(), height);
        if (useProject.getState().epoch !== epoch) return;
        if (!res.walls.length)
          return say(
            tr(
              `Aucun mur reconnu dans ce DXF (calques : ${res.report.layers.slice(0, 6).join(", ") || "aucun"}).`,
              `No walls found in this DXF (layers: ${res.report.layers.slice(0, 6).join(", ") || "none"}).`,
            ),
          );
        const found = roomsFromPolygons(detectAllRooms(res.walls), res.texts);
        const ops = fixInteriorOpenings(res.openings, res.walls, found);
        commit(() => ({ walls: res.walls, openings: ops, rooms: found, background: null, furniture: undefined }));
        patch({ planFloor: false, furnished: true });
        if (level === 0) patch({ name: file.name.replace(/\.dxf$/i, "") });
        else alignBelow();
        setTool("select");
        setFitKey((k) => k + 1);
        const read = res.texts.length ? tr(" (noms lus sur le plan)", " (names read from the plan)") : "";
        return say(
          tr(
            `DXF importé : ${res.walls.length} murs, ${ops.length} ouvertures, ${found.length} pièces${read}. Vérifiez les types de pièces.`,
            `DXF imported: ${res.walls.length} walls, ${ops.length} openings, ${found.length} rooms${read}. Check the room types.`,
          ),
        );
      }
      const isPdf = name.endsWith(".pdf") || file.type === "application/pdf";
      if (!isPdf && !file.type.startsWith("image/"))
        return say(tr("Format non pris en charge : image (PNG, JPG), PDF, DXF ou projet .json.", "Unsupported format: image (PNG, JPG), PDF, DXF or .json project."));
      setBusy(isPdf ? tr("Lecture du PDF…", "Reading the PDF…") : tr("Chargement de l'image…", "Loading the image…"));
      let img: { src: string; w: number; h: number; pages?: number } = isPdf ? await readPdf(file) : await readImage(file);
      const pages = img.pages ?? 1;
      if (pages > 1) {
        // un plan par page (rez-de-chaussée, étage…) : on demande laquelle
        setBusy(null);
        const ans = prompt(
          tr(`Ce PDF a ${pages} pages. Quelle page importer pour « ${house[level].name} » ?`, `This PDF has ${pages} pages. Which page should be imported for “${house[level].name}”?`),
          String(Math.min(level + 1, pages)),
        );
        const page = parseInt(ans ?? "", 10);
        if (!page) return;
        setBusy(tr("Lecture du PDF…", "Reading the PDF…"));
        if (page !== 1) img = await readPdf(file, page);
      }
      if (useProject.getState().epoch !== epoch) return;
      const bg: Background = { src: img.src, widthPx: img.w, heightPx: img.h, scale: 15 / img.w, x: 0, y: 0, opacity: 0.4 };
      setBackground(bg);
      if (level === 0) patch({ name: file.name.replace(/\.[^.]+$/, "") });
      setStep("plan");
      setSelected(null);
      await readImagePlan(bg);
    } catch (err) {
      console.error(err);
      say(tr("Impossible de lire ce fichier.", "This file could not be read."));
    } finally {
      setBusy(null);
    }
  };

  /** lecture automatique des murs, ouvertures et pièces sur l'image du plan */
  const readImagePlan = async (bg: Background) => {
    setBusy(tr("Lecture automatique du plan…", "Reading the plan automatically…"));
    const epoch = useProject.getState().epoch;
    await new Promise((r) => setTimeout(r, 30)); // laisse le message s'afficher avant le calcul
    try {
      const res = await autoReadPlan(bg, height, setBusy);
      // un autre projet a été ouvert pendant la lecture : ce résultat ne le concerne pas
      if (useProject.getState().epoch !== epoch) return;
      if (!res) {
        setTool("calibrate");
        setFitKey((k) => k + 1);
        return say(
          tr(
            "Je n'ai pas reconnu les murs sur cette image. Calibrez l'échelle sur une cote connue, puis tracez-les avec l'outil Mur.",
            "No walls were recognised on this image. Calibrate the scale on a known dimension, then draw them with the Wall tool.",
          ),
        );
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
        tr(
          `Plan lu : ${res.walls.length} murs, ${count("door")} portes, ${count("window") + count("baie")} fenêtres, ${res.rooms.length} pièces`,
          `Plan read: ${res.walls.length} walls, ${count("door")} doors, ${count("window") + count("baie")} windows, ${res.rooms.length} rooms`,
        ) +
          (res.named ? tr(` dont ${res.named} nommées d'après le plan.`, `, ${res.named} named from the plan.`) : ".") +
          (res.scaleFrom === "surfaces"
            ? tr(" Échelle réglée d'après les surfaces écrites sur le plan.", " Scale set from the areas written on the plan.")
            : res.estimated
              ? tr(" Échelle estimée : vérifiez-la avec l'outil Échelle sur une cote connue.", " Estimated scale: check it with the Scale tool on a known dimension.")
              : "") +
          tr(" Complétez les murs manquants si besoin.", " Add any missing walls if needed."),
      );
    } finally {
      setBusy(null);
    }
  };

  const newProject = () => {
    if (!empty && !confirm(tr("Commencer un nouveau projet ? Le projet actuel sera remplacé (pensez à l'enregistrer).", "Start a new project? The current one will be replaced (remember to save it).")))
      return;
    load(EMPTY_PROJECT);
    setStep("plan");
    setTool("select");
    setSelected(null);
    setFitKey((k) => k + 1);
  };

  const saveJson = () => {
    const blob = new Blob([JSON.stringify(project)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${project.name.replace(/[^\p{L}\p{N}-]+/gu, "-") || tr("projet", "project")}.plan3d.json`;
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
      say(tr("Échelle réglée : le plan lu a été remis aux bonnes dimensions.", "Scale set: the plan has been resized to its real dimensions."));
    } else {
      setTool("wall");
      say(tr("Échelle réglée. Tracez maintenant les murs par-dessus le plan.", "Scale set. Now draw the walls over the plan."));
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
    say(
      tr(
        "Étage ajouté : ses façades reprennent celles du dessous. Importez son plan avec « Ouvrir », ou tracez ses cloisons.",
        "Floor added: its façades follow the floor below. Import its plan with “Open”, or draw its partitions.",
      ),
    );
  };
  const dropLevel = (i: number) => {
    if (!confirm(tr(`Supprimer « ${house[i].name} » et tout ce qu'il contient ?`, `Delete “${house[i].name}” and everything on it?`))) return;
    commit((p) => removeLevel(p, i));
    setSelected(null);
  };
  /** pose le niveau actif sur celui du dessous (façades l'une sur l'autre) */
  const alignBelow = () => {
    const d = alignOffset(useProject.getState().project);
    if (!d) return say(tr("Rien à caler : il faut des murs sur les deux niveaux.", "Nothing to align: both floors need walls."));
    if (Math.hypot(d.x, d.y) < 0.01) return say(tr("Ce niveau est déjà calé sur celui du dessous.", "This floor is already aligned with the one below."));
    commit((p) => translateActive(p, d));
    say(tr(`Niveau calé sur celui du dessous (décalé de ${fmt(Math.hypot(d.x, d.y))}).`, `Floor aligned with the one below (moved by ${fmt(Math.hypot(d.x, d.y))}).`));
  };

  const autoRooms = () => {
    const polys = detectAllRooms(walls);
    if (!polys.length) return say(tr("Aucune zone fermée : vérifiez que les murs se rejoignent.", "No closed area: check that the walls meet."));
    // on garde les pièces déjà nommées, on ajoute les zones qui n'en ont pas
    const fresh = roomsFromPolygons(polys).filter((r) => {
      const c = roomAnchor(r);
      return !rooms.some((x) => pointInPolygon(c, x.points));
    });
    if (!fresh.length) return say(tr("Toutes les pièces fermées sont déjà définies.", "All closed rooms are already defined."));
    commit((p) => ({ rooms: [...p.rooms, ...fresh] }));
    say(tr(`${fresh.length} pièce(s) détectée(s). Vérifiez leur type dans la liste.`, `${fresh.length} room(s) detected. Check their type in the list.`));
  };

  const goto3d = (target: Step) => {
    if (target !== "plan" && !hasWalls) return say(tr("Commencez par importer ou dessiner un plan.", "Start by importing or drawing a plan."));
    if (target !== "plan" && !allRooms.length)
      say(tr("Astuce : définissez les pièces (outil Pièce) pour avoir les sols, le mobilier et la visite guidée.", "Tip: define the rooms (Room tool) to get floors, furniture and the guided tour."));
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
    if (what === "visite" && !tour) return say(tr("Définissez au moins une pièce pour générer la visite guidée.", "Define at least one room to create the guided tour."));
    if (typeof MediaRecorder === "undefined")
      return say(tr("Ce navigateur ne permet pas d'enregistrer une vidéo. Essayez Chrome, Edge ou Safari récent.", "This browser cannot record video. Try a recent Chrome, Edge or Safari."));
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
        const slug = project.name.replace(/[^\p{L}\p{N}-]+/gu, "-") || tr("maison", "house");
        downloadBlob(blob, `${what === "visite" ? tr("visite", "tour") : tr("construction", "build")}-${slug}${format === "vertical" ? "-vertical" : ""}.${type.includes("mp4") ? "mp4" : "webm"}`);
        setRec(null);
        say(tr(`Vidéo enregistrée (${(blob.size / 1e6).toFixed(1).replace(".", ",")} Mo).`, `Video saved (${(blob.size / 1e6).toFixed(1)} MB).`));
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
    if (!ok)
      return say(tr("Casque VR non détecté. Ouvrez cette page dans le navigateur d'un casque (Meta Quest…) pour visiter en VR.", "No VR headset detected. Open this page in a headset's browser (Meta Quest…) to visit in VR."));
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
  // accueil : tant qu'aucun plan n'est ouvert, ni outils de dessin ni panneau latéral
  const welcome = step === "plan" && empty;

  return (
    <div className="flex h-dvh flex-col">
      {/* ---------- en-tête ---------- */}
      {/* sur téléphone et tablette : logo, étapes en icônes et un menu ; sur grand écran, tout est visible */}
      <header className="relative flex h-14 shrink-0 items-center gap-2 border-b border-line bg-paper px-3 sm:gap-4 sm:px-4 lg:h-16">
        <div className="flex min-w-0 items-center gap-2.5">
          <Logo className="h-8 w-auto shrink-0 lg:h-9" title="Xwé" />
          <div className="hidden min-w-0 leading-tight sm:block">
            <div className="font-display text-[19px] font-semibold tracking-tight">Xwé</div>
            <input
              key={project.name + lang}
              defaultValue={project.name === EMPTY_PROJECT.name ? tr("Nouveau projet", "New project") : project.name}
              onBlur={(e) => e.target.value.trim() && patch({ name: e.target.value.trim() })}
              className="w-36 truncate bg-transparent text-xs text-muted outline-none focus:text-ink lg:w-56"
              aria-label={tr("Nom du projet", "Project name")}
            />
            {saveStatus !== "off" && saveStatus !== "waiting" && (
              <div className={`flex items-center gap-1 text-[10px] ${saveStatus === "error" ? "text-accent" : "text-muted"}`}>
                {saveStatus === "saving" ? <Loader2 className="size-3 animate-spin" /> : saveStatus === "error" ? <CloudOff className="size-3" /> : <Cloud className="size-3" />}
                {saveStatus === "saving"
                  ? tr("Enregistrement…", "Saving…")
                  : saveStatus === "error"
                    ? tr("Pas enregistré (hors ligne ?)", "Not saved (offline?)")
                    : tr("Enregistré dans mon espace", "Saved to my space")}
              </div>
            )}
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
                title={tr(s.label, s.en)}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-sm font-medium transition sm:gap-2 sm:px-4 sm:py-2 ${active ? "bg-ink text-paper shadow-sm" : "text-muted hover:text-ink"}`}
              >
                <span className={`grid size-5 place-items-center rounded-full text-[11px] ${active ? "bg-accent text-white" : "bg-sand text-ink"}`}>{i + 1}</span>
                <Icon className="size-4" />
                <span className="hidden md:inline">{tr(s.label, s.en)}</span>
              </button>
            );
          })}
        </nav>

        <div className="hidden items-center gap-1 lg:flex">
          <LangToggle />
          <button onClick={undo} disabled={!canUndo} title={tr("Annuler (⌘Z)", "Undo (⌘Z)")} className={`${btn} px-2 text-ink hover:bg-cream disabled:opacity-30`}>
            <Undo2 className="size-4" />
          </button>
          <button onClick={redo} disabled={!canRedo} title={tr("Rétablir (⇧⌘Z)", "Redo (⇧⌘Z)")} className={`${btn} px-2 text-ink hover:bg-cream disabled:opacity-30`}>
            <Redo2 className="size-4" />
          </button>
          <span className="mx-1 h-6 w-px bg-line" />
          <button onClick={() => fileRef.current?.click()} title={tr("Ouvrir", "Open")} className={`${btn} text-ink hover:bg-cream`}>
            <FolderOpen className="size-4" /> <span className="hidden xl:inline">{tr("Ouvrir", "Open")}</span>
          </button>
          <button onClick={saveJson} disabled={empty} title={tr("Enregistrer", "Save")} className={`${btn} text-ink hover:bg-cream disabled:opacity-30`}>
            <Save className="size-4" /> <span className="hidden xl:inline">{tr("Enregistrer", "Save")}</span>
          </button>
          <button onClick={newProject} title={tr("Nouveau", "New")} className={`${btn} text-ink hover:bg-cream`}>
            <FilePlus2 className="size-4" /> <span className="hidden xl:inline">{tr("Nouveau", "New")}</span>
          </button>
        </div>

        <button
          onClick={() => setMenu((v) => !v)}
          aria-expanded={menu}
          aria-label={tr("Menu", "Menu")}
          className="grid size-9 shrink-0 place-items-center rounded-full text-ink hover:bg-cream lg:hidden"
        >
          {menu ? <X className="size-5" /> : <Ellipsis className="size-5" />}
        </button>
        {/* le compte (solde et avatar) ferme l'en-tête, tout à droite */}
        <AccountArea className="max-sm:hidden lg:ml-1 lg:border-l lg:border-line lg:pl-3" />
        {menu && (
          <>
            <div className="fixed inset-0 z-30 lg:hidden" onClick={() => setMenu(false)} />
            <div className="absolute right-2 top-full z-40 mt-2 w-64 space-y-1 rounded-2xl bg-paper p-2 shadow-xl ring-1 ring-line lg:hidden">
              {/* compte, sur téléphone (l'en-tête n'a pas la place) */}
              {authReady && accountsOn && (
                <div className="space-y-1 border-b border-line pb-1 sm:hidden">
                  {user ? (
                    <>
                      <div className="truncate px-3 pt-1 text-xs text-muted">{user.email}</div>
                      <VerifyNotice />
                      <button
                        onClick={() => {
                          setMenu(false);
                          useCredits.getState().setSpaceOpen(true);
                        }}
                        className={menuItem}
                      >
                        <LayoutGrid className="size-4 text-ink" /> {tr("Mon espace", "My space")}
                        <span className="ml-auto text-xs text-muted">{tr("mes projets", "my projects")}</span>
                      </button>
                      <button
                        onClick={() => {
                          setMenu(false);
                          useCredits.getState().setBuyOpen(true);
                        }}
                        className={menuItem}
                      >
                        <Coins className="size-4 text-accent" /> {tr("Crédits", "Credits")} : <b className="tabular-nums">{credits ?? "…"}</b>
                        <span className="ml-auto text-xs font-semibold text-accent">{tr("Acheter", "Buy")}</span>
                      </button>
                      <button
                        onClick={() => {
                          setMenu(false);
                          useCredits.getState().logout();
                        }}
                        className={menuItem}
                      >
                        <LogOut className="size-4 text-muted" /> {tr("Se déconnecter", "Sign out")}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        setMenu(false);
                        useCredits.getState().setLoginOpen(true);
                      }}
                      className={menuItem}
                    >
                      <UserRound className="size-4 text-accent" /> {tr("Se connecter", "Sign in")}
                      <span className="ml-auto text-xs text-muted">{tr("20 crédits offerts", "20 free credits")}</span>
                    </button>
                  )}
                </div>
              )}
              <button
                onClick={() => {
                  setMenu(false);
                  fileRef.current?.click();
                }}
                className={menuItem}
              >
                <FolderOpen className="size-4 text-muted" /> {tr("Ouvrir un plan ou un projet", "Open a plan or project")}
              </button>
              <button
                disabled={empty}
                onClick={() => {
                  setMenu(false);
                  saveJson();
                }}
                className={menuItem}
              >
                <Save className="size-4 text-muted" /> {tr("Enregistrer le projet", "Save the project")}
              </button>
              <button
                onClick={() => {
                  setMenu(false);
                  newProject();
                }}
                className={menuItem}
              >
                <FilePlus2 className="size-4 text-muted" /> {tr("Nouveau projet", "New project")}
              </button>
              <div className="flex items-center justify-between gap-2 border-t border-line px-1 pt-2">
                <div className="flex gap-1">
                  <button onClick={undo} disabled={!canUndo} aria-label={tr("Annuler", "Undo")} className="grid size-9 place-items-center rounded-full hover:bg-cream disabled:opacity-30">
                    <Undo2 className="size-4" />
                  </button>
                  <button onClick={redo} disabled={!canRedo} aria-label={tr("Rétablir", "Redo")} className="grid size-9 place-items-center rounded-full hover:bg-cream disabled:opacity-30">
                    <Redo2 className="size-4" />
                  </button>
                </div>
                <LangToggle />
              </div>
            </div>
          </>
        )}
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

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ---------- barre d'outils du plan (à gauche ; sous le plan sur téléphone et tablette) ---------- */}
        {step === "plan" && !welcome && (
          <div className="scroll-soft flex shrink-0 items-center gap-1 border-line bg-paper max-lg:order-2 max-lg:overflow-x-auto max-lg:border-t max-lg:px-2 max-lg:py-1.5 lg:w-[76px] lg:flex-col lg:border-r lg:py-3">
            {TOOLS.map((t) => {
              const Icon = t.icon;
              const active = tool === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTool(t.id)}
                  title={`${tr(t.label, t.en)} (${t.key.toUpperCase()})`}
                  className={`flex w-16 shrink-0 flex-col items-center gap-1 rounded-xl py-2 text-[11px] font-medium transition ${active ? "bg-ink text-paper" : "text-muted hover:bg-cream hover:text-ink"}`}
                >
                  <Icon className="size-5" strokeWidth={1.7} />
                  {tr(t.label, t.en)}
                </button>
              );
            })}
            <div className="flex shrink-0 flex-col items-center gap-1 max-lg:ml-auto lg:mt-auto">
              <button onClick={() => setFitKey((k) => k + 1)} title={tr("Recadrer", "Fit to screen")} className="rounded-xl p-2.5 text-muted hover:bg-cream hover:text-ink">
                <Maximize2 className="size-5" strokeWidth={1.7} />
              </button>
            </div>
          </div>
        )}

        {/* ---------- zone centrale ---------- */}
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden max-lg:order-1">
          {welcome ? (
            <div
              className="size-full bg-cream"
              style={{
                backgroundImage:
                  "linear-gradient(rgba(120,100,70,.10) 1px, transparent 1px), linear-gradient(90deg, rgba(120,100,70,.10) 1px, transparent 1px), linear-gradient(rgba(120,100,70,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(120,100,70,.05) 1px, transparent 1px)",
                backgroundSize: "100px 100px, 100px 100px, 20px 20px, 20px 20px",
              }}
            />
          ) : step === "plan" ? (
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
          {welcome && (
            <div className="absolute inset-0 grid place-items-center overflow-y-auto p-4 sm:p-6">
              <div className="w-full max-w-2xl rounded-3xl bg-paper/95 p-6 shadow-[0_30px_80px_-24px_rgba(42,38,32,0.4)] ring-1 ring-line backdrop-blur sm:p-10">
                <Logo detailed className="mb-4 h-16 w-auto sm:mb-5 sm:h-24" />
                <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{tr("Du plan à la visite réaliste", "From plan to realistic tour")}</h1>
                <p className="mt-3 text-[15px] leading-relaxed text-muted sm:text-base">
                  {tr(
                    "Importez votre plan : la maison apparaît en 3D, se visite pièce par pièce, s'aménage, puis devient photo et vidéo réalistes.",
                    "Import your plan: the house appears in 3D, can be toured room by room and furnished, then becomes realistic photos and videos.",
                  )}
                </p>
                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  <button onClick={() => fileRef.current?.click()} className="group rounded-2xl bg-ink p-4 text-left text-paper transition hover:-translate-y-0.5">
                    <Upload className="size-5 text-accent" />
                    <div className="mt-3 font-medium">{tr("Importer un plan", "Import a plan")}</div>
                    <div className="mt-0.5 text-xs text-paper/60">{tr("PDF, image ou DXF", "PDF, image or DXF")}</div>
                  </button>
                  <button
                    onClick={() => {
                      load(sampleProject());
                      setFitKey((k) => k + 1);
                      setTool("select");
                    }}
                    className="rounded-2xl bg-accent-soft p-4 text-left ring-1 ring-[#efc6ae] transition hover:-translate-y-0.5"
                  >
                    <House className="size-5 text-accent" />
                    <div className="mt-3 font-medium">{tr("Villa d'exemple", "Sample villa")}</div>
                    <div className="mt-0.5 text-xs text-muted">{tr("3 chambres, 140 m²", "3 bedrooms, 140 m²")}</div>
                  </button>
                </div>
                <p className="mt-4 text-sm text-muted">
                  {tr("Maison à étage ?", "Multi-storey house?")}{" "}
                  <button
                    onClick={() => {
                      load(sampleDuplex());
                      setFitKey((k) => k + 1);
                      setTool("select");
                    }}
                    className="font-medium text-accent underline decoration-accent-soft underline-offset-2 hover:decoration-accent"
                  >
                    {tr("Ouvrir le duplex d'exemple", "Open the sample duplex")}
                  </button>{" "}
                  {tr("(R+1 : escalier, mezzanine, terrasse).", "(two floors: stairs, mezzanine, terrace).")}
                </p>
                {user && (
                  <button
                    onClick={() => useCredits.getState().setSpaceOpen(true)}
                    className="mt-3 flex w-full items-center gap-2 rounded-2xl bg-white px-4 py-3 text-left text-sm font-medium ring-1 ring-line transition hover:ring-sand"
                  >
                    <LayoutGrid className="size-4 text-accent" /> {tr("Reprendre un de mes projets", "Continue one of my projects")}
                    <span className="ml-auto text-xs text-muted">{tr("Mon espace", "My space")}</span>
                  </button>
                )}
                <p className="mt-2 text-xs text-muted">
                  {tr("Pas de plan sous la main ? Plans d'essai :", "No plan at hand? Test plans:")}{" "}
                  <a href="/exemples/maison-b.pdf" download className="font-medium text-ink underline decoration-sand underline-offset-2 hover:decoration-accent">PDF</a>
                  {" · "}
                  <a href="/exemples/maison-b.png" download className="font-medium text-ink underline decoration-sand underline-offset-2 hover:decoration-accent">{tr("image", "image")}</a>
                  {" · "}
                  <a href="/exemples/maison-b.dxf" download className="font-medium text-ink underline decoration-sand underline-offset-2 hover:decoration-accent">DXF (AutoCAD)</a>
                </p>
              </div>
            </div>
          )}

          {/* calibrage */}
          {calib && (
            <div className="absolute left-1/2 top-3 z-10 flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-2xl bg-paper px-4 py-3 shadow-lg ring-1 ring-line sm:top-4">
              <Ruler className="size-4 text-leaf" />
              <span className="text-sm">{tr("Longueur réelle de ce segment :", "Real length of this segment:")}</span>
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
                <Check className="size-4" /> {tr("Valider", "Apply")}
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
                  {tr("Enregistrement", "Recording")} · {Math.floor(recTime / 60000)}:{String(Math.floor(recTime / 1000) % 60).padStart(2, "0")}
                </span>
              ) : (
                <span>{tr("Préparation…", "Getting ready…")}</span>
              )}
              <button onClick={stopRecording} className={`${btn} bg-paper text-ink hover:bg-cream`}>
                <Square className="size-3.5 fill-current" />
                <span className="max-sm:hidden">{tr("Arrêter et télécharger", "Stop and download")}</span>
                <span className="sm:hidden">{tr("Arrêter", "Stop")}</span>
              </button>
            </div>
          )}

          {step !== "plan" && hasWalls && !rec && (
            <>
              <div className="scroll-soft absolute left-1/2 top-3 z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 sm:top-4 items-center gap-1 w-max flex-wrap justify-center rounded-[22px] bg-paper/95 p-1 shadow-lg ring-1 ring-line backdrop-blur">
                {(
                  [
                    { id: "maquette", label: tr("Maquette", "Model"), icon: Box },
                    { id: "visite", label: tr("Visite libre", "Free tour"), icon: Footprints },
                    { id: "guidee", label: tr("Visite guidée", "Guided tour"), icon: Route },
                  ] as const
                ).map((m) => {
                  const Icon = m.icon;
                  const active = mode === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => {
                        if (m.id === "guidee") {
                          if (!tour) return say(tr("Définissez au moins une pièce pour générer la visite guidée.", "Define at least one room to create the guided tour."));
                          setPlaying(true);
                          setStopIdx(-1);
                          setTourNonce((n) => n + 1);
                        }
                        if (m.id === "visite") setWalkAt(null);
                        setMode(m.id);
                      }}
                      className={`${btn} ${active ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}
                    >
                      <Icon className="size-4" /> <span className={active ? "" : "max-md:hidden lg:max-xl:hidden"}>{m.label}</span>
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
                      className={`${btn} ${cutaway && !roof ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"}`} title={tr("Murs coupés à 1,10 m pour voir l'intérieur", "Walls cut at 1.10 m to see inside")}>
                      <Scissors className="size-4" /> <span className="max-2xl:hidden">{tr("Coupe", "Cutaway")}</span>
                    </button>
                    <button onClick={() => setRoof((v) => !v)} className={`${btn} ${roof ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"}`} title={tr("Toit-terrasse sur la maison (vue de l'extérieur)", "Flat roof on the house (outside view)")}>
                      <House className="size-4" /> <span className="max-2xl:hidden">{tr("Toit", "Roof")}</span>
                    </button>
                    <button onClick={() => setLabelsOn((v) => !v)} className={`${btn} ${labelsOn ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"}`} title={tr("Nom et surface de chaque pièce", "Name and area of each room")}>
                      <Tag className="size-4" /> <span className="max-2xl:hidden">{tr("Noms", "Labels")}</span>
                    </button>
                    <button onClick={() => playBuild()} disabled={building} className={`${btn} text-muted hover:text-ink disabled:opacity-40`} title={tr("Voir la maison se construire depuis le plan", "Watch the house rise from the plan")}>
                      <Hammer className="size-4" /> <span className="max-2xl:hidden">{tr("Construire", "Build")}</span>
                    </button>
                  </>
                )}
                <button onClick={enterVR} className={`${btn} text-muted hover:text-ink`} title={tr("Visiter avec un casque VR", "Visit with a VR headset")}>
                  <Glasses className="size-4" /> <span className="max-2xl:hidden">VR</span>
                </button>
                <button onClick={() => exportRef.current?.()} className={`${btn} text-muted hover:text-ink`} title={tr("Télécharger le modèle 3D (GLB) pour SketchUp, Blender, Unreal…", "Download the 3D model (GLB) for SketchUp, Blender, Unreal…")}>
                  <Download className="size-4" /> <span className="max-2xl:hidden">GLB</span>
                </button>
                <button
                  onClick={() => {
                    setAiOpen((v) => !v);
                    setRecMenu(false);
                  }}
                  className={`${btn} ${aiOpen ? "bg-accent text-white" : "text-accent hover:bg-accent-soft"}`}
                  title={tr("Photo et vidéo réalistes", "Realistic photo and video")}
                >
                  <Sparkles className="size-4" /> <span className="max-sm:hidden">{tr("Rendu IA", "AI render")}</span>
                </button>
                <button
                  onClick={() => {
                    setRecMenu((v) => !v);
                    setAiOpen(false);
                  }}
                  className={`${btn} ${recMenu ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"}`}
                  title={tr("Filmer la visite guidée", "Film the guided tour")}
                >
                  <Clapperboard className="size-4" /> <span className="max-2xl:hidden">{tr("Vidéo", "Video")}</span>
                </button>
              </div>

              {recMenu && (
                <div className="absolute left-1/2 top-[60px] z-10 w-[min(340px,calc(100%-1.5rem))] -translate-x-1/2 max-sm:top-[108px] sm:top-[68px] rounded-2xl bg-paper p-3 shadow-xl ring-1 ring-line">
                  <div className="flex gap-1 rounded-full bg-cream p-1 text-xs font-medium">
                    {(
                      [
                        ["visite", tr("La visite guidée", "The guided tour")],
                        ["construction", tr("La construction", "The build")],
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
                      <div className="mt-2 text-sm font-medium">{tr("Paysage", "Landscape")}</div>
                      <div className="text-xs text-muted">{tr("YouTube, présentation client", "YouTube, client presentation")}</div>
                    </button>
                    <button onClick={() => startRecording("vertical", recWhat)} className="rounded-xl bg-white p-3 text-left ring-1 ring-line transition hover:ring-accent">
                      <Smartphone className="size-5 text-accent" />
                      <div className="mt-2 text-sm font-medium">{tr("Vertical 9:16", "Vertical 9:16")}</div>
                      <div className="text-xs text-muted">{tr("Reels, TikTok, statuts", "Reels, TikTok, Stories")}</div>
                    </button>
                  </div>
                  <p className="px-1 pt-2 text-xs leading-relaxed text-muted">
                    {recWhat === "visite"
                      ? tr(
                          "La visite guidée repart du début et la vidéo se télécharge à la fin du parcours (ou quand vous l'arrêtez).",
                          "The guided tour restarts and the video downloads at the end of the tour (or when you stop it).",
                        )
                      : tr(
                          "La maison sort du plan, niveau par niveau, pendant que la caméra tourne autour. La vidéo se télécharge à la fin.",
                          "The house rises from the plan, floor by floor, while the camera circles it. The video downloads at the end.",
                        )}
                  </p>
                </div>
              )}

              {multi && mode === "maquette" && (
                <div className="absolute left-3 top-1/2 z-10 flex -translate-y-1/2 sm:left-4 flex-col gap-1 rounded-2xl bg-paper/95 p-1.5 shadow-lg ring-1 ring-line backdrop-blur">
                  <div className="flex items-center justify-center gap-1 px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                    <Layers className="size-3" /> {tr("Niveaux", "Floors")}
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
                        title={step === "interieur" ? tr(`Aménager : ${L.name}`, `Furnish: ${L.name}`) : tr(`Voir jusqu'à : ${L.name}`, `Show up to: ${L.name}`)}
                      >
                        {L.name}
                      </button>
                    );
                  })}
                </div>
              )}

              {mode === "visite" && !coarse && (
                <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-ink/80 px-4 py-2 text-sm text-paper backdrop-blur">
                  {tr("Glissez pour regarder · ", "Drag to look around · ")}
                  <b>{tr("Z Q S D", "W A S D")}</b>
                  {tr(" ou flèches pour avancer", " or arrow keys to move")}
                </div>
              )}
              {mode === "visite" && coarse && <TouchPad hint={tr("Glissez pour regarder", "Drag to look around")} />}

              {mode === "guidee" && tour && (
                <div className="absolute inset-x-0 bottom-3 flex flex-col items-center gap-3 px-3 sm:bottom-5 sm:px-6">
                  {stopIdx >= 0 && (
                    <div key={stopIdx} className="rounded-2xl bg-paper/95 px-5 py-2.5 text-center shadow-lg ring-1 ring-line">
                      <div className="text-[11px] uppercase tracking-wider text-muted">
                        {tr("Étape", "Stop")} {stopIdx + 1} / {tour.stops.length}
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
                      title={tr("Recommencer", "Restart")}
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
                <p className="text-muted">{tr("Aucun plan pour l'instant.", "No plan yet.")}</p>
                <button onClick={() => setStep("plan")} className={`${btn} mt-3 bg-ink text-paper`}>
                  <Ruler className="size-4" /> {tr("Aller au plan", "Go to the plan")}
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
              name={project.name.replace(/[^\p{L}\p{N}-]+/gu, "-") || tr("maison", "house")}
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
            <div className="pointer-events-none absolute inset-x-3 bottom-3 z-30 rounded-2xl bg-ink px-4 py-3 text-sm text-paper shadow-lg sm:inset-x-auto sm:bottom-5 sm:left-5 sm:max-w-md">{busy ?? toast}</div>
          )}
        </main>

        {/* ---------- panneau latéral ---------- */}
        {!welcome && (
        <aside
          className={`flex shrink-0 flex-col border-line bg-paper max-lg:order-3 max-lg:border-t max-lg:pb-[env(safe-area-inset-bottom)] lg:w-[320px] lg:border-l ${sheet ? "max-lg:h-[55dvh]" : ""}`}
        >
          {/* téléphone et tablette : le panneau se replie en bas d'écran pour laisser la place au plan et à la 3D */}
          <div className="flex h-12 shrink-0 items-center gap-2 pr-3 lg:hidden">
            <button onClick={() => setSheet((v) => !v)} aria-expanded={sheet} className="flex h-full min-w-0 flex-1 items-center gap-2.5 pl-4 text-left text-sm font-medium">
              <span className="h-1 w-8 shrink-0 rounded-full bg-sand" />
              <span className="truncate">
                {step === "plan"
                  ? `${tr("Plan", "Plan")} · ${rooms.length} ${tr("pièces", "rooms")}${sel ? ` · ${tr("sélection", "selection")}` : ""}`
                  : step === "3d"
                    ? tr("La maison et ses pièces", "The house and its rooms")
                    : tr("Style et mobilier", "Style and furniture")}
              </span>
              {sheet ? <ChevronDown className="size-4 shrink-0 text-muted" /> : <ChevronUp className="size-4 shrink-0 text-muted" />}
            </button>
            {/* l'étape suivante reste à portée de pouce, même panneau replié */}
            {step === "plan" && hasWalls && (
              <button onClick={() => goto3d("3d")} className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 py-2 text-sm font-medium text-white">
                <Box className="size-4" /> {tr("Voir en 3D", "See in 3D")}
              </button>
            )}
            {step === "3d" && (
              <button onClick={() => goto3d("interieur")} className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-3.5 py-2 text-sm font-medium text-white">
                <Sofa className="size-4" /> {tr("Aménager", "Furnish")}
              </button>
            )}
          </div>
          <div className={`scroll-soft min-h-0 flex-1 overflow-y-auto ${sheet ? "" : "max-lg:hidden"}`}>
          {step === "plan" && (
            <>
              <Section
                title={tr("Niveaux", "Floors")}
                right={
                  <button onClick={newLevel} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft" title={tr("Ajouter un étage au-dessus", "Add a floor above")}>
                    <Plus className="size-3.5" /> {tr("Étage", "Floor")}
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
                            aria-label={tr("Nom du niveau", "Floor name")}
                          />
                        ) : (
                          <button onClick={() => gotoLevel(L.index)} className="min-w-0 flex-1 truncate text-left text-sm font-medium">
                            {L.name}
                          </button>
                        )}
                        <span className="shrink-0 text-[11px] tabular-nums opacity-70">{L.z > 0 ? `+${fmt(L.z)}` : tr("sol", "ground")}</span>
                        {multi && (
                          <button onClick={() => dropLevel(L.index)} className="shrink-0 rounded-md p-0.5 opacity-60 hover:opacity-100" title={tr("Supprimer ce niveau", "Delete this floor")}>
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
                      {tr(
                        "Le niveau du dessous apparaît en gris. Importez le plan de cet étage avec « Ouvrir » : il est calé dessus automatiquement.",
                        "The floor below appears in grey. Import this floor's plan with “Open”: it is aligned on it automatically.",
                      )}
                    </p>
                    <div className="flex items-center gap-1">
                      <button onClick={() => alignBelow()} className={`${btn} flex-1 justify-center bg-white px-2 text-xs text-ink ring-1 ring-line hover:bg-sand`} title={tr("Poser les façades de cet étage sur celles du dessous", "Align this floor's façades with the ones below")}>
                        <Magnet className="size-3.5" /> {tr("Caler", "Align")}
                      </button>
                      {(
                        [
                          [ArrowLeft, -0.1, 0],
                          [ArrowUp, 0, -0.1],
                          [ArrowDown, 0, 0.1],
                          [ArrowRight, 0.1, 0],
                        ] as const
                      ).map(([Icon, dx, dy], k) => (
                        <button key={k} onClick={() => commit((p) => translateActive(p, { x: dx, y: dy }))} className="grid size-7 place-items-center rounded-lg bg-white ring-1 ring-line hover:bg-sand" title={tr("Décaler de 10 cm", "Move by 10 cm")}>
                          <Icon className="size-3.5" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </Section>

              <Section title={(() => { const t = TOOLS.find((x) => x.id === tool); return t ? tr(t.label, t.en) : ""; })()}>
                <p className="text-sm leading-relaxed text-muted">{tr(HELP[tool], HELP_EN[tool])}</p>
                {tool === "wall" && (
                  <div className="space-y-2 pt-1">
                    <NumField key={`t${thickness}`} label={tr("Épaisseur", "Thickness")} value={thickness} min={0.05} onCommit={setThickness} />
                    <NumField key={`h${height}`} label={tr("Hauteur", "Height")} value={height} min={1} onCommit={setHeight} />
                    <div className="flex gap-1.5 pt-1">
                      {[
                        [tr("Porteur", "Load-bearing"), 0.25],
                        [tr("Standard", "Standard"), 0.2],
                        [tr("Cloison", "Partition"), 0.1],
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
                    <span className="text-muted">{tr("Type", "Type")}</span>
                    <TypeSelect value={roomType} onChange={setRoomType} className="flex-1" />
                  </div>
                )}
                {(["door", "window", "baie", "passage"] as Tool[]).includes(tool) && (
                  <p className="text-xs text-muted">
                    {tr("Taille par défaut :", "Default size:")} {fmt(OPENING_DEFAULTS[tool as OpeningKind].width)} × {fmt(OPENING_DEFAULTS[tool as OpeningKind].height)}
                    {tr(", modifiable ensuite avec l'outil Sélection.", ", editable afterwards with the Select tool.")}
                  </p>
                )}
              </Section>

              {sel && (
                <Section
                  title={
                    sel.kind === "wall"
                      ? tr("Mur sélectionné", "Selected wall")
                      : sel.kind === "opening"
                        ? tr(OPENING_DEFAULTS[sel.o.kind].label, OPENING_LABELS_EN[sel.o.kind])
                        : tr("Pièce", "Room")
                  }
                  right={
                    <button
                      onClick={() => {
                        remove(selected!);
                        setSelected(null);
                      }}
                      className="rounded-lg p-1.5 text-muted hover:bg-accent-soft hover:text-accent"
                      title={tr("Supprimer", "Delete")}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  }
                >
                  {sel.kind === "wall" && (
                    <>
                      <NumField
                        key={`L${sel.w.id}${wallLength(sel.w)}`}
                        label={tr("Longueur", "Length")}
                        value={wallLength(sel.w)}
                        min={0.1}
                        onCommit={(L) => updateWall(sel.w.id, { b: add(sel.w.a, mul(wallDir(sel.w), L)) })}
                      />
                      <NumField key={`T${sel.w.id}${sel.w.thickness}`} label={tr("Épaisseur", "Thickness")} value={sel.w.thickness} min={0.05} onCommit={(v) => updateWall(sel.w.id, { thickness: v })} />
                      <NumField key={`H${sel.w.id}${sel.w.height}`} label={tr("Hauteur", "Height")} value={sel.w.height} min={1} onCommit={(v) => updateWall(sel.w.id, { height: v })} />
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
                            {tr(OPENING_DEFAULTS[k].label, OPENING_LABELS_EN[k])}
                          </button>
                        ))}
                      </div>
                      <NumField key={`W${sel.o.id}${sel.o.width}`} label={tr("Largeur", "Width")} value={sel.o.width} min={0.3} onCommit={(v) => updateOpening(sel.o.id, { width: v })} />
                      <NumField key={`Hh${sel.o.id}${sel.o.height}`} label={tr("Hauteur", "Height")} value={sel.o.height} min={0.3} onCommit={(v) => updateOpening(sel.o.id, { height: v })} />
                      {sel.o.kind === "window" && (
                        <NumField key={`S${sel.o.id}${sel.o.sill}`} label={tr("Allège", "Sill height")} value={sel.o.sill} onCommit={(v) => updateOpening(sel.o.id, { sill: v })} />
                      )}
                      <NumField key={`P${sel.o.id}${sel.o.t}`} label={tr("Position sur le mur", "Position on the wall")} value={sel.o.t} onCommit={(v) => updateOpening(sel.o.id, { t: v })} />
                    </>
                  )}
                  {sel.kind === "room" && (
                    <>
                      <label className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-muted">{tr("Nom", "Name")}</span>
                        <input
                          key={sel.r.id + sel.r.name}
                          defaultValue={sel.r.name}
                          onBlur={(e) => e.target.value.trim() && updateRoom(sel.r.id, { name: e.target.value.trim() })}
                          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                          className="w-40 rounded-lg border border-line bg-white px-2 py-1 outline-none focus:border-accent"
                        />
                      </label>
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-muted">{tr("Type", "Type")}</span>
                        <TypeSelect value={sel.r.type} onChange={(type) => updateRoom(sel.r.id, { type })} className="w-40" />
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted">{tr("Surface", "Area")}</span>
                        <span className="tabular-nums">{fmtArea(Math.abs(polygonArea(sel.r.points)))}</span>
                      </div>
                      {!sel.r.stairs && (
                        <button
                          onClick={() => updateRoom(sel.r.id, { stairs: defaultStairs(sel.r) })}
                          className={`${btn} w-full justify-center bg-cream text-xs text-ink hover:bg-sand`}
                          title={tr("Volée droite le long du plus grand côté ; elle relie ce niveau à celui du dessus", "Straight flight along the longest side, linking this floor to the one above")}
                        >
                          <Plus className="size-3.5" /> {tr("Ajouter un escalier", "Add stairs")}
                        </button>
                      )}
                      {sel.r.stairs && (
                        <div className="flex gap-1.5 pt-1">
                          <button
                            onClick={() => updateRoom(sel.r.id, { stairs: { ...sel.r.stairs!, rot: sel.r.stairs!.rot + Math.PI } })}
                            className={`${btn} flex-1 justify-center bg-cream px-2 text-xs text-ink hover:bg-sand`}
                            title={tr("L'escalier monte dans l'autre sens", "The stairs go up the other way")}
                          >
                            <ArrowLeftRight className="size-3.5" /> {tr("Sens de l'escalier", "Stairs direction")}
                          </button>
                          <button onClick={() => updateRoom(sel.r.id, { stairs: undefined })} className={`${btn} justify-center bg-cream px-2 text-xs text-ink hover:bg-sand`} title={tr("Retirer l'escalier lu sur le plan", "Remove the stairs read from the plan")}>
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
                  title={tr("Plan importé", "Imported plan")}
                  right={
                    <button onClick={() => setBackground(null)} className="rounded-lg p-1.5 text-muted hover:bg-accent-soft hover:text-accent" title={tr("Retirer le plan", "Remove the plan")}>
                      <Trash2 className="size-4" />
                    </button>
                  }
                >
                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted">{tr("Opacité", "Opacity")}</span>
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
                    <span className="text-muted">{tr("Taille du plan", "Plan size")}</span>
                    <span className="tabular-nums">
                      {fmt(background.widthPx * background.scale)} × {fmt(background.heightPx * background.scale)}
                    </span>
                  </div>
                  {background.auto && !background.calibrated && (
                    <p className="rounded-xl bg-accent-soft px-3 py-2 text-xs leading-relaxed text-ink">
                      {tr("Échelle ", "Scale ")}
                      <b>{tr("estimée", "estimated")}</b>
                      {tr(
                        " d'après l'épaisseur des murs. Pour des dimensions exactes, cliquez les deux bouts d'une cote connue.",
                        " from the wall thickness. For exact dimensions, click both ends of a known dimension.",
                      )}
                    </p>
                  )}
                  <button onClick={() => setTool("calibrate")} className={`${btn} w-full justify-center bg-cream text-ink hover:bg-sand`}>
                    <Ruler className="size-4" /> {background.calibrated ? tr("Recalibrer l'échelle", "Recalibrate the scale") : tr("Calibrer l'échelle", "Calibrate the scale")}
                  </button>
                  <button
                    onClick={() => {
                      if (walls.length && !confirm(tr("Relire le plan remplace les murs, ouvertures et pièces actuels. Continuer ?", "Reading the plan again replaces the current walls, openings and rooms. Continue?"))) return;
                      readImagePlan(background);
                    }}
                    className={`${btn} w-full justify-center bg-cream text-ink hover:bg-sand`}
                  >
                    <WandSparkles className="size-4" /> {tr("Relire le plan automatiquement", "Read the plan again")}
                  </button>
                </Section>
              )}

              <Section
                title={`${tr("Pièces", "Rooms")} · ${rooms.length}`}
                right={
                  walls.length > 0 && (
                    <button onClick={autoRooms} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft" title={tr("Détecter toutes les pièces fermées", "Detect all closed rooms")}>
                      <WandSparkles className="size-3.5" /> {tr("Détecter", "Detect")}
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
                  <Box className="size-5" /> {tr("Voir la maison en 3D", "See the house in 3D")}
                </button>
                <p className="mt-3 text-center text-xs text-muted">
                  {walls.length} {tr("murs", "walls")} · {openings.length} {tr("ouvertures", "openings")} ·{" "}
                  {fmtArea(rooms.reduce((s, r) => s + Math.abs(polygonArea(r.points)), 0))} {tr("habitables", "living area")}
                </p>
              </div>
            </>
          )}

          {step === "3d" && (
            <>
              <Section title={tr("La maison", "The house")}>
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    [allRooms.length, tr("pièces", "rooms")],
                    [fmtArea(allRooms.reduce((s, r) => s + Math.abs(polygonArea(r.points)), 0)).replace(" m²", ""), tr("m² habitables", "m² living area")],
                    [house.reduce((n, L) => n + L.openings.filter((o) => o.kind !== "passage").length, 0), tr("ouvertures", "openings")],
                  ].map(([v, l]) => (
                    <div key={l as string} className="rounded-xl bg-cream px-2 py-3">
                      <div className="font-display text-xl font-semibold tabular-nums">{v}</div>
                      <div className="text-[11px] text-muted">{l}</div>
                    </div>
                  ))}
                </div>
              </Section>
              <Section title={tr("Visiter une pièce", "Visit a room")}>
                {house.map((L) => (
                  <div key={L.index} className="space-y-2">
                    {multi && <div className="pt-1 text-xs font-semibold text-muted">{L.name}</div>}
                    <RoomList rooms={L.rooms} level={L.index} pickLabel={tr("Y aller", "Go")} onPick={visitRoom} />
                  </div>
                ))}
              </Section>
              <div className="p-5">
                <button
                  onClick={() => goto3d("interieur")}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3 font-medium text-white shadow-sm transition hover:brightness-105"
                >
                  <Sofa className="size-5" /> {tr("Aménager l'intérieur", "Design the interior")}
                </button>
              </div>
            </>
          )}

          {step === "interieur" && (
            <>
              <Section title={tr("Style d'aménagement", "Interior style")}>
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
                        <div className="mt-2 text-[13px] font-semibold leading-tight">{tr(s.name, s.nameEn)}</div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs leading-relaxed text-muted">
                  {(() => {
                    const st = STYLES.find((s) => s.id === project.styleId);
                    return st ? tr(st.description, st.descriptionEn) : null;
                  })()}
                </p>
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
          </div>
        </aside>
        )}
      </div>
      <BuyCredits />
      <LoginDialog />
      <MySpace
        currentId={project.id}
        onOpen={async (id) => {
          const p = await openProject(id);
          load(p);
          markSaved(useProject.getState().project);
          setSelected(null);
          setSelectedF(null);
          setTool("select");
          setStep(p.walls.length || (p.levels?.length ?? 0) > 1 ? "3d" : "plan");
          setFitKey((k) => k + 1);
        }}
        onNew={() => {
          load(EMPTY_PROJECT);
          setStep("plan");
          setTool("select");
          setSelected(null);
          setFitKey((k) => k + 1);
        }}
      />
    </div>
  );
}
