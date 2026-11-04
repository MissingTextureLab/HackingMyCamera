// Turns a fatal GPU error into something a person can act on: why it happened on THIS phone and what to try.
// Pure (no DOM): the app gathers an `Env` and this module only reasons about it.

export interface Env {
  ua: string;
  secure: boolean;
  /** Android major version from userAgentData.platformVersion; the UA string is frozen at "Android 10" in Chrome. */
  android?: number;
  model?: string;
}

export interface Diagnosis {
  /** Short, goes in the big glitch type. */
  title: string;
  /** Reason and fix, one short line each (shown uppercase). */
  lines: string[];
  /** Plain-text report for the clipboard, to send to the developer. */
  report: string;
}

export const MIN_CHROME = 121; // first Chrome with WebGPU on Android
export const MIN_ANDROID = 12;

const TITLES = ['SIN WEBGPU', 'SIN ADAPTADOR GPU', 'SIN DISPOSITIVO GPU', 'GPU PERDIDA', 'WORKER'];

export function chromeMajor(ua: string): number | undefined {
  const m = /Chrome\/(\d+)/.exec(ua);
  return m ? Number(m[1]) : undefined;
}

/** Which browser is this, and is it one that can run WebGPU on Android at all. */
export function browserOf(ua: string): { name: string; ok: boolean } {
  if (/FBAN|FBAV|Instagram|Snapchat|TikTok|musical_ly|Line\/|Telegram|Twitter|LinkedInApp|GSA\//.test(ua)) return { name: 'NAVEGADOR DE OTRA APP', ok: false };
  if (/SamsungBrowser/.test(ua)) return { name: 'SAMSUNG INTERNET', ok: false };
  if (/Firefox|Fennec/.test(ua)) return { name: 'FIREFOX', ok: false };
  if (/; wv\)/.test(ua)) return { name: 'WEBVIEW', ok: false };
  if (/EdgA\//.test(ua)) return { name: 'EDGE', ok: true };
  if (/OPR\//.test(ua)) return { name: 'OPERA', ok: true };
  if (/Chrome\//.test(ua)) return { name: 'CHROME', ok: true };
  return { name: 'NAVEGADOR DESCONOCIDO', ok: false };
}

export function diagnose(message: string, env: Env): Diagnosis {
  const cut = message.indexOf(':');
  const head = (cut < 0 ? message : message.slice(0, cut)).trim();
  const known = TITLES.includes(head);
  const title = known ? head : 'ERROR DE GPU';
  const detail = (known ? (cut < 0 ? '' : message.slice(cut + 1)) : message).trim().split('\n')[0].slice(0, 90);

  const browser = browserOf(env.ua);
  const chrome = chromeMajor(env.ua);
  const lines: string[] = [];
  const noGpu = title === 'SIN WEBGPU' || title === 'SIN ADAPTADOR GPU';

  if (noGpu) {
    if (!env.secure) lines.push('NECESITA HTTPS');
    if (!browser.ok) lines.push(`${browser.name}: ABRE EL ENLACE EN CHROME`);
    else if (chrome !== undefined && chrome < MIN_CHROME) lines.push(`CHROME ${chrome}: ACTUALIZA A ${MIN_CHROME} O MÁS`);
    if (env.android !== undefined && env.android < MIN_ANDROID) lines.push(`ANDROID ${env.android}: NECESITA ${MIN_ANDROID} O MÁS`);
    if (lines.length === 0) {
      lines.push(
        title === 'SIN ADAPTADOR GPU' ? 'CHROME NO ENCUENTRA UNA GPU COMPATIBLE' : 'ESTE NAVEGADOR NO TIENE WEBGPU',
        'SUELE SER EL DRIVER DE ESTE MÓVIL: ACTUALIZA CHROME Y WEBVIEW',
      );
    }
  } else if (title === 'SIN DISPOSITIVO GPU') {
    lines.push('LA GPU EXISTE PERO NO ABRE', 'CIERRA OTRAS APPS Y REINTENTA');
  } else if (title === 'GPU PERDIDA') {
    lines.push('EL SISTEMA REINICIÓ LA GPU', 'CIERRA Y VUELVE A ABRIR');
  }
  if (detail) lines.push(detail);

  const specs = [env.model, env.android !== undefined ? `ANDROID ${env.android}` : undefined, chrome !== undefined ? `${browser.name} ${chrome}` : browser.name]
    .filter(Boolean)
    .join(' · ');
  lines.push(specs);

  const report = [`HACKING MY CAMERA · ${title}`, detail && `ERROR: ${detail}`, `MODELO: ${env.model ?? '?'}`, `ANDROID: ${env.android ?? '?'}`, `NAVEGADOR: ${browser.name} ${chrome ?? '?'}`, `HTTPS: ${env.secure}`, `UA: ${env.ua}`]
    .filter(Boolean)
    .join('\n');

  return { title, lines, report };
}

/** Collects the environment in the page (the worker has no userAgentData model). */
export async function readEnv(): Promise<Env> {
  const env: Env = { ua: navigator.userAgent, secure: window.isSecureContext };
  try {
    const uad = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ model?: string; platformVersion?: string }> } }).userAgentData;
    const v = await uad?.getHighEntropyValues(['model', 'platformVersion']);
    if (v?.model) env.model = v.model;
    const major = Number.parseInt(v?.platformVersion ?? '', 10);
    if (Number.isFinite(major) && major > 0) env.android = major;
  } catch {}
  return env;
}
