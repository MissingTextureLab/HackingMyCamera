// Messages between the UI thread and the render worker.

import type { EffectGraph } from '../graph/types';
import type { EngineStats } from '../gpu/engine';

export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number }
  | { type: 'frames'; stream: ReadableStream<VideoFrame>; mirror: boolean }
  | { type: 'testSource' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'effect'; graph: EffectGraph }
  | { type: 'warm'; graphs: EffectGraph[] }
  | { type: 'param'; slot: number; value: number }
  | { type: 'photo' }
  | { type: 'recStart' }
  | { type: 'recStop' };

export interface MacroInfo {
  label: string;
  slot: number;
  min: number;
  max: number;
  value: number;
}

export type FromWorker =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'effect'; id: string; macros: MacroInfo[] }
  | { type: 'photo'; blob: Blob }
  | { type: 'recStarted' }
  | { type: 'recStopped'; blob: Blob | null; error?: string }
  | { type: 'stats'; fps: number; stats: EngineStats; source: 'camera' | 'test' };
