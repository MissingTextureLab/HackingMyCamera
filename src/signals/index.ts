// Modulation signals (the CHOP side of TouchDesigner). Runs in the render
// worker: every frame each Mod reads a source normalized to 0…1, maps it to
// its range and writes the param's uniform. No allocation per frame.

import type { EventChannel, LfoShape, Mod, SignalSource, TouchChannel } from '../graph/types';

export interface TouchSnapshot {
  down: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  count: number;
  pinch: number;
}

const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export function lfo(shape: LfoShape, phase01: number, cycle: number): number {
  const p = phase01 - Math.floor(phase01);
  switch (shape) {
    case 'sine':
      return 0.5 - 0.5 * Math.cos(p * 2 * Math.PI);
    case 'tri':
      return 1 - Math.abs(2 * p - 1);
    case 'saw':
      return p;
    case 'square':
      return p < 0.5 ? 0 : 1;
    case 'random':
      return hash(cycle);
    case 'noise': {
      // smooth value noise between per-cycle random points
      const a = hash(cycle);
      const b = hash(cycle + 1);
      const t = p * p * (3 - 2 * p);
      return a + (b - a) * t;
    }
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Raw touch channels → 0…1. Velocities are signed: 0.5 is still. */
export function touchValue(t: TouchSnapshot, ch: TouchChannel): number {
  switch (ch) {
    case 'x':
      return clamp01(t.x);
    case 'y':
      return clamp01(1 - t.y);
    case 'down':
      return t.down;
    case 'vx':
      return clamp01(0.5 + t.vx / 8);
    case 'vy':
      return clamp01(0.5 - t.vy / 8);
    case 'count':
      return clamp01(t.count / 2);
    case 'pinch':
      return clamp01((t.pinch - 0.5) / 2);
  }
}

/** Tilt in degrees from the reference pose; 0.5 is level, ±TILT_RANGE reaches 0 / 1. */
export interface MotionSnapshot {
  x: number;
  y: number;
}
export const TILT_RANGE = 25;

/** How long an event pulse lasts, in seconds. */
export const EVENT_DECAY = 0.6;

export function eventValue(at: number | undefined, time: number): number {
  if (at === undefined) return 0;
  const k = clamp01(1 - (time - at) / EVENT_DECAY);
  return k * k;
}

export function sourceValue(
  src: SignalSource,
  time: number,
  touch: TouchSnapshot,
  motion: MotionSnapshot = { x: 0, y: 0 },
  events: Partial<Record<EventChannel, number>> = {},
): number {
  if (src.kind === 'touch') return touchValue(touch, src.channel);
  if (src.kind === 'event') return eventValue(events[src.channel], time);
  if (src.kind === 'motion') return clamp01(0.5 + motion[src.channel] / (2 * TILT_RANGE));
  const cycles = time * src.rate + (src.phase ?? 0);
  return lfo(src.shape, cycles, Math.floor(cycles));
}

interface Bound {
  mod: Mod;
  slot: number;
  value: number;
}

export class Signals {
  private bound: Bound[] = [];
  readonly touch: TouchSnapshot = { down: 0, x: 0.5, y: 0.5, vx: 0, vy: 0, count: 0, pinch: 1 };
  readonly motion: MotionSnapshot = { x: 0, y: 0 };

  /** When each event last fired, in signal time (seconds). */
  readonly events: Partial<Record<EventChannel, number>> = {};

  trigger(channel: EventChannel, time: number) {
    this.events[channel] = time;
  }

  setMotion(m: MotionSnapshot) {
    this.motion.x = m.x;
    this.motion.y = m.y;
  }

  /** Binds an effect's mods to their uniform slots. Initial values seed the smoothing. */
  bind(mods: Mod[], slots: Record<string, number>, values: Float32Array) {
    this.bound = mods.map((mod) => {
      const slot = slots[mod.target];
      if (slot === undefined) throw new Error(`mod ${mod.target}: not a uniform param`);
      return { mod, slot, value: values[slot] };
    });
  }

  setTouch(t: TouchSnapshot) {
    Object.assign(this.touch, t);
  }

  /** Computes every mod for this frame and hands (slot, value) to `write`. */
  update(time: number, dt: number, write: (slot: number, value: number) => void) {
    for (const b of this.bound) {
      const { mod } = b;
      const v = sourceValue(mod.source, time, this.touch, this.motion, this.events);
      let target = mod.range[0] + (mod.range[1] - mod.range[0]) * v;
      const smooth = mod.smooth ?? 0;
      // frame-rate independent one-pole: `smooth` is the per-frame factor at 60 fps
      const keep = smooth > 0 ? Math.pow(smooth, dt * 60) : 0;
      b.value = b.value * keep + target * (1 - keep);
      target = b.value;
      if (mod.quantize) target = Math.round(target / mod.quantize) * mod.quantize;
      write(b.slot, target);
    }
  }
}
