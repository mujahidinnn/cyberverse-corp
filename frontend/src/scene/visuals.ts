import * as THREE from 'three';
import type { AgentStatus } from '../store/officeStore';

export const DIVISION_COLOR: Record<string, string> = {
  executive: '#f59e0b',
  engineering: '#3b82f6',
  creative: '#ec4899',
  marketing: '#22c55e',
  operations: '#a855f7',
};

export const STATUS_RING: Partial<Record<AgentStatus, string>> = {
  THINKING: '#fbbf24',
  QUEUED: '#94a3b8',
  WORKING: '#22c55e',
  WAITING_APPROVAL: '#ef4444',
  TALKING: '#f8fafc',
  ERROR: '#b91c1c',
  MEETING: '#38bdf8',
};

const EMOJI: Record<string, string> = {
  thought: '💭', zzz: '💤', hourglass: '⏳', check: '✅', cross: '❌', sweat: '💦', anger: '💢', idea: '💡',
  sparkle: '✨', thunder_blue: '⚡', heart: '❤️', music: '🎵', question: '❓', exclaim: '❗', satellite: '📡', coin: '🪙',
};

const steps = new Uint8Array([115, 190, 255]);
export const toonGradient = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
toonGradient.minFilter = THREE.NearestFilter;
toonGradient.magFilter = THREE.NearestFilter;
toonGradient.needsUpdate = true;

const emojiCache = new Map<string, THREE.CanvasTexture>();

export function emojiTexture(icon: string): THREE.CanvasTexture | null {
  const ch = EMOJI[icon];
  if (!ch) return null;
  let tex = emojiCache.get(icon);
  if (!tex) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(253, 255, 248, 0.97)';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(32, 32, 29, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.font = '38px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, 32, 35);
    tex = new THREE.CanvasTexture(c);
    emojiCache.set(icon, tex);
  }
  return tex;
}

const toonMaterials = new Map<string, THREE.MeshToonMaterial>();
export function toon(color: string): THREE.MeshToonMaterial {
  let m = toonMaterials.get(color);
  if (!m) {
    m = new THREE.MeshToonMaterial({ color, gradientMap: toonGradient });
    toonMaterials.set(color, m);
  }
  return m;
}
