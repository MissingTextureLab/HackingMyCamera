// The gallery: fourteen effects, each about one visual question. Names follow
// DESIGN.md (catalogue code + one Spanish word).
//
// Gestures travel between two named characters (poles), never from "off" to
// "full": A = drag x, B = drag y (up = second pole), C = two-finger twist.
// Each axis moves several params at once; `at` is where it rests.
// Mods move params on their own (LFO), with the finger (touch) or on a shot.

import { cam, effect, event, lfo, noise, o, touch } from '../dsl';
import type { EffectGraph } from '../graph/types';

// Optics: a cinema lens. Bright spots bleed long horizontal streaks; the
// glass bends and fringes at the edges.
const lente = effect({ id: 'lente', code: '01', name: 'Lente' }, (m) => {
  const l = cam().lens(1.5, 0.3, 0.45);
  const f = l.flare(0.8, 500, 1.2);
  m.macro(['LIMPIA', 'CINE'], [
    [f, 'intensity', 0.4, 2.4],
    [f, 'reach', 150, 1100],
    [l, 'aberration', 0.5, 3],
  ]);
  m.macro(['BURBUJA', 'PLANA'], [
    [l, 'barrel', 1.1, -0.1],
    [l, 'vignette', 0.85, 0.2],
  ]);
  m.macro(['TODO', 'SOLO LUCES'], [[f, 'threshold', 0.55, 0.95]]);
  f.out(0);
});

// Print: two-ink halftone, out of register; shooting knocks the plates apart.
const trama = effect({ id: 'trama', code: '07', name: 'Trama' }, (m) => {
  const c = cam().contrast(1.15);
  const r = c.riso(3, 7, 1.1, 0, 0, 0);
  m.macro(['PERIÓDICO', 'CARTEL'], [
    [r, 'cell', 4, 16],
    [r, 'offset', 1, 12],
    [r, 'gain', 1, 1.4],
  ]);
  m.macro(['PUNTO', 'CRUZ'], [[r, 'screen', 0, 2.99]], 0);
  m.macro(['PÁLIDA', 'ENTINTADA'], [[c, 'amount', 0.9, 1.5]]);
  m.mod(r, 'jolt', event('shot'), 0, 18);
  r.out(0);
});

// Symmetry: two mirrors facing each other. Each reflection sits inside the
// last, mirrored, with an acid frame.
const espejo = effect({ id: 'espejo', code: '12', name: 'Espejo' }, (m) => {
  const a = cam().abyss(o(0), 0.78, 0, 0);
  m.macro(['PASILLO', 'ABISMO'], [[a, 'scale', 0.9, 0.6]]);
  m.macro(['RECTO', 'ESPIRAL'], [[a, 'angle', 0, 0.45]], 0.3);
  m.macro(['IZQUIERDA', 'DERECHA'], [[a, 'shift', -0.22, 0.22]]);
  a.out(0);
});

// Light: painting with light. Only what is bright leaves a trail, like a long
// exposure; move a torch, or the phone, and you draw.
const halo = effect({ id: 'halo', code: '14', name: 'Halo' }, (m) => {
  const mask = cam().thresh(0.82, 0.06);
  const lights = cam().mult(mask, 1);
  const fade = o(1).gain(0.96);
  const trails = fade.lighten(lights, 1);
  trails.out(1);
  const glow = trails.bloom(0.3, 1.2, 10);
  m.macro(['VELA', 'NEÓN'], [
    [fade, 'amount', 0.9, 0.99],
    [glow, 'intensity', 0.6, 2.4],
  ]);
  m.macro(['NIEBLA', 'ESTRELLA'], [
    [glow, 'radius', 18, 4],
    [mask, 'threshold', 0.6, 0.92],
  ]);
  cam().gain(0.7).add(glow, 1).out(0);
});

// Memory: only what moves is remembered. Still parts stay sharp; moving
// things leave coloured ghosts that flow over a noise relief and fade.
// "Moving" = differs from a background that slowly adapts (o1).
const muda = effect({ id: 'muda', code: '19', name: 'Muda' }, (m) => {
  const bg = o(1).blend(cam(), 0.06);
  bg.out(1);
  const moving = cam().diff(o(1)).thresh(0.1, 0.05);
  const ink = cam().citrink(1, 0, 3).mult(moving, 1);
  const relief = noise(2, 0.15);
  const flow = o(2).displace(relief, 6);
  const fade = flow.gain(0.96);
  const ghosts = fade.lighten(ink, 1);
  ghosts.out(2);
  m.macro(['BRISA', 'RIADA'], [
    [fade, 'amount', 0.9, 0.985],
    [flow, 'amount', 2, 18],
  ]);
  m.macro(['TODO', 'LO QUE CORRE'], [
    [moving, 'threshold', 0.03, 0.25],
    [bg, 'amount', 0.02, 0.15],
  ]);
  m.macro(['GRANDE', 'MENUDO'], [[relief, 'scale', 0.8, 6]]);
  m.mod(relief, 'speed', lfo('sine', 0.05), 0.05, 0.4);
  cam().lighten(ghosts, 1).out(0);
});

// Time: slit-scan. Each row (or column, or ring) is an earlier moment.
const barrido = effect({ id: 'barrido', code: '22', name: 'Barrido' }, (m) => {
  const s = o(0).slit(cam(), 2, 0.72, 0);
  m.macro(['LENTO', 'RÁPIDO'], [[s, 'speed', 0.6, 9]], 0.3);
  m.macro(['ABAJO', 'ARRIBA'], [[s, 'line', 0.9, 0.25]], 0.3);
  m.macro(['HORIZONTAL', 'RADIAL'], [[s, 'shape', 0, 2.99]], 0);
  s.out(0);
});

// Type: the image written in Martian Mono, the identity's own face.
const letra = effect({ id: 'letra', code: '31', name: 'Letra' }, (m) => {
  const a = cam().ascii(12, 1.3);
  m.macro(['MINÚSCULA', 'TITULAR'], [[a, 'cell', 6, 30]], 0.25);
  m.macro(['SUAVE', 'DURA'], [[a, 'contrast', 0.7, 2.6]]);
  a.out(0);
});

// Tessellation: stained glass, fine where the image is busy.
const vitral = effect({ id: 'vitral', code: '36', name: 'Vitral' }, (m) => {
  const v = cam().vitral(10, 0.08, 0.5, 0.6);
  m.macro(['CATEDRAL', 'MOSAICO'], [
    [v, 'scale', 5, 28],
    [v, 'border', 0.14, 0.05],
  ], 0.35);
  m.macro(['REGULAR', 'ORGÁNICO'], [
    [v, 'detail', 0.1, 0.9],
    [v, 'jitter', 0.2, 0.9],
  ]);
  v.out(0);
});

// Signal: analogue video. Touch the image and the sync goes.
const senal = effect({ id: 'senal', code: '44', name: 'Señal' }, (m) => {
  const v = cam().vhs(0.5, 0.6, 1.2, 0);
  m.macro(['NUEVA', 'GASTADA'], [
    [v, 'tracking', 0.1, 1.3],
    [v, 'noise', 0.2, 1.3],
  ], 0.4);
  m.macro(['NÍTIDA', 'SANGRANTE'], [[v, 'bleed', 0.3, 4]], 0.3);
  m.mod(v, 'desync', touch('down'), 0, 1, { smooth: 0.85 });
  v.out(0);
});

// Glitch: real pixel sorting. Each column's runs of mid-to-bright pixels are
// sorted by brightness, on the GPU.
const orden = effect({ id: 'orden', code: '50', name: 'Orden' }, (m) => {
  const s = cam().sort(0.35, 1, 0);
  m.macro(['CHISPAS', 'CASCADA'], [[s, 'low', 0.85, 0.1]]);
  m.macro(['SUBE', 'BAJA'], [[s, 'dir', 0, 1]], 0);
  m.macro(['SIN LUCES', 'CON LUCES'], [[s, 'high', 0.6, 1]], 1);
  s.out(0);
});

/* ---------- 3D: a fixed, composed framing with a slow sway so the volume reads ---------- */

// Relief: the image as terrain, drawn as ridge lines with hidden lines removed.
// Low and frontal, like the Unknown Pleasures cover.
const relieve = effect({ id: 'relieve', code: '60', name: 'Relieve' }, (m) => {
  const r = cam().blur(3).relief(0.5, 0, 0.3, 3, 1.6, 60);
  m.macro(['LLANURA', 'CORDILLERA'], [
    [r, 'height', 0.15, 1.1],
    [r, 'pitch', 0.22, 0.45],
  ], 0.4);
  m.macro(['FINO', 'GRUESO'], [
    [r, 'rows', 140, 18],
    [r, 'thickness', 1, 3.5],
  ]);
  m.mod(r, 'yaw', lfo('sine', 0.03), -0.08, 0.08);
  r.out(0);
});

// Volume: the camera as a cloud of points, seen three-quarters, drifting.
const nube = effect({ id: 'nube', code: '63', name: 'Nube' }, (m) => {
  const c = cam().cloud(0.9, 3, 0.5, 0.18, 2.7, 0.05);
  m.macro(['POLVO', 'CONFETI'], [[c, 'size', 1.5, 8]], 0.3);
  m.macro(['PLANA', 'HONDA'], [[c, 'depth', 0.2, 2.4]], 0.35);
  m.macro(['QUIETA', 'ENJAMBRE'], [[c, 'drift', 0, 0.3]], 0.2);
  m.mod(c, 'yaw', lfo('sine', 0.025), 0.42, 0.58);
  c.out(0);
});

// Mass: a city of blocks, as tall as the image is bright. Isometric.
const ciudad = effect({ id: 'ciudad', code: '66', name: 'Ciudad' }, (m) => {
  const c = cam().blur(6).city(0.8, 0.785, 0.6155, 1.7, 0.15);
  m.macro(['PUEBLO', 'METRÓPOLIS'], [
    [c, 'height', 0.3, 2],
    [c, 'gap', 0.35, 0.05],
  ], 0.4);
  m.macro(['MAQUETA', 'CALLE'], [[c, 'zoom', 3, 0.9]], 0.4);
  m.mod(c, 'yaw', lfo('sine', 0.02), 0.72, 0.85);
  c.out(0);
});

// Carving: the image as a textured relief seen almost head-on; bright parts
// come forward, sharp contrasts become walls and spikes, lights get a halo.
const talla = effect({ id: 'talla', code: '69', name: 'Talla' }, (m) => {
  const t = cam().contrast(1.15).carve(0.6, -0.18, 0.12, 4.2, 1, 1);
  const glow = t.bloom(0.75, 0.9, 10);
  m.macro(['BAJORRELIEVE', 'PÚAS'], [
    [t, 'depth', 0.2, 1.3],
    [t, 'sharp', 0.6, 2.2],
  ], 0.35);
  m.macro(['FRENTE', 'PERFIL'], [[t, 'yaw', -0.05, -0.75]], 0.2);
  m.macro(['MATE', 'BRILLO'], [
    [glow, 'intensity', 0.2, 1.8],
    [glow, 'threshold', 0.85, 0.6],
  ], 0.4);
  m.mod(t, 'pitch', lfo('sine', 0.03), 0.05, 0.2);
  glow.out(0);
});

export const PRESETS: EffectGraph[] = [lente, trama, espejo, halo, muda, barrido, letra, vitral, senal, orden, relieve, nube, ciudad, talla];
