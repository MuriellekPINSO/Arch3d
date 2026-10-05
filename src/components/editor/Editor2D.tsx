"use client";
/* Éditeur de plan en SVG, en mètres. Molette : zoom ; clic droit / milieu / espace + glisser : déplacer la vue. */
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { Opening, OpeningKind, Pt, Room, Wall } from "@/lib/types";
import { OPENING_DEFAULTS, ROOM_LABELS, uid } from "@/lib/types";
import { useProject } from "@/lib/store";
import {
  add, dist, fmt, fmtArea, mul, perp, pointAtWall, polygonArea, projectOnWall, roomAnchor, sub, wallDir, wallLength,
} from "@/lib/geometry";
import { detectRoom } from "@/lib/roomDetect";

export type Tool = "select" | "wall" | OpeningKind | "room" | "calibrate";

const ROOM_FILL: Record<string, string> = {
  salon: "#f3d9b8", chambre: "#d6e4d0", cuisine: "#f4e3a8", salle_de_bain: "#cfe3ec", wc: "#cfe3ec",
  salle_a_manger: "#f0d0c0", bureau: "#e2dcef", couloir: "#ece8df", terrasse: "#dfe8c8", garage: "#e0ddd6", escalier: "#e6e0f0", autre: "#e8e4dc",
};

interface Props {
  tool: Tool;
  wallThickness: number;
  wallHeight: number;
  roomType: Room["type"];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onCalibrate: (a: Pt, b: Pt) => void;
  onMessage: (m: string) => void;
  fitKey: number;
}

export default function Editor2D({ tool, wallThickness, wallHeight, roomType, selected, onSelect, onCalibrate, onMessage, fitKey }: Props) {
  const project = useProject((s) => s.project);
  const addWalls = useProject((s) => s.addWalls);
  const addOpening = useProject((s) => s.addOpening);
  const addRoom = useProject((s) => s.addRoom);
  const commit = useProject((s) => s.commit);
  const { walls, openings, rooms, background } = project;

  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ s: 40, ox: 80, oy: 80 }); // px par mètre, décalage en px
  const [hover, setHover] = useState<Pt | null>(null);
  const [chain, setChain] = useState<Pt | null>(null); // début du mur en cours
  const [calib, setCalib] = useState<Pt | null>(null);
  const [drag, setDrag] = useState<{ wallId: string; end: "a" | "b"; from: Pt; to: Pt } | null>(null);
  const pan = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const space = useRef(false);

  const toWorld = useCallback(
    (cx: number, cy: number): Pt => {
      const r = svgRef.current!.getBoundingClientRect();
      return { x: (cx - r.left - view.ox) / view.s, y: (cy - r.top - view.oy) / view.s };
    },
    [view],
  );

  // recadrage sur le dessin
  const fit = useCallback(() => {
    const el = svgRef.current;
    if (!el) return;
    const pts: Pt[] = walls.flatMap((w) => [w.a, w.b]);
    if (background) pts.push({ x: background.x, y: background.y }, { x: background.x + background.widthPx * background.scale, y: background.y + background.heightPx * background.scale });
    if (!pts.length) return setView({ s: 40, ox: 80, oy: 80 });
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const r = el.getBoundingClientRect();
    const s = Math.min((r.width - 120) / Math.max(1, x1 - x0), (r.height - 120) / Math.max(1, y1 - y0));
    setView({ s, ox: (r.width - (x1 - x0) * s) / 2 - x0 * s, oy: (r.height - (y1 - y0) * s) / 2 - y0 * s });
  }, [walls, background]);
  const onFit = useEffectEvent(fit);
  useEffect(() => {
    // après la mise en page, pour mesurer le SVG
    const id = requestAnimationFrame(() => onFit());
    return () => cancelAnimationFrame(id);
  }, [fitKey]);

  // accrochage : extrémités de murs, puis angle droit par rapport au point de départ
  const snap = useCallback(
    (p: Pt, from: Pt | null): { p: Pt; snapped: boolean } => {
      const tol = 12 / view.s;
      let best: Pt | null = null;
      let bd = tol;
      for (const w of walls)
        for (const q of [w.a, w.b]) {
          const d = dist(p, q);
          if (d < bd) { bd = d; best = q; }
        }
      if (best) return { p: best, snapped: true };
      if (from) {
        const d = sub(p, from);
        const ang = Math.atan2(d.y, d.x);
        const step = Math.PI / 4;
        const near = Math.round(ang / step) * step;
        if (Math.abs(ang - near) < 0.12) {
          const L = Math.hypot(d.x, d.y);
          const q = { x: from.x + Math.cos(near) * L, y: from.y + Math.sin(near) * L };
          return { p: { x: Math.round(q.x * 100) / 100, y: Math.round(q.y * 100) / 100 }, snapped: false };
        }
      }
      return { p: { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }, snapped: false };
    },
    [walls, view.s],
  );

  const nearestWall = useCallback(
    (p: Pt) => {
      let best: { w: Wall; t: number; d: number } | null = null;
      for (const w of walls) {
        const pr = projectOnWall(p, w);
        if (pr.d < Math.max(w.thickness, 18 / view.s) && (!best || pr.d < best.d)) best = { w, t: pr.t, d: pr.d };
      }
      return best;
    },
    [walls, view.s],
  );

  const openingPreview = useMemo(() => {
    if (!hover || !["door", "window", "baie", "passage"].includes(tool)) return null;
    const nw = nearestWall(hover);
    if (!nw) return null;
    const kind = tool as OpeningKind;
    const width = Math.min(OPENING_DEFAULTS[kind].width, wallLength(nw.w) - 0.1);
    const t = Math.max(width / 2 + 0.05, Math.min(wallLength(nw.w) - width / 2 - 0.05, Math.round(nw.t * 20) / 20));
    return { w: nw.w, t, width, kind };
  }, [hover, tool, nearestWall]);

  // clavier : Échap termine le mur en cours, Suppr efface la sélection
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "SELECT") return;
      if (e.key === " ") space.current = true;
      if (e.key === "Escape" || e.key === "Enter") { setChain(null); setCalib(null); }
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        useProject.getState().remove(selected);
        onSelect(null);
      }
    };
    const ku = (e: KeyboardEvent) => { if (e.key === " ") space.current = false; };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => { window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); };
  }, [selected, onSelect]);

  // changement d'outil : on abandonne le tracé en cours
  const [prevTool, setPrevTool] = useState(tool);
  if (prevTool !== tool) {
    setPrevTool(tool);
    setChain(null);
    setCalib(null);
  }

  const onWheel = (e: React.WheelEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0015);
    setView((v) => {
      const s = Math.max(5, Math.min(400, v.s * k));
      const f = s / v.s;
      return { s, ox: mx - (mx - v.ox) * f, oy: my - (my - v.oy) * f };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || e.button === 2 || space.current) {
      pan.current = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy };
      setPanning(true);
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    const p = toWorld(e.clientX, e.clientY);

    if (tool === "select") {
      // poignée d'extrémité du mur sélectionné ?
      const sw = walls.find((w) => w.id === selected);
      if (sw) {
        for (const end of ["a", "b"] as const) {
          if (dist(p, sw[end]) < 10 / view.s) {
            setDrag({ wallId: sw.id, end, from: sw[end], to: sw[end] });
            return;
          }
        }
      }
      const op = openings.find((o) => {
        const w = walls.find((x) => x.id === o.wallId);
        if (!w) return false;
        const pr = projectOnWall(p, w);
        return pr.d < w.thickness / 2 + 6 / view.s && Math.abs(pr.t - o.t) < o.width / 2;
      });
      if (op) return onSelect(op.id);
      const wl = walls.find((w) => projectOnWall(p, w).d < w.thickness / 2 + 4 / view.s);
      if (wl) return onSelect(wl.id);
      const rm = [...rooms].reverse().find((r) => {
        // point dans le polygone
        let inside = false;
        for (let i = 0, j = r.points.length - 1; i < r.points.length; j = i++) {
          const a = r.points[i], b = r.points[j];
          if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
        }
        return inside;
      });
      onSelect(rm?.id ?? null);
      if (!rm) {
        pan.current = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy };
        setPanning(true);
      }
      return;
    }

    if (tool === "wall") {
      const s = snap(p, chain).p;
      if (!chain) return setChain(s);
      if (dist(s, chain) < 0.05) return setChain(null);
      addWalls([{ id: uid(), a: chain, b: s, thickness: wallThickness, height: wallHeight }]);
      // on ferme la boucle si on revient sur un point existant de départ de chaîne
      setChain(e.detail >= 2 ? null : s);
      return;
    }

    if (openingPreview) {
      const { w, t, width, kind } = openingPreview;
      const clash = openings.some((o) => o.wallId === w.id && Math.abs(o.t - t) < (o.width + width) / 2);
      if (clash) return onMessage("Il y a déjà une ouverture à cet endroit.");
      const d = OPENING_DEFAULTS[kind];
      const o: Opening = { id: uid(), wallId: w.id, kind, t, width, height: d.height, sill: d.sill };
      addOpening(o);
      return;
    }

    if (tool === "room") {
      const poly = detectRoom(p, walls);
      if (!poly) return onMessage("Zone non fermée : les murs doivent entourer complètement la pièce.");
      const n = rooms.filter((r) => r.type === roomType).length + 1;
      addRoom({ id: uid(), name: `${ROOM_LABELS[roomType]}${["salon", "cuisine", "couloir"].includes(roomType) && n === 1 ? "" : ` ${n}`}`, type: roomType, points: poly });
      return;
    }

    if (tool === "calibrate") {
      if (!calib) return setCalib(p);
      onCalibrate(calib, p);
      setCalib(null);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pan.current) {
      const pc = pan.current;
      setView((v) => ({ ...v, ox: pc.ox + e.clientX - pc.x, oy: pc.oy + e.clientY - pc.y }));
      return;
    }
    const p = toWorld(e.clientX, e.clientY);
    if (drag) {
      setDrag({ ...drag, to: snap(p, null).p });
      return;
    }
    setHover(tool === "wall" ? snap(p, chain).p : p);
  };

  const onPointerUp = () => {
    pan.current = null;
    setPanning(false);
    if (drag) {
      const { from, to } = drag;
      if (dist(from, to) > 0.005) {
        // toutes les extrémités confondues suivent
        commit((pr) => ({
          walls: pr.walls.map((w) => ({
            ...w,
            a: dist(w.a, from) < 0.01 ? to : w.a,
            b: dist(w.b, from) < 0.01 ? to : w.b,
          })),
        }));
      }
      setDrag(null);
    }
  };

  // murs affichés (avec l'extrémité en cours de déplacement)
  const shownWalls = drag
    ? walls.map((w) => ({ ...w, a: dist(w.a, drag.from) < 0.01 ? drag.to : w.a, b: dist(w.b, drag.from) < 0.01 ? drag.to : w.b }))
    : walls;

  const px = (n: number) => n / view.s; // n pixels → mètres
  const wallPoly = (w: Wall) => {
    const n = perp(wallDir(w));
    const h = w.thickness / 2;
    const ext = mul(wallDir(w), h);
    const a = sub(w.a, ext);
    const b = add(w.b, ext);
    return [add(a, mul(n, h)), add(b, mul(n, h)), sub(b, mul(n, h)), sub(a, mul(n, h))].map((p) => `${p.x},${p.y}`).join(" ");
  };

  const cursor = panning ? "grabbing" : tool === "select" ? "default" : "crosshair";

  return (
    <svg
      ref={svgRef}
      className="size-full touch-none select-none bg-[#f7f5f0]"
      style={{ cursor }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <defs>
        <pattern id="grid" width={view.s} height={view.s} patternUnits="userSpaceOnUse" x={view.ox} y={view.oy}>
          <path d={`M ${view.s} 0 L 0 0 0 ${view.s}`} fill="none" stroke="#e3ded3" strokeWidth={1} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />

      <g transform={`translate(${view.ox} ${view.oy}) scale(${view.s})`}>
        {background && (
          <image
            href={background.src}
            x={background.x}
            y={background.y}
            width={background.widthPx * background.scale}
            height={background.heightPx * background.scale}
            opacity={background.opacity}
            preserveAspectRatio="none"
          />
        )}

        {rooms.map((r) => {
          const c = roomAnchor(r);
          const sel = r.id === selected;
          return (
            <g key={r.id}>
              <polygon
                points={r.points.map((p) => `${p.x},${p.y}`).join(" ")}
                fill={ROOM_FILL[r.type] ?? "#eee"}
                fillOpacity={background ? 0.55 : 0.85}
                stroke={sel ? "#d9622b" : "none"}
                strokeWidth={px(2.5)}
              />
              <text x={c.x} y={c.y - px(4)} textAnchor="middle" fontSize={px(13)} fontWeight={600} fill="#2a2620">{r.name}</text>
              <text x={c.x} y={c.y + px(12)} textAnchor="middle" fontSize={px(11)} fill="#6b6459">{fmtArea(Math.abs(polygonArea(r.points)))}</text>
            </g>
          );
        })}

        {shownWalls.map((w) => (
          <polygon key={w.id} points={wallPoly(w)} fill={w.id === selected ? "#d9622b" : "#2a2620"} />
        ))}

        {openings.map((o) => {
          const w = shownWalls.find((x) => x.id === o.wallId);
          if (!w) return null;
          const d = wallDir(w);
          const n = perp(d);
          const c = pointAtWall(w, o.t);
          const a = add(c, mul(d, -o.width / 2));
          const b = add(c, mul(d, o.width / 2));
          const h = w.thickness / 2 + px(1);
          const quad = [add(a, mul(n, h)), add(b, mul(n, h)), sub(b, mul(n, h)), sub(a, mul(n, h))].map((p) => `${p.x},${p.y}`).join(" ");
          const sel = o.id === selected;
          const stroke = sel ? "#d9622b" : "#2a2620";
          return (
            <g key={o.id}>
              <polygon points={quad} fill="#f7f5f0" stroke={stroke} strokeWidth={px(1)} />
              {o.kind === "door" && (
                <path
                  d={`M ${a.x} ${a.y} L ${add(a, mul(n, o.width)).x} ${add(a, mul(n, o.width)).y} A ${o.width} ${o.width} 0 0 1 ${b.x} ${b.y}`}
                  fill="none" stroke={stroke} strokeWidth={px(1.2)}
                />
              )}
              {(o.kind === "window" || o.kind === "baie") && (
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={sel ? "#d9622b" : "#3c8dbc"} strokeWidth={px(o.kind === "baie" ? 3 : 2)} />
              )}
              {o.kind === "passage" && (
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={stroke} strokeWidth={px(1)} strokeDasharray={`${px(4)} ${px(3)}`} />
              )}
            </g>
          );
        })}

        {/* poignées du mur sélectionné */}
        {shownWalls.filter((w) => w.id === selected).flatMap((w) => [w.a, w.b]).map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={px(6)} fill="#fff" stroke="#d9622b" strokeWidth={px(2)} />
        ))}

        {/* aperçus */}
        {tool === "wall" && chain && hover && (
          <g>
            <line x1={chain.x} y1={chain.y} x2={hover.x} y2={hover.y} stroke="#d9622b" strokeWidth={wallThickness} strokeOpacity={0.55} strokeLinecap="square" />
            <text x={(chain.x + hover.x) / 2} y={(chain.y + hover.y) / 2 - px(10)} textAnchor="middle" fontSize={px(13)} fontWeight={700} fill="#d9622b">
              {fmt(dist(chain, hover))}
            </text>
          </g>
        )}
        {tool === "wall" && hover && <circle cx={hover.x} cy={hover.y} r={px(4)} fill="#d9622b" />}
        {openingPreview && (() => {
          const { w, t, width } = openingPreview;
          const d = wallDir(w);
          const c = pointAtWall(w, t);
          const a = add(c, mul(d, -width / 2));
          const b = add(c, mul(d, width / 2));
          return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#d9622b" strokeWidth={w.thickness + px(4)} strokeOpacity={0.6} />;
        })()}
        {tool === "calibrate" && calib && hover && (
          <g>
            <line x1={calib.x} y1={calib.y} x2={hover.x} y2={hover.y} stroke="#2f7d5b" strokeWidth={px(2)} strokeDasharray={`${px(6)} ${px(4)}`} />
            <circle cx={calib.x} cy={calib.y} r={px(5)} fill="#2f7d5b" />
          </g>
        )}
      </g>

      <text x={16} y={24} fontSize={12} fill="#6b6459">
        {walls.length ? `${walls.length} murs · ${openings.length} ouvertures · ${rooms.length} pièces` : "Plan vide"}
        {" · "}1 carreau = 1 m
      </text>
      {hover && (
        <text x={16} y={42} fontSize={11} fill="#9a9284">
          x {hover.x.toFixed(2)} · y {hover.y.toFixed(2)} m
        </text>
      )}
    </svg>
  );
}
