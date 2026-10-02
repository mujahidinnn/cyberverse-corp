import { useMemo } from 'react';
import { Instance, Instances } from '@react-three/drei';
import * as THREE from 'three';
import { useTheme } from '../theme';
import { chairPosition, type Desk } from '../data/nav';
import { ENTRANCE, FLOOR, FLOOR_CENTER, FURNITURE, GLASS_H, GLASS_WALLS, MEETING_TABLE, WALL_H, type Furniture } from '../data/office';
import { toon, toonGradient } from './visuals';
import { SCENE } from '../theme';

const INK = '#2b2f55';
const ENV = {
  light: { wall: '#fff8ee', trim: '#e8b98f', glass: '#8fe3ff', frame: '#5a6aa8', window: '#a8e1ff', wood: '#d99a5b', darkWood: '#a5623a', metal: '#d6def0', tile: '#fff6e9', line: '#f0dcc4', leaf: '#43c96a', pot: '#e0834a', rugShade: 1 },
  dark: { wall: '#2a2f5e', trim: '#3b4280', glass: '#5fd4ff', frame: '#5560a8', window: '#3346a0', wood: '#8a5a3c', darkWood: '#5e3a2a', metal: '#56608f', tile: '#1c2148', line: '#2a3066', leaf: '#2f9c63', pot: '#9c5a3a', rugShade: 0.65 },
};
type Pal = (typeof ENV)['light'];

const rad = (d: number) => (d * Math.PI) / 180;
const FW = FLOOR.x2 - FLOOR.x1;
const FD = FLOOR.z2 - FLOOR.z1;

function useTileTexture(base: string, line: string) {
  return useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = line;
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(FW, FD);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [base, line]);
}

const logoTexture = (() => {
  let tex: THREE.CanvasTexture | null = null;
  return () => {
    if (tex) return tex;
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 1024, 0);
    g.addColorStop(0, '#2b2f55');
    g.addColorStop(1, '#5a4fd0');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 256);
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 120px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CYBERVERSE', 512, 110);
    ctx.fillStyle = '#eef0ff';
    ctx.font = '600 44px system-ui, sans-serif';
    ctx.fillText('C O R P O R A T I O N', 512, 200);
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
})();

function Box({ p, s, color, rot = 0, cast = true }: { p: [number, number, number]; s: [number, number, number]; color: string; rot?: number; cast?: boolean }) {
  return (
    <mesh position={p} rotation-y={rot} material={toon(color)} castShadow={cast} receiveShadow>
      <boxGeometry args={s} />
    </mesh>
  );
}

function Cyl({ p, r, h, color, rt }: { p: [number, number, number]; r: number; h: number; color: string; rt?: number }) {
  return (
    <mesh position={p} material={toon(color)} castShadow>
      <cylinderGeometry args={[rt ?? r, r, h, 16]} />
    </mesh>
  );
}

function Glow({ p, s, color, rot = 0 }: { p: [number, number, number]; s: [number, number, number]; color: string; rot?: number }) {
  return (
    <mesh position={p} rotation-y={rot}>
      <boxGeometry args={s} />
      <meshStandardMaterial color={INK} emissive={color} emissiveIntensity={0.85} />
    </mesh>
  );
}

function Item({ f, c }: { f: Furniture; c: Pal }) {
  switch (f.kind) {
    case 'rack':
      return (
        <group position={[f.x, 0, f.z]}>
          <Box p={[0, 1, 0]} s={[0.8, 2, 0.9]} color={INK} />
          {[0.5, 0.9, 1.3, 1.7].map((y) => (
            <mesh key={y} position={[0.41, y, 0]}>
              <boxGeometry args={[0.02, 0.06, 0.7]} />
              <meshBasicMaterial color={y === 1.3 ? '#22c55e' : '#38bdf8'} />
            </mesh>
          ))}
        </group>
      );
    case 'cabinet':
      return (
        <group position={[f.x, 0, f.z]} rotation-y={rad(f.rot)}>
          <Box p={[0, 0.7, 0]} s={[1.1, 1.4, 0.6]} color="#8a97c8" />
          {[0.35, 0.8, 1.2].map((y) => <Box key={y} p={[0, y, 0.31]} s={[0.3, 0.05, 0.02]} color="#ffffff" cast={false} />)}
        </group>
      );
    case 'plant':
      return (
        <group position={[f.x, 0, f.z]} scale={f.big ? 1.4 : 1}>
          <Cyl p={[0, 0.22, 0]} r={0.15} rt={0.2} h={0.44} color={c.pot} />
          {[[0, 0.75, 0, 0.32], [0.15, 0.95, 0.05, 0.22], [-0.12, 0.9, -0.08, 0.24]].map(([x, y, z, r]) => (
            <mesh key={`${x}${y}`} position={[x, y, z]} material={toon(c.leaf)} castShadow>
              <icosahedronGeometry args={[r, 1]} />
            </mesh>
          ))}
        </group>
      );
    case 'sofa':
      return (
        <group position={[f.x, 0, f.z]} rotation-y={rad(f.rot)}>
          <Box p={[0, 0.25, 0]} s={[2.2, 0.5, 0.9]} color={f.color} />
          <Box p={[0, 0.65, -0.35]} s={[2.2, 0.6, 0.2]} color={f.color} />
          <Box p={[-1.05, 0.45, 0]} s={[0.15, 0.4, 0.9]} color={f.color} />
          <Box p={[1.05, 0.45, 0]} s={[0.15, 0.4, 0.9]} color={f.color} />
        </group>
      );
    case 'coffeeTable':
      return <Box p={[f.x, 0.22, f.z]} s={[0.8, 0.44, 1.1]} color={c.darkWood} />;
    case 'bookshelf':
      return (
        <group position={[f.x, 0, f.z]} rotation-y={rad(f.rot)}>
          <Box p={[0, 1.1, 0]} s={[2.6, 2.2, 0.4]} color={c.darkWood} />
          {[0.5, 1.05, 1.6].map((y, i) => (
            <group key={y}>
              {[-1, -0.6, -0.25, 0.2, 0.55, 0.95].map((x, j) => (
                <Box key={x} p={[x, y + 0.18, 0.12]} s={[0.22, 0.36, 0.2]} cast={false}
                  color={['#dc2626', '#2563eb', '#16a34a', '#facc15', '#7c3aed', '#f97316'][(i + j) % 6]} />
              ))}
            </group>
          ))}
        </group>
      );
    case 'bossDesk':
      return (
        <group position={[f.x, 0, f.z]}>
          <Box p={[0, 0.76, 0]} s={[2.6, 0.08, 1.1]} color={c.darkWood} />
          <Box p={[-1.15, 0.38, 0]} s={[0.2, 0.76, 1]} color={c.darkWood} />
          <Box p={[1.15, 0.38, 0]} s={[0.2, 0.76, 1]} color={c.darkWood} />
          <Box p={[0, 0.45, -0.45]} s={[2.1, 0.6, 0.06]} color={c.darkWood} />
          {[-0.45, 0.45].map((x) => <Glow key={x} p={[x, 1.1, -0.3]} s={[0.75, 0.45, 0.04]} color="#38bdf8" rot={x < 0 ? 0.2 : -0.2} />)}
          <Box p={[0, 0.5, -1.05]} s={[0.75, 0.12, 0.7]} color={INK} />
          <Box p={[0, 1.05, -1.38]} s={[0.75, 1.0, 0.12]} color={INK} />
        </group>
      );
    case 'rug':
      return (
        <mesh rotation-x={-Math.PI / 2} position={[f.x, 0.015, f.z]} receiveShadow raycast={() => null}>
          <planeGeometry args={[f.w, f.d]} />
          <meshToonMaterial color={new THREE.Color(f.color).multiplyScalar(c.rugShade)} gradientMap={toonGradient} />
        </mesh>
      );
    case 'counter':
      return (
        <group position={[f.x, 0, f.z]}>
          <Box p={[0, 0.5, 0]} s={[f.w, 1, 0.7]} color={c.wood} />
          <Box p={[0, 1.02, 0]} s={[f.w + 0.1, 0.05, 0.75]} color="#f8fafc" />
          <Box p={[-f.w / 2 + 0.6, 1.3, -0.1]} s={[0.4, 0.5, 0.35]} color={INK} />
        </group>
      );
    case 'fridge':
      return <Box p={[f.x, 0.95, f.z]} s={[0.8, 1.9, 0.75]} color={c.metal} />;
    case 'barTable':
      return (
        <group position={[f.x, 0, f.z]}>
          <Cyl p={[0, 1, 0]} r={0.4} h={0.05} color="#f8fafc" />
          <Cyl p={[0, 0.5, 0]} r={0.05} h={1} color={c.metal} />
        </group>
      );
    case 'screen':
      return (
        <group position={[f.x, 0, f.z]} rotation-y={rad(f.rot)}>
          <Glow p={[0, 1.55, 0]} s={[f.w, 1.2, 0.06]} color="#22d3ee" />
          <Box p={[0, 0.5, 0]} s={[0.12, 1, 0.12]} color={c.frame} />
        </group>
      );
    case 'whiteboard':
      return (
        <group position={[f.x, 0, f.z]} rotation-y={rad(f.rot)}>
          <Box p={[0, 1.35, 0]} s={[1.8, 1.1, 0.05]} color="#f8fafc" />
          <Box p={[-0.5, 0.4, 0]} s={[0.05, 0.8, 0.05]} color={c.frame} />
          <Box p={[0.5, 0.4, 0]} s={[0.05, 0.8, 0.05]} color={c.frame} />
        </group>
      );
    case 'trophy':
      return (
        <group position={[f.x, 0, f.z]}>
          <Box p={[0, 0.45, 0]} s={[0.5, 0.9, 0.5]} color={c.darkWood} />
          <Cyl p={[0, 1.1, 0]} r={0.06} rt={0.16} h={0.35} color="#facc15" />
        </group>
      );
    case 'treadmill':
      return (
        <group position={[f.x, 0, f.z]}>
          <Box p={[0, 0.12, 0]} s={[1.8, 0.24, 0.8]} color="#3a4070" />
          <Box p={[0, 0.25, 0]} s={[1.6, 0.03, 0.6]} color="#4a5187" cast={false} />
          <Box p={[0.85, 0.75, 0]} s={[0.08, 1.1, 0.7]} color="#7c86b5" />
          <Glow p={[0.85, 1.3, 0]} s={[0.2, 0.3, 0.5]} color="#22c55e" />
        </group>
      );
    case 'dumbbells':
      return (
        <group position={[f.x, 0, f.z]}>
          <Box p={[0, 0.45, 0]} s={[1.6, 0.9, 0.4]} color="#4a5187" />
          {[-0.6, -0.2, 0.2, 0.6].map((x) => (
            <mesh key={x} position={[x, 0.95, 0]} rotation-z={Math.PI / 2} material={toon(INK)}>
              <cylinderGeometry args={[0.07, 0.07, 0.3, 10]} />
            </mesh>
          ))}
        </group>
      );
    case 'bench':
      return (
        <group position={[f.x, 0, f.z]}>
          <Box p={[0, 0.45, 0]} s={[1.3, 0.12, 0.35]} color={INK} />
          <Box p={[0, 0.22, 0]} s={[0.12, 0.44, 0.3]} color="#7c86b5" />
          <Box p={[0.55, 1.1, 0]} s={[0.05, 1.2, 1]} color="#a9b3d6" />
        </group>
      );
    case 'yogaMat':
      return <Box p={[f.x, 0.02, f.z]} s={[1.9, 0.03, 0.7]} color={f.color} cast={false} />;
    case 'arcade':
      return (
        <group position={[f.x, 0, f.z]}>
          <Box p={[0, 0.9, 0]} s={[0.8, 1.8, 0.7]} color={f.color} />
          <Glow p={[0, 1.35, 0.33]} s={[0.6, 0.5, 0.05]} color="#a855f7" />
          <Box p={[0, 0.95, 0.4]} s={[0.7, 0.08, 0.25]} color={INK} />
        </group>
      );
    case 'pingpong':
      return (
        <group position={[f.x, 0, f.z]}>
          <Box p={[0, 0.76, 0]} s={[2.7, 0.06, 1.5]} color="#3d7bff" />
          <Box p={[0, 0.86, 0]} s={[0.02, 0.15, 1.5]} color="#f8fafc" cast={false} />
          {[[-1.1, -0.6], [1.1, -0.6], [-1.1, 0.6], [1.1, 0.6]].map(([x, z]) => <Box key={`${x}${z}`} p={[x, 0.37, z]} s={[0.06, 0.74, 0.06]} color={INK} />)}
        </group>
      );
    case 'beanbag':
      return (
        <mesh position={[f.x, 0.3, f.z]} scale={[1, 0.6, 1]} material={toon(f.color)} castShadow>
          <sphereGeometry args={[0.5, 16, 12]} />
        </mesh>
      );
    case 'massageChair':
      return (
        <group position={[f.x, 0, f.z]}>
          <Box p={[0, 0.35, 0]} s={[0.8, 0.7, 1.1]} color="#a5623a" />
          <Box p={[0, 1.05, -0.45]} s={[0.8, 1.0, 0.25]} color="#a5623a" />
        </group>
      );
    case 'logoWall':
      return (
        <group position={[f.x, 0, f.z]}>
          <Box p={[0, 1.3, 0]} s={[0.3, 2.6, 5]} color={INK} />
          <mesh position={[0.16, 1.5, 0]} rotation-y={Math.PI / 2}>
            <planeGeometry args={[4.6, 1.15]} />
            <meshBasicMaterial map={logoTexture()} toneMapped={false} />
          </mesh>
        </group>
      );
    case 'gate':
      return (
        <group position={[f.x, 0, f.z]}>
          <Box p={[0, 0.5, 0]} s={[0.18, 1, 0.8]} color={c.metal} />
          <Glow p={[0, 1.02, -0.3]} s={[0.12, 0.04, 0.12]} color="#22c55e" />
        </group>
      );
    case 'mat':
      return <Box p={[f.x, 0.02, f.z]} s={[4, 0.03, 1]} color="#4a5187" cast={false} />;
  }
}

function Chairs({ desks, color }: { desks: Desk[]; color: string }) {
  const seats = desks.map((d) => ({ ...chairPosition(d), yaw: rad(d.rotation_y) + Math.PI, id: d.desk_id }));
  return (
    <>
      <Instances limit={64} castShadow frustumCulled={false} material={toon(color)}>
        <boxGeometry args={[0.55, 0.1, 0.5]} />
        {seats.map((s) => <Instance key={s.id} position={[s.x, 0.46, s.z]} rotation-y={s.yaw} />)}
      </Instances>
      <Instances limit={64} castShadow frustumCulled={false} material={toon(color)}>
        <boxGeometry args={[0.55, 0.6, 0.08]} />
        {seats.map((s) => (
          <Instance key={s.id} position={[s.x - Math.sin(s.yaw) * 0.26, 0.82, s.z - Math.cos(s.yaw) * 0.26]} rotation-y={s.yaw} />
        ))}
      </Instances>
      <Instances limit={64} frustumCulled={false} material={toon('#4a5187')}>
        <cylinderGeometry args={[0.04, 0.2, 0.42, 8]} />
        {seats.map((s) => <Instance key={s.id} position={[s.x, 0.21, s.z]} />)}
      </Instances>
    </>
  );
}

export function Environment({ desks }: { desks: Desk[] }) {
  const theme = useTheme((s) => s.theme);
  const c = ENV[theme];
  const tile = useTileTexture(c.tile, c.line);
  const glassMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: c.glass, transparent: true, opacity: 0.22, roughness: 0.1, depthWrite: false }),
    [c.glass],
  );
  const winXs = Array.from({ length: Math.floor(FW / 10) }, (_, i) => FLOOR.x1 + 6 + i * 10);

  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[FLOOR_CENTER.x, 0.001, FLOOR_CENTER.z]} receiveShadow raycast={() => null}>
        <planeGeometry args={[FW, FD]} />
        <meshToonMaterial map={tile} gradientMap={toonGradient} />
      </mesh>

      {}
      <Box p={[FLOOR_CENTER.x, WALL_H / 2, FLOOR.z1 - 0.15]} s={[FW + 0.6, WALL_H, 0.3]} color={c.wall} />
      <Box p={[FLOOR.x1 - 0.15, WALL_H / 2, FLOOR_CENTER.z]} s={[0.3, WALL_H, FD]} color={c.wall} />
      {winXs.map((x) => (
        <mesh key={x} position={[x, 1.8, FLOOR.z1 + 0.02]}>
          <planeGeometry args={[7, 1.6]} />
          <meshBasicMaterial color={c.window} />
        </mesh>
      ))}
      {[-14, -4, 12].map((z) => (
        <mesh key={z} position={[FLOOR.x1 + 0.02, 1.8, z]} rotation-y={Math.PI / 2}>
          <planeGeometry args={[6, 1.6]} />
          <meshBasicMaterial color={c.window} />
        </mesh>
      ))}
      <Box p={[(FLOOR.x1 + ENTRANCE.x1) / 2, 0.12, FLOOR.z2 + 0.1]} s={[ENTRANCE.x1 - FLOOR.x1, 0.24, 0.2]} color={c.trim} />
      <Box p={[(ENTRANCE.x2 + FLOOR.x2) / 2, 0.12, FLOOR.z2 + 0.1]} s={[FLOOR.x2 - ENTRANCE.x2, 0.24, 0.2]} color={c.trim} />
      <Box p={[FLOOR.x2 + 0.1, 0.12, FLOOR_CENTER.z]} s={[0.2, 0.24, FD]} color={c.trim} />
      {}
      <Box p={[ENTRANCE.x1, 1.3, FLOOR.z2 + 0.1]} s={[0.2, 2.6, 0.3]} color={c.frame} />
      <Box p={[ENTRANCE.x2, 1.3, FLOOR.z2 + 0.1]} s={[0.2, 2.6, 0.3]} color={c.frame} />
      <Box p={[(ENTRANCE.x1 + ENTRANCE.x2) / 2, 2.6, FLOOR.z2 + 0.1]} s={[ENTRANCE.x2 - ENTRANCE.x1 + 0.2, 0.2, 0.3]} color={c.frame} />

      {GLASS_WALLS.map((w, i) => {
        const sx = w.x2 - w.x1;
        const sz = w.z2 - w.z1;
        return (
          <group key={i} position={[(w.x1 + w.x2) / 2, 0, (w.z1 + w.z2) / 2]}>
            <mesh position-y={GLASS_H / 2} material={glassMat} raycast={() => null}>
              <boxGeometry args={[sx, GLASS_H, sz]} />
            </mesh>
            <Box p={[0, GLASS_H, 0]} s={[sx + 0.02, 0.08, sz + 0.02]} color={c.frame} cast={false} />
            <Box p={[0, 0.04, 0]} s={[sx + 0.02, 0.08, sz + 0.02]} color={c.frame} cast={false} />
          </group>
        );
      })}

      {}
      <mesh position={[MEETING_TABLE.x, 0.75, MEETING_TABLE.z]} material={toon(c.darkWood)} castShadow>
        <cylinderGeometry args={[MEETING_TABLE.r, MEETING_TABLE.r, 0.08, 40]} />
      </mesh>
      <Cyl p={[MEETING_TABLE.x, 0.37, MEETING_TABLE.z]} r={0.5} rt={0.3} h={0.74} color={c.metal} />
      {Array.from({ length: MEETING_TABLE.seats }, (_, i) => {
        const a = (i / MEETING_TABLE.seats) * Math.PI * 2;
        const r = MEETING_TABLE.r + 0.55;
        return (
          <group key={i} position={[MEETING_TABLE.x + Math.sin(a) * r, 0, MEETING_TABLE.z + Math.cos(a) * r]} rotation-y={a + Math.PI}>
            <Box p={[0, 0.46, 0]} s={[0.5, 0.1, 0.45]} color={c.frame} />
            <Box p={[0, 0.8, -0.22]} s={[0.5, 0.55, 0.07]} color={c.frame} />
          </group>
        );
      })}

      {FURNITURE.map((f, i) => <Item key={i} f={f} c={c} />)}
      <Chairs desks={desks} color={SCENE[theme].chair} />
    </group>
  );
}
