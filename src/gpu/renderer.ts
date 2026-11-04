// What the render worker needs from a backend: WebGPU (engine.ts) or WebGL2 (gl-engine.ts).

import type { CompiledEffect } from '../graph/compile';
import type { EffectGraph } from '../graph/types';
import type { EngineStats } from './engine';

export interface Renderer {
  readonly canvas: OffscreenCanvas;
  /** 'core' / 'compat': WebGPU (compat = over OpenGL ES); 'gl': WebGL2, 2D effects only. */
  readonly mode: 'core' | 'compat' | 'gl';
  /** Processors (compute, e.g. sort) fit this device. */
  readonly compute: boolean;
  /** The viewfinder surface: date-back stamp for captures, the xerox flash on effect change. */
  readonly main: { stamp: boolean; xeroxFrames: number; setStampText(text: string): void };
  onError: (message: string) => void;

  resize(width: number, height: number): void;
  uploadFrame(frame: VideoFrame, mirror: boolean): void;
  setTestCamFps(fps: number): void;
  renderTestCard(time: number): void;
  setEffect(graph: EffectGraph): Promise<CompiledEffect>;
  addThumb(id: string, canvas: OffscreenCanvas, graph: EffectGraph): Promise<void>;
  setParam(slot: number, value: number): void;
  setGrade(mode: number): void;
  setZoom(zoom: number): void;
  render(time: number, dt: number): void;
  stats(): EngineStats;
}
