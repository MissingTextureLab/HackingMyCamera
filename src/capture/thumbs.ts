// Thumbnails for the gallery grid: a full 1920 px JPEG or an mp4 is far too much
// to decode for a 90 px cell, so each capture is shrunk once (a video to its
// first frame) and the small JPEG is cached for the session. Two at a time, so
// scrolling a long roll never stalls the camera behind it.

import type { Capture } from './store';

export interface Thumb {
  url: string;
  /** seconds, videos only */
  duration?: number;
  /** size of the original */
  width: number;
  height: number;
}

const SIDE = 256;
const cache = new Map<string, Promise<Thumb | null>>();
const urls = new Map<string, string>();

let active = 0;
const waiting: (() => void)[] = [];
function slot(): Promise<void> {
  if (active < 2) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(() => (active++, resolve())));
}
function release() {
  active--;
  waiting.shift()?.();
}

const keyOf = (c: Capture) => `${c.name}:${c.size}:${c.time}`;

export function thumbnail(c: Capture): Promise<Thumb | null> {
  const key = keyOf(c);
  let p = cache.get(key);
  if (!p) {
    p = slot().then(async () => {
      try {
        return await make(c, key);
      } catch {
        return null;
      } finally {
        release();
      }
    });
    cache.set(key, p);
  }
  return p;
}

/** Frees the cached thumbnail of a deleted capture. */
export function forgetThumb(c: Capture) {
  const key = keyOf(c);
  cache.delete(key);
  const url = urls.get(key);
  if (url) URL.revokeObjectURL(url);
  urls.delete(key);
}

async function make(c: Capture, key: string): Promise<Thumb | null> {
  const source = c.video ? await frameOf(c.file) : await bitmapOf(c.file);
  if (!source) return null;
  const { image, width, height, duration } = source;
  // centre-cropped square, like every phone gallery
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIDE;
  const g = canvas.getContext('2d')!;
  const side = Math.min(image.width, image.height);
  g.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, SIDE, SIDE);
  image.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  return { url, duration, width, height };
}

interface Source {
  image: ImageBitmap;
  width: number;
  height: number;
  duration?: number;
}

async function bitmapOf(file: File): Promise<Source | null> {
  // decode straight to a small bitmap when the browser can; the original size is read from the header
  const full = await createImageBitmap(file);
  const { width, height } = full;
  const k = SIDE / Math.min(width, height);
  if (k >= 1) return { image: full, width, height };
  const small = await createImageBitmap(full, { resizeWidth: Math.round(width * k), resizeHeight: Math.round(height * k), resizeQuality: 'medium' });
  full.close();
  return { image: small, width, height };
}

function frameOf(file: File): Promise<Source | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (s: Source | null) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
      resolve(s);
    };
    const timer = setTimeout(() => done(null), 6000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onerror = () => done(null);
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(0.1, (video.duration || 0) / 2);
    };
    // copy the frame out before `done` unloads the element
    video.onseeked = () => {
      const { videoWidth: width, videoHeight: height, duration } = video;
      createImageBitmap(video).then(
        (image) => done({ image, width, height, duration }),
        () => done(null),
      );
    };
    video.src = url;
  });
}
