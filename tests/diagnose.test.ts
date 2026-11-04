import { describe, expect, it } from 'vitest';
import { browserOf, diagnose, type Env } from '../src/app/diagnose';

const CHROME = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const env = (o: Partial<Env> = {}): Env => ({ ua: CHROME, secure: true, ...o });

describe('error screen diagnosis', () => {
  it('blames an Android that is too old, using platformVersion rather than the frozen UA', () => {
    const d = diagnose('SIN ADAPTADOR GPU', env({ android: 11, model: 'SM-A135F' }));
    expect(d.title).toBe('SIN ADAPTADOR GPU');
    expect(d.lines).toContain('ANDROID 11: NECESITA 12 O MÁS');
    expect(d.lines.at(-1)).toBe('SM-A135F · ANDROID 11 · CHROME 130');
  });

  it('tells in-app browsers to open Chrome', () => {
    const ua = CHROME + ' Instagram 300.0';
    expect(browserOf(ua).ok).toBe(false);
    expect(diagnose('SIN WEBGPU', env({ ua })).lines[0]).toBe('NAVEGADOR DE OTRA APP: ABRE EL ENLACE EN CHROME');
  });

  it('asks for a newer Chrome', () => {
    const d = diagnose('SIN WEBGPU', env({ ua: CHROME.replace('130', '115') }));
    expect(d.lines[0]).toBe('CHROME 115: ACTUALIZA A 121 O MÁS');
  });

  it('falls back to the driver when nothing else explains it', () => {
    const d = diagnose('SIN ADAPTADOR GPU', env({ android: 14 }));
    expect(d.lines[0]).toBe('CHROME NO ENCUENTRA UNA GPU COMPATIBLE');
  });

  it('keeps the device error detail and puts the specs in the report', () => {
    const d = diagnose('SIN DISPOSITIVO GPU: qualcomm adreno Out of memory', env({ android: 14, model: 'Pixel 8' }));
    expect(d.title).toBe('SIN DISPOSITIVO GPU');
    expect(d.lines).toContain('qualcomm adreno Out of memory');
    expect(d.report).toContain('MODELO: Pixel 8');
  });

  it('shows unknown errors under a generic title', () => {
    expect(diagnose('Something odd', env()).title).toBe('ERROR DE GPU');
  });
});
