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
  /** Frames as a transferable stream; null where MediaStreamTrackProcessor is missing (Safari), see `pump`. */
  stream: ReadableStream<VideoFrame> | null;
  /** Fallback without `stream`: calls `onFrame` with a fresh VideoFrame per camera frame. */
  pump(onFrame: (frame: VideoFrame) => void): void;
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
  return !!navigator.mediaDevices?.getUserMedia && typeof VideoFrame === 'function';
}

/** Safari has no MediaStreamTrackProcessor: play the track in a <video> and grab a VideoFrame per frame. */
function pumpVideo(media: MediaStream, onFrame: (frame: VideoFrame) => void) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = media;
  // iOS only decodes a video that is attached and has a size
  video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.append(video);
  let alive = true;
  const tick = () => {
    if (!alive) return;
    if (video.videoWidth > 0) {
      try {
        onFrame(new VideoFrame(video, { timestamp: Math.round(performance.now() * 1000) }));
      } catch (e) {
        console.warn('frame', e);
      }
    }
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  };
  video.play().then(tick, (e) => console.warn('camera play', e));
  return () => {
    alive = false;
    video.pause();
    video.srcObject = null;
    video.remove();
  };
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
  const Processor = (globalThis as { MediaStreamTrackProcessor?: typeof MediaStreamTrackProcessor }).MediaStreamTrackProcessor;
  const processor = Processor ? new Processor<VideoFrame>({ track, maxBufferSize: 2 }) : null;
  let stopPump = () => {};

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
    stream: processor?.readable ?? null,
    pump(onFrame) {
      stopPump = pumpVideo(media, onFrame);
    },
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
    stop() {
      stopPump();
      media.getTracks().forEach((t) => t.stop());
    },
  };
}
