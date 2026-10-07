import * as THREE from "three";
import type { Tour } from "./tour";

/* Déroulé de la visite guidée, indépendant de l'affichage : la même mécanique anime la visite à l'écran
   (pas de temps réel) et l'export image par image pour l'IA (pas de temps fixe, donc reproductible). */

export const EYE = 1.6;
export const PAUSE = 5; // secondes d'arrêt dans chaque pièce
export const SPEED = 1.05; // m/s
export const PITCH = -0.05;
export const TOUR_FOV = 70;

export class TourPlayer {
  private curve: THREE.CatmullRomCurve3;
  private total: number;
  private ts: number[] = [];
  private ds: number[] = [];
  private stopDist: number[];
  private d = 0;
  private pause = 0;
  private nextStop = 0;
  private cur = -1;
  private ended = false;
  private ahead = new THREE.Vector3();
  readonly position = new THREE.Vector3();
  yaw = 0;

  constructor(private tour: Tour) {
    const pts = tour.points.map((p) => new THREE.Vector3(p.x, p.z + EYE, p.y));
    if (pts.length < 2) pts.push(pts[0].clone().add(new THREE.Vector3(0.01, 0, 0)));
    this.curve = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.3);
    // table distance ↔ paramètre
    const N = (pts.length - 1) * 40;
    let total = 0;
    let prev = this.curve.getPoint(0);
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = this.curve.getPoint(t);
      total += p.distanceTo(prev);
      prev = p;
      this.ts.push(t);
      this.ds.push(total);
    }
    this.total = total;
    this.stopDist = tour.stops.map((s) => this.ds[Math.round((s.index / (pts.length - 1)) * N)]);
    this.curve.getPoint(0, this.position);
  }

  private tAt(d: number) {
    let lo = 0;
    let hi = this.ds.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.ds[m] < d) lo = m + 1;
      else hi = m;
    }
    return this.ts[lo];
  }

  /** Moment (en secondes depuis le départ) où la visite arrive à l'arrêt `i`. */
  arrival(i: number) {
    return this.stopDist[i] / SPEED + i * PAUSE;
  }

  /** Avance de `dt` secondes. Renvoie l'indice de l'arrêt atteint, « fin » au bout du parcours, sinon null. */
  step(dt: number, playing: boolean): number | "fin" | null {
    const step = Math.min(dt, 0.05);
    let sweep = 0;
    let event: number | "fin" | null = null;
    if (playing) {
      if (this.pause > 0) {
        this.pause -= step;
        sweep = Math.sin((1 - this.pause / PAUSE) * Math.PI * 2) * 0.55; // regard qui balaie la pièce
      } else if (this.d < this.total) {
        this.d = Math.min(this.total, this.d + SPEED * step);
        if (this.nextStop < this.stopDist.length && this.d >= this.stopDist[this.nextStop]) {
          this.d = this.stopDist[this.nextStop];
          this.pause = PAUSE;
          this.cur = this.nextStop;
          event = this.nextStop;
          this.nextStop++;
        }
      } else if (!this.ended) {
        // fin du parcours (dernier arrêt terminé)
        this.ended = true;
        event = "fin";
      }
    }
    const p = this.curve.getPoint(this.tAt(this.d), this.position);
    const ahead = this.curve.getPoint(Math.min(1, this.tAt(Math.min(this.total, this.d + 0.8))), this.ahead);
    let yaw = Math.atan2(-(ahead.x - p.x), -(ahead.z - p.z));
    if (ahead.distanceTo(p) < 0.05) yaw = this.yaw;
    if (this.pause > 0 && this.cur >= 0) {
      const L = this.tour.stops[this.cur].look;
      yaw = Math.atan2(-(L.x - p.x), -(L.y - p.z)) + sweep;
    }
    // lissage de l'orientation
    let diff = yaw - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.yaw += diff * Math.min(1, step * 2.5);
    return event;
  }
}

/** Les points de vue d'un plan de la visite autour de l'arrêt `stop` : on arrive dans la pièce (`lead` secondes
    avant l'arrêt) puis on la balaie du regard. `frames` images à `fps` images/s, pas de temps fixe. */
export function tourShot(tour: Tour, stop: number, frames: number, fps: number, lead = 2) {
  const player = new TourPlayer(tour);
  const SUB = 5; // sous-pas par image, pour un lissage du regard proche de celui de l'écran
  const dt = 1 / (fps * SUB);
  const start = Math.max(0, Math.round((player.arrival(stop) - lead) * fps * SUB));
  const poses: { position: THREE.Vector3; yaw: number }[] = [];
  for (let k = 0; poses.length < frames; k++) {
    if (k >= start && (k - start) % SUB === 0) poses.push({ position: player.position.clone(), yaw: player.yaw });
    player.step(dt, true);
  }
  return poses;
}
