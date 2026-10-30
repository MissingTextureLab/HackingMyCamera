// The gallery: ten effects, each about one visual question. Names follow
// DESIGN.md (catalogue code + one Spanish word).
// Macros: A = drag x, B = drag y, C = two-finger twist.
// Mods move params on their own (LFO) or with the finger (touch).

import { cam, effect, lfo, noise, o, osc, touch } from '../dsl';
import type { EffectGraph } from '../graph/types';

// Optics: what a cheap lens does to light. Barrel, chromatic fringes, vignette.
const lente = effect({ id: 'lente', code: '01', name: 'Lente' }, (m) => {
  const l = cam().lens(2.8, 0.5, 0.65);
  m.macro('ABERRACIÓN', l, 'aberration', 0, 6);
  m.macro('CURVA', l, 'barrel', -0.5, 1.2);
  m.macro('VIÑETA', l, 'vignette', 0, 1);
  l.out(0);
});

// Print: two-ink halftone, out of register.
const trama = effect({ id: 'trama', code: '07', name: 'Trama' }, (m) => {
  const r = cam().contrast(1.15).riso(3, 7, 1.1);
  m.macro('REGISTRO', r, 'offset', 0, 14);
  m.macro('PUNTO', r, 'cell', 3, 18);
  m.macro('TINTA', r, 'gain', 0.6, 1.8);
  r.out(0);
});

// Symmetry: a mandala that turns slowly by itself.
const espejo = effect({ id: 'espejo', code: '12', name: 'Espejo' }, (m) => {
  const rot = cam().rotate(0);
  const k = rot.kaleid(6);
  const w = k.modulateRotate(osc(2, 0.04), 0.3);
  const c = w.citrink(0.8, 0.5, 2, 2);
  m.macro('LADOS', k, 'sides', 2, 12);
  m.macro('GIRO', w, 'multiple', 0, 2);
  m.macro('CICLO', c, 'cycle', 0, 7);
  m.mod(rot, 'angle', lfo('sine', 0.03), -0.6, 0.6);
  c.out(0);
});

// Light: only the bright parts bleed, and the glow breathes.
const halo = effect({ id: 'halo', code: '14', name: 'Halo' }, (m) => {
  const b = cam().contrast(1.15).bloom(0.55, 1.4, 10);
  const c = b.citrink(0.35);
  m.macro('UMBRAL', b, 'threshold', 0.9, 0.2);
  m.macro('BRILLO', b, 'intensity', 0.2, 3);
  m.macro('COLOR', c, 'amount', 0, 1);
  m.mod(b, 'radius', lfo('tri', 0.2), 6, 14, { smooth: 0.9 });
  c.out(0);
});

// Memory: TouchDesigner feedback. The last frame flows over a noise relief and
// slowly absorbs the camera.
const muda = effect({ id: 'muda', code: '19', name: 'Muda' }, (m) => {
  const relief = noise(2, 0.15);
  const flow = o(0).displace(relief, 6);
  const mix = flow.blend(cam().citrink(1, 0, 3), 0.1);
  m.macro('MEMORIA', mix, 'amount', 0.4, 0.02);
  m.macro('FLUJO', flow, 'amount', 0, 20);
  m.macro('ESCALA', relief, 'scale', 0.5, 6);
  m.mod(relief, 'speed', lfo('sine', 0.05), 0.05, 0.4);
  mix.out(0);
});

// Time: slit-scan. Each row above the line is an earlier moment.
const barrido = effect({ id: 'barrido', code: '22', name: 'Barrido' }, (m) => {
  const s = o(0).slit(cam(), 2, 0.72);
  m.macro('VELOCIDAD', s, 'speed', 0.5, 10);
  m.macro('LÍNEA', s, 'line', 0.2, 0.95);
  s.out(0);
});

// Type: the image written in characters.
const letra = effect({ id: 'letra', code: '31', name: 'Letra' }, (m) => {
  const a = cam().ascii(10, 1.3);
  m.macro('CUERPO', a, 'cell', 6, 28);
  m.macro('CONTRASTE', a, 'contrast', 0.6, 2.6);
  a.out(0);
});

// Tessellation: stained glass, the cells drifting.
const vitral = effect({ id: 'vitral', code: '36', name: 'Vitral' }, (m) => {
  const v = cam().vitral(14, 0.08, 0.6);
  m.macro('TESELAS', v, 'scale', 4, 40);
  m.macro('PLOMO', v, 'border', 0.01, 0.3);
  m.macro('DERIVA', v, 'jitter', 0, 1);
  v.out(0);
});

// Signal: analogue video. Touching the image interferes with the signal.
const senal = effect({ id: 'senal', code: '44', name: 'Señal' }, (m) => {
  const v = cam().vhs(0.5, 0.6, 1.2);
  m.macro('TRACKING', v, 'tracking', 0, 1.5);
  m.macro('SANGRADO', v, 'bleed', 0, 4);
  m.mod(v, 'noise', touch('down'), 0.4, 1.6, { smooth: 0.85 });
  v.out(0);
});

// Glitch: pixel sorting, bright runs melting along an angle.
const orden = effect({ id: 'orden', code: '50', name: 'Orden' }, (m) => {
  const s = cam().sort(0.55, 220, 0);
  m.macro('UMBRAL', s, 'threshold', 0.95, 0.2);
  m.macro('ALCANCE', s, 'reach', 20, 700);
  m.macro('ÁNGULO', s, 'angle', -1.57, 1.57);
  s.out(0);
});

export const PRESETS: EffectGraph[] = [lente, trama, espejo, halo, muda, barrido, letra, vitral, senal, orden];
