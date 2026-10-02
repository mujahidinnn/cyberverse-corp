import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type PF from 'pathfinding';
import { useOffice, type AgentState } from '../store/officeStore';
import { chairPosition, findPath, presence, slotPosition, visitPoint, type Desk, type Point, type Spot } from '../data/nav';
import type { Station } from '../data/office';
import { STATUS_RING, emojiTexture } from './visuals';
import { Humanoid, type Mode } from './Humanoid';
import { appearanceFor } from '../data/appearance';

const STAND_UP_MS = 280;
const TAU = Math.PI * 2;

export function AgentAvatar({ agent, desks, grid }: { agent: AgentState; desks: Record<string, Desk>; grid: PF.Grid }) {
  const group = useRef<THREE.Group>(null!);
  const [seated, setSeated] = useState(true);
  const ring = useRef<THREE.Mesh>(null!);
  const marker = useRef<THREE.Mesh>(null!);
  const path = useRef<Point[]>([]);
  const walking = useRef(false);
  const sitting = useRef(true);
  const standAt = useRef(0);
  const yaw = useRef(0);
  const arrive = useRef<{ yaw: number | null; home: boolean; spot?: Spot }>({ yaw: null, home: true });
  const station = useRef<Station | null>(null);
  const modeRef = useRef<Mode>('sit_idle');
  const ambientAway = useRef(false);
  const lod = useOffice((s) => s.lod);
  const select = useOffice((s) => s.select);
  const selected = useOffice((s) => s.selected === agent.agent_id);
  const bubble = useOffice((s) => s.bubbles.find((b) => b.speaker_id === agent.agent_id));

  const home = useMemo(() => chairPosition(desks[agent.desk_id]), [desks, agent.desk_id]);
  const seatYaw = useMemo(() => ((desks[agent.desk_id]?.rotation_y ?? 0) * Math.PI) / 180 + Math.PI, [desks, agent.desk_id]);
  const appearance = useMemo(() => appearanceFor(agent.agent_id, agent.division, agent.number),
    [agent.agent_id, agent.division, agent.number]);
  const speed = 1.5 + (agent.number % 5) * 0.12;
  const icon = agent.emotion_icon ? emojiTexture(agent.emotion_icon) : null;
  const ringColor = STATUS_RING[agent.status];

  const leaveStation = () => {
    if (station.current) presence.get(station.current.id)?.delete(agent.agent_id);
    station.current = null;
  };

  useEffect(() => {
    group.current.position.set(home.x, 0, home.z);
    group.current.rotation.y = yaw.current = seatYaw;
    path.current = [];
    walking.current = false;
    sitting.current = true;
    setSeated(true);
    return leaveStation;
  }, [home, seatYaw]);

  const walkTo = (dest: Point, arriveYaw: number | null, spot?: Spot) => {
    const p = group.current.position;
    leaveStation();
    p.y = 0;
    path.current = findPath(grid, { x: p.x, z: p.z }, dest);
    arrive.current = { yaw: arriveYaw, home: dest === home, spot };
    if (sitting.current) standAt.current = performance.now() + STAND_UP_MS;
    sitting.current = false;
    walking.current = true;
    setSeated(false);
  };

  useEffect(() => {
    if (!agent.move) return;
    const t = agent.move.target;
    ambientAway.current = !!agent.move.ambient && t !== agent.desk_id;
    if (t === agent.desk_id) return walkTo(home, seatYaw);
    if (desks[t]) return walkTo(visitPoint(desks[t]), null);
    const slot = slotPosition(t);
    if (slot) walkTo(slot, slot.yaw, slot);
  }, [agent.move]);

  useEffect(() => {
    const busy = ['THINKING', 'WORKING', 'QUEUED', 'WAITING_APPROVAL', 'ERROR', 'TALKING'].includes(agent.status);
    if (busy && ambientAway.current) {
      ambientAway.current = false;
      walkTo(home, seatYaw);
    }
  }, [agent.status]);

  const sitMode: Mode = ({
    WORKING: 'sit_type', THINKING: 'sit_think', QUEUED: 'sit_think', TALKING: 'sit_talk',
    WAITING_APPROVAL: 'sit_frozen', ERROR: 'sit_sad',
  } as Record<string, Mode>)[agent.status] ?? (agent.emotion_icon === 'check' ? 'sit_cheer' : bubble ? 'sit_talk' : 'sit_idle');
  const standMode: Mode = agent.status === 'MEETING' ? (bubble ? 'stand_talk' : 'listen')
    : bubble || agent.status === 'TALKING' ? 'stand_talk' : 'stand_idle';

  useFrame(({ clock }, dt) => {
    const g = group.current;
    const t = clock.elapsedTime + agent.number;
    const rising = performance.now() < standAt.current;

    if (path.current.length && !rising) {
      const target = path.current[0];
      const dx = target.x - g.position.x;
      const dz = target.z - g.position.z;
      const dist = Math.hypot(dx, dz);
      const step = speed * dt;
      if (dist <= step) {
        g.position.set(target.x, 0, target.z);
        path.current.shift();
      } else {
        g.position.x += (dx / dist) * step;
        g.position.z += (dz / dist) * step;
        yaw.current = Math.atan2(dx, dz);
      }
    }
    if (walking.current && !path.current.length) {
      const a = arrive.current;
      if (a.yaw !== null) yaw.current = a.yaw;
      walking.current = false;
      sitting.current = a.home;
      setSeated(a.home);
      if (a.spot?.station) {
        g.position.y = a.spot.y ?? 0;
        station.current = a.spot.station;
        if (!presence.has(a.spot.station.id)) presence.set(a.spot.station.id, new Set());
        presence.get(a.spot.station.id)!.add(agent.agent_id);
      }
    }
    const turn = ((yaw.current - g.rotation.y + Math.PI) % TAU + TAU) % TAU - Math.PI;
    g.rotation.y += turn * Math.min(1, dt * 12);

    const st = station.current;
    modeRef.current = walking.current ? (rising ? 'stand_idle' : 'walk')
      : sitting.current ? sitMode
      : st && standMode === 'stand_idle' && (presence.get(st.id)?.size ?? 0) >= st.min ? st.act
      : standMode;

    if (marker.current) marker.current.rotation.y += dt * 3;
    if (ring.current) {
      const s = agent.status === 'WAITING_APPROVAL' ? 1 + Math.sin(t * 6) * 0.15 : 1;
      ring.current.scale.setScalar(s);
    }
  });

  return (
    <group ref={group} name={agent.agent_id}>
      <Humanoid
        appearance={appearance}
        mode={modeRef}
        phase={agent.number * 0.7}
        highlight={selected}
        lod={lod}
        onClick={(e) => {
          e.stopPropagation();
          select(agent.agent_id);
        }}
      />
      {ringColor && (
        <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={0.02}>
          <ringGeometry args={[0.45, 0.6, 32]} />
          <meshBasicMaterial color={ringColor} transparent opacity={0.85} />
        </mesh>
      )}
      {agent.status === 'ERROR' && (
        <mesh ref={marker} position={[0, 2.05, 0]} rotation-x={Math.PI}>
          <coneGeometry args={[0.18, 0.35, 4]} />
          <meshBasicMaterial color="#dc2626" />
        </mesh>
      )}
      {icon && (
        <sprite position={[0.4, seated ? 1.75 : 2.05, 0]} scale={0.45}>
          <spriteMaterial map={icon} transparent depthWrite={false} />
        </sprite>
      )}
      {bubble && (
        <Html position={[0, seated ? 1.72 : 2.05, 0]} zIndexRange={[20, 0]}>
          <div className={`bubble-anchor bubble-${bubble.style}`} style={{ '--lead': `${14 + (agent.number % 4) * 22}px` } as React.CSSProperties}>
            <div className="bubble">
              <b>{agent.name} <i>{agent.role}</i></b>
              <span>{bubble.text}</span>
            </div>
            <div className="bubble-leader" />
            <div className="bubble-dot" />
          </div>
        </Html>
      )}
    </group>
  );
}
