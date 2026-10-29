// Camera acquisition on the UI thread. Frames go to the render worker as a
// transferred ReadableStream<VideoFrame>; the worker uploads them to the GPU.

declare class MediaStreamTrackProcessor<T> {
  constructor(init: { track: MediaStreamTrack; maxBufferSize?: number });
  readonly readable: ReadableStream<T>;
}

export type Facing = 'environment' | 'user';

export interface CameraFeed {
  stream: ReadableStream<VideoFrame>;
  facing: Facing;
  stop(): void;
}

export function cameraSupported() {
  return !!navigator.mediaDevices?.getUserMedia && typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor === 'function';
}

export async function openCamera(facing: Facing): Promise<CameraFeed> {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
  });
  const track = media.getVideoTracks()[0];
  // Small buffer: drop stale frames rather than queue latency.
  const processor = new MediaStreamTrackProcessor<VideoFrame>({ track, maxBufferSize: 2 });
  return {
    stream: processor.readable,
    facing,
    stop: () => media.getTracks().forEach((t) => t.stop()),
  };
}
