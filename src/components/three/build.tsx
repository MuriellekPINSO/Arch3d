"use client";
/* Animation « la maison se construit » : chaque niveau sort du plan, sol, murs, ouvertures puis meubles. */
import { createContext, useContext, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type * as THREE from "three";

/** Instant de départ de l'animation (secondes, horloge de `performance.now`) ; null = maison construite. */
export const BuildClock = createContext<React.RefObject<number | null> | null>(null);

export const LEVEL_TIME = 3.2; // durée de construction d'un niveau
export const buildDuration = (levels: number) => levels * LEVEL_TIME + 0.4;

const ease = (k: number) => 1 - Math.pow(1 - k, 3);

function useProgress(at: number, dur: number) {
  const clock = useContext(BuildClock);
  return () => {
    const t0 = clock?.current;
    if (t0 == null) return 1;
    return ease(Math.min(1, Math.max(0, (performance.now() / 1000 - t0 - at) / dur)));
  };
}

/** Fait apparaître ses enfants à l'instant `at` : `y` = monte depuis le sol, `pop` = grandit depuis `pivot`. */
export function Grow({
  at,
  dur = 0.6,
  mode = "y",
  pivot = [0, 0, 0],
  children,
}: {
  at: number;
  dur?: number;
  mode?: "y" | "pop";
  pivot?: [number, number, number];
  children: React.ReactNode;
}) {
  const ref = useRef<THREE.Group>(null);
  const progress = useProgress(at, dur);
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const k = progress();
    const v = Math.max(k, 1e-4);
    if (mode === "y") g.scale.set(1, v, 1);
    else g.scale.setScalar(v);
    g.visible = k > 0.001;
  });
  return (
    <group position={pivot}>
      <group ref={ref}>
        <group position={[-pivot[0], -pivot[1], -pivot[2]]}>{children}</group>
      </group>
    </group>
  );
}

/** Visible seulement pendant l'animation, jusqu'à l'instant `until` (le plan posé au sol au début). */
export function During({ until, children }: { until: number; children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const clock = useContext(BuildClock);
  useFrame(() => {
    const g = ref.current;
    const t0 = clock?.current;
    if (g) g.visible = t0 != null && performance.now() / 1000 - t0 < until;
  });
  return <group ref={ref}>{children}</group>;
}
