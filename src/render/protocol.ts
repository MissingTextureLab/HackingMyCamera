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
  poles: [string, string];
  targets: { slot: number; from: number; to: number }[];
  /** Resting position. */
  at: number;
  /** Current position, 0 (first pole) … 1 (second pole). */
  position: number;
}

export type FromWorker =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'effect'; id: string; macros: MacroInfo[] }
  | { type: 'photo'; blob: Blob }
  | { type: 'recStarted' }
  | { type: 'recStopped'; blob: Blob | null; error?: string }
  | { type: 'stats'; fps: number; stats: EngineStats; source: 'camera' | 'test' };
