// Glyph atlas for LETRA: characters of Martian Mono (the identity's mono face),
// drawn once in the worker and ordered by how much ink each one carries, so a
// brighter cell gets a denser character.

import fontUrl from '@fontsource/martian-mono/files/martian-mono-latin-500-normal.woff2?url';
import dotoUrl from '@fontsource/doto/files/doto-latin-700-normal.woff2?url';

/** Characters the date-back stamp can print, in atlas order. */
export const STAMP_CHARS = " 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZÑ-.:/'";
export const STAMP_W = 40;
export const STAMP_H = 64;

/** The stamp's alphabet in Doto (the identity's dot-matrix face), one row. */
export async function buildStampAtlas(): Promise<OffscreenCanvas> {
  let family = 'monospace';
  try {
    const face = new FontFace('HMC Dot', `url(${dotoUrl})`, { weight: '700' });
    await face.load();
    (self as unknown as { fonts: FontFaceSet }).fonts.add(face);
    family = '"HMC Dot"';
  } catch {
    // generic monospace: the stamp still prints
  }
  const atlas = new OffscreenCanvas(STAMP_W * STAMP_CHARS.length, STAMP_H);
  const ctx = atlas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, atlas.width, atlas.height);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(STAMP_H * 0.85)}px ${family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  [...STAMP_CHARS].forEach((ch, i) => ctx.fillText(ch, i * STAMP_W + STAMP_W / 2, STAMP_H / 2 + 2));
  return atlas;
}

/** Text → atlas indices; anything outside the alphabet becomes a space. */
export function stampCodes(text: string): number[] {
  return [...text.toUpperCase()].map((ch) => Math.max(0, STAMP_CHARS.indexOf(ch)));
}

export const GLYPH_COUNT = 16;
/** Contour strokes after the density ramp, by direction: 0°, 45° down, 90°, 45° up. */
export const STROKE_CHARS = ['-', '\\', '|', '/'];
/** Slots in the atlas row (registry.ts's ascii op divides by this). */
export const GLYPH_SLOTS = GLYPH_COUNT + STROKE_CHARS.length;
export const GLYPH_W = 48;
export const GLYPH_H = 64;

const CANDIDATES = " .,'`:;-_~^=+*<>/|ilrvxzcsoaeunXYZKOQ08#%&@$WMB";

type Ctx = OffscreenCanvasRenderingContext2D;

export async function buildGlyphAtlas(): Promise<OffscreenCanvas> {
  let family = 'monospace';
  try {
    const face = new FontFace('HMC Mono', `url(${fontUrl})`, { weight: '500' });
    await face.load();
    (self as unknown as { fonts: FontFaceSet }).fonts.add(face);
    family = '"HMC Mono"';
  } catch {
    // keep the generic monospace: LETRA still works, just less on-brand
  }

  const draw = (ctx: Ctx, ch: string, x: number) => {
    ctx.fillStyle = '#ffffff';
    ctx.font = `500 ${Math.round(GLYPH_H * 0.8)}px ${family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, x + GLYPH_W / 2, GLYPH_H / 2 + 2);
  };

  // measure each candidate's ink
  const probe = new OffscreenCanvas(GLYPH_W, GLYPH_H);
  const pctx = probe.getContext('2d', { willReadFrequently: true }) as Ctx;
  const measured = [...new Set(CANDIDATES)].map((ch) => {
    pctx.clearRect(0, 0, GLYPH_W, GLYPH_H);
    draw(pctx, ch, 0);
    const data = pctx.getImageData(0, 0, GLYPH_W, GLYPH_H).data;
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) ink += data[i];
    return { ch, ink };
  });
  measured.sort((a, b) => a.ink - b.ink);

  // spread GLYPH_COUNT picks evenly over the density range; the space is first
  const picks: string[] = [];
  for (let i = 0; i < GLYPH_COUNT; i++) {
    const ch = measured[Math.round((i * (measured.length - 1)) / (GLYPH_COUNT - 1))].ch;
    if (!picks.includes(ch)) picks.push(ch);
  }
  while (picks.length < GLYPH_COUNT) picks.push(measured[measured.length - 1].ch);

  const atlas = new OffscreenCanvas(GLYPH_W * GLYPH_SLOTS, GLYPH_H);
  const actx = atlas.getContext('2d') as Ctx;
  actx.fillStyle = '#000000';
  actx.fillRect(0, 0, atlas.width, atlas.height);
  [...picks, ...STROKE_CHARS].forEach((ch, i) => draw(actx, ch, i * GLYPH_W));
  return atlas;
}
