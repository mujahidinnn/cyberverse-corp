import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useOffice } from '../store/officeStore';
import { FURNITURE, STATIONS } from '../data/office';
import { presence } from '../data/nav';

const MAX_AWAY = 10;
const STAYS_AT_POST = new Set(['agent_goro', 'agent_chie']);
const TICK_S = 4;
const LOD_ZOOM = 14;

export function AmbientDirector() {
  const groups = useRef(new Map<string, { ids: string[]; backAt: number }>());
  const last = useRef(0);

  useFrame(({ clock }) => {
    const now = clock.elapsedTime;
    if (now - last.current < TICK_S) return;
    last.current = now;
    const st = useOffice.getState();

    for (const [id, g] of groups.current) {
      const left = g.ids.filter((a) => st.agents[a]?.status === 'IDLE');
      if (now < g.backAt && left.length >= STATIONS.find((s) => s.id === id)!.min) continue;
      groups.current.delete(id);
      for (const a of left) st.ambientMove(a, st.agents[a].desk_id);
    }
    if (st.meeting?.running) return;

    const away = new Set([...groups.current.values()].flatMap((g) => g.ids));
    const idle = Object.values(st.agents).filter(
      (a) => a.status === 'IDLE' && !away.has(a.agent_id) && a.agent_id !== st.selected &&
        a.agent_id !== st.chatWith && !STAYS_AT_POST.has(a.agent_id),
    );
    if (!idle.length) return;
    const pick = () => idle.splice(Math.floor(Math.random() * idle.length), 1)[0];

    const free = STATIONS.filter((s) => !groups.current.has(s.id));
    if (free.length && Math.random() < 0.45) {
      const s = free[Math.floor(Math.random() * free.length)];
      const n = Math.min(s.slots.length, s.min + Math.floor(Math.random() * (s.slots.length - s.min + 1)));
      if (idle.length >= n && away.size + n <= MAX_AWAY) {
        const ids = Array.from({ length: n }, () => pick().agent_id);
        groups.current.set(s.id, { ids, backAt: now + 35 + Math.random() * 25 });
        ids.forEach((id, i) => st.ambientMove(id, `st:${s.id}:${i}`));
      }
    }
    if (idle.length && st.bubbles.length < 2 && Math.random() < 0.1) {
      const a = pick();
      const lines = a.ambient_lines ?? [];
      if (lines.length) st.sayLocal(a.agent_id, lines[Math.floor(Math.random() * lines.length)]);
    }
  });
  return <PingPongBall />;
}

function PingPongBall() {
  const ball = useRef<THREE.Mesh>(null!);
  const table = FURNITURE.find((f) => f.kind === 'pingpong')!;
  useFrame(({ clock }) => {
    ball.current.visible = (presence.get('pingpong')?.size ?? 0) >= 2;
    const t = clock.elapsedTime * 2.6;
    ball.current.position.set(table.x + Math.sin(t) * 1.7, 0.85 + Math.abs(Math.sin(t * 2)) * 0.35, table.z + Math.sin(t * 0.7) * 0.4);
  });
  return (
    <mesh ref={ball} visible={false}>
      <sphereGeometry args={[0.06, 10, 8]} />
      <meshBasicMaterial color="#ffffff" />
    </mesh>
  );
}

interface View {
  target: THREE.Vector3;
  position: THREE.Vector3;
  zoom: number;
}

export function CameraDirector() {
  const { camera, controls, scene } = useThree() as unknown as {
    camera: THREE.OrthographicCamera;
    controls: { target: THREE.Vector3; update: () => void } | null;
    scene: THREE.Scene;
  };
  const selected = useOffice((s) => s.selected);
  const saved = useRef<View | null>(null);
  const goal = useRef<View | null>(null);

  useEffect(() => {
    if (!controls || useOffice.getState().follow) return;
    if (selected) {
      const obj = scene.getObjectByName(selected);
      if (!obj) return;
      saved.current ??= { target: controls.target.clone(), position: camera.position.clone(), zoom: camera.zoom };
      const offset = camera.position.clone().sub(controls.target);
      const target = obj.position.clone();
      goal.current = { target, position: target.clone().add(offset), zoom: Math.max(camera.zoom, 32) };
    } else if (saved.current) {
      goal.current = saved.current;
      saved.current = null;
    }
  }, [selected, camera, controls, scene]);

  useFrame(() => {
    const g = goal.current;
    if (g && controls) {
      controls.target.lerp(g.target, 0.12);
      camera.position.lerp(g.position, 0.12);
      camera.zoom += (g.zoom - camera.zoom) * 0.12;
      camera.updateProjectionMatrix();
      controls.update();
      if (controls.target.distanceTo(g.target) < 0.02 && Math.abs(camera.zoom - g.zoom) < 0.1) goal.current = null;
    }
    const lod = camera.zoom < LOD_ZOOM;
    if (lod !== useOffice.getState().lod) useOffice.getState().setLod(lod);
  });
  return null;
}
