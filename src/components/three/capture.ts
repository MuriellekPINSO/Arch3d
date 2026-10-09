/* Captures pour les rendus IA : cartes de profondeur exactes tirées de la 3D (la géométrie vient du plan,
   l'IA n'a plus qu'à l'habiller) et plans de la visite guidée rendus image par image. */
import * as THREE from "three";
import type { RootState } from "@react-three/fiber";
import type { Pt, Room } from "@/lib/types";
import type { Furniture } from "@/lib/furnish";
import type { HouseLevel } from "@/lib/levels";
import { type Tour, yawTowards } from "@/lib/tour";
import { offsetPolygon, pointInPolygon, roomAnchor } from "@/lib/geometry";
import { PITCH, TOUR_FOV, tourShot } from "@/lib/tourPlayer";
import { GrayAPNG, grayPNG } from "@/lib/png";
import { tx } from "@/lib/i18n";

export const SHOT_FRAMES = 81; // 5 s à 16 images/s, la longueur que produit Wan 2.2
export const SHOT_FPS = 16;

export interface TourShot {
  control: Blob; // profondeur, APNG de SHOT_FRAMES images
  first: string; // première image en couleurs (data URL PNG)
  firstDepth: Blob; // profondeur de la première image (PNG)
}

/** Point de vue d'une photo (pour l'animer plus tard depuis exactement la même vue). */
export interface ShotPose {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fov: number;
  aspect: number;
  target: [number, number, number] | null; // centre de rotation de la vue maquette
}

export interface CaptureAPI {
  /** profondeur de la vue affichée, même cadrage que la capture du canvas */
  depthOfView(): Promise<Blob>;
  /** point de vue actuel */
  pose(): ShotPose;
  /** plan de la visite guidée autour de l'arrêt `stop`, à la taille de la vidéo voulue ; `lead` : secondes de marche
      avant l'arrêt (0 = on part du seuil de la pièce, regard vers l'intérieur, puis tour du regard) */
  tourShot(stop: number, w: number, h: number, onProgress?: (done: number, total: number) => void, lead?: number): Promise<TourShot>;
  /** petit mouvement de caméra depuis la vue d'une photo (travelling avant dans une pièce, rotation autour de la
      maison sinon), en profondeur image par image : de quoi animer la photo sans rien inventer */
  moveShot(from: ShotPose, kind: "dolly" | "orbit", w: number, h: number, onProgress?: (done: number, total: number) => void): Promise<TourShot>;
  /** plan « photographe » d'une pièce : depuis son meilleur angle, regard en diagonale vers le cœur de la pièce,
      léger panoramique et petite avancée (film de présentation) */
  roomShot(roomId: string, w: number, h: number, onProgress?: (done: number, total: number) => void): Promise<TourShot>;
}

/* profondeur le long de l'axe de visée, en échelle logarithmique : proche = blanc, loin (et ciel) = noir,
   comme les cartes de Depth Anything sur lesquelles les modèles de contrôle ont appris */
function depthMaterial(near: number, far: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uNear: { value: near }, uFar: { value: far } },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      varying float vDepth;
      void main() {
        #include <begin_vertex>
        #include <project_vertex>
        vDepth = -mvPosition.z;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNear;
      uniform float uFar;
      varying float vDepth;
      void main() {
        float v = 1.0 - log(max(vDepth, uNear) / uNear) / log(uFar / uNear);
        gl_FragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
      }`,
  });
}

/** Plage large qui contient toute la maison (murs), pas le terrain qui l'entoure. */
function houseRange(box: THREE.Box3, eyes: THREE.Vector3[]) {
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(
    (i) => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z),
  );
  let near = Infinity;
  let far = 0;
  for (const e of eyes) {
    near = Math.min(near, box.distanceToPoint(e));
    for (const c of corners) far = Math.max(far, e.distanceTo(c));
  }
  near = Math.max(0.3, near);
  return { near, far: Math.max(far, near * 2 + 1) };
}

const BLACK = new THREE.Color(0, 0, 0);

class DepthRenderer {
  private rt: THREE.WebGLRenderTarget;
  private mat: THREE.ShaderMaterial;
  private rgba: Uint8Array;

  constructor(private gl: THREE.WebGLRenderer, private scene: THREE.Scene, private w: number, private h: number) {
    this.rt = new THREE.WebGLRenderTarget(w, h, { samples: 4 });
    this.mat = depthMaterial(0.3, 30);
    this.rgba = new Uint8Array(w * h * 4);
  }

  set range({ near, far }: { near: number; far: number }) {
    this.mat.uniforms.uNear.value = near;
    this.mat.uniforms.uFar.value = far;
  }

  /** Profondeurs réellement vues par `cam` (du 1er au 99e centile, ciel exclu), mesurées sur la plage large `wide`. */
  measure(cam: THREE.Camera, wide: { near: number; far: number }) {
    this.range = wide;
    const k = Math.log(wide.far / wide.near);
    const g = this.render(cam);
    const zs: number[] = [];
    for (let i = 0; i < g.length; i += 97) if (g[i] > 0) zs.push(wide.near * Math.exp((1 - g[i] / 255) * k));
    if (zs.length < 50) return wide;
    zs.sort((a, b) => a - b);
    const near = Math.max(0.15, zs[Math.floor(zs.length * 0.01)] * 0.9);
    return { near, far: Math.max(near * 2, zs[Math.floor(zs.length * 0.99)] * 1.15) };
  }

  /** Rend la profondeur vue par `cam` ; la scène est rendue intacte avant de rendre la main. */
  render(cam: THREE.Camera) {
    const { gl, scene, w, h } = this;
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    const hidden: THREE.Object3D[] = [];
    scene.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        // vitres, ombres de contact, surlignages : transparents, on voit à travers
        if (mats.every((x) => !x.visible || (x.transparent && x.opacity < 0.9))) hidden.push(m);
        else swapped.push([m, m.material]);
      } else if ((o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) hidden.push(o);
    });
    const background = scene.background;
    const autoShadows = gl.shadowMap.autoUpdate;
    const target = gl.getRenderTarget();
    try {
      for (const [m] of swapped) m.material = this.mat;
      for (const o of hidden) o.visible = false;
      scene.background = BLACK;
      gl.shadowMap.autoUpdate = false;
      gl.setRenderTarget(this.rt);
      gl.render(scene, cam);
      gl.readRenderTargetPixels(this.rt, 0, 0, w, h, this.rgba);
    } finally {
      for (const [m, mat] of swapped) m.material = mat;
      for (const o of hidden) o.visible = true;
      scene.background = background;
      gl.shadowMap.autoUpdate = autoShadows;
      gl.setRenderTarget(target);
    }
    // WebGL lit de bas en haut
    const gray = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      const dst = y * w;
      for (let x = 0; x < w; x++) gray[dst + x] = this.rgba[src + x * 4];
    }
    return gray;
  }

  dispose() {
    this.rt.dispose();
    this.mat.dispose();
  }
}

/** Plage de chaque image, calée sur ce qu'elle voit (toute la gamme de gris sert), puis lissée sur ±1 s :
    elle suit le passage d'une porte à la pièce sans scintiller. Mesurée une image sur deux. */
function smoothRanges(dr: DepthRenderer, cams: THREE.Camera[], wide: { near: number; far: number }) {
  const logs: [number, number][] = [];
  let last: [number, number] | null = null;
  cams.forEach((cam, i) => {
    if (i % 2 === 0 || !last) {
      const r = dr.measure(cam, wide);
      last = [Math.log(r.near), Math.log(r.far)];
    }
    logs.push(last);
  });
  const R = 16;
  return logs.map((_, i) => {
    let n = 0;
    let f = 0;
    let c = 0;
    for (let j = Math.max(0, i - R); j <= Math.min(logs.length - 1, i + R); j++) {
      n += logs[j][0];
      f += logs[j][1];
      c++;
    }
    return { near: Math.exp(n / c), far: Math.exp(f / c) };
  });
}

/** Rendu couleur à une taille donnée, sur le canvas lui-même (tons et couleurs identiques à l'écran). */
function renderColor(gl: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera, w: number, h: number) {
  const size = gl.getSize(new THREE.Vector2());
  const ratio = gl.getPixelRatio();
  const target = gl.getRenderTarget();
  try {
    gl.setPixelRatio(1);
    gl.setSize(w, h, false);
    gl.setRenderTarget(null);
    gl.render(scene, cam);
    return gl.domElement.toDataURL("image/png");
  } finally {
    gl.setPixelRatio(ratio);
    gl.setSize(size.x, size.y, false);
    gl.setRenderTarget(target);
  }
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

/** Rend une suite de caméras : première image en couleurs, sa profondeur, et la profondeur de chaque image (APNG). */
async function shoot(gl: THREE.WebGLRenderer, scene: THREE.Scene, cams: THREE.Camera[], w: number, h: number, wide: { near: number; far: number }, onProgress?: (done: number, total: number) => void): Promise<TourShot> {
  const dr = new DepthRenderer(gl, scene, w, h);
  const apng = new GrayAPNG(w, h, cams.length, SHOT_FPS);
  let first = "";
  let firstDepth: Blob | null = null;
  try {
    const ranges = smoothRanges(dr, cams, wide);
    for (let i = 0; i < cams.length; i++) {
      dr.range = ranges[i];
      const gray = dr.render(cams[i]);
      if (i === 0) {
        first = renderColor(gl, scene, cams[0], w, h);
        firstDepth = await grayPNG(gray, w, h);
      }
      await apng.add(gray);
      onProgress?.(i + 1, cams.length);
      await nextFrame();
    }
  } finally {
    dr.dispose();
  }
  return { control: apng.blob(), first, firstDepth: firstDepth! };
}

const ROOM_FOV = 60; // vertical : ~90° en largeur au format 16:9, l'angle d'un photographe immobilier
const ROOM_EYE = 1.45;

/** Positions et directions candidates pour filmer une pièce : coins (rentrés de 35 et 70 cm), milieux des côtés et
    cœur de la pièce, regard vers les meubles, vers le cœur ou vers le coin opposé. */
function roomCandidates(room: Room, furniture: Furniture[]) {
  const anchor = roomAnchor(room);
  const items = furniture.filter((f) => f.roomId === room.id && f.kind !== "tapis");
  let toFurniture = anchor;
  if (items.length) {
    let sw = 0, sx = 0, sy = 0;
    for (const f of items) {
      const k = f.w * f.d;
      sw += k; sx += f.x * k; sy += f.y * k;
    }
    toFurniture = { x: (sx / sw + anchor.x) / 2, y: (sy / sw + anchor.y) / 2 };
  }
  const ring = (d: number) => offsetPolygon(room.points, -d);
  const mids = (pts: Pt[]) => pts.map((a, i) => ({ x: (a.x + pts[(i + 1) % pts.length].x) / 2, y: (a.y + pts[(i + 1) % pts.length].y) / 2 }));
  const spots = [...ring(0.35), ...ring(0.7), ...mids(ring(0.35)), anchor].filter((c) => pointInPolygon(c, room.points));
  const out: { from: Pt; yaw: number }[] = [];
  for (const c of spots) {
    const far = ring(0.35).reduce((a, b) => (Math.hypot(b.x - c.x, b.y - c.y) > Math.hypot(a.x - c.x, a.y - c.y) ? b : a), c);
    for (const t of [toFurniture, anchor, far]) if (Math.hypot(t.x - c.x, t.y - c.y) > 0.5) out.push({ from: c, yaw: yawTowards(c, t) });
  }
  return out;
}

const roomCam = (from: Pt, z: number, yaw: number, aspect: number) => {
  const cam = new THREE.PerspectiveCamera(ROOM_FOV, aspect, 0.05, 500);
  cam.position.set(from.x, z + ROOM_EYE, from.y);
  cam.rotation.set(-0.08, yaw, 0, "YXZ");
  cam.updateMatrixWorld();
  return cam;
};

/** Le meilleur point de vue d'une pièce, jugé sur de petites images de profondeur : on voit loin (profondeur médiane),
    sans mur ni meuble collé à l'objectif. */
function bestRoomView(gl: THREE.WebGLRenderer, scene: THREE.Scene, room: Room, z: number, furniture: Furniture[], wide: { near: number; far: number }) {
  const W = 160;
  const H = 90;
  const dr = new DepthRenderer(gl, scene, W, H);
  dr.range = wide;
  const k = Math.log(wide.far / wide.near);
  let best: { from: Pt; yaw: number; score: number } | null = null;
  try {
    for (const c of roomCandidates(room, furniture)) {
      const g = dr.render(roomCam(c.from, z, c.yaw, W / H));
      const d: number[] = [];
      for (let i = 0; i < g.length; i += 3) d.push(g[i] ? wide.near * Math.exp((1 - g[i] / 255) * k) : wide.far);
      d.sort((a, b) => a - b);
      const median = d[d.length >> 1];
      const close = d.filter((x) => x < 0.8).length / d.length;
      const score = Math.min(median, 6) + 0.5 * d[Math.floor(d.length * 0.25)] - 8 * close;
      if (!best || score > best.score) best = { ...c, score };
    }
  } finally {
    dr.dispose();
  }
  return best ?? { from: roomAnchor(room), yaw: 0, score: 0 };
}

/** `bounds` : boîte englobant les murs de la maison. */
export function createCapture(get: () => RootState, bounds: () => THREE.Box3, tour: () => Tour | null, levels: () => HouseLevel[]): CaptureAPI {
  return {
    async depthOfView() {
      const { gl, scene, camera } = get();
      const c = gl.domElement;
      // même proportion que le canvas, autour d'un million de pixels (l'IA travaille à cette taille)
      const s = Math.min(1, Math.sqrt(1.2e6 / (c.width * c.height)));
      const w = Math.round(c.width * s);
      const h = Math.round(c.height * s);
      const dr = new DepthRenderer(gl, scene, w, h);
      try {
        dr.range = dr.measure(camera, houseRange(bounds(), [camera.getWorldPosition(new THREE.Vector3())]));
        return await grayPNG(dr.render(camera), w, h);
      } finally {
        dr.dispose();
      }
    },

    pose() {
      const { camera, controls } = get();
      const cam = camera as THREE.PerspectiveCamera;
      const target = (controls as unknown as { target?: THREE.Vector3 } | null)?.target;
      return {
        position: cam.position.toArray() as [number, number, number],
        quaternion: cam.quaternion.toArray() as [number, number, number, number],
        fov: cam.fov,
        aspect: cam.aspect,
        target: target ? (target.toArray() as [number, number, number]) : null,
      };
    },

    async roomShot(roomId, w, h, onProgress) {
      const { gl, scene } = get();
      const L = levels().find((l) => l.rooms.some((r) => r.id === roomId));
      const room = L?.rooms.find((r) => r.id === roomId);
      if (!L || !room) throw new Error(tx("Pièce introuvable.", "Room not found."));
      const wide = houseRange(bounds(), [new THREE.Vector3(roomAnchor(room).x, L.z + ROOM_EYE, roomAnchor(room).y)]);
      const { from, yaw } = bestRoomView(gl, scene, room, L.z, L.furniture, wide);
      // petite avancée dans le sens du regard, et panoramique lent de ~18°
      const dir = { x: -Math.sin(yaw), y: -Math.cos(yaw) };
      const ease = (k: number) => k * k * (3 - 2 * k);
      const cams = Array.from({ length: SHOT_FRAMES }, (_, i) => {
        const k = ease(i / (SHOT_FRAMES - 1));
        return roomCam({ x: from.x + dir.x * 0.3 * k, y: from.y + dir.y * 0.3 * k }, L.z, yaw - 0.16 + 0.32 * k, w / h);
      });
      return shoot(gl, scene, cams, w, h, houseRange(bounds(), cams.map((c) => c.position)), onProgress);
    },

    async moveShot(from, kind, w, h, onProgress) {
      const { gl, scene } = get();
      // la photo est recadrée au centre aux proportions de la vidéo : même champ horizontal si elle est plus haute
      const aspect = w / h;
      const fov =
        from.aspect < aspect ? (2 * Math.atan(Math.tan((from.fov * Math.PI) / 360) * (from.aspect / aspect)) * 180) / Math.PI : from.fov;
      const start = new THREE.Vector3(...from.position);
      const q0 = new THREE.Quaternion(...from.quaternion);
      const ease = (k: number) => k * k * (3 - 2 * k);
      let poseAt: (k: number, cam: THREE.PerspectiveCamera) => void;
      if (kind === "dolly") {
        // on avance à l'horizontale dans la direction du regard, sans approcher le mur d'en face
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q0);
        fwd.y = 0;
        fwd.normalize();
        const ray = new THREE.Raycaster(start, fwd, 0.05, 20);
        const hit = ray.intersectObjects(scene.children, true).find((x) => x.object.visible && (x.object as THREE.Mesh).isMesh);
        const dist = Math.min(1.2, Math.max(0, ((hit?.distance ?? 3) - 0.8) * 0.6));
        poseAt = (k, cam) => {
          cam.position.copy(start).addScaledVector(fwd, dist * ease(k));
          cam.quaternion.copy(q0);
        };
      } else {
        // rotation lente autour du centre visé (vue maquette, façade)
        const target = from.target ? new THREE.Vector3(...from.target) : start.clone().add(new THREE.Vector3(0, 0, -5).applyQuaternion(q0));
        const off = start.clone().sub(target);
        const up = new THREE.Vector3(0, 1, 0);
        poseAt = (k, cam) => {
          cam.position.copy(target).add(off.clone().applyAxisAngle(up, (18 * Math.PI) / 180 * ease(k)));
          cam.lookAt(target);
        };
      }
      const cams = Array.from({ length: SHOT_FRAMES }, (_, i) => {
        const cam = new THREE.PerspectiveCamera(fov, aspect, 0.05, 500);
        poseAt(i / (SHOT_FRAMES - 1), cam);
        cam.updateMatrixWorld();
        return cam;
      });
      return shoot(gl, scene, cams, w, h, houseRange(bounds(), cams.map((c) => c.position)), onProgress);
    },

    async tourShot(stop, w, h, onProgress, lead = 2) {
      const { gl, scene } = get();
      const t = tour();
      if (!t) throw new Error(tx("Pas de visite guidée à filmer.", "No guided tour to film."));
      const cams = tourShot(t, stop, SHOT_FRAMES, SHOT_FPS, lead).map((p) => {
        const cam = new THREE.PerspectiveCamera(TOUR_FOV, w / h, 0.05, 500);
        cam.position.copy(p.position);
        cam.rotation.set(PITCH, p.yaw, 0, "YXZ");
        cam.updateMatrixWorld();
        return cam;
      });
      const dr = new DepthRenderer(gl, scene, w, h);
      const apng = new GrayAPNG(w, h, SHOT_FRAMES, SHOT_FPS);
      let first = "";
      let firstDepth: Blob | null = null;
      try {
        const ranges = smoothRanges(dr, cams, houseRange(bounds(), cams.map((c) => c.position)));
        for (let i = 0; i < cams.length; i++) {
          dr.range = ranges[i];
          const gray = dr.render(cams[i]);
          if (i === 0) {
            first = renderColor(gl, scene, cams[0], w, h);
            firstDepth = await grayPNG(gray, w, h);
          }
          await apng.add(gray);
          onProgress?.(i + 1, cams.length);
          await nextFrame(); // laisse l'écran respirer
        }
      } finally {
        dr.dispose();
      }
      return { control: apng.blob(), first, firstDepth: firstDepth! };
    },
  };
}
