"use client";
/* Écran « Votre idée » : la personne décrit sa maison en une phrase, Xwé lit les réglages
   dans la phrase (parseIdea, sans IA ni réseau), les montre en direct et les laisse modifier. */
import { Sparkles, Armchair, Bath, BedDouble, Boxes, Briefcase, Car, CookingPot, Map, Minus, Plus, Ruler, X } from "lucide-react";
import { useRef, useState } from "react";
import { useLang, useTr } from "@/lib/i18n";
import { parseIdea, type IdeaBrief } from "@/lib/idea";
import { STYLES } from "@/lib/styles";

const PRESETS_FR = [
  "Maison de 3 chambres plain-pied, avec garage et grande terrasse, cuisine ouverte",
  "Duplex R+1 de 5 chambres avec bureau, terrain de 20 × 25 m",
  "Petite maison 2 chambres sur 10 × 15 m, cuisine fermée, une salle de bain",
];
const PRESETS_EN = [
  "3-bedroom single-storey house with garage and a large terrace, open kitchen",
  "Two-storey 5-bedroom duplex with an office, 20 × 25 m plot",
  "Small 2-bedroom house on 10 × 15 m, closed kitchen, one bathroom",
];

function Stepper({ label, value, min, max, onChange, icon }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-line">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        {icon && <span className="text-accent">{icon}</span>}
        <span className="truncate text-muted">{label}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <button onClick={() => onChange(value - 1)} disabled={value <= min} aria-label="-" className="grid size-7 place-items-center rounded-full bg-cream text-ink disabled:opacity-30">
          <Minus className="size-3.5" />
        </button>
        <span className="w-6 text-center font-semibold tabular-nums">{value}</span>
        <button onClick={() => onChange(value + 1)} disabled={value >= max} aria-label="+" className="grid size-7 place-items-center rounded-full bg-cream text-ink disabled:opacity-30">
          <Plus className="size-3.5" />
        </button>
      </span>
    </div>
  );
}

function Toggle({ label, value, onChange, icon }: { label: string; value: boolean; onChange: (v: boolean) => void; icon?: React.ReactNode }) {
  return (
    <button
      onClick={() => onChange(!value)}
      aria-pressed={value}
      className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm ring-1 transition ${value ? "bg-accent-soft text-ink ring-[#efc6ae]" : "bg-white text-muted ring-line"}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className={value ? "text-accent" : "text-muted/70"}>{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      <span className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white transition ${value ? "bg-accent" : "bg-sand"}`}>
        {value ? "✓" : ""}
      </span>
    </button>
  );
}

export default function IdeaWizard({
  onClose,
  onNext,
  initial,
}: {
  onClose: () => void;
  onNext: (brief: IdeaBrief, text: string) => void;
  /** l'idée précédente, quand on revient (« Une autre idée », retour depuis les plans) */
  initial?: { text: string; brief: IdeaBrief } | null;
}) {
  const tr = useTr();
  const lang = useLang((s) => s.lang);
  const presets = lang === "en" ? PRESETS_EN : PRESETS_FR;
  // les réglages, recalculés à chaque frappe ; modifiés à la main, ils restent jusqu'à la frappe suivante
  const [text, setText] = useState(initial?.text ?? "");
  const [brief, setBrief] = useState<IdeaBrief>(() => initial?.brief ?? parseIdea("", lang));
  const touched = useRef(false);

  const onChangeText = (t: string) => {
    setText(t);
    touched.current = false;
    setBrief(parseIdea(t, lang));
  };

  const patch = (b: Partial<IdeaBrief>) => {
    touched.current = true;
    setBrief((x) => ({ ...x, ...b }));
  };

  return (
    <div className="absolute inset-0 z-20 overflow-y-auto bg-cream/70 p-4 backdrop-blur sm:p-8">
      <div className="mx-auto w-full max-w-3xl rounded-3xl bg-paper p-5 shadow-[0_30px_80px_-24px_rgba(42,38,32,0.4)] ring-1 ring-line sm:p-9">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-accent">
              <Sparkles className="size-5" />
              <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{tr("Votre idée", "Your idea")}</h2>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted sm:text-[15px]">
              {tr(
                "Décrivez la maison de vos rêves : Xwé en lit les réglages et dessine des plans pour vous.",
                "Describe your dream home: Xwé reads its settings and draws plans for you.",
              )}
            </p>
          </div>
          <button onClick={onClose} aria-label={tr("Fermer", "Close")} className="rounded-full p-2 text-muted hover:bg-cream hover:text-ink">
            <X className="size-5" />
          </button>
        </div>

        <textarea
          value={text}
          onChange={(e) => onChangeText(e.target.value)}
          rows={3}
          autoFocus
          placeholder={tr(
            "Ex. : Villa de 4 chambres sur un terrain de 15 × 20 m, avec garage, grande terrasse et cuisine ouverte",
            "E.g.: 4-bedroom villa on a 15 × 20 m plot, with garage, large terrace and open kitchen",
          )}
          className="mt-5 w-full resize-none rounded-2xl border border-line bg-white px-4 py-3 text-[15px] leading-relaxed outline-none transition focus:border-accent"
        />

        {/* trois idées toutes prêtes */}
        <div className="mt-3 flex flex-wrap gap-2">
          {presets.map((p, i) => (
            <button
              key={i}
              onClick={() => onChangeText(p)}
              className="max-w-full rounded-full bg-cream px-3.5 py-1.5 text-xs font-medium text-muted transition hover:bg-sand hover:text-ink sm:text-[13px]"
            >
              {p.length > 44 ? `${p.slice(0, 42)}…` : p}
            </button>
          ))}
        </div>

        {/* réglages lus en direct, modifiables */}
        <div className="mt-6">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
            <Ruler className="size-3.5" />
            {tr("Ce que Xwé a compris", "What Xwé understood")}
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Stepper label={tr("Chambres", "Bedrooms")} icon={<BedDouble className="size-4" />} value={brief.bedrooms} min={1} max={6} onChange={(n) => patch({ bedrooms: n })} />
            <Stepper label={tr("Salles de bain", "Bathrooms")} icon={<Bath className="size-4" />} value={brief.bathrooms} min={1} max={4} onChange={(n) => patch({ bathrooms: n })} />
            <Stepper label={tr("Niveaux", "Floors")} icon={<Boxes className="size-4" />} value={brief.levels} min={1} max={2} onChange={(n) => patch({ levels: n === 2 ? 2 : 1 })} />
            <div className="flex items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-line">
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <Map className="size-4 shrink-0 text-accent" />
                <span className="truncate text-muted">{tr("Terrain", "Plot")}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-sm">
                <input
                  aria-label={tr("Largeur du terrain", "Plot width")}
                  className="w-14 rounded-lg border border-line bg-paper px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-accent"
                  inputMode="decimal"
                  value={Math.round(brief.plotW)}
                  onChange={(e) => patch({ plotW: parseFloat(e.target.value.replace(",", ".")) || brief.plotW })}
                />
                <span className="text-xs text-muted">×</span>
                <input
                  aria-label={tr("Profondeur du terrain", "Plot depth")}
                  className="w-14 rounded-lg border border-line bg-paper px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-accent"
                  inputMode="decimal"
                  value={Math.round(brief.plotD)}
                  onChange={(e) => patch({ plotD: parseFloat(e.target.value.replace(",", ".")) || brief.plotD })}
                />
                <span className="text-xs text-muted">m</span>
              </span>
            </div>
            <Toggle label={tr("Garage", "Garage")} icon={<Car className="size-4" />} value={brief.garage} onChange={(v) => patch({ garage: v })} />
            <Toggle label={tr("Terrasse", "Terrace")} icon={<Armchair className="size-4" />} value={brief.terrace} onChange={(v) => patch({ terrace: v })} />
            <Toggle label={tr("Bureau", "Office")} icon={<Briefcase className="size-4" />} value={brief.office} onChange={(v) => patch({ office: v })} />
            <Toggle label={tr("Cuisine ouverte", "Open kitchen")} icon={<CookingPot className="size-4" />} value={brief.openKitchen} onChange={(v) => patch({ openKitchen: v })} />
          </div>

          {/* style : les pastilles de couleur des STYLES */}
          <div className="mt-3 flex flex-wrap gap-2">
            {STYLES.map((s) => (
              <button
                key={s.id}
                onClick={() => patch({ styleId: s.id })}
                title={tr(s.description, s.descriptionEn)}
                className={`flex items-center gap-2 rounded-full py-1 pl-1.5 pr-3 text-xs font-medium transition ring-1 ${brief.styleId === s.id ? "bg-accent-soft text-ink ring-[#efc6ae]" : "bg-white text-muted ring-line hover:text-ink"}`}
              >
                <span className="flex h-5 w-9 overflow-hidden rounded-full ring-1 ring-line">
                  <span className="flex-1" style={{ background: s.wall }} />
                  <span className="flex-1" style={{ background: s.floors.default.color }} />
                  <span className="flex-1" style={{ background: s.accent }} />
                  <span className="flex-1" style={{ background: s.accent2 }} />
                </span>
                <span className="truncate">{tr(s.name, s.nameEn)}</span>
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={() => onNext({ ...brief, plotW: Math.min(40, Math.max(8, brief.plotW)), plotD: Math.min(40, Math.max(8, brief.plotD)) }, text)}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3.5 font-display text-lg font-semibold text-white shadow-sm transition hover:brightness-105"
        >
          <Sparkles className="size-5" /> {tr("Dessiner ma maison", "Draw my house")}
        </button>
      </div>
    </div>
  );
}
