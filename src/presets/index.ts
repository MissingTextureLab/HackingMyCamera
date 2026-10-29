// Gallery presets. Names follow DESIGN.md: a catalogue code and one Spanish word.

import { cam, effect, noise, o, osc } from '../dsl';
import type { EffectGraph } from '../graph/types';

const crudo = effect({ id: 'crudo', code: '01', name: 'Crudo' }, (m) => {
  const c = cam().contrast(1.05);
  m.macro('CONTRASTE', c, 'amount', 0.6, 2.2);
  c.out(0);
});

const trama = effect({ id: 'trama', code: '07', name: 'Trama' }, (m) => {
  const t = cam().contrast(1.2).citrink(1, 1, 0, 3);
  m.macro('GRANO', t, 'scale', 1, 10);
  m.macro('CICLO', t, 'cycle', 0, 7);
  t.out(0);
});

const espejo = effect({ id: 'espejo', code: '12', name: 'Espejo' }, (m) => {
  const k = cam().kaleid(4);
  const r = k.modulateRotate(osc(3, 0.05), 0.4);
  m.macro('LADOS', k, 'sides', 2, 12);
  m.macro('GIRO', r, 'multiple', 0, 2);
  r.citrink(0.85, 0.6, 2, 2).out(0);
});

// Feedback: the previous frame, slightly zoomed and pushed by noise, slowly
// absorbs the camera.
const muda = effect({ id: 'muda', code: '03', name: 'Muda' }, (m) => {
  const trail = o(0).scale(1.012).modulate(noise(3, 0.2), 0.004);
  const fresh = cam().citrink(1, 0, 3);
  const mix = trail.blend(fresh, 0.12);
  m.macro('MEMORIA', mix, 'amount', 0.5, 0.02);
  mix.out(0);
});

export const PRESETS: EffectGraph[] = [crudo, trama, espejo, muda];
