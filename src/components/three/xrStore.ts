"use client";
import { createXRStore } from "@react-three/xr";

/* Une seule session WebXR pour toute l'app (bouton « Casque VR »). */
let xrStore: ReturnType<typeof createXRStore> | null = null;
export const getXRStore = () => (xrStore ??= createXRStore({ offerSession: false, emulate: false }));
