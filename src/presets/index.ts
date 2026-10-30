// The gallery: eleven effects, each about one visual question. Names follow
// DESIGN.md (catalogue code + one Spanish word).
// Macros: A = drag x, B = drag y, C = two-finger twist.
// Mods move params on their own (LFO) or with the finger (touch).

import { cam, effect, event, lfo, noise, o, solid, touch } from '../dsl';
import type { EffectGraph } from '../graph/types';

// Print, comic-book style: inked shadows and contours, a fine soft screen on
// textured paper, a colour plate out of register; shooting knocks it apart.
const trama = effect({ id: 'trama', code: '07', name: 'Trama' }, (m) => {
  const r = cam().contrast(1.1).comic(4.5, 8, 1, 1, 0);
  m.macro('REGISTRO', r, 'offset', 0, 64);
  m.macro('PUNTO', r, 'cell', 3, 12);
  m.macro('TINTA', r, 'ink', 0.4, 1.6);
  m.mod(r, 'jolt', event('shot'), 0, 48);
  r.out(0);
});

// Symmetry: two mirrors facing each other. Each reflection sits inside the
// last, mirrored, and every bounce bitcrushes it a little more.
const espejo = effect({ id: 'espejo', code: '12', name: 'Espejo' }, (m) => {
  const a = cam().abyss(o(0), 0.6, 0, 0, 0.4);
  m.macro('TAMAÑO', a, 'scale', 0.35, 0.8);
  m.macro('GIRO', a, 'angle', -0.5, 0.5);
  m.macro('DESGASTE', a, 'crush', 0, 1);
  a.out(0);
});

// Light: painting with light. Only what is bright leaves a trail, like a long
// exposure; move a torch, or the phone, and you draw. The trail keeps its age:
// fresh light is green, old light turns purple and goes up in smoke. Taking a
// photo or starting a recording flashes and wipes it: a new exposure.
const halo = effect({ id: 'halo', code: '14', name: 'Halo' }, (m) => {
  const fresh = cam().thresh(0.82, 0.06);
  const drift = o(1).smoke(1);
  const fade = drift.gain(0.96);
  const wipe = fade.gain(1);
  const trails = wipe.lighten(fresh, 1);
  trails.out(1);
  const glow = trails.aging(0.45).bloom(0.3, 1.2, 10);
  const view = cam().gain(0.7).add(glow, 1).add(solid(1, 1, 1), 0);
  m.macro('ESTELA', fade, 'amount', 0.85, 0.995);
  m.macro('UMBRAL', fresh, 'threshold', 0.95, 0.5);
  m.macro('HUMO', drift, 'amount', 0, 2.5);
  m.mod(wipe, 'amount', event('taken'), 1, 0);
  m.mod(view, 'amount', event('taken'), 0, 0.85);
  view.out(0);
});

// Memory: only what moves is remembered. Still parts stay sharp; moving
// things leave coloured ghosts that flow over a noise relief and fade.
// "Moving" = differs from a background that slowly adapts (o1). The ghosts
// are also datamoshed: dragged in blocks along the real motion, measured
// against the previous camera frame (o3).
const muda = effect({ id: 'muda', code: '19', name: 'Muda' }, (m) => {
  o(1).blend(cam(), 0.06).out(1);
  cam().out(3);
  const moving = cam().diff(o(1)).thresh(0.1, 0.05);
  const ink = cam().citrink(1, 0, 3).mult(moving, 1);
  const relief = noise(2, 0.15);
  const motion = cam().flow(o(3));
  const flow = o(2).displace(relief, 6).mosh(motion, 1.5, 16);
  const fade = flow.gain(0.96);
  const ghosts = fade.lighten(ink, 1);
  ghosts.out(2);
  m.macro('MEMORIA', fade, 'amount', 0.8, 0.99);
  m.macro('ARRASTRE', flow, 'drag', 0, 4);
  m.macro('SENSIBILIDAD', moving, 'threshold', 0.3, 0.02);
  m.mod(relief, 'speed', lfo('sine', 0.05), 0.05, 0.4);
  cam().lighten(ghosts, 1).out(0);
});

// Time: slit-scan on a horizontal line. Each row is an earlier moment, and
// each one a worse copy of the last: the further from the line, the more worn.
const barrido = effect({ id: 'barrido', code: '22', name: 'Barrido' }, (m) => {
  const s = o(0).slit(cam(), 2, 0.72, 0, 0.4);
  // slow and clean → fast and broken (speed 2 at the resting wear 0.4)
  m.macro('GASTO', s, 'wear', 0, 1, [[s, 'speed', 0.5, 4.25]]);
  // the line follows the finger up and down (B is inverted y)
  m.macro('LÍNEA', s, 'line', 0.95, 0.05);
  s.out(0);
});

// Type: the image written in Martian Mono, the identity's own face. Big
// letters where the image is calm, small ones where it is busy; contours are
// drawn with strokes that follow them. The light letters glow.
const letra = effect({ id: 'letra', code: '31', name: 'Letra' }, (m) => {
  const a = cam().ascii(10, 1.3, 0.22, 0.12);
  m.macro('CUERPO', a, 'cell', 5, 22);
  m.macro('TRAZOS', a, 'stroke', 0.8, 0.06);
  m.macro('DETALLE', a, 'split', 0.6, 0.03);
  a.bloom(0.5, 1.1, 10).out(0);
});

// Signal: analogue video. Touch the image and the sync goes.
const senal = effect({ id: 'senal', code: '44', name: 'Señal' }, (m) => {
  const v = cam().vhs(0.5, 0.6, 1.2, 0);
  m.macro('TRACKING', v, 'tracking', 0, 1.5);
  m.macro('SANGRADO', v, 'bleed', 0, 4);
  m.macro('RUIDO', v, 'noise', 0, 1.5);
  m.mod(v, 'desync', touch('down'), 0, 1, { smooth: 0.85 });
  v.out(0);
});

// Glitch: real pixel sorting. Each column's runs of mid-to-bright pixels are
// sorted by brightness, on the GPU.
const orden = effect({ id: 'orden', code: '50', name: 'Orden' }, (m) => {
  const s = cam().sort(0.35, 1, 0);
  m.macro('UMBRAL', s, 'low', 0.9, 0.05);
  m.macro('TECHO', s, 'high', 0.4, 1);
  m.macro('SENTIDO', s, 'dir', 0, 1);
  s.out(0);
});

/* ---------- 3D: a fixed, composed framing with a slow sway so the volume reads ---------- */

// Relief: the image as terrain, drawn as ridge lines with hidden lines removed.
// Low and frontal, like the Unknown Pleasures cover.
const relieve = effect({ id: 'relieve', code: '60', name: 'Relieve' }, (m) => {
  const r = cam().blur(3).relief(0.5, 0, 0.3, 3, 1.6, 60);
  m.macro('ALTURA', r, 'height', 0, 1.2);
  m.macro('LÍNEAS', r, 'rows', 12, 140);
  m.macro('TRAZO', r, 'thickness', 0.5, 5);
  m.mod(r, 'yaw', lfo('sine', 0.03), -0.08, 0.08);
  r.out(0);
});

// Mass: a city of blocks, as tall as the image is bright. Isometric.
const ciudad = effect({ id: 'ciudad', code: '66', name: 'Ciudad' }, (m) => {
  const c = cam().blur(6).city(0.8, 0.785, 0.6155, 1.7, 0.15);
  m.macro('ALTURA', c, 'height', 0, 2);
  m.macro('ZOOM', c, 'zoom', 3, 0.8);
  m.macro('CALLES', c, 'gap', 0, 0.6);
  m.mod(c, 'yaw', lfo('sine', 0.02), 0.72, 0.85);
  c.out(0);
});

// Carving: the image as a textured relief seen almost head-on; bright parts
// come forward, sharp contrasts become walls and spikes, lights get a halo.
const talla = effect({ id: 'talla', code: '69', name: 'Talla' }, (m) => {
  const t = cam().contrast(1.15).carve(0.6, -0.18, 0.12, 4.2, 1, 1);
  const glow = t.bloom(0.75, 0.9, 10);
  m.macro('PROFUNDIDAD', t, 'depth', 0, 1.6);
  m.macro('ÁNGULO', t, 'yaw', -0.8, 0.8);
  m.macro('AFILADO', t, 'sharp', 0.4, 3);
  m.mod(t, 'pitch', lfo('sine', 0.03), 0.05, 0.2);
  glow.out(0);
});

export const PRESETS: EffectGraph[] = [trama, espejo, halo, muda, barrido, letra, senal, orden, relieve, ciudad, talla];
