// Glyph atlas for LETRA: characters of Martian Mono (the identity's mono face),
// drawn once in the worker and ordered by how much ink each one carries, so a
// brighter cell gets a denser character.

import fontUrl from '@fontsource/martian-mono/files/martian-mono-latin-500-normal.woff2?url';

export const GLYPH_COUNT = 16;
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

  const atlas = new OffscreenCanvas(GLYPH_W * GLYPH_COUNT, GLYPH_H);
  const actx = atlas.getContext('2d') as Ctx;
  actx.fillStyle = '#000000';
  actx.fillRect(0, 0, atlas.width, atlas.height);
  picks.forEach((ch, i) => draw(actx, ch, i * GLYPH_W));
  return atlas;
}
