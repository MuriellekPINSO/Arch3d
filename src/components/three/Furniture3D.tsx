"use client";
/* Meubles procéduraux : formes simples aux couleurs du style. Repère local : largeur sur x,
   profondeur sur z (face avant vers +z), sol à y = 0. */
import { RoundedBox } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { BoxGeometry } from "three";
import type { Furniture } from "@/lib/furnish";
import type { InteriorStyle } from "@/lib/styles";

const WHITE = "#f4f2ee";
const BLACK = "#1c1c1c";
const GREEN = "#3f6b3a";

type M = { color: string; roughness?: number; metalness?: number; transparent?: boolean; opacity?: number };

function Box({ s, p, m, r = 0.02 }: { s: [number, number, number]; p: [number, number, number]; m: M; r?: number }) {
  return (
    <RoundedBox args={s} position={p} radius={Math.min(r, ...s.map((v) => v / 2 - 0.001))} smoothness={2} castShadow receiveShadow>
      <meshStandardMaterial color={m.color} roughness={m.roughness ?? 0.7} metalness={m.metalness ?? 0} transparent={m.transparent} opacity={m.opacity ?? 1} />
    </RoundedBox>
  );
}

function Cyl({ r, h, p, m, top }: { r: number; h: number; p: [number, number, number]; m: M; top?: number }) {
  return (
    <mesh position={p} castShadow receiveShadow>
      <cylinderGeometry args={[top ?? r, r, h, 24]} />
      <meshStandardMaterial color={m.color} roughness={m.roughness ?? 0.6} metalness={m.metalness ?? 0} />
    </mesh>
  );
}

function Leg({ x, z, h, c }: { x: number; z: number; h: number; c: string }) {
  return <Cyl r={0.022} h={h} p={[x, h / 2, z]} m={{ color: c, metalness: 0.4, roughness: 0.4 }} />;
}

function Plant({ size, s }: { size: number; s: InteriorStyle }) {
  const pot = size * 0.32;
  return (
    <group>
      <Cyl r={pot} top={pot * 1.15} h={size * 0.7} p={[0, size * 0.35, 0]} m={{ color: s.id === "afro-chic" ? "#a4532d" : WHITE }} />
      {[0, 1, 2, 3, 4].map((i) => (
        <mesh key={i} position={[Math.sin(i * 1.3) * pot * 0.6, size * (1.0 + i * 0.28), Math.cos(i * 1.3) * pot * 0.6]} castShadow>
          <icosahedronGeometry args={[size * (0.42 - i * 0.04), 0]} />
          <meshStandardMaterial color={i % 2 ? GREEN : "#4f7d45"} roughness={0.9} flatShading />
        </mesh>
      ))}
    </group>
  );
}

function Piece({ f, s }: { f: Furniture; s: InteriorStyle }) {
  const { w, d } = f;
  const wood = { color: s.wood };
  const fabric = { color: s.fabric, roughness: 0.95 };
  switch (f.kind) {
    case "lit_double":
    case "lit_simple":
      return (
        <group>
          <Box s={[w, 0.3, d]} p={[0, 0.15, 0]} m={wood} />
          <Box s={[w - 0.06, 0.22, d - 0.1]} p={[0, 0.41, 0.03]} m={{ color: WHITE }} r={0.06} />
          <Box s={[w - 0.04, 0.06, d * 0.62]} p={[0, 0.53, d * 0.18]} m={{ color: s.accent2, roughness: 1 }} r={0.03} />
          <Box s={[w + 0.06, 1.0, 0.08]} p={[0, 0.5, -d / 2 + 0.04]} m={fabric} r={0.03} />
          {(f.kind === "lit_double" ? [-w / 4, w / 4] : [0]).map((x, i) => (
            <Box key={i} s={[f.kind === "lit_double" ? w / 2 - 0.12 : w - 0.2, 0.13, 0.32]} p={[x, 0.6, -d / 2 + 0.3]} m={{ color: WHITE }} r={0.06} />
          ))}
        </group>
      );
    case "chevet":
      return (
        <group>
          <Box s={[w, 0.5, d]} p={[0, 0.25, 0]} m={wood} />
          <Cyl r={0.05} h={0.25} p={[0, 0.62, -0.05]} m={{ color: s.metal }} />
          <Cyl r={0.14} top={0.09} h={0.16} p={[0, 0.82, -0.05]} m={{ color: "#f3e6c8", roughness: 1 }} />
        </group>
      );
    case "armoire":
      return (
        <group>
          <Box s={[w, 2.1, d]} p={[0, 1.05, 0]} m={wood} />
          {[-1, 1].map((k) => (
            <Box key={k} s={[0.02, 0.35, 0.03]} p={[k * 0.04, 1.1, d / 2 + 0.01]} m={{ color: s.metal, metalness: 0.6 }} />
          ))}
          <Box s={[0.01, 2.0, 0.01]} p={[0, 1.05, d / 2 + 0.005]} m={{ color: BLACK }} r={0.004} />
        </group>
      );
    case "tapis":
      return <Box s={[w, 0.012, d]} p={[0, 0.006, 0]} m={{ color: s.accent, roughness: 1 }} r={0.005} />;
    case "canape":
    case "fauteuil":
      return (
        <group>
          <Box s={[w, 0.42, d]} p={[0, 0.21, 0]} m={fabric} r={0.06} />
          <Box s={[w, 0.45, 0.22]} p={[0, 0.62, -d / 2 + 0.11]} m={fabric} r={0.08} />
          {[-1, 1].map((k) => (
            <Box key={k} s={[0.18, 0.62, d]} p={[k * (w / 2 - 0.09), 0.31, 0]} m={fabric} r={0.07} />
          ))}
          {f.kind === "canape" &&
            [-w / 4, w / 4].map((x, i) => (
              <Box key={i} s={[0.42, 0.38, 0.12]} p={[x, 0.62, -d / 2 + 0.3]} m={{ color: i ? s.accent2 : s.accent, roughness: 1 }} r={0.06} />
            ))}
        </group>
      );
    case "table_basse":
      return (
        <group>
          <Box s={[w, 0.05, d]} p={[0, 0.4, 0]} m={wood} />
          {[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b], i) => <Leg key={i} x={a * (w / 2 - 0.08)} z={b * (d / 2 - 0.08)} h={0.38} c={s.metal} />)}
          <Cyl r={0.07} h={0.12} p={[0.15, 0.49, 0]} m={{ color: s.accent2 }} />
        </group>
      );
    case "meuble_tv":
      return (
        <group>
          <Box s={[w, 0.5, d]} p={[0, 0.25, 0]} m={wood} />
          <Box s={[Math.min(1.3, w * 0.8), 0.75, 0.05]} p={[0, 0.5 + 0.45, -d / 2 + 0.1]} m={{ color: BLACK, roughness: 0.2 }} r={0.01} />
        </group>
      );
    case "lampadaire":
      return (
        <group>
          <Cyl r={0.14} h={0.03} p={[0, 0.015, 0]} m={{ color: s.metal }} />
          <Cyl r={0.015} h={1.55} p={[0, 0.8, 0]} m={{ color: s.metal, metalness: 0.5 }} />
          <Cyl r={0.2} top={0.14} h={0.25} p={[0, 1.65, 0]} m={{ color: "#f3e6c8", roughness: 1 }} />
        </group>
      );
    case "table":
      return (
        <group>
          <Box s={[w, 0.05, d]} p={[0, 0.74, 0]} m={wood} />
          {[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b], i) => <Leg key={i} x={a * (w / 2 - 0.08)} z={b * (d / 2 - 0.08)} h={0.72} c={s.metal} />)}
          <Cyl r={0.08} top={0.05} h={0.22} p={[0, 0.87, 0]} m={{ color: s.accent }} />
        </group>
      );
    case "chaise":
      return (
        <group>
          <Box s={[0.44, 0.05, 0.44]} p={[0, 0.46, 0]} m={wood} />
          <Box s={[0.44, 0.42, 0.04]} p={[0, 0.7, -0.2]} m={wood} />
          {[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b], i) => <Leg key={i} x={a * 0.18} z={b * 0.18} h={0.44} c={s.metal} />)}
        </group>
      );
    case "plan_travail":
      return (
        <group>
          <Box s={[w, 0.86, d]} p={[0, 0.43, 0]} m={{ color: s.id === "afro-chic" ? s.wood : WHITE }} r={0.01} />
          <Box s={[w + 0.02, 0.04, d + 0.02]} p={[0, 0.88, 0]} m={{ color: "#d9d4cc", roughness: 0.3 }} r={0.005} />
          <Box s={[0.5, 0.02, 0.36]} p={[-w / 4, 0.905, 0.02]} m={{ color: "#9aa3a8", metalness: 0.7, roughness: 0.25 }} r={0.01} />
          <Box s={[0.6, 0.02, 0.5]} p={[w / 4, 0.905, 0.02]} m={{ color: BLACK, roughness: 0.15 }} r={0.01} />
          {f.upper !== false && <Box s={[w, 0.7, 0.34]} p={[0, 1.85, -d / 2 + 0.17]} m={{ color: s.id === "afro-chic" ? s.wood : WHITE }} r={0.01} />}
          {Array.from({ length: Math.max(1, Math.floor(w / 0.6)) }, (_, i) => (
            <Box key={i} s={[0.01, 0.82, 0.01]} p={[-w / 2 + (i + 1) * (w / (Math.floor(w / 0.6) + 1)), 0.43, d / 2 + 0.005]} m={{ color: "#bdb7ad" }} r={0.003} />
          ))}
        </group>
      );
    case "frigo":
      return <Box s={[w, 1.85, d]} p={[0, 0.925, 0]} m={{ color: "#d8dadc", metalness: 0.5, roughness: 0.35 }} r={0.03} />;
    case "douche":
      return (
        <group>
          <Box s={[w, 0.05, d]} p={[0, 0.025, 0]} m={{ color: WHITE }} r={0.01} />
          <Box s={[w, 2.0, 0.01]} p={[0, 1.05, d / 2]} m={{ color: "#cfe8f2", transparent: true, opacity: 0.25, roughness: 0.05 }} r={0.002} />
          <Cyl r={0.1} h={0.02} p={[0, 2.05, -d / 2 + 0.25]} m={{ color: s.metal, metalness: 0.8 }} />
        </group>
      );
    case "baignoire":
      return (
        <group>
          <Box s={[w, 0.55, d]} p={[0, 0.275, 0]} m={{ color: WHITE, roughness: 0.25 }} r={0.08} />
          <Box s={[w - 0.16, 0.02, d - 0.16]} p={[0, 0.5, 0]} m={{ color: "#a9d4e3", roughness: 0.1 }} r={0.06} />
        </group>
      );
    case "vasque":
      return (
        <group>
          <Box s={[w, 0.8, d]} p={[0, 0.4, 0]} m={wood} />
          <Box s={[w * 0.5, 0.14, d * 0.7]} p={[0, 0.87, 0.02]} m={{ color: WHITE, roughness: 0.2 }} r={0.05} />
          <Box s={[w * 0.9, 0.7, 0.02]} p={[0, 1.55, -d / 2 + 0.01]} m={{ color: "#d3e0e5", metalness: 0.25, roughness: 0.12 }} r={0.01} />
        </group>
      );
    case "wc":
      return (
        <group>
          <Cyl r={0.19} top={0.17} h={0.4} p={[0, 0.2, 0.08]} m={{ color: WHITE, roughness: 0.25 }} />
          <Box s={[0.38, 0.38, 0.17]} p={[0, 0.6, -d / 2 + 0.09]} m={{ color: WHITE, roughness: 0.25 }} r={0.03} />
        </group>
      );
    case "bureau":
      return (
        <group>
          <Box s={[w, 0.04, d]} p={[0, 0.74, 0]} m={wood} />
          {[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b], i) => <Leg key={i} x={a * (w / 2 - 0.05)} z={b * (d / 2 - 0.05)} h={0.72} c={s.metal} />)}
          <Box s={[0.34, 0.02, 0.24]} p={[0, 0.77, 0]} m={{ color: "#8c8f93", metalness: 0.6 }} r={0.005} />
        </group>
      );
    case "etagere":
      return (
        <group>
          {[0, 0.45, 0.9, 1.35, 1.78].map((y, i) => (
            <Box key={i} s={[w, 0.03, d]} p={[0, y + 0.015, 0]} m={wood} />
          ))}
          {[-1, 1].map((k) => <Box key={k} s={[0.03, 1.8, d]} p={[k * (w / 2 - 0.015), 0.9, 0]} m={wood} />)}
          {[0.05, 0.5, 0.95, 1.4].map((y, i) =>
            Array.from({ length: 6 }, (_, j) => (
              <Box key={`${i}-${j}`} s={[0.04, 0.26 + ((i + j) % 3) * 0.03, d * 0.8]} p={[-w / 2 + 0.15 + j * 0.08 + i * 0.05, y + 0.16, 0]} m={{ color: [s.accent, s.accent2, s.fabric][(i + j) % 3] }} r={0.005} />
            )),
          )}
        </group>
      );
    case "console":
      return (
        <group>
          <Box s={[w, 0.04, d]} p={[0, 0.8, 0]} m={wood} />
          {[-1, 1].map((k) => <Box key={k} s={[0.04, 0.78, d]} p={[k * (w / 2 - 0.02), 0.39, 0]} m={wood} />)}
          <Cyl r={0.06} top={0.04} h={0.3} p={[0.25, 0.97, 0]} m={{ color: s.accent }} />
        </group>
      );
    case "transat":
      return (
        <group>
          <Box s={[w, 0.25, d * 0.7]} p={[0, 0.25, d * 0.15]} m={{ color: s.fabric, roughness: 1 }} r={0.04} />
          <Box s={[w, 0.05, d * 0.45]} p={[0, 0.55, -d * 0.28]} m={{ color: s.fabric }} r={0.02} />
        </group>
      );
    case "plante":
      return <Plant size={Math.min(w, d)} s={s} />;
    case "escalier": {
      // volée droite qui monte le long de x, marches d'environ 17 cm jusqu'au niveau du dessus
      const n = f.rise ? Math.max(10, Math.round(f.rise / 0.175)) : 16;
      const riser = f.rise ? f.rise / n : 0.17;
      const tread = w / n;
      return (
        <group>
          {Array.from({ length: n }, (_, i) => {
            const h = (i + 1) * riser;
            return <Box key={i} s={[tread + 0.002, h, d]} p={[-w / 2 + (i + 0.5) * tread, h / 2, 0]} m={i % 2 ? wood : { color: s.wood, roughness: 0.6 }} r={0.005} />;
          })}
          {/* main courante côté vide */}
          {Array.from({ length: 5 }, (_, i) => {
            const x = -w / 2 + (i + 0.5) * (w / 5);
            const base = ((x + w / 2) / tread) * riser;
            return <Box key={`p${i}`} s={[0.03, 0.9, 0.03]} p={[x, base + 0.45, d / 2 - 0.04]} m={{ color: s.metal, metalness: 0.6 }} r={0.005} />;
          })}
          <mesh position={[0, n * riser / 2 + 0.9, d / 2 - 0.04]} rotation-z={Math.atan2(n * riser, w)}>
            <boxGeometry args={[Math.hypot(w, n * riser), 0.04, 0.05]} />
            <meshStandardMaterial color={s.metal} metalness={0.6} roughness={0.35} />
          </mesh>
        </group>
      );
    }
    case "voiture": {
      // berline simple : la longueur est la profondeur (z)
      const body = "#9c3b2b";
      return (
        <group>
          <Box s={[w, 0.5, d]} p={[0, 0.48, 0]} m={{ color: body, metalness: 0.5, roughness: 0.3 }} r={0.12} />
          <Box s={[w * 0.86, 0.46, d * 0.5]} p={[0, 0.94, -d * 0.05]} m={{ color: "#1f2a30", metalness: 0.3, roughness: 0.1 }} r={0.1} />
          <Box s={[w * 0.88, 0.06, d * 0.46]} p={[0, 1.19, -d * 0.05]} m={{ color: body, metalness: 0.5, roughness: 0.3 }} r={0.03} />
          {[-1, 1].flatMap((sx) =>
            [-1, 1].map((sz) => (
              <mesh key={`${sx}${sz}`} position={[sx * (w / 2 - 0.08), 0.33, sz * d * 0.32]} rotation-z={Math.PI / 2} castShadow>
                <cylinderGeometry args={[0.33, 0.33, 0.24, 24]} />
                <meshStandardMaterial color={BLACK} roughness={0.8} />
              </mesh>
            )),
          )}
          {[-1, 1].map((sx) => (
            <Box key={`f${sx}`} s={[0.32, 0.1, 0.04]} p={[sx * w * 0.3, 0.6, d / 2]} m={{ color: "#fff6d8", metalness: 0.2 }} r={0.02} />
          ))}
        </group>
      );
    }
    default:
      return null;
  }
}

export default function Furniture3D({
  f,
  style,
  selected = false,
  onPointerDown,
}: {
  f: Furniture;
  style: InteriorStyle;
  selected?: boolean;
  onPointerDown?: (e: ThreeEvent<PointerEvent>) => void;
}) {
  return (
    <group position={[f.x, 0, f.y]} rotation-y={f.rot} onPointerDown={onPointerDown}>
      <Piece f={f} s={style} />
      {selected && (
        // cadre de sélection au sol + volume léger
        <group>
          <mesh position={[0, 0.012, 0]} rotation-x={-Math.PI / 2}>
            <planeGeometry args={[f.w + 0.12, f.d + 0.12]} />
            <meshBasicMaterial color="#d9622b" transparent opacity={0.22} depthWrite={false} />
          </mesh>
          <lineSegments position={[0, 0.02, 0]}>
            <edgesGeometry args={[new BoxGeometry(f.w + 0.12, 0.001, f.d + 0.12)]} />
            <lineBasicMaterial color="#d9622b" />
          </lineSegments>
        </group>
      )}
    </group>
  );
}
