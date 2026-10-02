import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type PF from 'pathfinding';
import { useOffice } from '../store/officeStore';
import { chairPosition, findPath, isWalkable, type Desk, type Point } from '../data/nav';
import { Humanoid } from './Humanoid';
import { CEO_APPEARANCE } from '../data/appearance';
import { BOSS_ROOM } from '../data/office';

const WALK = 4;
const RUN = 7;
const NEAR_ENTER = 2.0;
const NEAR_EXIT = 2.5;
const SPAWN: Point = BOSS_ROOM.spawn;
const MOVE_KEYS: Record<string, [number, number]> = {
  w: [1, 0], arrowup: [1, 0], s: [-1, 0], arrowdown: [-1, 0],
  d: [0, 1], arrowright: [0, 1], a: [0, -1], arrowleft: [0, -1],
};

const isTyping = (e: KeyboardEvent) =>
  !!(e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]');

const _fwd = new THREE.Vector3();

export function CeoAvatar({ grid, desks }: { grid: PF.Grid; desks: Record<string, Desk> }) {
  const group = useRef<THREE.Group>(null!);
  const [moving, setMoving] = useState(false);
  const pressed = useRef(new Set<string>());
  const path = useRef<Point[]>([]);
  const lastScan = useRef(0);
  const movingRef = useRef(false);
  const ceoTarget = useOffice((s) => s.ceoTarget);
  const { camera, controls } = useThree() as unknown as {
    camera: THREE.Camera;
    controls: { target: THREE.Vector3; update: () => void } | null;
  };

  useEffect(() => {
    group.current.position.set(SPAWN.x, 0, SPAWN.z);
    group.current.rotation.y = Math.PI / 4;
    const down = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      pressed.current.add(e.key.toLowerCase());
      if (e.key === 'Shift') pressed.current.add('shift');
    };
    const up = (e: KeyboardEvent) => {
      pressed.current.delete(e.key.toLowerCase());
      if (e.key === 'Shift') pressed.current.delete('shift');
    };
    const clear = () => pressed.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, []);

  useEffect(() => {
    if (!ceoTarget) return;
    const p = group.current.position;
    path.current = findPath(grid, { x: p.x, z: p.z }, { x: ceoTarget.x, z: ceoTarget.z });
  }, [ceoTarget, grid]);

  useFrame(({ clock }, dt) => {
    const g = group.current;
    const speed = (pressed.current.has('shift') ? RUN : WALK) * dt;

    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    _fwd.normalize();
    let f = 0;
    let r = 0;
    for (const k of pressed.current) {
      const m = MOVE_KEYS[k];
      if (m) {
        f += m[0];
        r += m[1];
      }
    }
    let mx = _fwd.x * f - _fwd.z * r;
    let mz = _fwd.z * f + _fwd.x * r;
    const len = Math.hypot(mx, mz);
    let isMoving = false;

    if (len > 0) {
      path.current = [];
      mx = (mx / len) * speed;
      mz = (mz / len) * speed;
      if (isWalkable(grid, g.position.x + mx, g.position.z)) g.position.x += mx;
      if (isWalkable(grid, g.position.x, g.position.z + mz)) g.position.z += mz;
      g.rotation.y = Math.atan2(mx, mz);
      isMoving = true;
    } else if (path.current.length) {
      const t = path.current[0];
      const dx = t.x - g.position.x;
      const dz = t.z - g.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= speed) {
        g.position.set(t.x, 0, t.z);
        path.current.shift();
      } else {
        g.position.x += (dx / dist) * speed;
        g.position.z += (dz / dist) * speed;
        g.rotation.y = Math.atan2(dx, dz);
      }
      isMoving = true;
    }
    if (isMoving !== movingRef.current) {
      movingRef.current = isMoving;
      setMoving(isMoving);
    }

    const state = useOffice.getState();
    if (state.follow && controls) {
      const dx = (g.position.x - controls.target.x) * 0.1;
      const dz = (g.position.z - controls.target.z) * 0.1;
      controls.target.x += dx;
      controls.target.z += dz;
      camera.position.x += dx;
      camera.position.z += dz;
      controls.update();
    }

    if (clock.elapsedTime - lastScan.current < 0.2) return;
    lastScan.current = clock.elapsedTime;
    let best: string | null = null;
    let bestD = Infinity;
    for (const a of Object.values(state.agents)) {
      const desk = desks[a.desk_id];
      if (!desk || a.kind !== 'llm') continue;
      const c = chairPosition(desk);
      const d = Math.hypot(c.x - g.position.x, c.z - g.position.z);
      if (d < bestD) {
        bestD = d;
        best = a.agent_id;
      }
    }
    const current = state.nearAgent;
    const keep = current && current === best ? bestD <= NEAR_EXIT : false;
    const next = keep ? current : bestD <= NEAR_ENTER ? best : null;
    if (next !== current) state.setNear(next);
  });

  return (
    <group ref={group} name="ceo">
      <Humanoid appearance={CEO_APPEARANCE} mode={moving ? 'walk' : 'stand_idle'} />
      <mesh rotation-x={-Math.PI / 2} position-y={0.02}>
        <ringGeometry args={[0.45, 0.62, 32]} />
        <meshBasicMaterial color="#38bdf8" />
      </mesh>
      <Html position={[0, 2.95, 0]} center zIndexRange={[10, 0]}>
        <div className="ceo-tag">Kamu</div>
      </Html>
    </group>
  );
}
