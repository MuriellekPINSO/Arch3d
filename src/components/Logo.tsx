/* Logo Xwé : un plan en L dont les murs se sont levés (vue isométrique). La version simple, sans cloisons,
   reste lisible en petit (icône d'onglet, en-tête). */

const OUTER: [number, number][] = [[0, 0], [10, 0], [10, 5], [6.2, 5], [6.2, 8], [0, 8]];
const INNER: [number, number, number, number][] = [[0, 4, 3, 4], [4.3, 4, 6.2, 4], [6.2, 0, 6.2, 2.2], [6.2, 3.5, 6.2, 5]];
const H = 3.2;

type Seg = { x1: number; y1: number; x2: number; y2: number; outer: boolean };

function geometry(detailed: boolean) {
  const s = 11;
  const P = (x: number, y: number, z: number) => [100 + (x - y) * 0.866 * s, 46 + (x + y) * 0.5 * s - z * s];
  const pts = (arr: number[][]) => arr.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ");
  const segs: Seg[] = OUTER.map(([x1, y1], i) => {
    const [x2, y2] = OUTER[(i + 1) % OUTER.length];
    return { x1, y1, x2, y2, outer: true };
  });
  if (detailed) for (const [x1, y1, x2, y2] of INNER) segs.push({ x1, y1, x2, y2, outer: false });
  // du plus éloigné au plus proche
  segs.sort((a, b) => a.x1 + a.y1 + a.x2 + a.y2 - (b.x1 + b.y1 + b.x2 + b.y2));
  return {
    floor: pts(OUTER.map(([x, y]) => P(x, y, 0))),
    walls: segs.map((w) => ({
      face: pts([P(w.x1, w.y1, 0), P(w.x2, w.y2, 0), P(w.x2, w.y2, H), P(w.x1, w.y1, H)]),
      along: w.y1 === w.y2,
      top: [...P(w.x1, w.y1, H), ...P(w.x2, w.y2, H)],
      outer: w.outer,
    })),
  };
}

const SIMPLE = geometry(false);
const DETAILED = geometry(true);

export default function Logo({ className, detailed = false, title }: { className?: string; detailed?: boolean; title?: string }) {
  const g = detailed ? DETAILED : SIMPLE;
  return (
    <svg viewBox="19.8 6.8 179.5 125.7" className={className} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <polygon points={g.floor} fill="var(--color-accent-soft)" />
      {g.walls.map((w, i) => (
        <g key={i}>
          <polygon points={w.face} fill={w.along ? "var(--color-sand)" : "#c9bca2"} stroke="var(--color-ink)" strokeWidth={detailed ? 2 : 3.2} strokeLinejoin="round" />
          <line
            x1={w.top[0]}
            y1={w.top[1]}
            x2={w.top[2]}
            y2={w.top[3]}
            stroke={w.outer ? "var(--color-ink)" : "var(--color-accent)"}
            strokeWidth={detailed ? 3.2 : 5}
            strokeLinecap="round"
          />
        </g>
      ))}
    </svg>
  );
}
