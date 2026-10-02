import { create } from 'zustand';

export type Theme = 'light' | 'dark';

const KEY = 'cyberverse_theme';

function initialTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export const useTheme = create<{ theme: Theme; toggle: () => void }>((set, get) => ({
  theme: initialTheme(),
  toggle: () => {
    const theme: Theme = get().theme === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(KEY, theme);
    } catch {
    }
    apply(theme);
    set({ theme });
  },
}));

apply(useTheme.getState().theme);

export const SCENE = {
  light: {
    desk: '#f4d3a6',
    chair: '#6f7dd6',
    monitor: '#2b2f55',
    monitorGlow: '#7ee8ff',
    ambientColor: '#dcd8ff',
    ambient: 1.75,
    hemiSky: '#ffffff',
    hemiGround: '#ffd9c2',
    hemi: 0.6,
    sunColor: '#fff2d9',
    sun: 1.0,
  },
  dark: {
    desk: '#8f7f9c',
    chair: '#4a4f96',
    monitor: '#14173a',
    monitorGlow: '#7ee8ff',
    ambientColor: '#8f96ff',
    ambient: 1.6,
    hemiSky: '#a8b8ff',
    hemiGround: '#2a2460',
    hemi: 0.5,
    sunColor: '#cfe0ff',
    sun: 0.9,
  },
} as const;
