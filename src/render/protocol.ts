// Messages between the UI thread and the render worker.

import type { EffectGraph } from '../graph/types';
import type { EngineStats } from '../gpu/engine';
import type { MotionSnapshot, TouchSnapshot } from '../signals';

export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number }
  | { type: 'frames'; stream: ReadableStream<VideoFrame>; mirror: boolean }
  | { type: 'testSource' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'effect'; graph: EffectGraph }
  | { type: 'param'; slot: number; value: number }
  | { type: 'zoom'; digital: number }
  | { type: 'grade'; mode: 0 | 1 }
  | { type: 'touch'; state: TouchSnapshot }
  | { type: 'motion'; state: MotionSnapshot }
  | { type: 'thumb'; id: string; canvas: OffscreenCanvas; graph: EffectGraph }
  | { type: 'photo' }
  | { type: 'recStart' }
  | { type: 'recStop' };

export interface MacroInfo {
  label: string;
  slot: number;
  min: number;
  max: number;
  value: number;
  /** 0 drag x (A), 1 drag y (B), 2 twist (C). */
  gesture: number;
  /** Params that follow this macro, each over its own range. */
  links?: { slot: number; min: number; max: number }[];
}

export type FromWorker =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'effect'; id: string; macros: MacroInfo[] }
  | { type: 'photo'; blob: Blob }
  | { type: 'recStarted' }
  | { type: 'recStopped'; blob: Blob | null; error?: string }
  | { type: 'stats'; fps: number; stats: EngineStats; source: 'camera' | 'test' };
