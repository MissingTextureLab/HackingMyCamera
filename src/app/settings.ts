// What the app remembers between sessions: capture settings, the last effect,
// the favourites, the camera and the shutter mode. The revelado grade and the
// capture counter keep their own keys (`hmc.grade`, `hmc.count`).

import type { Facing } from '../io/camera';

export interface Settings {
  /** Long side of the render / camera, in px. */
  side: 960 | 1280 | 1920;
  fps: 30 | 60;
  /** 0 low, 1 medium, 2 high: JPEG quality and video bitrate. */
  quality: 0 | 1 | 2;
  facing: Facing;
  mode: 'photo' | 'video';
  effect: string | null;
  favs: string[];
}

const KEY = 'hmc.settings';
export const DEFAULTS: Settings = { side: 1920, fps: 30, quality: 2, facing: 'environment', mode: 'photo', effect: null, favs: [] };

export const SIDES: { value: Settings['side']; label: string }[] = [
  { value: 960, label: '540P' },
  { value: 1280, label: '720P' },
  { value: 1920, label: '1080P' },
];

/** Camera size for a long side (16:9 request; the browser picks the nearest mode). */
export const cameraSize = (side: number) => ({ width: side, height: Math.round((side * 9) / 16) });

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    const s = { ...DEFAULTS };
    if (raw.side === 960 || raw.side === 1280 || raw.side === 1920) s.side = raw.side;
    if (raw.fps === 30 || raw.fps === 60) s.fps = raw.fps;
    if (raw.quality === 0 || raw.quality === 1 || raw.quality === 2) s.quality = raw.quality;
    if (raw.facing === 'user' || raw.facing === 'environment') s.facing = raw.facing;
    if (raw.mode === 'photo' || raw.mode === 'video') s.mode = raw.mode;
    if (typeof raw.effect === 'string') s.effect = raw.effect;
    if (Array.isArray(raw.favs)) s.favs = raw.favs.filter((f) => typeof f === 'string');
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}
