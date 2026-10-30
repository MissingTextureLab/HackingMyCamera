// Camera acquisition on the UI thread. Frames go to the render worker as a
// transferred ReadableStream<VideoFrame>; the worker uploads them to the GPU.

declare class MediaStreamTrackProcessor<T> {
  constructor(init: { track: MediaStreamTrack; maxBufferSize?: number });
  readonly readable: ReadableStream<T>;
}

export type Facing = 'environment' | 'user';

/** Total zoom offered by the pinch gesture; hardware covers what it can, the shader the rest. */
export const MAX_ZOOM = 8;

export interface CameraFeed {
  stream: ReadableStream<VideoFrame>;
  facing: Facing;
  /** Applies a total zoom ≥ 1. Returns the part left for the shader (digital zoom). */
  zoom(total: number): number;
  stop(): void;
}

interface ZoomRange {
  min: number;
  max: number;
}

export function cameraSupported() {
  return !!navigator.mediaDevices?.getUserMedia && typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor === 'function';
}

export async function openCamera(facing: Facing): Promise<CameraFeed> {
  const video: MediaTrackConstraints & { zoom?: boolean } = {
    facingMode: { ideal: facing },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  };
  let media: MediaStream;
  try {
    // `zoom: true` asks for the zoom permission together with the camera.
    media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...video, zoom: true } as MediaTrackConstraints });
  } catch (e) {
    if ((e as Error).name !== 'OverconstrainedError' && (e as Error).name !== 'TypeError') throw e;
    media = await navigator.mediaDevices.getUserMedia({ audio: false, video });
  }
  const track = media.getVideoTracks()[0];
  // Small buffer: drop stale frames rather than queue latency.
  const processor = new MediaStreamTrackProcessor<VideoFrame>({ track, maxBufferSize: 2 });

  const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { zoom?: ZoomRange };
  const hw: ZoomRange | null = caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null;

  // applyConstraints is async and can be slow: keep one in flight, apply the latest after.
  let busy = false;
  let wanted: number | null = null;
  let applied = hw?.min ?? 1;
  const push = () => {
    if (busy || wanted === null || !hw) return;
    const z = wanted;
    wanted = null;
    busy = true;
    track
      .applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] })
      .then(() => (applied = z))
      .catch(() => {})
      .finally(() => {
        busy = false;
        push();
      });
  };

  return {
    stream: processor.readable,
    facing,
    zoom(total) {
      const t = Math.min(MAX_ZOOM, Math.max(1, total));
      if (!hw) return t;
      // hardware zoom is in the camera's own units, starting at hw.min
      const optical = Math.min(hw.max, hw.min * t);
      if (Math.abs(optical - applied) > 0.01) {
        wanted = optical;
        push();
      }
      return t / (optical / hw.min);
    },
    stop: () => media.getTracks().forEach((t) => t.stop()),
  };
}
