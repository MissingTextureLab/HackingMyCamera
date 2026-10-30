<script lang="ts">
  import { onMount } from 'svelte';
  import EffectStrip from './EffectStrip.svelte';
  import Shutter from './Shutter.svelte';
  import { PRESETS } from '../presets';
  import { cameraSupported, MAX_ZOOM, openCamera, type CameraFeed, type Facing } from '../io/camera';
  import { Gestures } from './gestures';
  import { Tilt } from '../io/motion';
  import type { FromWorker, MacroInfo, ToWorker } from '../render/protocol';
  import type { EngineStats } from '../gpu/engine';

  let canvas: HTMLCanvasElement;
  let worker: Worker;
  const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);

  // Thumbnail canvases arrive before the worker is ready; hand them over once it is.
  let workerReady = false;
  const pendingThumbs: { id: string; canvas: OffscreenCanvas }[] = [];
  function sendThumb(id: string, thumb: OffscreenCanvas) {
    const graph = PRESETS.find((p) => p.id === id);
    if (graph) send({ type: 'thumb', id, canvas: thumb, graph }, [thumb]);
  }
  function queueThumb(id: string, thumb: OffscreenCanvas) {
    if (workerReady) sendThumb(id, thumb);
    else pendingThumbs.push({ id, canvas: thumb });
  }

  // effect
  let effectId = $state(PRESETS[0].id);
  // not named `effect`: Svelte would read `$effect` as a store subscription to it
  const active = $derived(PRESETS.find((p) => p.id === effectId)!);
  let macros = $state<MacroInfo[]>([]);
  let titleOn = $state(false);

  // camera
  let feed: CameraFeed | null = null;
  let facing = $state<Facing>('environment');
  let source = $state<'camera' | 'test'>('test');

  // capture
  let recording = $state(false);
  let recSeconds = $state(0);
  let stamp = $state<string | null>(null);
  let misreg = $state(false);
  let last = $state<{ url: string; blob: Blob; name: string; video: boolean } | null>(null);

  // status
  let fatal = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let hud = $state(false);

  // revelado mode (DESIGN.md): remembered across sessions
  const GRADES = ['ÁCIDO', 'MORADO'] as const;
  let grade = $state<0 | 1>(0);
  try {
    grade = localStorage.getItem('hmc.grade') === '1' ? 1 : 0;
  } catch {}
  function toggleGrade() {
    grade = grade === 0 ? 1 : 0;
    try {
      localStorage.setItem('hmc.grade', String(grade));
    } catch {}
    send({ type: 'grade', mode: grade });
    sabotage();
    buzz(8);
  }

  // gestures on the viewfinder
  let gesture = $state<'none' | 'drag' | 'pinch'>('none');
  let zoom = $state(1);
  let defaults: number[] = [];
  let pinchFrom = 1;
  let twistFrom = 0;
  let tilt: Tilt | null = null;
  let stats = $state<{ fps: number; stats: EngineStats } | null>(null);

  const timers: Record<string, ReturnType<typeof setTimeout>> = {};
  function flash(key: string, ms: number, on: () => void, off: () => void) {
    clearTimeout(timers[key]);
    on();
    timers[key] = setTimeout(off, ms);
  }
  const HOLD = 600;
  const buzz = (p: number | number[]) => {
    try {
      navigator.vibrate?.(p);
    } catch {}
  };
  function sabotage() {
    flash('misreg', HOLD, () => (misreg = true), () => (misreg = false));
  }
  function say(text: string) {
    flash('notice', 2500, () => (notice = text), () => (notice = null));
  }

  function nextName(ext: string) {
    let n = 1;
    try {
      n = Number(localStorage.getItem('hmc.count') ?? '0') + 1;
      localStorage.setItem('hmc.count', String(n));
    } catch {}
    return `HMC-${String(n).padStart(4, '0')}.${ext}`;
  }

  function onMessage(e: MessageEvent<FromWorker>) {
    const m = e.data;
    switch (m.type) {
      case 'ready':
        workerReady = true;
        selectEffect(effectId, false);
        for (const t of pendingThumbs.splice(0)) sendThumb(t.id, t.canvas);
        send({ type: 'grade', mode: grade });
        startCamera();
        break;
      case 'error':
        console.error('[render]', m.message);
        if (m.message.startsWith('SIN WEBGPU') || m.message.startsWith('SIN ADAPTADOR') || m.message.startsWith('GPU PERDIDA')) fatal = m.message;
        else say(m.message.split('\n')[0].slice(0, 60).toUpperCase());
        break;
      case 'effect':
        if (m.id === effectId) {
          macros = m.macros;
          defaults = m.macros.map((x) => x.value);
        }
        break;
      case 'photo':
        keep(m.blob, nextName('jpg'), false);
        flash('stamp', HOLD, () => (stamp = 'GUARDADO'), () => (stamp = null));
        sabotage();
        buzz([12, 40, 12]);
        break;
      case 'recStarted':
        recording = true;
        recSeconds = 0;
        sabotage();
        buzz(30);
        break;
      case 'recStopped':
        recording = false;
        if (m.blob) keep(m.blob, nextName('mp4'), true);
        else say(`NO SE GRABO: ${(m.error ?? '').slice(0, 40).toUpperCase()}`);
        buzz(12);
        break;
      case 'stats':
        stats = { fps: m.fps, stats: m.stats };
        source = m.source;
        break;
    }
  }

  function keep(blob: Blob, name: string, video: boolean) {
    if (last) URL.revokeObjectURL(last.url);
    last = { url: URL.createObjectURL(blob), blob, name, video };
  }

  async function share() {
    if (!last) return;
    const file = new File([last.blob], last.name, { type: last.blob.type });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
    const a = document.createElement('a');
    a.href = last.url;
    a.download = last.name;
    a.click();
  }

  function selectEffect(id: string, announce = true) {
    const graph = PRESETS.find((p) => p.id === id);
    if (!graph) return;
    effectId = id;
    macros = [];
    send({ type: 'effect', graph });
    if (announce) {
      flash('title', HOLD, () => (titleOn = true), () => (titleOn = false));
      buzz(8);
    }
  }

  async function startCamera() {
    feed?.stop();
    feed = null;
    const forceTest = new URLSearchParams(location.search).get('source') === 'test';
    if (forceTest || !cameraSupported()) {
      send({ type: 'testSource' });
      if (!forceTest) say('SIN CAMARA: CARTA DE AJUSTE');
      return;
    }
    try {
      feed = await openCamera(facing);
      send({ type: 'frames', stream: feed.stream, mirror: facing === 'user' }, [feed.stream]);
      applyZoom(1);
    } catch (e) {
      console.warn('camera', e);
      send({ type: 'testSource' });
      say('SIN CAMARA: CARTA DE AJUSTE');
    }
  }

  function flip() {
    facing = facing === 'environment' ? 'user' : 'environment';
    buzz(8);
    startCamera();
  }

  function setMacro(i: number, value: number) {
    const m = macros[i];
    if (!m) return;
    const lo = Math.min(m.min, m.max);
    const hi = Math.max(m.min, m.max);
    const v = Math.min(hi, Math.max(lo, value));
    macros[i] = { ...m, value: v };
    send({ type: 'param', slot: m.slot, value: v });
  }

  function applyZoom(total: number) {
    zoom = Math.min(MAX_ZOOM, Math.max(1, total));
    send({ type: 'zoom', digital: feed ? feed.zoom(zoom) : zoom });
  }

  function attachGestures(el: HTMLElement) {
    return new Gestures(el, {
      onStart(kind) {
        gesture = kind;
        pinchFrom = zoom;
        twistFrom = macros[2]?.value ?? 0;
      },
      onDrag(x, y) {
        // macros A/B follow the finger: x → A, inverted y → B
        [x, y].forEach((t, i) => {
          const m = macros[i];
          if (m) setMacro(i, m.min + (m.max - m.min) * t);
        });
      },
      onPinch(scale) {
        applyZoom(pinchFrom * scale);
      },
      onTwist(radians) {
        const m = macros[2];
        if (m) setMacro(2, twistFrom + (radians / Math.PI) * (m.max - m.min));
      },
      onDoubleTap() {
        defaults.forEach((v, i) => setMacro(i, v));
        applyZoom(1);
        tilt?.recalibrate();
        buzz(8);
      },
      onEnd() {
        gesture = 'none';
      },
      onTouch(state) {
        send({ type: 'touch', state: { ...state } });
      },
    });
  }

  // Fullscreen and wake lock need a user gesture: take the first one.
  let engaged = false;
  async function engage() {
    if (engaged) return;
    engaged = true;
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {}
    try {
      await navigator.wakeLock?.request('screen');
    } catch {}
  }

  // Triple tap on the status tag toggles the debug HUD.
  let taps: number[] = [];
  function statusTap() {
    const now = performance.now();
    taps = [...taps.filter((t) => now - t < 600), now];
    if (taps.length >= 3) {
      hud = !hud;
      taps = [];
    }
  }

  function physicalSize() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { width: Math.round(r.width * dpr), height: Math.round(r.height * dpr) };
  }

  $effect(() => {
    if (!recording) return;
    const id = setInterval(() => recSeconds++, 1000);
    return () => clearInterval(id);
  });

  onMount(() => {
    if (!navigator.gpu) {
      fatal = 'SIN WEBGPU';
      return;
    }
    worker = new Worker(new URL('../render/worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', (e) => (fatal = `WORKER: ${e.message}`));
    const offscreen = canvas.transferControlToOffscreen();
    send({ type: 'init', canvas: offscreen, ...physicalSize() }, [offscreen]);

    const ro = new ResizeObserver(() => send({ type: 'resize', ...physicalSize() }));
    ro.observe(canvas);
    const gestures = attachGestures(canvas);
    tilt = new Tilt((state) => send({ type: 'motion', state }));
    return () => {
      tilt?.destroy();
      gestures.destroy();
      ro.disconnect();
      feed?.stop();
      worker.terminate();
    };
  });

  const fmt = (v: number) => v.toFixed(2);
  const recClock = $derived(`${String(Math.floor(recSeconds / 60)).padStart(2, '0')}:${String(recSeconds % 60).padStart(2, '0')}`);
  const lens = $derived(source === 'test' ? 'TEST' : facing === 'user' ? 'FRON' : 'TRAS');
</script>

<main class="screen" class:misreg onpointerdowncapture={engage}>
  <canvas
    bind:this={canvas}
    class="cam"
    aria-label="Visor: arrastra para las macros, pellizca para el zoom, gira con dos dedos, doble toque para restablecer"
  ></canvas>

  <div class="tag tl label"><span class="muted">FX-{active.code}</span><span>{active.name}</span></div>
  <button class="tag tc label" type="button" onclick={toggleGrade} aria-label="Revelado: {GRADES[grade]}. Toca para cambiar">
    <span class="swatch" class:violet={grade === 1}></span><span>{GRADES[grade]}</span>
  </button>
  <button class="tag tr label" type="button" onclick={statusTap} aria-label="Cámara activa">
    <span class="led" class:on={source === 'camera'} class:rec={recording}></span><span>{lens}</span>
  </button>

  {#if titleOn}<p class="fxtitle">{active.name}</p>{/if}

  {#if recording}
    <div class="recstamp"><b>REC</b><span>{recClock}</span></div>
  {/if}
  {#if stamp}<div class="stamp">{stamp}</div>{/if}
  {#if notice}<div class="notice label">{notice}</div>{/if}

  {#if gesture === 'drag' && macros.length}
    <div class="readout">
      {#each macros.slice(0, 2) as m, i (m.slot)}
        <div class="cell" class:a={i === 0}>
          <span class="k label">{i === 0 ? 'A' : 'B'} / {m.label}</span>
          <span class="v">{fmt(m.value)}</span>
        </div>
      {/each}
    </div>
  {:else if gesture === 'pinch'}
    <div class="readout">
      <div class="cell a">
        <span class="k label">ZOOM</span>
        <span class="v">{zoom.toFixed(1)}×</span>
      </div>
      {#if macros[2]}
        <div class="cell">
          <span class="k label">C / {macros[2].label}</span>
          <span class="v">{fmt(macros[2].value)}</span>
        </div>
      {/if}
    </div>
  {/if}

  {#if hud && stats}
    <div class="hud label">
      <span>{stats.fps.toFixed(0)} FPS</span>
      <span>GPU {stats.stats.gpuMs?.toFixed(2) ?? '—'} MS</span>
      <span>{stats.stats.width}×{stats.stats.height}</span>
      <span>{stats.stats.passes} PASES</span>
    </div>
  {/if}

  <div class="deck">
    <EffectStrip effects={PRESETS} selected={effectId} onselect={(id) => selectEffect(id)} onthumb={queueThumb} />
    <div class="row">
      <button class="key label" type="button" onclick={flip} aria-label="Cambiar cámara">F/T</button>
      <Shutter
        {recording}
        onphoto={() => send({ type: 'photo' })}
        onrecstart={() => send({ type: 'recStart' })}
        onrecstop={() => send({ type: 'recStop' })}
      />
      <button class="last" type="button" onclick={share} aria-label="Compartir última captura" disabled={!last} data-src={last?.url}>
        {#if last && !last.video}<img src={last.url} alt="" />{/if}
        {#if last}<span class="n">{last.name.slice(4, 8)}{last.video ? ' MP4' : ''}</span>{/if}
      </button>
    </div>
  </div>

  {#if fatal}
    <div class="fatal"><p>{fatal}</p><span class="label">Chrome para Android con WebGPU</span></div>
  {/if}
</main>

<style>
  .screen {
    position: fixed;
    inset: 0;
    background: var(--viewfinder);
    overflow: hidden;
    /* the browser must never pinch-zoom or scroll the app: gestures are ours */
    touch-action: none;
  }
  .cam {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
  }

  .tag {
    position: absolute;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    background: var(--panel);
    color: var(--ink);
    padding: var(--space-1) var(--space-2);
    border: 0;
    border-radius: var(--radius-0);
  }
  .tag .muted {
    color: var(--ink-muted);
  }
  .tl {
    top: calc(var(--space-4) + env(safe-area-inset-top, 0px));
    left: var(--space-4);
  }
  .tr {
    top: calc(var(--space-4) + env(safe-area-inset-top, 0px));
    right: var(--space-4);
    cursor: pointer;
  }
  .tc {
    top: calc(var(--space-4) + env(safe-area-inset-top, 0px));
    left: 50%;
    transform: translateX(-50%);
    cursor: pointer;
  }
  .swatch {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-0);
    background: var(--acid);
  }
  /* the MORADO grade's mid tone: the one colour outside Citrink, shown only here */
  .swatch.violet {
    background: #8c3fbf;
  }
  .led {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-knob);
    background: var(--panel-deep);
  }
  .led.on {
    background: var(--grass);
  }
  .led.rec {
    background: var(--flash);
  }

  .fxtitle {
    position: absolute;
    left: var(--space-4);
    top: calc(52px + env(safe-area-inset-top, 0px));
    margin: 0;
    font-family: var(--font-display);
    font-size: 48px;
    line-height: 0.95;
    text-transform: uppercase;
    color: var(--ink);
    /* straight on the image, no plate: difference keeps it legible on any colour */
    mix-blend-mode: difference;
    pointer-events: none;
  }

  .stamp {
    position: absolute;
    left: 50%;
    top: 34%;
    transform: translate(-50%, -50%) rotate(var(--stamp-angle));
    background: var(--flash);
    color: var(--ink-fixed);
    padding: var(--space-2) var(--space-3);
    font-family: var(--font-display);
    font-size: 30px;
    line-height: 1;
    white-space: nowrap;
    pointer-events: none;
  }
  .recstamp {
    position: absolute;
    top: calc(56px + env(safe-area-inset-top, 0px));
    right: var(--space-4);
    transform: rotate(var(--stamp-angle));
    background: var(--flash);
    color: var(--ink-fixed);
    padding: var(--space-1) var(--space-2);
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    pointer-events: none;
  }
  .recstamp b {
    font-family: var(--font-display);
    font-weight: 400;
    font-size: 24px;
    line-height: 1;
  }
  .recstamp span {
    font-family: var(--font-dot);
    font-weight: 800;
    font-size: 22px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .notice {
    position: absolute;
    top: 30%;
    left: 50%;
    transform: translateX(-50%) rotate(var(--stamp-angle));
    background: var(--flash);
    color: var(--ink-fixed);
    padding: var(--space-1) var(--space-2);
    max-width: 80%;
    pointer-events: none;
  }

  .readout {
    position: absolute;
    left: var(--space-4);
    bottom: calc(196px + env(safe-area-inset-bottom, 0px));
    display: flex;
    gap: var(--space-2);
    pointer-events: none;
  }
  .cell {
    background: var(--panel);
    padding: var(--space-1) var(--space-2) var(--space-2);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .cell .k {
    color: var(--ink-muted);
  }
  .cell .v {
    font-family: var(--font-dot);
    font-size: 40px;
    line-height: 1;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }
  .cell.a .v {
    color: var(--acid);
  }

  .hud {
    position: absolute;
    top: calc(52px + env(safe-area-inset-top, 0px));
    right: var(--space-4);
    background: var(--panel);
    color: var(--ink);
    padding: var(--space-2);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  .deck {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 0 var(--space-4) calc(var(--space-8) + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .row {
    display: grid;
    grid-template-columns: 48px 1fr 48px;
    align-items: center;
  }
  .key {
    width: 48px;
    height: 48px;
    border-radius: var(--radius-key);
    background: var(--panel);
    color: var(--ink);
    border: 1px solid var(--lagoon);
    cursor: pointer;
    transition: background var(--tick) var(--ease-step);
  }
  .key:active {
    background: var(--panel-deep);
  }
  .key:focus-visible,
  .last:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 3px;
  }
  .last {
    width: 48px;
    height: 48px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-0);
    outline: 1px solid var(--lagoon);
    background: var(--panel);
    position: relative;
    overflow: hidden;
    cursor: pointer;
  }
  .last img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .last .n {
    position: absolute;
    left: 0;
    bottom: 0;
    background: var(--panel);
    font-size: 8px;
    line-height: 10px;
    padding: 0 2px;
    letter-spacing: 0.04em;
    color: var(--ink);
  }

  /* sabotage: misregistration of the printed layer on events */
  .misreg :global(.label),
  .misreg .tag {
    text-shadow:
      var(--misreg) 0 0 var(--flash),
      calc(var(--misreg) * -1) 0 0 var(--grass);
  }
  .misreg .deck {
    transform: translateX(var(--misreg));
  }
  @media (prefers-reduced-motion: reduce) {
    .misreg .deck {
      transform: none;
    }
    .misreg :global(.label),
    .misreg .tag {
      text-shadow: none;
      color: var(--flash);
    }
  }

  .fatal {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    background: var(--viewfinder);
    padding: var(--space-6);
    text-align: center;
  }
  .fatal p {
    margin: 0;
    font-family: var(--font-pop);
    font-size: 48px;
    line-height: 1;
    background: var(--flash);
    color: var(--ink-fixed);
    padding: var(--space-2) var(--space-3);
    transform: rotate(var(--stamp-angle));
  }
  .fatal .label {
    color: var(--ink-muted);
  }
</style>
