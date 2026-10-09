"use client";
/* Design d'espace (étape Intérieur) : mobilier modifiable, finitions de chaque pièce, catalogue. */
import { useState } from "react";
import { Copy, Map as MapIcon, MousePointerClick, RotateCcw, RotateCw, Trash2, Undo2 } from "lucide-react";
import type { Project, Room } from "@/lib/types";
import { ROOM_LABELS, ROOM_LABELS_EN } from "@/lib/types";
import { useProject } from "@/lib/store";
import { CATALOG, GROUP_EN, furnitureLabel, type Furniture } from "@/lib/furnish";
import { useLang, useTr } from "@/lib/i18n";
import { FLOOR_OPTIONS, WALL_COLORS, addF, duplicateF, removeF, resizeF, rotateF } from "@/lib/design";
import { floorFor, styleById } from "@/lib/styles";
import { fmtArea, polygonArea } from "@/lib/geometry";

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-b border-line px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-display text-[13px] font-semibold uppercase tracking-wider text-muted">{title}</h3>
        {right}
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <button role="switch" aria-checked={on} onClick={onChange} className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-accent" : "bg-sand"}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
      </button>
    </label>
  );
}

function Size({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(value.toFixed(2));
  const done = () => {
    const n = parseFloat(v.replace(",", "."));
    if (Number.isFinite(n) && n >= 0.1 && n <= 8 && Math.abs(n - value) > 1e-3) onCommit(n);
    else setV(value.toFixed(2));
  };
  return (
    <label className="flex flex-1 items-center gap-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <input
        className="w-full min-w-0 rounded-lg border border-line bg-white px-2 py-1 text-right tabular-nums outline-none focus:border-accent"
        inputMode="decimal"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <span className="text-xs text-muted">m</span>
    </label>
  );
}

const chip = "rounded-lg px-2.5 py-1 text-xs font-medium transition";

export default function DesignPanel({
  project,
  furniture,
  selectedId,
  setSelectedId,
  roomId,
  setRoomId,
  onVisit,
}: {
  project: Project;
  furniture: Furniture[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  roomId: string | null;
  setRoomId: (id: string | null) => void;
  onVisit: (r: Room) => void;
}) {
  const tr = useTr();
  const en = useLang((s) => s.lang) === "en";
  const { commit, patch, updateRoom } = useProject.getState();
  const { rooms, background } = project;
  const style = styleById(project.styleId);
  const custom = !!project.furniture;
  const edit = (fn: (l: Furniture[]) => Furniture[]) => commit(() => ({ furniture: fn(furniture) }));
  const sel = furniture.find((f) => f.id === selectedId) ?? null;
  const room = rooms.find((r) => r.id === roomId) ?? null;
  const [group, setGroup] = useState<string>("Salon");
  const groups = [...new Set(CATALOG.map((c) => c.group))];

  return (
    <>
      {background && (
        <Section title={tr("Plan d'origine", "Original plan")}>
          <Switch on={!!project.planFloor} onChange={() => patch({ planFloor: !project.planFloor })} label={tr("Dessin du plan au sol", "Plan drawing on the floor")} />
          <p className="text-xs leading-relaxed text-muted">
            {project.planFloor
              ? tr(
                  "Le plan est plaqué au sol, à l'échelle : on retrouve en 3D tout ce qui y est dessiné (meubles, jardin, voiture…).",
                  "The plan is laid on the floor to scale: everything drawn on it shows up in 3D (furniture, garden, car…).",
                )
              : tr("Les sols prennent les matières choisies pour chaque pièce.", "Floors use the materials chosen for each room.")}
          </p>
        </Section>
      )}

      <Section
        title={`${tr("Mobilier", "Furniture")} · ${furniture.length}`}
        right={
          custom && (
            <button
              onClick={() => {
                if (!confirm(tr("Revenir à l'ameublement automatique ? Les meubles placés à la main seront remplacés.", "Go back to automatic furnishing? Furniture you placed by hand will be replaced."))) return;
                commit(() => ({ furniture: undefined }));
                setSelectedId(null);
              }}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft"
            >
              <Undo2 className="size-3.5" /> {tr("Automatique", "Automatic")}
            </button>
          )
        }
      >
        {custom ? (
          <p className="text-xs leading-relaxed text-muted">
            {tr(
              "Aménagement personnalisé. Cliquez un meuble dans la vue 3D pour le sélectionner, glissez-le pour le déplacer.",
              "Custom layout. Click a piece of furniture in the 3D view to select it, drag it to move it.",
            )}
          </p>
        ) : (
          <>
            <Switch on={project.furnished} onChange={() => patch({ furnished: !project.furnished })} label={tr("Meubler automatiquement", "Furnish automatically")} />
            <p className="text-xs leading-relaxed text-muted">
              {tr(
                "Meubles placés selon le type de chaque pièce. Cliquez-en un dans la vue 3D pour le déplacer : l'aménagement devient le vôtre.",
                "Furniture placed according to each room's type. Click one in the 3D view to move it: the layout becomes yours.",
              )}
            </p>
          </>
        )}
      </Section>

      {sel && (
        <Section
          title={furnitureLabel(sel.kind, en)}
          right={
            <button
              onClick={() => {
                edit((l) => removeF(l, sel.id));
                setSelectedId(null);
              }}
              className="rounded-lg p-1.5 text-muted hover:bg-accent-soft hover:text-accent"
              title={tr("Supprimer (Suppr)", "Delete (Del)")}
            >
              <Trash2 className="size-4" />
            </button>
          }
        >
          <div className="flex gap-1.5">
            <button onClick={() => edit((l) => rotateF(l, sel.id, Math.PI / 2))} className={`${chip} flex flex-1 items-center justify-center gap-1 bg-cream hover:bg-sand`} title={tr("Tourner (R)", "Rotate (R)")}>
              <RotateCcw className="size-3.5" /> 90°
            </button>
            <button onClick={() => edit((l) => rotateF(l, sel.id, -Math.PI / 2))} className={`${chip} flex flex-1 items-center justify-center gap-1 bg-cream hover:bg-sand`}>
              <RotateCw className="size-3.5" /> 90°
            </button>
            <button onClick={() => edit((l) => rotateF(l, sel.id, -Math.PI / 12))} className={`${chip} flex flex-1 items-center justify-center gap-1 bg-cream hover:bg-sand`}>
              <RotateCw className="size-3.5" /> 15°
            </button>
            <button
              onClick={() => {
                const [l, id] = duplicateF(furniture, sel.id);
                commit(() => ({ furniture: l }));
                setSelectedId(id);
              }}
              className={`${chip} flex items-center justify-center gap-1 bg-cream hover:bg-sand`}
              title={tr("Dupliquer", "Duplicate")}
            >
              <Copy className="size-3.5" />
            </button>
          </div>
          <div key={sel.id + sel.w + sel.d} className="flex gap-3">
            <Size label={tr("L", "W")} value={sel.w} onCommit={(w) => edit((l) => resizeF(l, sel.id, w, sel.d))} />
            <Size label={tr("P", "D")} value={sel.d} onCommit={(d) => edit((l) => resizeF(l, sel.id, sel.w, d))} />
          </div>
        </Section>
      )}

      <Section title={room ? room.name : tr("Pièce", "Room")} right={room && <span className="text-xs tabular-nums text-muted">{fmtArea(Math.abs(polygonArea(room.points)))}</span>}>
        {!room ? (
          <p className="flex items-start gap-2 text-sm leading-relaxed text-muted">
            <MousePointerClick className="mt-0.5 size-4 shrink-0" />{" "}
            {tr(
              "Cliquez une pièce dans la vue 3D (ou dans la liste) pour choisir son sol, ses murs et y ajouter des meubles.",
              "Click a room in the 3D view (or in the list) to choose its floor and walls and add furniture.",
            )}
          </p>
        ) : (
          <>
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted">
                <span>{tr("Sol", "Floor")}</span>
                {room.finish?.floor && (
                  <button onClick={() => updateRoom(room.id, { finish: { ...room.finish, floor: undefined } })} className="text-accent hover:underline">
                    {tr("style par défaut", "use style default")}
                  </button>
                )}
              </div>
              {(() => {
                const cur = room.finish?.floor ?? floorFor(style, room.type);
                return (
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap gap-1">
                      {FLOOR_OPTIONS.map((o) => (
                        <button
                          key={o.kind}
                          onClick={() => {
                            updateRoom(room.id, { finish: { ...room.finish, floor: { kind: o.kind, color: o.colors[0] } } });
                            if (project.planFloor) patch({ planFloor: false }); // sinon le dessin du plan cache le sol choisi
                          }}
                          className={`${chip} ${cur.kind === o.kind ? "bg-ink text-paper" : "bg-cream text-muted hover:text-ink"}`}
                        >
                          {en ? o.labelEn : o.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-1.5">
                      {(FLOOR_OPTIONS.find((o) => o.kind === cur.kind)?.colors ?? []).map((c) => (
                        <button
                          key={c}
                          onClick={() => {
                            updateRoom(room.id, { finish: { ...room.finish, floor: { kind: cur.kind, color: c } } });
                            if (project.planFloor) patch({ planFloor: false });
                          }}
                          className={`size-7 rounded-lg ring-offset-2 transition ${cur.color === c ? "ring-2 ring-accent" : "ring-1 ring-line"}`}
                          style={{ background: c }}
                          title={c}
                        />
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted">
                <span>{tr("Murs", "Walls")}</span>
                {room.finish?.wall && (
                  <button onClick={() => updateRoom(room.id, { finish: { ...room.finish, wall: undefined } })} className="text-accent hover:underline">
                    {tr("style par défaut", "use style default")}
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {WALL_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => updateRoom(room.id, { finish: { ...room.finish, wall: c } })}
                    className={`size-7 rounded-full ring-offset-2 transition ${(room.finish?.wall ?? style.wall) === c ? "ring-2 ring-accent" : "ring-1 ring-line"}`}
                    style={{ background: c }}
                    title={c}
                  />
                ))}
                <label className="relative size-7 cursor-pointer overflow-hidden rounded-full ring-1 ring-line" title={tr("Autre couleur", "Other colour")}>
                  <span className="absolute inset-0 bg-[conic-gradient(#e35,#fc3,#3c6,#39f,#a3f,#e35)]" />
                  <input
                    type="color"
                    value={room.finish?.wall ?? style.wall}
                    onChange={(e) => updateRoom(room.id, { finish: { ...room.finish, wall: e.target.value } })}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </label>
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted">{tr("Ajouter un meuble", "Add furniture")}</div>
              <div className="mb-2 flex flex-wrap gap-1">
                {groups.map((g) => (
                  <button key={g} onClick={() => setGroup(g)} className={`${chip} ${group === g ? "bg-ink text-paper" : "bg-cream text-muted hover:text-ink"}`}>
                    {en ? (GROUP_EN[g] ?? g) : g}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {CATALOG.filter((c) => c.group === group).map((c) => (
                  <button
                    key={c.kind}
                    onClick={() => {
                      const [l, id] = addF(furniture, c.kind, room);
                      commit(() => ({ furniture: l }));
                      setSelectedId(id);
                    }}
                    className="rounded-xl bg-white px-3 py-2 text-left text-xs ring-1 ring-line transition hover:ring-accent"
                  >
                    <div className="font-medium text-ink">{en ? c.labelEn : c.label}</div>
                    <div className="tabular-nums text-muted">
                      {c.w.toFixed(2)} × {c.d.toFixed(2)} m
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </Section>

      <Section title={`${tr("Pièces", "Rooms")} · ${rooms.length}`}>
        <ul className="space-y-1.5">
          {rooms.map((r) => (
            <li key={r.id}>
              <div
                className={`flex items-center gap-2 rounded-xl px-3 py-2 ${r.id === roomId ? "bg-white ring-2 ring-accent" : "bg-white ring-1 ring-line"}`}
              >
                <button onClick={() => setRoomId(r.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-medium">{r.name}</div>
                  <div className="text-xs text-muted">
                    {tr(ROOM_LABELS[r.type], ROOM_LABELS_EN[r.type])} · {fmtArea(Math.abs(polygonArea(r.points)))}
                  </div>
                </button>
                <select
                  value={r.type}
                  onChange={(e) => updateRoom(r.id, { type: e.target.value as Room["type"] })}
                  className="w-24 rounded-lg border border-line bg-white px-1 py-0.5 text-xs outline-none"
                  aria-label={tr("Type de pièce", "Room type")}
                >
                  {Object.entries(ROOM_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {en ? ROOM_LABELS_EN[k as Room["type"]] : l}
                    </option>
                  ))}
                </select>
                <button onClick={() => onVisit(r)} className="rounded-lg bg-cream p-1.5 text-muted hover:bg-sand hover:text-ink" title={tr("Visiter", "Visit")}>
                  <MapIcon className="size-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
