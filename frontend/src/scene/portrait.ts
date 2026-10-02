import * as THREE from 'three';
import { CEO_APPEARANCE, appearanceFor } from '../data/appearance';
import { B, FACE_OFFSET, bodyMaterial, buildGeometry, buildSkeleton, faceGeometry, faceMaterial, type Appearance } from './humanoid';

const SIZE = 96;
const cache = new Map<string, string>();
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;

function setup(): void {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);
  scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(1.5, 2.5, 3);
  scene.add(key);
  camera = new THREE.PerspectiveCamera(24, 1, 0.1, 10);
  camera.position.set(0.32, 1.66, 1.75);
  camera.lookAt(0, 1.55, 0);
}

function render(a: Appearance): string {
  if (!renderer) setup();
  const geo = buildGeometry(a);
  const { bones, skeleton } = buildSkeleton();
  const mesh = new THREE.SkinnedMesh(geo, bodyMaterial);
  mesh.add(bones[B.root]);
  mesh.bind(skeleton);
  mesh.frustumCulled = false;
  const face = new THREE.Mesh(faceGeometry, faceMaterial(a.eyes, a.body === 'f'));
  face.position.copy(FACE_OFFSET);
  bones[B.head].add(face);
  scene!.add(mesh);
  renderer!.render(scene!, camera!);
  const url = renderer!.domElement.toDataURL('image/png');
  scene!.remove(mesh);
  geo.dispose();
  return url;
}

export function portrait(agentId: string, division: string, number: number): string {
  let url = cache.get(agentId);
  if (url === undefined) {
    try {
      url = render(agentId === 'ceo' ? CEO_APPEARANCE : appearanceFor(agentId, division, number));
    } catch {
      url = '';
    }
    cache.set(agentId, url);
  }
  return url;
}
