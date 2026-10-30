// The effect format shared by presets, the DSL, the editor (H5) and saved files.
// See PLAN.md §2.

export type OutputId = 'o0' | 'o1' | 'o2' | 'o3';
export const OUTPUTS: readonly OutputId[] = ['o0', 'o1', 'o2', 'o3'];

export interface NodeSpec {
  op: string;
  in?: string[];
  params?: Record<string, number>;
}

export interface Macro {
  label: string;
  /** "<nodeId>.<param>" */
  target: string;
  range: [number, number];
  /** Params that follow the same gesture, each over its own range. */
  links?: { target: string; range: [number, number] }[];
}

export type LfoShape = 'sine' | 'tri' | 'saw' | 'square' | 'random' | 'noise';
export type TouchChannel = 'x' | 'y' | 'down' | 'vx' | 'vy' | 'count' | 'pinch';
/** Phone tilt relative to how it was held when the effect started: x = left/right, y = forward/back. */
export type MotionChannel = 'x' | 'y';
/** Pulses: 1 at the event, fading to 0 within 0.6 s. 'shot' = photo or start of recording. */
/** shot: as a photo / recording is taken (it shows in it); taken: right after (it doesn't). */
export type EventChannel = 'shot' | 'taken';

/** A signal normalized to 0…1 (see src/signals). */
export type SignalSource =
  | { kind: 'lfo'; shape: LfoShape; /** Hz */ rate: number; phase?: number }
  | { kind: 'touch'; channel: TouchChannel }
  | { kind: 'motion'; channel: MotionChannel }
  | { kind: 'event'; channel: EventChannel };

/** Drives one param from a signal every frame. */
export interface Mod {
  /** "<nodeId>.<param>" */
  target: string;
  source: SignalSource;
  range: [number, number];
  /** 0 = follow instantly … 0.99 = very slow (one-pole, per 60 fps frame). */
  smooth?: number;
  /** Round the result to multiples of this. */
  quantize?: number;
}

export interface EffectGraph {
  id: string;
  /** Catalogue number shown in the UI: FX-<code>. */
  code: string;
  /** One word, shown in caps. */
  name: string;
  version: 1;
  nodes: Record<string, NodeSpec>;
  outputs: Partial<Record<OutputId, string>>;
  display: OutputId;
  macros: Macro[];
  mods: Mod[];
}
