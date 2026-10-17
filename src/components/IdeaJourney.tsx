"use client";
/* Le parcours « de l'idée à la maison » : choix parmi les variantes (plans qui se dessinent sous les yeux),
   puis enchaînement automatique des étapes existantes (construction 3D, visite guidée, intérieur meublé),
   avec un ruban de progression et une carte finale. La logique du parcours vit dans App ; ici, l'affichage. */
import { ArrowLeft, Check, Clapperboard, PencilRuler, Redo2, Sparkles, X } from "lucide-react";
import { useMemo } from "react";
import type { LevelContent, Project, RoomType } from "@/lib/types";
import { polygonArea } from "@/lib/geometry";
import { useTr } from "@/lib/i18n";

/* ---------- le plan en SVG : les murs se tracent, puis les pièces se colorent et se nomment ---------- */

const ROOM_COLORS: Partial<Record<RoomType, string>> = {
  salon: "#f6dccd",
  chambre: "#efe3cf",
  cuisine: "#e4e8dc",
  salle_de_bain: "#dbe8e6",
  wc: "#dbe8e6",
  bureau: "#ece4d6",
  couloir: "#f4f0e8",
  salle_a_manger: "#f3e4d4",
  terrasse: "#e3ead9",
  garage: "#e2ded6",
  escalier: "#ece7dd",
  autre: "#eeeae2",
};

const S = 20; // unités SVG par mètre

/* tracé des murs et apparition des pièces ; rien ne bouge si la personne a demandé moins d'animations */
const CSS = `
@keyframes xwe-trace { to { stroke-dashoffset: 0 } }
@keyframes xwe-fade { to { opacity: 1 } }
.xwe-wall { stroke-dasharray: 1; stroke-dashoffset: 1; animation: xwe-trace .45s ease-out forwards; }
.xwe-in { opacity: 0; animation: xwe-fade .6s ease forwards; }
@media (prefers-reduced-motion: reduce) { .xwe-wall { animation: none; stroke-dashoffset: 0 } .xwe-in { animation: none; opacity: 1 } }
`;

function LevelSVG({ lv, box, delay, label }: { lv: LevelContent; box: { x0: number; y0: number; x1: number; y1: number }; delay: number; label?: string }) {
  const X = (x: number) => (x - box.x0) * S;
  const Y = (y: number) => (y - box.y0) * S;
  const walls = lv.walls;
  const step = Math.min(70, 1100 / Math.max(1, walls.length)); // tout le tracé tient en ~1 s
  const roomsAt = delay + walls.length * step + 150;
  const els: React.ReactNode[] = [];

  // sols
  lv.rooms.forEach((r, i) =>
    els.push(
      <polygon
        key={`f${r.id}`}
        points={r.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")}
        fill={ROOM_COLORS[r.type] ?? ROOM_COLORS.autre}
        className="xwe-in"
        style={{ animationDelay: `${roomsAt + i * 40}ms` }}
      />,
    ),
  );

  // murs : des morceaux entre les ouvertures (prolongés aux extrémités pour fermer les angles)
  walls.forEach((w, i) => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const dx = (w.b.x - w.a.x) / L;
    const dy = (w.b.y - w.a.y) / L;
    const at = (t: number) => ({ x: w.a.x + dx * t, y: w.a.y + dy * t });
    const ops = lv.openings.filter((o) => o.wallId === w.id).sort((a, b) => a.t - b.t);
    const low = w.height < 1.5;
    const piece = (s: number, e: number, k: string) => {
      if (e - s < 0.02) return;
      const a = at(s);
      const b = at(e);
      els.push(
        <line
          key={k}
          x1={X(a.x)}
          y1={Y(a.y)}
          x2={X(b.x)}
          y2={Y(b.y)}
          pathLength={1}
          stroke={low ? "#a69a88" : "#2a2620"}
          strokeWidth={w.thickness * S}
          className="xwe-wall"
          style={{ animationDelay: `${delay + i * step}ms` }}
        />,
      );
    };
    let t = -w.thickness / 2;
    ops.forEach((o, k) => {
      const s = o.t - o.width / 2;
      const e = o.t + o.width / 2;
      piece(t, s, `w${w.id}-${k}`);
      t = e;
      const a = at(s);
      const b = at(e);
      const style = { animationDelay: `${roomsAt}ms` };
      if (o.kind === "window" || o.kind === "baie")
        els.push(
          <line key={`o${o.id}`} x1={X(a.x)} y1={Y(a.y)} x2={X(b.x)} y2={Y(b.y)} stroke={o.kind === "baie" ? "#3b82c4" : "#8bbbd9"} strokeWidth={w.thickness * S * 0.45} className="xwe-in" style={style} />,
        );
      else if (o.kind === "door") {
        // le battant ouvert et son arc
        const r = o.width * S;
        const nx = -dy;
        const ny = dx;
        els.push(
          <path
            key={`o${o.id}`}
            d={`M ${X(a.x)} ${Y(a.y)} l ${nx * r} ${ny * r} A ${r} ${r} 0 0 0 ${X(b.x)} ${Y(b.y)}`}
            fill="none"
            stroke="#c0643a"
            strokeWidth={1}
            opacity={0.8}
            className="xwe-in"
            style={style}
          />,
        );
      }
    });
    piece(t, L + w.thickness / 2, `w${w.id}-end`);
  });

  // escalier : la volée en pointillés, une flèche qui monte
  for (const r of lv.rooms) {
    if (!r.stairs) continue;
    const s = r.stairs;
    const c = Math.cos(s.rot);
    const sn = Math.sin(s.rot);
    const at = (u: number, v: number) => ({ x: s.x + c * u + sn * v, y: s.y - sn * u + c * v });
    const P = [at(-s.w / 2, -s.d / 2), at(s.w / 2, -s.d / 2), at(s.w / 2, s.d / 2), at(-s.w / 2, s.d / 2)];
    const b = at(-s.w / 2 + 0.3, 0);
    const t = at(s.w / 2 - 0.3, 0);
    els.push(
      <g key={`st${r.id}`} className="xwe-in" style={{ animationDelay: `${roomsAt}ms` }} stroke="#c0643a" fill="none" strokeWidth={1.2}>
        <polygon points={P.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")} strokeDasharray="3 2" />
        <line x1={X(b.x)} y1={Y(b.y)} x2={X(t.x)} y2={Y(t.y)} />
        <circle cx={X(t.x)} cy={Y(t.y)} r={2.5} fill="#c0643a" />
      </g>,
    );
  }

  // noms et surfaces, quand ils tiennent dans la pièce
  lv.rooms.forEach((r, i) => {
    const xs = r.points.map((p) => p.x);
    const ys = r.points.map((p) => p.y);
    const w = (Math.max(...xs) - Math.min(...xs)) * S;
    const h = (Math.max(...ys) - Math.min(...ys)) * S;
    const cx = X((Math.min(...xs) + Math.max(...xs)) / 2);
    const cy = Y((Math.min(...ys) + Math.max(...ys)) / 2);
    const area = Math.abs(polygonArea(r.points));
    const size = Math.min(10, (w - 4) / Math.max(4, r.name.length * 0.56));
    if (h < 18 || area < 2.5) return;
    els.push(
      <g key={`t${r.id}`} className="xwe-in" style={{ animationDelay: `${roomsAt + 300 + i * 30}ms` }} textAnchor="middle" fontFamily="var(--font-sans, sans-serif)">
        {size >= 5.5 && (
          <text x={cx} y={cy - 1} fontSize={size} fontWeight={600} fill="#2a2620">
            {r.name}
          </text>
        )}
        <text x={cx} y={cy + (size >= 5.5 ? size + 1 : 3)} fontSize={Math.min(8.5, Math.max(6, size * 0.85))} fill="#6b6459">
          {area.toFixed(0)} m²
        </text>
      </g>,
    );
  });

  const W = (box.x1 - box.x0) * S;
  const H = (box.y1 - box.y0) * S;
  return (
    <figure className="min-w-0 flex-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto block h-auto max-h-[42vh] w-full" role="img" aria-label={label ?? "plan"}>
        {els}
      </svg>
      {label && <figcaption className="mt-1 text-center text-[11px] font-medium uppercase tracking-wider text-muted">{label}</figcaption>}
    </figure>
  );
}

/** Le plan d'une maison, tous ses niveaux côte à côte, à la même échelle. */
export function PlanSVG({ project, delay = 0 }: { project: Project; delay?: number }) {
  const tr = useTr();
  const lvs = useMemo(() => [project as LevelContent, ...(project.levels ?? []).slice(1).map((l) => l.data!).filter(Boolean)], [project]);
  const box = useMemo(() => {
    const pts = lvs.flatMap((lv) => [...lv.walls.flatMap((w) => [w.a, w.b]), ...lv.rooms.flatMap((r) => r.points)]);
    const m = 0.4;
    return { x0: Math.min(...pts.map((p) => p.x)) - m, y0: Math.min(...pts.map((p) => p.y)) - m, x1: Math.max(...pts.map((p) => p.x)) + m, y1: Math.max(...pts.map((p) => p.y)) + m };
  }, [lvs]);
  const names = project.levels?.map((l) => l.name) ?? [];
  return (
    <div className="flex items-end gap-3">
      <style>{CSS}</style>
      {lvs.map((lv, i) => (
        <LevelSVG key={i} lv={lv} box={box} delay={delay + i * 500} label={lvs.length > 1 ? names[i] ?? (i ? tr("Étage", "Upper floor") : tr("Rez-de-chaussée", "Ground floor")) : undefined} />
      ))}
    </div>
  );
}

/* ---------- écran de choix : les variantes ---------- */

export interface IdeaPlanCard {
  title: string;
  summary: string;
  project: Project;
}

export function IdeaPlans({ plans, onChoose, onBack }: { plans: IdeaPlanCard[] | null; onChoose: (i: number) => void; onBack: () => void }) {
  const tr = useTr();
  return (
    <div className="absolute inset-0 z-20 overflow-y-auto bg-cream/80 p-4 backdrop-blur sm:p-8">
      <div className="mx-auto w-full max-w-6xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <button onClick={onBack} className="mb-2 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-sm text-muted hover:bg-paper hover:text-ink">
              <ArrowLeft className="size-4" /> {tr("Mon idée", "My idea")}
            </button>
            <div className="flex items-center gap-2 text-accent">
              <PencilRuler className="size-5 shrink-0" />
              <h2 className="font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
                {plans === null
                  ? tr("Xwé dessine vos plans…", "Xwé is drawing your plans…")
                  : plans.length > 1
                    ? tr(`Voici ${plans.length === 2 ? "deux" : "trois"} maisons pour vous`, `Here are ${plans.length === 2 ? "two" : "three"} homes for you`)
                    : plans.length
                      ? tr("Voici votre maison", "Here is your home")
                      : tr("Aucune maison ne tient sur ce terrain", "No home fits on this plot")}
              </h2>
            </div>
            <p className="mt-1.5 text-sm text-muted sm:text-[15px]">
              {plans === null
                ? tr("Les pièces, les couloirs, les portes, les fenêtres : tout se met en place.", "Rooms, hallways, doors, windows: it all falls into place.")
                : plans.length
                  ? tr("Choisissez celle qui vous plaît : Xwé la construit, vous la fait visiter et la meuble.", "Pick the one you like: Xwé builds it, gives you the tour and furnishes it.")
                  : tr("Agrandissez le terrain ou retirez une pièce, puis réessayez.", "Make the plot bigger or remove a room, then try again.")}
            </p>
          </div>
          <button onClick={onBack} aria-label={tr("Fermer", "Close")} className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-paper hover:text-ink">
            <X className="size-5" />
          </button>
        </div>

        {plans === null ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="relative h-72 overflow-hidden rounded-3xl bg-paper ring-1 ring-line">
                <div className="xwe-shimmer absolute inset-0" />
                <Sparkles className="absolute left-1/2 top-1/2 size-8 -translate-x-1/2 -translate-y-1/2 animate-pulse text-accent/60" style={{ animationDelay: `${i * 200}ms` }} />
              </div>
            ))}
          </div>
        ) : (
          <div className={`mt-6 grid gap-4 ${plans.length > 1 ? "sm:grid-cols-2" : ""} ${plans.length > 2 ? "xl:grid-cols-3" : ""}`}>
            {plans.map((pl, i) => (
              <div
                key={pl.title + i}
                className="group flex flex-col overflow-hidden rounded-3xl bg-paper text-left shadow-[0_18px_50px_-20px_rgba(42,38,32,0.35)] ring-1 ring-line transition hover:-translate-y-1 hover:shadow-xl"
              >
                <div className="bg-[#fbf9f5] p-4 sm:p-5">
                  <PlanSVG project={pl.project} delay={i * 350} />
                </div>
                <div className="flex flex-1 flex-col p-4 sm:p-5">
                  <div className="font-display text-xl font-semibold">{pl.title}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {pl.summary.split(" · ").map((s) => (
                      <span key={s} className="rounded-full bg-cream px-2.5 py-1 text-xs text-muted">
                        {s}
                      </span>
                    ))}
                  </div>
                  <button
                    onClick={() => onChoose(i)}
                    className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 self-start rounded-full bg-accent px-5 text-sm font-semibold text-white transition hover:brightness-105"
                  >
                    <Check className="size-4" /> {tr("Choisir cette maison", "Choose this home")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- le ruban du parcours ---------- */

export const JOURNEY_STEPS_FR = ["Votre idée", "Plan", "Construction", "Visite guidée", "Intérieur", "Photo et vidéo"];
export const JOURNEY_STEPS_EN = ["Your idea", "Plan", "Build", "Guided tour", "Interior", "Photo and video"];

/** Le ruban de progression en haut, la phrase de l'étape, « Passer » et « Arrêter ». */
export function JourneyRibbon({ index, message, onNext, onStop }: { index: number; message: string; onNext: () => void; onStop: () => void }) {
  const tr = useTr();
  const steps = tr(JOURNEY_STEPS_FR.join("|"), JOURNEY_STEPS_EN.join("|")).split("|");
  return (
    <div className="pointer-events-auto absolute left-1/2 top-3 z-20 w-[min(760px,calc(100%-1.5rem))] -translate-x-1/2 rounded-2xl bg-paper/95 p-2.5 shadow-xl ring-1 ring-line backdrop-blur sm:top-4 sm:p-3">
      <div className="flex items-center gap-1 sm:gap-1.5">
        {steps.map((s, i) => (
          <div key={s} className={`flex items-center gap-1 sm:gap-1.5 ${i === index ? "min-w-0" : "shrink-0"}`}>
            <span
              className={`grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold transition ${
                i < index ? "bg-leaf text-white" : i === index ? "bg-accent text-white ring-4 ring-accent/20" : "bg-sand text-muted"
              }`}
            >
              {i < index ? <Check className="size-3.5" /> : i + 1}
            </span>
            {i === index && <span className="truncate text-xs font-semibold text-ink">{s}</span>}
            {i < steps.length - 1 && <span className={`hidden h-px w-3 shrink-0 sm:block ${i < index ? "bg-leaf/60" : "bg-line"}`} />}
          </div>
        ))}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button onClick={onNext} className="min-h-9 whitespace-nowrap rounded-full bg-cream px-3 text-xs font-semibold text-ink hover:bg-sand">
            {tr("Passer", "Skip")}
          </button>
          <button onClick={onStop} className="min-h-9 whitespace-nowrap rounded-full px-2.5 text-xs font-medium text-muted hover:text-ink" title={tr("Garder la maison et reprendre la main", "Keep the house and take over")}>
            {tr("Arrêter", "Stop")}
          </button>
        </span>
      </div>
      <div key={message} className="xwe-in mt-2 text-center font-display text-[15px] text-ink sm:text-base">
        {message}
      </div>
    </div>
  );
}

/* ---------- la carte finale ---------- */

export function IdeaDone({ onFilm, onEditPlan, onAnother, onAI, onClose }: { onAI: () => void; onFilm: () => void; onEditPlan: () => void; onAnother: () => void; onClose: () => void }) {
  const tr = useTr();
  return (
    <div className="xwe-in absolute inset-x-3 bottom-3 z-20 mx-auto max-w-md rounded-3xl bg-paper p-5 shadow-2xl ring-1 ring-line sm:inset-x-auto sm:bottom-6 sm:left-5 sm:w-[420px]">
      <style>{CSS}</style>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-leaf">
            <Check className="size-5" />
            <h2 className="font-display text-xl font-semibold">{tr("Votre maison est prête", "Your home is ready")}</h2>
          </div>
          <p className="mt-1 text-sm text-muted">{tr("Construite, visitée, meublée. Et maintenant ?", "Built, toured, furnished. What next?")}</p>
        </div>
        <button onClick={onClose} aria-label={tr("Fermer", "Close")} className="-mr-2 -mt-2 grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-cream hover:text-ink">
          <X className="size-5" />
        </button>
      </div>
      <div className="mt-3 grid gap-2">
        <button onClick={onAI} className="flex items-center gap-3 rounded-2xl bg-ink px-4 py-3 text-left text-paper transition hover:brightness-110">
          <Sparkles className="size-5 shrink-0 text-accent" />
          <span className="min-w-0">
            <span className="block font-medium">{tr("Photo et vidéo réalistes", "Realistic photo and video")}</span>
            <span className="block text-xs text-paper/60">{tr("Choisissez dans le panneau Rendu IA", "Choose in the AI render panel")}</span>
          </span>
        </button>
        <button onClick={onFilm} className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 text-left ring-1 ring-line transition hover:ring-sand">
          <Clapperboard className="size-5 shrink-0 text-accent" />
          <span className="min-w-0">
            <span className="block font-medium">{tr("Filmer la visite", "Film the tour")}</span>
            <span className="block text-xs text-muted">{tr("Une vidéo de la visite guidée, gratuite", "A free video of the guided tour")}</span>
          </span>
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={onEditPlan} className="flex min-h-11 items-center gap-2 rounded-2xl bg-white px-3 text-left text-sm ring-1 ring-line transition hover:ring-sand">
            <PencilRuler className="size-4 shrink-0 text-muted" /> {tr("Modifier le plan", "Edit the plan")}
          </button>
          <button onClick={onAnother} className="flex min-h-11 items-center gap-2 rounded-2xl bg-white px-3 text-left text-sm ring-1 ring-line transition hover:ring-sand">
            <Redo2 className="size-4 shrink-0 text-muted" /> {tr("Une autre idée", "Another idea")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Les animations du parcours (à monter une fois là où le ruban s'affiche). */
export const JourneyStyle = () => <style>{CSS}</style>;
