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
  import type { EffectGraph } from '../graph/types';
  import { needsCompute } from '../graph/compile';
  import { diagnose, readEnv, type Diagnosis } from './diagnose';

  let canvas: HTMLCanvasElement;
  let worker: Worker;
  const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);

  /** The gallery: PRESETS minus what this GPU cannot run (known once the worker is ready). */
  let presets = $state.raw<EffectGraph[]>(PRESETS); // raw: graphs are posted to the worker

  // Thumbnail canvases arrive before the worker is ready; hand them over once it is.
  let workerReady = false;
  const pendingThumbs: { id: string; canvas: OffscreenCanvas }[] = [];
  function sendThumb(id: string, thumb: OffscreenCanvas) {
    const graph = presets.find((p) => p.id === id);
    if (graph) send({ type: 'thumb', id, canvas: thumb, graph }, [thumb]);
  }
  function queueThumb(id: string, thumb: OffscreenCanvas) {
    if (workerReady) sendThumb(id, thumb);
    else pendingThumbs.push({ id, canvas: thumb });
  }

  // effect
  let effectId = $state(PRESETS[0].id);
  // not named `effect`: Svelte would read `$effect` as a store subscription to it
  const active = $derived(presets.find((p) => p.id === effectId)!);
  /** By gesture: [A, B, C]; an effect may leave some empty. */
  let macros = $state<(MacroInfo | undefined)[]>([]);
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
  let fatal = $state<Diagnosis | null>(null);
  let copied = $state(false);
  async function showFatal(message: string) {
    fatal = diagnose(message, await readEnv());
  }
  async function copyReport() {
    try {
      await navigator.clipboard.writeText(fatal!.report);
      copied = true;
    } catch {
      say('NO SE PUDO COPIAR');
    }
  }
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
    buzz(8);
  }

  // gestures on the viewfinder
  let gesture = $state<'none' | 'drag' | 'pinch'>('none');
  let zoom = $state(1);
  let defaults: (number | undefined)[] = [];
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
        if (!m.compute) presets = PRESETS.filter((p) => !needsCompute(p));
        if (m.mode === 'compat') say('MODO COMPATIBLE');
        selectEffect(effectId, false);
        for (const t of pendingThumbs.splice(0)) sendThumb(t.id, t.canvas);
        send({ type: 'grade', mode: grade });
        startCamera();
        break;
      case 'error':
        console.error('[render]', m.message);
        if (m.fatal || m.message.startsWith('GPU PERDIDA')) showFatal(m.message);
        else say(m.message.split('\n')[0].slice(0, 60).toUpperCase());
        break;
      case 'effect':
        if (m.id === effectId) {
          const byGesture: (MacroInfo | undefined)[] = [undefined, undefined, undefined];
          for (const x of m.macros) byGesture[x.gesture] = x;
          macros = byGesture;
          defaults = byGesture.map((x) => x?.value);
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
        buzz(30);
        break;
      case 'recStopped':
        recording = false;
        if (m.blob) keep(m.blob, nextName('mp4'), true);
        else say(`NO SE GRABÓ:${(m.error ?? '').slice(0, 40).toUpperCase()}`);
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
    const graph = presets.find((p) => p.id === id);
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
    const query = new URLSearchParams(location.search);
    const forceTest = query.get('source') === 'test';
    // ?camfps=30 simulates a 30 fps camera on the test card
    const camFps = Number(query.get('camfps')) || 0;
    if (forceTest || !cameraSupported()) {
      send({ type: 'testSource', camFps });
      if (!forceTest) say('SIN CÁMARA: CARTA DE AJUSTE');
      return;
    }
    try {
      feed = await openCamera(facing);
      const mirror = facing === 'user';
      if (feed.stream) send({ type: 'frames', stream: feed.stream, mirror }, [feed.stream]);
      else feed.pump((frame) => send({ type: 'frame', frame, mirror }, [frame]));
      applyZoom(1);
    } catch (e) {
      console.warn('camera', e);
      send({ type: 'testSource', camFps });
      say('SIN CÁMARA: CARTA DE AJUSTE');
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
    const t = m.max === m.min ? 0 : (v - m.min) / (m.max - m.min);
    for (const l of m.links ?? []) send({ type: 'param', slot: l.slot, value: l.min + (l.max - l.min) * t });
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
        defaults.forEach((v, i) => v !== undefined && setMacro(i, v));
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
      showFatal('SIN WEBGPU');
      return;
    }
    worker = new Worker(new URL('../render/worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', (e) => showFatal(`WORKER: ${e.message}`));
    const offscreen = canvas.transferControlToOffscreen();
    // ?gpu=compat forces WebGPU compatibility mode, to test what OpenGL ES phones get
    const gpu = new URLSearchParams(location.search).get('gpu') === 'compat' ? 'compat' : undefined;
    send({ type: 'init', canvas: offscreen, ...physicalSize(), gpu }, [offscreen]);

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
  const two = (n: number) => String(n).padStart(2, '0');
  const position = $derived(`${two(presets.indexOf(active) + 1)}/${two(presets.length)}`);

  // the readouts sit just above the deck, whatever its height is
  let deckH = $state(0);
  // what the stamps say, for screen readers (they come and go too fast to be found)
  const announcement = $derived(notice ?? stamp ?? (recording ? 'GRABANDO' : ''));
</script>

<main class="screen" class:misreg onpointerdowncapture={engage}>
  <canvas
    bind:this={canvas}
    class="cam"
    aria-label="Visor: arrastra para las macros, pellizca para el zoom, gira con dos dedos, doble toque para restablecer"
  ></canvas>

  <div class="tag tl label cut-br active"><span class="muted">FX-{active.code}</span><span>{active.name}</span></div>
  <button class="tag tc label" type="button" onclick={toggleGrade} aria-label="Revelado: {GRADES[grade]}. Toca para cambiar">
    <span class="swatch" class:violet={grade === 1}></span><span>{GRADES[grade]}</span>
  </button>
  <button class="tag tr label cut-bl" type="button" onclick={statusTap} aria-label="Cámara {lens}. Tres toques abren el HUD de depuración">
    <span class="led" class:on={source === 'camera'} class:rec={recording}></span><span>{lens}</span>
  </button>

  {#if titleOn}<p class="fxtitle">{active.name}</p>{/if}

  {#if recording}
    <div class="recstamp"><b>REC</b><span>{recClock}</span></div>
  {/if}
  {#if stamp}<div class="stamp">{stamp}</div>{/if}
  {#if notice}<div class="notice label">{notice}</div>{/if}
  <div class="sr" role="status">{announcement}</div>

  {#if gesture === 'drag' && (macros[0] || macros[1])}
    <div class="readout" style:bottom="{deckH + 8}px">
      {#each macros.slice(0, 2) as m, i (i)}
        {#if m}
          <div class="cell cut-tr" class:a={i === 0}>
            <span class="k label">{i === 0 ? 'A' : 'B'} / {m.label}</span>
            <span class="v scan">{fmt(m.value)}</span>
          </div>
        {/if}
      {/each}
    </div>
  {:else if gesture === 'pinch'}
    <div class="readout" style:bottom="{deckH + 8}px">
      <div class="cell cut-tr a">
        <span class="k label">ZOOM</span>
        <span class="v scan">{zoom.toFixed(1)}×</span>
      </div>
      {#if macros[2]}
        <div class="cell cut-tr">
          <span class="k label">C / {macros[2].label}</span>
          <span class="v scan">{fmt(macros[2].value)}</span>
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

  <div class="deck" bind:clientHeight={deckH}>
    <div class="rail" aria-hidden="true">
      <span class="pos label cut-bl">{position}</span>
    </div>
    <EffectStrip effects={presets} selected={effectId} onselect={(id) => selectEffect(id)} onthumb={queueThumb} />
    <div class="row">
      <button class="key cut-tr" type="button" onclick={flip} aria-label="Cambiar cámara"><span class="label cut-tr">F/T</span></button>
      <Shutter
        {recording}
        onphoto={() => send({ type: 'photo' })}
        onrecstart={() => send({ type: 'recStart' })}
        onrecstop={() => send({ type: 'recStop' })}
      />
      <button class="last cut-tl" type="button" onclick={share} aria-label="Compartir última captura" disabled={!last} data-src={last?.url}>
        <span class="well cut-tl">{#if last && !last.video}<img src={last.url} alt="" />{/if}</span>
        {#if last}<span class="n">{last.name.slice(4, 8)}{last.video ? ' MP4' : ''}</span>{/if}
      </button>
    </div>
  </div>

  {#if fatal}
    <div class="fatal" role="alert">
      <div class="card">
        <p>{fatal.title}</p>
        <div class="why">
          {#each fatal.lines as line, i}<span class="label" class:specs={i === fatal.lines.length - 1}>{line}</span>{/each}
        </div>
      </div>
      <div class="actions">
        <button class="label" onclick={copyReport}>{copied ? 'COPIADO' : 'COPIAR INFORME'}</button>
        <button class="label" onclick={() => location.assign('?diag')}>DIAGNÓSTICO</button>
        <button class="label" onclick={() => location.reload()}>REINTENTAR</button>
      </div>
    </div>
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
  /* side plates mirror each other: stripe on the outer edge, the cut (and the
     padding that clears it) on the inner corner; the centre plate stays plain */
  .tl {
    border-left: var(--stroke) solid var(--lagoon);
    padding-right: var(--space-3);
  }
  .tr {
    border-right: var(--stroke) solid var(--lagoon);
    padding-left: var(--space-3);
  }
  .tag.active {
    border-color: var(--acid);
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
  /* the plates are 20px tall: the button reaches 14px past its edges so a thumb
     can hit it. Not on .tr, whose clip-path would cut the extension off. */
  .tc::after {
    content: '';
    position: absolute;
    inset: -14px;
  }
  /* clip-path would cut an outline: draw it inside the plate instead */
  button.tag:focus-visible {
    outline: var(--stroke) solid var(--focus);
    outline-offset: calc(var(--stroke) * -1);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
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

  /* GUARDADO: set like the effect titles (.fxtitle), straight on the image */
  .stamp {
    position: absolute;
    left: 50%;
    top: 34%;
    transform: translate(-50%, -50%);
    margin: 0;
    font-family: var(--font-display);
    font-size: 48px;
    line-height: 0.95;
    text-transform: uppercase;
    color: var(--ink);
    mix-blend-mode: difference;
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
    font-size: 32px;
    line-height: 1;
  }
  .recstamp span {
    font-family: var(--font-dot);
    font-weight: 800;
    font-size: 24px;
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
    /* bottom comes from the measured deck height (see the markup) */
    display: flex;
    gap: var(--space-2);
    pointer-events: none;
  }
  /* a header bar over a scan-line body (DESIGN.md, Capa HUD) */
  .cell {
    display: flex;
    flex-direction: column;
  }
  /* the cut is on the header's top right, towards the centre */
  .cell .k {
    background: var(--panel-deep);
    color: var(--ink);
    padding: var(--space-1) var(--space-4) var(--space-1) var(--space-2);
  }
  .cell.a .k {
    background: var(--acid);
    color: var(--ink-fixed);
  }
  .cell .v {
    padding: var(--space-2);
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
  /* corner brackets, lagoon: an instrument frame, not a selection; mirrored
     because the HUD sits on the right */
  .hud::before,
  .hud::after {
    content: '';
    position: absolute;
    width: var(--bracket);
    height: var(--bracket);
    border: 0 solid var(--lagoon);
  }
  .hud::before {
    top: calc(var(--space-1) * -1);
    right: calc(var(--space-1) * -1);
    border-top-width: var(--stroke);
    border-right-width: var(--stroke);
  }
  .hud::after {
    left: calc(var(--space-1) * -1);
    bottom: calc(var(--space-1) * -1);
    border-left-width: var(--stroke);
    border-bottom-width: var(--stroke);
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
  /* hairline over the gallery, capped at both ends, with the position on a plate */
  .rail {
    position: relative;
    height: 12px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    margin-bottom: calc(var(--space-2) * -1);
  }
  .rail::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 1px;
    background: var(--lagoon);
  }
  .rail::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 2px;
    height: 8px;
    border: 0 solid var(--lagoon);
    border-left-width: var(--stroke);
    border-right-width: var(--stroke);
  }
  /* stacked over the strip, whose ticks scroll under it */
  .rail .pos {
    position: relative;
    margin-right: var(--space-4);
    background: var(--panel);
    color: var(--ink-muted);
    padding: 0 var(--space-2) 0 var(--space-3);
    font-variant-numeric: tabular-nums;
    z-index: 1;
  }
  .row {
    display: grid;
    grid-template-columns: 48px 1fr 48px;
    align-items: center;
  }
  /* framed pieces: a lagoon cut with 1px padding around a face with the same
     cut; F/T and the last capture cut the top corner that faces the shutter */
  .key {
    width: 48px;
    height: 48px;
    padding: 1px;
    border: 0;
    border-radius: var(--radius-0);
    background: var(--lagoon);
    color: var(--ink);
    cursor: pointer;
  }
  .key span {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    background: var(--panel);
    transition: background var(--tick) var(--ease-step);
  }
  .key:active span {
    background: var(--panel-deep);
  }
  /* clip-path would cut an outline: focus thickens the frame instead */
  .key:focus-visible,
  .last:focus-visible {
    outline: none;
    padding: var(--stroke);
    background: var(--focus);
  }
  .last {
    width: 48px;
    height: 48px;
    padding: 1px;
    border: 0;
    border-radius: var(--radius-0);
    background: var(--lagoon);
    position: relative;
    cursor: pointer;
  }
  .last .well {
    display: block;
    width: 100%;
    height: 100%;
    background: var(--panel);
  }
  .last img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .last .n {
    position: absolute;
    left: 1px;
    bottom: 1px;
    background: var(--panel);
    font-size: 10px;
    line-height: 12px;
    padding: 0 var(--space-1);
    max-width: 100%;
    box-sizing: border-box;
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
  /* a Stray-style window: flash header bar over a scan-line body, stamped askew */
  .fatal .card {
    display: flex;
    flex-direction: column;
    transform: rotate(var(--stamp-angle));
  }
  /* no plates on this screen: the text sits straight on the floor */
  .fatal p {
    margin: 0;
    font-family: var(--font-pop);
    font-size: 48px;
    line-height: 1;
    color: var(--flash);
    padding: var(--space-2) var(--space-3);
  }
  .fatal .why {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    max-width: 320px;
  }
  .fatal .why .label {
    color: var(--ink);
    font-size: 12px;
    line-height: 16px;
  }
  .fatal .why .specs {
    color: var(--ink-muted);
  }
  .fatal .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
  }
  .fatal button {
    min-height: 48px;
    padding: 0 var(--space-4);
    border: 1px solid var(--lagoon);
    border-radius: var(--radius-0);
    background: none;
    color: var(--ink);
    cursor: pointer;
  }
  .fatal button:active {
    border-color: var(--acid);
    color: var(--acid);
  }
</style>
