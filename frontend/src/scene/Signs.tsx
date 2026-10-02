import { Html } from '@react-three/drei';
import { useOffice } from '../store/officeStore';
import { EXEC_WING } from '../data/office';
import { DIVISION_COLOR } from './visuals';
import { Icon, type IconKey } from '../hud/icons';
import { toon } from './visuals';

interface Sign {
  key: string;
  kind: 'totem' | 'plaque';
  icon: IconKey;
  title: string;
  division?: string;
  accent?: string;
  subtitle?: string;
  x: number;
  z: number;
  scale?: number;
}

const TOTEM_SCALE = 1.4;

const LEAD: Record<string, string> = {
  engineering: 'agent_aoi', creative: 'agent_luna', marketing: 'agent_ryota', operations: 'agent_daichi',
};

const SIGNS: Sign[] = [
  { key: 'eng', kind: 'totem', icon: 'engineering', title: 'Engineering Bay', division: 'engineering', x: 10.5, z: -12.3 },
  { key: 'cre', kind: 'totem', icon: 'creative', title: 'Creative Lounge', division: 'creative', x: 29.2, z: 9.9 },
  { key: 'mkt', kind: 'totem', icon: 'marketing', title: 'Marketing & Growth', division: 'marketing', x: 17.5, z: 17.9 },
  { key: 'ops', kind: 'totem', icon: 'operations', title: 'Operations & HR', division: 'operations', x: -19.1, z: 9.9 },
  { key: 'exec', kind: 'totem', icon: 'executive', title: 'Executive Wing', accent: DIVISION_COLOR.executive, subtitle: 'CEO, CTO, CPO', x: 7.7, z: -1.7 },
  { key: 'hall', kind: 'totem', icon: 'townhall', title: 'Town Hall', accent: '#64748b', subtitle: 'All-Hands Meeting', x: -8.8, z: -10.2, scale: 0.85 },
  { key: 'meet', kind: 'totem', icon: 'meetingRoom', title: 'Meeting Room', accent: '#64748b', subtitle: '14 kursi', x: 6.9, z: 10.3, scale: 0.85 },
  { key: 'pantry', kind: 'totem', icon: 'pantry', title: 'Pantry', accent: '#d97706', subtitle: 'Kopi & camilan', x: 14.9, z: 9.8, scale: 0.8 },
  { key: 'heal', kind: 'totem', icon: 'healing', title: 'Ruang Healing', accent: '#10b981', subtitle: 'Gym, game, relaksasi', x: 48.7, z: -2.2 },
  { key: 'lobby', kind: 'totem', icon: 'lobby', title: 'Lobby & Ruang Tamu', accent: '#f59e0b', subtitle: 'Resepsionis: Chie', x: 38.4, z: 23.2 },
  { key: 'sec', kind: 'totem', icon: 'security', title: 'Pos Satpam', accent: '#1d4ed8', subtitle: 'Petugas: Goro', x: 48.6, z: 23.2, scale: 0.75 },
  { key: 'boss', kind: 'plaque', icon: 'boss', title: 'Ruang Bos', accent: '#facc15', x: 23.5, z: -10.85 },
  ...EXEC_WING.offices.map((x, i) => ({
    key: `office${i}`, kind: 'plaque' as const, icon: (['cto', 'ceo', 'cpo'] as const)[i],
    title: ['CTO Sora', 'CEO Ren', 'CPO Maya'][i], accent: DIVISION_COLOR.executive, x, z: EXEC_WING.z2 + 0.05,
  })),
];

const TOTEM_FACTOR = 0.014;
const PLAQUE_FACTOR = 0.0065;

export function Signs() {
  const agents = useOffice((s) => s.agents);
  const all = Object.values(agents);

  return (
    <group>
      {SIGNS.map((s) => {
        const accent = s.accent ?? (s.division ? DIVISION_COLOR[s.division] : '#64748b');
        let subtitle = s.subtitle ?? '';
        if (s.division) {
          const n = all.filter((a) => a.division === s.division).length;
          subtitle = n ? `${n} agen, Lead: ${agents[LEAD[s.division]]?.name ?? '-'}` : '';
        }
        const plaque = s.kind === 'plaque';
        const k = (s.scale ?? 1) * TOTEM_SCALE;
        const label = (
          <Html position={[0, plaque ? 2.12 : 2.05 * k, 0]} center distanceFactor={plaque ? PLAQUE_FACTOR : TOTEM_FACTOR * k}
            zIndexRange={[8, 0]} pointerEvents="none">
            <div className={plaque ? 'sign plaque' : 'sign'} style={{ '--sign': accent } as React.CSSProperties}>
              <span className="sign-icon"><Icon name={s.icon} size={plaque ? 20 : 30} /></span>
              <span>
                <b>{s.title}</b>
                {subtitle && !plaque && <small>{subtitle}</small>}
              </span>
            </div>
          </Html>
        );
        if (plaque) return <group key={s.key} position={[s.x, 0, s.z]}>{label}</group>;
        return (
          <group key={s.key} position={[s.x, 0, s.z]}>
            <mesh position={[0, 0.02 * k, 0]} scale={k} material={toon('#4a5187')} raycast={() => null}>
              <cylinderGeometry args={[0.35, 0.4, 0.04, 20]} />
            </mesh>
            <mesh position={[0, 0.8 * k, 0]} scale={k} material={toon('#5a6aa8')} raycast={() => null}>
              <boxGeometry args={[0.12, 1.6, 0.12]} />
            </mesh>
            {label}
          </group>
        );
      })}
    </group>
  );
}
