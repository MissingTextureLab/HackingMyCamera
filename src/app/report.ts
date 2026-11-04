// `?diag` verdict and report: which tier this phone would get (PLAN-DEVICES.md §2) and a text to send back.
// Pure: takes a finished Probe.

import { browserOf, chromeMajor } from './diagnose';
import type { Probe } from './probe';

export type Tier = 'A' | 'B' | 'C' | '-';

// Reference shader at 1280×720 (probe.ts). Provisional: to be calibrated with the reports from F1.
export const FAST_MS = 10;
export const SLOW_MS = 40;

export function proposeTier(p: Probe): { tier: Tier; reasons: string[] } {
  const g = p.gpu;
  const reasons: string[] = [];
  if (!g) reasons.push('SIN WEBGPU');
  else if (!g.attempts.hp && !g.attempts.plain && !g.attempts.compat && !g.attempts.fallback) reasons.push('SIN ADAPTADOR');
  else if (g.software) reasons.push('WEBGPU POR SOFTWARE');
  else if (!g.device) reasons.push('SIN DISPOSITIVO');
  else if (p.worker && !p.worker.adapter) reasons.push('SIN WEBGPU EN WORKER');
  else {
    // compatibility mode runs the app with lower limits: never the full tier
    const notes = [...(g.compatMode ? ['MODO COMPATIBLE'] : []), ...(g.compute ? [] : ['SIN CÓMPUTO'])];
    if (g.benchMs === undefined) return { tier: 'B', reasons: [...notes, 'SIN MEDIDA'] };
    if (g.benchMs <= FAST_MS && !notes.length) return { tier: 'A', reasons: [] };
    return { tier: 'B', reasons: [...notes, ...(g.benchMs > SLOW_MS ? ['GPU MUY LENTA'] : g.benchMs > FAST_MS ? ['GPU JUSTA'] : [])] };
  }
  if (!p.gl.ok) return { tier: '-', reasons: [...reasons, 'SIN WEBGL2'] };
  if (!p.gl.halfFloatRT) reasons.push('SIN BÚFER FLOAT');
  if (p.gl.benchMs !== undefined && p.gl.benchMs > SLOW_MS) reasons.push('GPU MUY LENTA');
  return { tier: 'C', reasons };
}

const yn = (b: boolean | undefined) => (b === undefined ? '?' : b ? 'SÍ' : 'NO');
const ms = (v: number | undefined) => (v === undefined ? '?' : `${v.toFixed(1)} MS`);
const mb = (bytes: number) => `${Math.round(bytes / 2 ** 20)}MB`;

/** One line per fact, for the screen and the clipboard; `key` is a short label (≤ 3 words). */
export function reportRows(p: Probe): [key: string, value: string][] {
  const { tier, reasons } = proposeTier(p);
  const browser = browserOf(p.env.ua);
  const g = p.gpu;
  const rows: [string, string][] = [
    ['NIVEL', `${tier}${reasons.length ? ` · ${reasons.join(' · ')}` : ''}`],
    ['MÓVIL', [p.env.model ?? '?', `ANDROID ${p.env.android ?? '?'}`].join(' · ')],
    ['NAVEGADOR', `${browser.name} ${chromeMajor(p.env.ua) ?? '?'}${p.standalone ? ' · INSTALADA' : ''}`],
    ['WEBGPU', !g ? 'NO' : `ALTO ${yn(g.attempts.hp)} · NORMAL ${yn(g.attempts.plain)} · COMPATIBLE ${yn(g.attempts.compat)} · SOFTWARE ${yn(g.attempts.fallback)}`],
  ];
  if (g && (g.vendor || g.architecture || g.description)) rows.push(['GPU', [g.vendor, g.architecture, g.description].filter(Boolean).join(' · ')]);
  if (g && (g.attempts.hp || g.attempts.plain || g.attempts.compat || g.attempts.fallback)) {
    rows.push(['DISPOSITIVO', g.device ? `SÍ · ${g.compatMode ? 'COMPATIBLE' : 'COMPLETO'} · CÓMPUTO ${yn(g.compute)}` : `NO · ${g.deviceError ?? '?'}`]);
    if (g.deviceError && g.device) rows.push(['ERROR', g.deviceError]);
    const l = g.limits;
    rows.push(['LÍMITES', `TEX ${l.maxTextureDimension2D} · STORAGE ${mb(l.maxStorageBufferBindingSize)} · HILOS ${l.maxComputeInvocationsPerWorkgroup} · SALIDAS ${l.maxColorAttachments}`]);
    rows.push(['VELOCIDAD WEBGPU', ms(g.benchMs)]);
  }
  rows.push(['WORKER', p.worker ? `WEBGPU ${yn(p.worker.gpu)} · ADAPTADOR ${yn(p.worker.adapter)} · CANVAS ${yn(p.worker.offscreenWebgpu)}` : 'SIN RESPUESTA']);
  rows.push(['WEBGL2', p.gl.ok ? `${p.gl.renderer ?? '?'} · FLOAT ${yn(p.gl.floatRT)} · HALF ${yn(p.gl.halfFloatRT)} · TEX ${p.gl.maxTexture ?? '?'}` : 'NO']);
  if (p.gl.ok) rows.push(['VELOCIDAD WEBGL2', ms(p.gl.benchMs)]);
  const m = p.media;
  rows.push(['VÍDEO', `CÁMARA ${yn(m.camera)} · PROCESSOR ${yn(m.trackProcessor)} · ENCODER ${yn(m.videoEncoder)} · H264 1080 ${yn(m.avc1080)} · MP4 ${yn(m.recorderMp4)}`]);
  rows.push(['EQUIPO', `${p.memory ?? '?'} GB · ${p.cores ?? '?'} NÚCLEOS · ${p.screen}`]);
  return rows;
}

/** The clipboard text: readable rows, then the raw probe as one JSON line for collecting results in a table. */
export function reportText(p: Probe): string {
  const rows = reportRows(p).map(([k, v]) => `${k}: ${v}`);
  return [`HACKING MY CAMERA · DIAGNÓSTICO ${p.date}`, ...rows, `UA: ${p.env.ua}`, `JSON: ${JSON.stringify(p)}`].join('\n');
}
