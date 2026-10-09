"use client";
/* « Mon espace » : le compte (solde, achat), tous les projets enregistrés en ligne et l'historique des crédits. */
import { useEffect, useState } from "react";
import { Coins, FilePlus2, FolderOpen, Loader2, LogOut, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { creditHistory, deleteProject, listProjects, renameProject, type LedgerEntry, type ProjectSummary } from "@/lib/cloud";
import { useCredits } from "@/lib/creditsStore";
import { fmtArea } from "@/lib/geometry";
import { useLang, useTr } from "@/lib/i18n";
import { PACKS, formatUsd, formatXof } from "@/lib/offres";

/** « il y a 3 h », « hier »… dans la langue de l'interface */
function ago(ms: number, lang: "fr" | "en") {
  if (!ms) return "";
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const s = (ms - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
    ["year", Infinity],
  ];
  let v = s;
  for (const [unit, n] of steps) {
    if (Math.abs(v) < n) return rtf.format(Math.round(v), unit);
    v /= n;
  }
  return "";
}

const REASONS: Record<string, [string, string]> = {
  offert: ["Crédits offerts", "Free credits"],
  achat: ["Achat de crédits", "Credit purchase"],
  remboursement: ["Rendu échoué, remboursé", "Failed render, refunded"],
  "rendu photo": ["Photo réaliste", "Realistic photo"],
  "rendu video": ["Vidéo", "Video"],
  "rendu visite": ["Vidéo de pièce", "Room video"],
  "rendu anime": ["Photo animée", "Animated photo"],
  "rendu film": ["Film complet", "Full film"],
};

export default function MySpace({ currentId, onOpen, onNew }: { currentId?: string; onOpen: (id: string) => Promise<void>; onNew: () => void }) {
  const tr = useTr();
  const lang = useLang((s) => s.lang);
  const { spaceOpen, setSpaceOpen, user, credits, setBuyOpen, logout } = useCredits();
  const [tab, setTab] = useState<"projets" | "credits">("projets");
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [history, setHistory] = useState<LedgerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

  // à chaque ouverture : la liste à jour (le projet en cours vient peut-être d'être enregistré)
  useEffect(() => {
    if (!spaceOpen || !user) return;
    let live = true;
    listProjects()
      .then((p) => live && setProjects(p))
      .catch((e) => live && setError((e as Error).message));
    creditHistory()
      .then((h) => live && setHistory(h))
      .catch(() => live && setHistory([]));
    return () => {
      live = false;
    };
  }, [spaceOpen, user]);

  if (!spaceOpen || !user) return null;
  const close = () => setSpaceOpen(false);

  const open = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await onOpen(id);
      close();
    } catch (e) {
      setError(`${tr("Ouverture impossible", "Could not open")} : ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  const rename = async (p: ProjectSummary) => {
    setMenu(null);
    const name = prompt(tr("Nouveau nom du projet", "New project name"), p.name)?.trim();
    if (!name || name === p.name) return;
    await renameProject(p.id, name).catch((e) => setError((e as Error).message));
    setProjects((l) => l?.map((x) => (x.id === p.id ? { ...x, name } : x)) ?? null);
  };
  const remove = async (p: ProjectSummary) => {
    setMenu(null);
    if (!confirm(tr(`Supprimer « ${p.name} » de votre espace ? C'est définitif.`, `Delete “${p.name}” from your space? This cannot be undone.`))) return;
    await deleteProject(p.id).catch((e) => setError((e as Error).message));
    setProjects((l) => l?.filter((x) => x.id !== p.id) ?? null);
  };

  const pro = PACKS.find((p) => p.best) ?? PACKS[0];
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-cream">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-paper px-4 lg:h-16 lg:px-6">
        <h1 className="font-display text-xl font-semibold tracking-tight">{tr("Mon espace", "My space")}</h1>
        <button onClick={close} className="grid size-9 place-items-center rounded-full text-muted hover:bg-cream" aria-label={tr("Fermer", "Close")}>
          <X className="size-5" />
        </button>
      </header>

      <div className="scroll-soft min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-6 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
          {/* le compte */}
          <section className="flex flex-wrap items-center gap-4 rounded-3xl bg-paper p-5 ring-1 ring-line sm:p-6">
            <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-full bg-ink text-xl font-semibold text-paper">
              {/* eslint-disable-next-line @next/next/no-img-element -- photo Google, servie par Google */}
              {user.photo ? <img src={user.photo} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : (user.name ?? user.email ?? "?")[0]?.toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-lg font-semibold">{user.name ?? user.email}</div>
              {user.name && <div className="truncate text-sm text-muted">{user.email}</div>}
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="font-display text-3xl font-semibold tabular-nums">{credits ?? "…"}</div>
                <div className="text-xs text-muted">{tr("crédits", "credits")}</div>
              </div>
              <button onClick={() => setBuyOpen(true)} className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-white hover:brightness-105">
                <Coins className="size-4" /> {tr("Acheter", "Buy")}
              </button>
            </div>
            <p className="w-full text-xs text-muted">
              {tr(
                `Pack ${pro.name[0]} : ${pro.credits} crédits pour ${formatXof(pro.xof)} (≈ ${formatUsd(pro.usd, lang)}). Une photo réaliste coûte 2 crédits.`,
                `${pro.name[1]} pack: ${pro.credits} credits for ${formatUsd(pro.usd, lang)} (${formatXof(pro.xof)}). A realistic photo costs 2 credits.`,
              )}
            </p>
          </section>

          <div className="flex items-center gap-1 rounded-full bg-paper p-1 ring-1 ring-line sm:w-fit">
            {(
              [
                ["projets", tr("Mes projets", "My projects")],
                ["credits", tr("Historique des crédits", "Credit history")],
              ] as const
            ).map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className={`flex-1 rounded-full px-4 py-2 text-sm font-medium sm:flex-none ${tab === k ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}>
                {l}
              </button>
            ))}
          </div>

          {error && <p className="rounded-2xl bg-accent-soft px-4 py-3 text-sm">{error}</p>}

          {tab === "projets" && (
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <button
                onClick={() => {
                  onNew();
                  close();
                }}
                className="flex aspect-[4/5] flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-sand bg-paper/60 text-sm font-medium text-muted transition hover:border-accent hover:text-accent"
              >
                <FilePlus2 className="size-7" />
                {tr("Nouveau projet", "New project")}
              </button>
              {projects === null &&
                [0, 1, 2].map((i) => <div key={i} className="aspect-[4/5] animate-pulse rounded-3xl bg-paper ring-1 ring-line" />)}
              {projects?.map((p) => (
                <div key={p.id} className={`group relative flex aspect-[4/5] flex-col overflow-hidden rounded-3xl bg-paper ring-1 transition hover:-translate-y-0.5 hover:shadow-lg ${p.id === currentId ? "ring-2 ring-accent" : "ring-line"}`}>
                  <button onClick={() => open(p.id)} disabled={!!busy} className="flex min-h-0 flex-1 flex-col text-left">
                    <div className="relative min-h-0 flex-1 bg-white p-3">
                      {p.thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element -- vignette SVG générée par l'app
                        <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(p.thumb)}`} alt="" className="size-full object-contain" />
                      ) : (
                        <div className="grid size-full place-items-center text-xs text-muted">{tr("Plan importé", "Imported plan")}</div>
                      )}
                      {busy === p.id && (
                        <div className="absolute inset-0 grid place-items-center bg-paper/70">
                          <Loader2 className="size-6 animate-spin text-accent" />
                        </div>
                      )}
                    </div>
                    <div className="border-t border-line px-3 py-2.5">
                      <div className="truncate text-sm font-semibold">{p.name}</div>
                      <div className="truncate text-[11px] text-muted">
                        {p.stats.rooms} {tr("pièces", "rooms")} · {fmtArea(p.stats.area)}
                        {p.stats.levels > 1 ? ` · ${p.stats.levels} ${tr("niveaux", "floors")}` : ""}
                      </div>
                      <div className="text-[11px] text-muted">{p.id === currentId ? tr("ouvert en ce moment", "open now") : ago(p.updatedAt, lang)}</div>
                    </div>
                  </button>
                  <button
                    onClick={() => setMenu(menu === p.id ? null : p.id)}
                    className="absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-paper/90 text-muted shadow-sm ring-1 ring-line hover:text-ink"
                    aria-label={tr("Options du projet", "Project options")}
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                  {menu === p.id && (
                    <div className="absolute right-2 top-11 z-10 w-40 rounded-2xl bg-paper p-1 shadow-xl ring-1 ring-line">
                      <button onClick={() => open(p.id)} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-cream">
                        <FolderOpen className="size-4 text-muted" /> {tr("Ouvrir", "Open")}
                      </button>
                      <button onClick={() => rename(p)} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-cream">
                        <Pencil className="size-4 text-muted" /> {tr("Renommer", "Rename")}
                      </button>
                      <button onClick={() => remove(p)} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-accent hover:bg-accent-soft">
                        <Trash2 className="size-4" /> {tr("Supprimer", "Delete")}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {projects?.length === 0 && (
                <p className="col-span-full rounded-2xl bg-paper px-4 py-3 text-sm text-muted ring-1 ring-line">
                  {tr(
                    "Aucun projet pour l'instant. Importez un plan : il s'enregistre ici tout seul, et vous le retrouvez sur tous vos appareils.",
                    "No projects yet. Import a plan: it is saved here automatically, and you find it on all your devices.",
                  )}
                </p>
              )}
            </section>
          )}

          {tab === "credits" && (
            <section className="overflow-hidden rounded-3xl bg-paper ring-1 ring-line">
              {history === null && <div className="p-6 text-sm text-muted">{tr("Chargement…", "Loading…")}</div>}
              {history?.length === 0 && <div className="p-6 text-sm text-muted">{tr("Aucun mouvement pour l'instant.", "No activity yet.")}</div>}
              <ul className="divide-y divide-line">
                {history?.map((h, i) => {
                  const label = REASONS[h.reason] ?? [h.reason, h.reason];
                  return (
                    <li key={i} className="flex items-center gap-3 px-5 py-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{lang === "en" ? label[1] : label[0]}</div>
                        <div className="text-xs text-muted">{h.at ? new Date(h.at).toLocaleString(lang === "en" ? "en-GB" : "fr-FR", { dateStyle: "medium", timeStyle: "short" }) : ""}</div>
                      </div>
                      <div className={`font-display text-base font-semibold tabular-nums ${h.delta > 0 ? "text-leaf" : "text-ink"}`}>
                        {h.delta > 0 ? "+" : ""}
                        {h.delta}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <button onClick={() => logout()} className="flex items-center gap-2 text-sm text-muted hover:text-ink">
            <LogOut className="size-4" /> {tr("Se déconnecter", "Sign out")}
          </button>
        </div>
      </div>
    </div>
  );
}
