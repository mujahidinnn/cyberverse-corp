import { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Instance, Instances, MapControls, OrthographicCamera, PerformanceMonitor } from '@react-three/drei';
import { useOffice } from '../store/officeStore';
import { buildGrid, type Desk } from '../data/nav';
import { AgentAvatar } from './AgentAvatar';
import { CeoAvatar } from './CeoAvatar';
import { Signs } from './Signs';
import { AmbientDirector, CameraDirector } from './Directors';
import { Environment } from './Environment';
import { FLOOR, FLOOR_CENTER, obstacles } from '../data/office';
import { toonGradient } from './visuals';
import { SCENE, useTheme } from '../theme';

const ZONES: [number, number, number, number, string, string][] = [
  [-6.75, 6.75, -6.8, -2.4, '#ffe1b8', '#6a4c28'],
  [-7, 7, -13.4, -7, '#dcdcff', '#37378a'],
  [-18, 18, -17, -13, '#c4e1ff', '#1d4c92'],
  [20, 28, -9, 9, '#ffd0e6', '#73306c'],
  [-16.5, 16.5, 13, 17, '#c9f5d3', '#1d6350'],
  [-28, -20, -9, 9, '#e3d4ff', '#4b3296'],
  [-6, 6, 1, 9.5, '#d0f1f4', '#1f5c78'],
  [8, 14, 4, 9, '#ffe9a8', '#6b5826'],
  [32, 49.5, -19.5, -3, '#c6f3e2', '#1a625c'],
  [32, 49.5, 3, 24, '#ffe3c2', '#5c3c62'],
];

function OfficeShell() {
  const theme = useTheme((s) => s.theme);
  const moveCeo = useOffice((s) => s.moveCeo);
  return (
    <group onClick={(e) => e.delta < 5 && moveCeo(e.point.x, e.point.z)}>
      {}
      <mesh rotation-x={-Math.PI / 2} position={[FLOOR_CENTER.x, 0, FLOOR_CENTER.z]}>
        <planeGeometry args={[FLOOR.x2 - FLOOR.x1, FLOOR.z2 - FLOOR.z1]} />
        <meshBasicMaterial visible={false} />
      </mesh>
      {ZONES.map(([x1, x2, z1, z2, light, dark], i) => (
        <mesh key={i} rotation-x={-Math.PI / 2} position={[(x1 + x2) / 2, 0.008, (z1 + z2) / 2]} receiveShadow>
          <planeGeometry args={[x2 - x1, z2 - z1]} />
          <meshToonMaterial color={theme === 'light' ? light : dark} gradientMap={toonGradient} transparent opacity={0.85} />
        </mesh>
      ))}
    </group>
  );
}

function DeskProps({ desks }: { desks: Desk[] }) {
  const pal = SCENE[useTheme((s) => s.theme)];
  return (
    <>
      <Instances limit={64} castShadow receiveShadow frustumCulled={false}>
        <boxGeometry args={[1.6, 0.75, 0.8]} />
        <meshToonMaterial color={pal.desk} gradientMap={toonGradient} />
        {desks.map((d) => (
          <Instance key={d.desk_id} position={[d.x, 0.375, d.z]} rotation-y={(d.rotation_y * Math.PI) / 180} />
        ))}
      </Instances>
      <Instances limit={64} castShadow frustumCulled={false}>
        <boxGeometry args={[0.7, 0.45, 0.05]} />
        <meshStandardMaterial color={pal.monitor} emissive={pal.monitorGlow} emissiveIntensity={0.35} />
        {desks.map((d) => {
          const r = (d.rotation_y * Math.PI) / 180;
          return (
            <Instance
              key={d.desk_id}
              position={[d.x - Math.sin(r) * 0.25, 1.0, d.z - Math.cos(r) * 0.25]}
              rotation-y={r}
            />
          );
        })}
      </Instances>
    </>
  );
}

export default function Office3DScene() {
  const agents = useOffice((s) => s.agents);
  const select = useOffice((s) => s.select);
  const pal = SCENE[useTheme((s) => s.theme)];
  const [dpr, setDpr] = useState(1.5);

  const deskList = useMemo(
    () => Object.values(agents).map(({ desk_id, x, z, rotation_y }) => ({ desk_id, x, z, rotation_y })),
    [Object.keys(agents).length],
  );
  const desks = useMemo(() => Object.fromEntries(deskList.map((d) => [d.desk_id, d])), [deskList]);
  const grid = useMemo(() => buildGrid(deskList, obstacles()), [deskList]);

  return (
    <Canvas shadows flat dpr={dpr} onPointerMissed={() => select(null)}>
      <PerformanceMonitor onDecline={() => setDpr(1)} onIncline={() => setDpr(1.5)} />
      <OrthographicCamera makeDefault position={[FLOOR_CENTER.x + 40, 40, FLOOR_CENTER.z + 40]} zoom={15} near={0.1} far={1000} />
      <MapControls makeDefault target={[FLOOR_CENTER.x, 0, FLOOR_CENTER.z]} enableRotate={false} minZoom={9} maxZoom={60} enableDamping />

      <ambientLight color={pal.ambientColor} intensity={pal.ambient} />
      <hemisphereLight args={[pal.hemiSky, pal.hemiGround, pal.hemi]} />
      <directionalLight
        position={[29, 40, 12]}
        color={pal.sunColor}
        intensity={pal.sun}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-50}
        shadow-camera-right={50}
        shadow-camera-top={50}
        shadow-camera-bottom={-50}
      />

      <OfficeShell />
      <Environment desks={deskList} />
      <DeskProps desks={deskList} />
      <Signs />
      <AmbientDirector />
      <CameraDirector />
      {Object.values(agents).map((a) => (
        <AgentAvatar key={a.agent_id} agent={a} desks={desks} grid={grid} />
      ))}
      {deskList.length > 0 && <CeoAvatar grid={grid} desks={desks} />}
    </Canvas>
  );
}
