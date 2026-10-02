import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { toonGradient } from './visuals';


export type HairStyle = 'short' | 'spiky' | 'bob' | 'long' | 'twintail' | 'ponytail' | 'bun' | 'slick';
export type Accessory = 'glasses' | 'catEars' | 'headset' | 'headphones' | 'hood' | 'tie' | 'clipboard' | 'brush' | 'broom' | 'mic' | 'crown';

export interface Appearance {
  body: 'f' | 'm';
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  eyes: string;
  top: string;
  bottom: string;
  skirt?: boolean;
  shoes: string;
  accessories: Accessory[];
}

export const B = {
  root: 0, hips: 1, spine: 2, head: 3,
  armL: 4, foreL: 5, armR: 6, foreR: 7,
  thighL: 8, shinL: 9, thighR: 10, shinR: 11,
} as const;

const REST: Record<number, [number, number, number]> = {
  [B.root]: [0, 0, 0],
  [B.hips]: [0, 0.84, 0],
  [B.spine]: [0, 0.92, 0],
  [B.head]: [0, 1.38, 0],
  [B.armL]: [0.2, 1.31, 0],
  [B.foreL]: [0.2, 1.06, 0],
  [B.armR]: [-0.2, 1.31, 0],
  [B.foreR]: [-0.2, 1.06, 0],
  [B.thighL]: [0.09, 0.82, 0],
  [B.shinL]: [0.09, 0.45, 0],
  [B.thighR]: [-0.09, 0.82, 0],
  [B.shinR]: [-0.09, 0.45, 0],
};
const PARENT: Record<number, number> = {
  [B.hips]: B.root, [B.spine]: B.hips, [B.head]: B.spine,
  [B.armL]: B.spine, [B.foreL]: B.armL, [B.armR]: B.spine, [B.foreR]: B.armR,
  [B.thighL]: B.hips, [B.shinL]: B.thighL, [B.thighR]: B.hips, [B.shinR]: B.thighR,
};
export const HIPS_STAND_Y = REST[B.hips][1];

const _c = new THREE.Color();

function part(geo: THREE.BufferGeometry, bone: number, color: string, pos: [number, number, number],
  rot?: [number, number, number], scale?: [number, number, number]): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(rot ?? [0, 0, 0]))),
    new THREE.Vector3(...(scale ?? [1, 1, 1])),
  );
  g.applyMatrix4(m);
  const n = g.attributes.position.count;
  _c.set(color);
  const colors = new Float32Array(n * 3);
  const idx = new Uint16Array(n * 4);
  const w = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    colors.set([_c.r, _c.g, _c.b], i * 3);
    idx[i * 4] = bone;
    w[i * 4] = 1;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
  g.deleteAttribute('uv');
  return g;
}

const cyl = (rt: number, rb: number, h: number, seg = 10) => new THREE.CylinderGeometry(rt, rb, h, seg);
const sph = (r: number, w = 16, h = 12, t0 = 0, tl = Math.PI) => new THREE.SphereGeometry(r, w, h, 0, Math.PI * 2, t0, tl);
const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);

const HEAD_C: [number, number, number] = [0, 1.58, 0];
const HEAD_R = 0.215;

function hairParts(a: Appearance): THREE.BufferGeometry[] {
  const c = a.hair;
  const [hx, hy, hz] = HEAD_C;
  const cap = part(sph(HEAD_R + 0.025, 18, 10, 0, Math.PI * 0.52), B.head, c, [hx, hy + 0.01, hz - 0.015], [-0.22, 0, 0]);
  const fringe = part(box(0.34, 0.07, 0.08), B.head, c, [hx, hy + 0.14, hz + 0.17], [0.5, 0, 0]);
  const back = (len: number) => part(box(0.4, len, 0.12), B.head, c, [hx, hy - len / 2 + 0.08, hz - 0.15]);
  switch (a.hairStyle) {
    case 'short':
      return [cap, fringe];
    case 'slick':
      return [part(sph(HEAD_R + 0.022, 18, 10, 0, Math.PI * 0.48), B.head, c, [hx, hy + 0.015, hz - 0.03], [-0.35, 0, 0])];
    case 'spiky':
      return [cap, ...[-0.12, 0, 0.12].flatMap((x) => [
        part(new THREE.ConeGeometry(0.06, 0.2, 6), B.head, c, [hx + x, hy + 0.25, hz - 0.02], [-0.3, 0, -x * 2]),
      ]), part(new THREE.ConeGeometry(0.07, 0.18, 6), B.head, c, [hx, hy + 0.2, hz + 0.12], [0.9, 0, 0])];
    case 'bob':
      return [cap, fringe, part(sph(HEAD_R + 0.04, 18, 12, Math.PI * 0.35, Math.PI * 0.35), B.head, c, [hx, hy - 0.02, hz - 0.01])];
    case 'long':
      return [cap, fringe, back(0.46), part(box(0.07, 0.34, 0.1), B.head, c, [hx + 0.19, hy - 0.12, hz + 0.02]),
        part(box(0.07, 0.34, 0.1), B.head, c, [hx - 0.19, hy - 0.12, hz + 0.02])];
    case 'twintail':
      return [cap, fringe, ...[1, -1].map((s) =>
        part(new THREE.CapsuleGeometry(0.06, 0.3, 4, 8), B.head, c, [hx + s * 0.26, hy - 0.08, hz - 0.05], [0, 0, s * 0.25]))];
    case 'ponytail':
      return [cap, fringe, part(new THREE.CapsuleGeometry(0.065, 0.32, 4, 8), B.head, c, [hx, hy - 0.08, hz - 0.26], [0.35, 0, 0])];
    case 'bun':
      return [cap, fringe, part(sph(0.1), B.head, c, [hx, hy + 0.2, hz - 0.12])];
  }
}

function accessoryParts(a: Appearance): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const [hx, hy, hz] = HEAD_C;
  for (const acc of a.accessories) {
    switch (acc) {
      case 'glasses':
        out.push(part(new THREE.TorusGeometry(0.055, 0.012, 6, 16), B.head, '#111827', [hx + 0.08, hy - 0.01, hz + 0.2]),
          part(new THREE.TorusGeometry(0.055, 0.012, 6, 16), B.head, '#111827', [hx - 0.08, hy - 0.01, hz + 0.2]),
          part(box(0.05, 0.012, 0.012), B.head, '#111827', [hx, hy, hz + 0.205]));
        break;
      case 'catEars':
        for (const s of [1, -1]) out.push(part(new THREE.ConeGeometry(0.07, 0.14, 4), B.head, a.hair, [hx + s * 0.13, hy + 0.23, hz - 0.02], [0, 0, -s * 0.35]));
        break;
      case 'headset':
      case 'headphones': {
        const band = acc === 'headset' ? '#f472b6' : '#111827';
        out.push(part(new THREE.TorusGeometry(0.24, 0.018, 6, 20, Math.PI), B.head, band, [hx, hy + 0.02, hz]));
        for (const s of [1, -1]) out.push(part(cyl(0.07, 0.07, 0.06, 12), B.head, band, [hx + s * 0.23, hy, hz], [0, 0, Math.PI / 2]));
        if (acc === 'headset') for (const s of [1, -1]) out.push(part(new THREE.ConeGeometry(0.05, 0.1, 4), B.head, band, [hx + s * 0.14, hy + 0.26, hz], [0, 0, -s * 0.3]));
        break;
      }
      case 'hood':
        out.push(part(new THREE.TorusGeometry(0.16, 0.06, 8, 16, Math.PI * 1.2), B.spine, a.top, [0, 1.36, -0.1], [Math.PI / 2 + 0.4, 0, -Math.PI * 0.1]));
        break;
      case 'tie':
        out.push(part(box(0.06, 0.28, 0.02), B.spine, '#b91c1c', [0, 1.15, 0.165]));
        break;
      case 'clipboard':
        out.push(part(box(0.2, 0.26, 0.02), B.foreL, '#a16207', [0.2, 0.84, 0.08], [0.2, 0, 0]),
          part(box(0.16, 0.2, 0.022), B.foreL, '#f8fafc', [0.2, 0.84, 0.09], [0.2, 0, 0]));
        break;
      case 'brush':
        out.push(part(cyl(0.012, 0.012, 0.3), B.foreR, '#92400e', [-0.2, 0.82, 0.06], [0.6, 0, 0]),
          part(new THREE.ConeGeometry(0.025, 0.06, 6), B.foreR, '#ec4899', [-0.2, 0.95, 0.15], [0.6, 0, 0]));
        break;
      case 'broom':
        out.push(part(cyl(0.015, 0.015, 1.1), B.foreR, '#92400e', [-0.2, 0.8, 0.05]),
          part(new THREE.ConeGeometry(0.12, 0.25, 8), B.foreR, '#facc15', [-0.2, 0.2, 0.05]));
        break;
      case 'mic':
        out.push(part(cyl(0.018, 0.018, 0.16), B.foreR, '#111827', [-0.2, 0.85, 0.05]),
          part(sph(0.04, 10, 8), B.foreR, '#9ca3af', [-0.2, 0.95, 0.05]));
        break;
      case 'crown':
        out.push(part(cyl(0.13, 0.12, 0.08, 8), B.head, '#facc15', [hx, hy + 0.24, hz - 0.02]));
        break;
    }
  }
  return out;
}

export function buildGeometry(a: Appearance): THREE.BufferGeometry {
  const f = a.body === 'f';
  const sw = f ? 0.9 : 1;
  const parts: THREE.BufferGeometry[] = [
    part(cyl(0.15 * sw, 0.15, 0.16), B.hips, a.bottom, [0, 0.84, 0]),
    part(cyl(0.175 * sw, 0.15, 0.46, 12), B.spine, a.top, [0, 1.1, 0], undefined, [1, 1, 0.78]),
    part(sph(0.1, 10, 8), B.spine, a.top, [0.17 * sw, 1.31, 0]),
    part(sph(0.1, 10, 8), B.spine, a.top, [-0.17 * sw, 1.31, 0]),
    part(cyl(0.055, 0.06, 0.1), B.head, a.skin, [0, 1.38, 0]),
    part(sph(HEAD_R, 20, 16), B.head, a.skin, HEAD_C, undefined, [1, 1.02, 0.96]),
    part(sph(0.04, 8, 6), B.head, a.skin, [HEAD_C[0] + 0.21, HEAD_C[1] - 0.02, 0]),
    part(sph(0.04, 8, 6), B.head, a.skin, [HEAD_C[0] - 0.21, HEAD_C[1] - 0.02, 0]),
    ...hairParts(a),
    ...accessoryParts(a),
  ];
  for (const [arm, fore, x] of [[B.armL, B.foreL, 0.2 * sw], [B.armR, B.foreR, -0.2 * sw]] as const) {
    parts.push(
      part(cyl(0.058, 0.052, 0.25), arm, a.top, [x, 1.185, 0]),
      part(cyl(0.05, 0.044, 0.2), fore, f ? a.skin : a.top, [x, 0.96, 0]),
      part(sph(0.05, 10, 8), fore, a.skin, [x, 0.83, 0.01]),
    );
  }
  for (const [thigh, shin, x] of [[B.thighL, B.shinL, 0.09], [B.thighR, B.shinR, -0.09]] as const) {
    parts.push(
      part(cyl(0.078, 0.066, 0.38), thigh, a.skirt ? a.skin : a.bottom, [x, 0.635, 0]),
      part(cyl(0.062, 0.052, 0.36), shin, a.skirt ? a.skin : a.bottom, [x, 0.27, 0]),
      part(box(0.11, 0.08, 0.22), shin, a.shoes, [x, 0.04, 0.04]),
    );
  }
  if (a.skirt) parts.push(part(cyl(0.16, 0.26, 0.3, 14), B.hips, a.bottom, [0, 0.7, 0]));
  const merged = mergeGeometries(parts)!;
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

export function buildSkeleton(): { bones: THREE.Bone[]; skeleton: THREE.Skeleton } {
  const bones: THREE.Bone[] = [];
  const count = Object.keys(REST).length;
  for (let i = 0; i < count; i++) bones.push(new THREE.Bone());
  for (let i = 0; i < count; i++) {
    const p = REST[i];
    if (i === B.root) bones[i].position.set(...p);
    else {
      const pp = REST[PARENT[i]];
      bones[i].position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
      bones[PARENT[i]].add(bones[i]);
    }
  }
  bones[B.root].updateMatrixWorld(true);
  return { bones, skeleton: new THREE.Skeleton(bones) };
}

export const bodyMaterial = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient });

const faceCache = new Map<string, THREE.MeshBasicMaterial>();
export function faceMaterial(eyes: string, female: boolean): THREE.MeshBasicMaterial {
  const key = `${eyes}|${female}`;
  let m = faceCache.get(key);
  if (m) return m;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  for (const x of [76, 180]) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(x, 58, 26, 34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = eyes;
    ctx.beginPath();
    ctx.ellipse(x, 62, 20, 29, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.ellipse(x, 64, 10, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x + 7, 48, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.ellipse(x, 58, 27, 35, 0, Math.PI * 1.1, Math.PI * 1.9);
    ctx.stroke();
    if (female) {
      ctx.fillStyle = 'rgba(244,114,182,0.35)';
      ctx.beginPath();
      ctx.ellipse(x + (x < 128 ? -14 : 14), 108, 18, 8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.strokeStyle = '#7f1d1d';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(128, 104, 10, 0.2, Math.PI - 0.2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  faceCache.set(key, m);
  return m;
}

export const faceGeometry = (() => {
  const g = new THREE.SphereGeometry(HEAD_R * 1.012, 24, 12, Math.PI / 2 - 0.62, 1.24, Math.PI * 0.4, Math.PI * 0.26);
  g.scale(1, 1.02, 0.96);
  return g;
})();
export const FACE_OFFSET = new THREE.Vector3(0, HEAD_C[1] - REST[B.head][1], 0);
