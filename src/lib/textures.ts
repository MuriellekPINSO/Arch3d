"use client";
import * as THREE from "three";
import type { FloorKind } from "./styles";

/* Textures de sol dessinées à la volée (aucun fichier à télécharger). Une texture couvre 2 × 2 m. */

const cache = new Map<string, THREE.CanvasTexture>();

function shade(hex: string, amount: number) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + amount)));
  return `#${c.getHexString()}`;
}

function rand(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function floorTexture(kind: FloorKind, color: string) {
  const key = `${kind}-${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const S = 512;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const g = cv.getContext("2d")!;
  const r = rand(kind.length * 97 + color.length * 13 + 7);
  g.fillStyle = color;
  g.fillRect(0, 0, S, S);

  if (kind === "parquet") {
    // lames de 0,18 m × 1,2 m en coupe de pierre
    const lw = S / 11;
    for (let col = 0; col < 12; col++) {
      let y = -r() * S * 0.6;
      while (y < S) {
        const h = S * (0.45 + r() * 0.25);
        g.fillStyle = shade(color, (r() - 0.5) * 0.1);
        g.fillRect(col * lw, y, lw - 1.5, h - 1.5);
        g.strokeStyle = shade(color, -0.08);
        g.globalAlpha = 0.25;
        for (let k = 0; k < 5; k++) {
          g.beginPath();
          const gx = col * lw + r() * lw;
          g.moveTo(gx, y);
          g.bezierCurveTo(gx + 3, y + h * 0.3, gx - 3, y + h * 0.6, gx + 1, y + h);
          g.stroke();
        }
        g.globalAlpha = 1;
        y += h;
      }
    }
  } else if (kind === "carrelage" || kind === "terre_cuite") {
    const n = kind === "carrelage" ? 3 : 7; // carreaux de 66 cm ou 28 cm
    const t = S / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        g.fillStyle = shade(color, (r() - 0.5) * (kind === "terre_cuite" ? 0.12 : 0.04));
        g.fillRect(i * t + 2, j * t + 2, t - 4, t - 4);
      }
    g.strokeStyle = shade(color, kind === "terre_cuite" ? 0.15 : -0.12);
    g.lineWidth = 3;
    for (let i = 0; i <= n; i++) {
      g.beginPath(); g.moveTo(i * t, 0); g.lineTo(i * t, S); g.stroke();
      g.beginPath(); g.moveTo(0, i * t); g.lineTo(S, i * t); g.stroke();
    }
  } else if (kind === "beton") {
    for (let k = 0; k < 2500; k++) {
      g.fillStyle = shade(color, (r() - 0.5) * 0.12);
      g.globalAlpha = 0.25;
      const s = 2 + r() * 18;
      g.beginPath();
      g.arc(r() * S, r() * S, s, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  } else if (kind === "pierre") {
    const n = 4;
    const t = S / n;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const off = j % 2 ? t / 2 : 0;
        g.fillStyle = shade(color, (r() - 0.5) * 0.1);
        g.fillRect(i * t + off + 3, j * t + 3, t - 6, t - 6);
        g.fillRect(i * t + off - S + 3, j * t + 3, t - 6, t - 6);
      }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.5, 0.5); // les UV du sol sont en mètres → 1 motif = 2 m
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  cache.set(key, tex);
  return tex;
}
