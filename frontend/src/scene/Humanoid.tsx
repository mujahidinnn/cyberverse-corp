import { forwardRef, useEffect, useMemo, useRef } from 'react';
import { createPortal, useFrame, type ThreeEvent } from '@react-three/fiber';
import { Outlines } from '@react-three/drei';
import * as THREE from 'three';
import {
  B, FACE_OFFSET, HIPS_STAND_Y, bodyMaterial, buildGeometry, buildSkeleton, faceGeometry, faceMaterial,
  type Appearance,
} from './humanoid';

export type Mode =
  | 'sit_idle' | 'sit_type' | 'sit_think' | 'sit_talk' | 'sit_frozen' | 'sit_sad' | 'sit_cheer'
  | 'stand_idle' | 'walk' | 'listen' | 'stand_talk'
  | 'run' | 'pingpong' | 'arcade' | 'yoga' | 'lift' | 'lounge' | 'chat' | 'coffee';

interface Pose {
  hipsY: number; spine: number; headX: number; headY: number; headZ: number;
  armL: number; armLz: number; foreL: number; armR: number; armRz: number; foreR: number;
  thighL: number; shinL: number; thighR: number; shinR: number;
}

const SIT_Y = 0.53;
const base = (): Pose => ({
  hipsY: HIPS_STAND_Y, spine: 0, headX: 0, headY: 0, headZ: 0,
  armL: 0, armLz: 0.08, foreL: 0, armR: 0, armRz: -0.08, foreR: 0,
  thighL: 0, shinL: 0, thighR: 0, shinR: 0,
});
const sit = (p: Pose): Pose => ({ ...p, hipsY: SIT_Y, thighL: -1.5, shinL: 1.45, thighR: -1.5, shinR: 1.45, spine: -0.04 });

function target(mode: Mode, t: number, phase: number): Pose {
  const p = base();
  const breathe = Math.sin(t * 1.6 + phase) * 0.02;
  switch (mode) {
    case 'sit_idle':
      return { ...sit(p), spine: -0.04 + breathe, armL: -0.35, foreL: -0.7, armR: -0.35, foreR: -0.7, headY: Math.sin(t * 0.3 + phase) * 0.25 };
    case 'sit_type': {
      const k = Math.sin(t * 18 + phase) * 0.07;
      return { ...sit(p), spine: -0.12, headX: 0.18, armL: -0.55, foreL: -0.95 + k, armR: -0.55, foreR: -0.95 - k };
    }
    case 'sit_think':
      return { ...sit(p), spine: -0.02 + breathe, headX: 0.05, headZ: 0.12, armL: -0.35, foreL: -0.7, armR: -0.95, armRz: -0.25, foreR: -2.15 };
    case 'sit_talk':
      return { ...sit(p), headX: Math.sin(t * 5) * 0.05, armL: -0.35, foreL: -0.7, armR: -0.8 + Math.sin(t * 4) * 0.25, foreR: -1.1, armRz: -0.3 };
    case 'sit_frozen':
      return { ...sit(p), spine: 0.02, headX: -0.08, armL: -0.6, foreL: -0.5, armR: -0.6, foreR: -0.5 };
    case 'sit_sad':
      return { ...sit(p), spine: 0.35, headX: 0.45, armL: -0.15, foreL: -0.3, armR: -0.15, foreR: -0.3 };
    case 'sit_cheer': {
      const w = Math.sin(t * 10) * 0.3;
      return { ...sit(p), headX: -0.15, armL: -2.9, armLz: 0.3 + w, foreL: -0.2, armR: -2.9, armRz: -0.3 - w, foreR: -0.2 };
    }
    case 'walk': {
      const s = Math.sin(t * 9 + phase);
      return {
        ...p, hipsY: HIPS_STAND_Y + Math.abs(Math.cos(t * 9 + phase)) * 0.03, spine: -0.05,
        thighL: s * 0.55, shinL: Math.max(0, -s) * 0.8, thighR: -s * 0.55, shinR: Math.max(0, s) * 0.8,
        armL: -s * 0.45, foreL: -0.25, armR: s * 0.45, foreR: -0.25,
      };
    }
    case 'run': {
      const s = Math.sin(t * 13 + phase);
      return {
        ...p, hipsY: HIPS_STAND_Y + Math.abs(Math.cos(t * 13 + phase)) * 0.05, spine: 0.14,
        thighL: s * 0.85, shinL: Math.max(0, -s) * 1.3 + 0.15, thighR: -s * 0.85, shinR: Math.max(0, s) * 1.3 + 0.15,
        armL: -s * 0.8, foreL: -1.4, armR: s * 0.8, foreR: -1.4,
      };
    }
    case 'pingpong': {
      const w = Math.sin(t * 5 + phase);
      return {
        ...p, hipsY: HIPS_STAND_Y - 0.05, spine: 0.16, headY: w * 0.2, thighL: -0.3, shinL: 0.5, thighR: -0.3, shinR: 0.5,
        armR: -1.0 + w * 0.6, armRz: -0.5 - w * 0.35, foreR: -0.9 + w * 0.3, armL: -0.3, armLz: 0.3, foreL: -0.8,
      };
    }
    case 'arcade': {
      const k = Math.sin(t * 16 + phase) * 0.12;
      return { ...p, spine: 0.1 + Math.sin(t * 2 + phase) * 0.05, headX: 0.12, armL: -0.75, foreL: -0.9 + k, armR: -0.75, foreR: -0.9 - k };
    }
    case 'yoga': {
      const a = Math.sin(t * 0.8 + phase) * 0.18;
      return { ...p, spine: breathe, headX: -0.1, armL: -3.0, armLz: 0.2 + a, foreL: -0.15, armR: -3.0, armRz: -0.2 + a, foreR: -0.15, thighR: -0.95, shinR: 1.9 };
    }
    case 'lift': {
      const c = Math.sin(t * 3 + phase);
      return { ...p, hipsY: HIPS_STAND_Y - 0.03, thighL: -0.2, shinL: 0.35, thighR: -0.2, shinR: 0.35, armL: -0.15, foreL: -1.2 - c * 0.9, armR: -0.15, foreR: -1.2 + c * 0.9 };
    }
    case 'lounge':
      return {
        ...sit(p), hipsY: SIT_Y - 0.05, spine: -0.28 + breathe, headX: 0.22, headY: Math.sin(t * 0.4 + phase) * 0.35,
        thighL: -1.35, shinL: 1.0, thighR: -1.35, shinR: 1.0, armL: -0.25, armLz: 0.35, foreL: -0.5, armR: -0.25, armRz: -0.35, foreR: -0.5,
      };
    case 'chat': {
      const talking = Math.sin(t * 0.6 + phase) > 0;
      return {
        ...p, spine: breathe, headX: talking ? Math.sin(t * 5) * 0.05 : Math.max(0, Math.sin(t * 2.2 + phase)) * 0.15,
        armL: -0.45, foreL: -1.35, armR: talking ? -0.8 + Math.sin(t * 4) * 0.3 : -0.1, armRz: talking ? -0.3 : -0.08, foreR: talking ? -1.0 : -0.2,
      };
    }
    case 'coffee':
      return { ...p, spine: 0.08, headX: 0.22, armL: -0.7, foreL: -0.8 + Math.sin(t * 3 + phase) * 0.15, armR: -0.55, foreR: -1.0 };
    case 'listen':
      return { ...p, spine: breathe, headX: Math.max(0, Math.sin(t * 2.2 + phase)) * 0.15, armL: -0.3, armLz: -0.25, foreL: -1.2, armR: -0.3, armRz: 0.25, foreR: -1.2 };
    case 'stand_talk':
      return { ...p, headX: Math.sin(t * 5) * 0.05, armR: -0.8 + Math.sin(t * 4) * 0.3, armRz: -0.3, foreR: -1.0, armL: -0.1, foreL: -0.2 };
    case 'stand_idle':
    default:
      return { ...p, spine: breathe, foreL: -0.12, foreR: -0.12, headY: Math.sin(t * 0.35 + phase) * 0.3 };
  }
}

interface Props {
  appearance: Appearance;
  mode: Mode | { current: Mode };
  highlight?: boolean;
  lod?: boolean;
  phase?: number;
  onClick?: (e: ThreeEvent<MouseEvent>) => void;
  children?: React.ReactNode;
}

export const Humanoid = forwardRef<THREE.Group, Props>(function Humanoid(
  { appearance, mode, highlight, lod, phase = 0, onClick, children }, ref,
) {
  const { mesh, bones } = useMemo(() => {
    const geo = buildGeometry(appearance);
    const { bones, skeleton } = buildSkeleton();
    const mesh = new THREE.SkinnedMesh(geo, bodyMaterial);
    mesh.add(bones[B.root]);
    mesh.bind(skeleton);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    const face = new THREE.Mesh(faceGeometry, faceMaterial(appearance.eyes, appearance.body === 'f'));
    face.position.copy(FACE_OFFSET);
    bones[B.head].add(face);
    return { mesh, bones };
  }, [appearance]);

  useEffect(() => () => mesh.geometry.dispose(), [mesh]);

  const pose = useRef<Pose>(base());
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useFrame(({ clock }, dt) => {
    const m = modeRef.current;
    const tgt = target(typeof m === 'string' ? m : m.current, clock.elapsedTime, phase);
    const k = Math.min(1, dt * 10);
    const p = pose.current;
    for (const key of Object.keys(p) as (keyof Pose)[]) p[key] += (tgt[key] - p[key]) * k;
    bones[B.hips].position.y = p.hipsY;
    bones[B.spine].rotation.x = p.spine;
    bones[B.head].rotation.set(p.headX, p.headY, p.headZ);
    bones[B.armL].rotation.set(p.armL, 0, p.armLz);
    bones[B.foreL].rotation.x = p.foreL;
    bones[B.armR].rotation.set(p.armR, 0, p.armRz);
    bones[B.foreR].rotation.x = p.foreR;
    bones[B.thighL].rotation.x = p.thighL;
    bones[B.shinL].rotation.x = p.shinL;
    bones[B.thighR].rotation.x = p.thighR;
    bones[B.shinR].rotation.x = p.shinR;
  });

  return (
    <group ref={ref} onClick={onClick}>
      <primitive object={mesh} scale={1.15} />
      {(!lod || highlight) &&
        createPortal(<Outlines thickness={highlight ? 0.035 : 0.018} color={highlight ? '#facc15' : '#0f172a'} />, mesh)}
      {children}
    </group>
  );
});
