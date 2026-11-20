<script lang="ts">
  // The roll: what every phone gallery does, set in the house style. A grid of
  // square thumbnails grouped by day (long press selects), and a viewer that
  // swipes between captures, pinches / double-taps to zoom, drags down to close
  // and plays videos. The system Back gesture closes the viewer, then the roll.
  import { onMount, tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { Capture } from '../capture/store';
  import { forgetThumb, thumbnail, type Thumb } from '../capture/thumbs';

  interface Props {
    /** newest first */
    items: Capture[];
    onclose: () => void;
    onshare: (c: Capture[]) => void;
    onsave: (c: Capture) => void;
    ondelete: (c: Capture[]) => void;
  }
  let { items, onclose, onshare, onsave, ondelete }: Props = $props();

  // ---- labels
  const MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  const WEEK = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
  const two = (n: number) => String(n).padStart(2, '0');
  const dayStart = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  function dayLabel(t: number) {
    const diff = Math.round((dayStart(Date.now()) - dayStart(t)) / 86_400_000);
    if (diff === 0) return 'HOY';
    if (diff === 1) return 'AYER';
    const d = new Date(t);
    const base = `${WEEK[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
    return d.getFullYear() === new Date().getFullYear() ? base : `${base} ${d.getFullYear()}`;
  }
  const clock = (t: number) => {
    const d = new Date(t);
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
  };
  const mmss = (s: number) => `${Math.floor(s / 60)}:${two(Math.floor(s % 60))}`;
  const weight = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const buzz = (ms: number) => {
    try {
      navigator.vibrate?.(ms);
    } catch {}
  };
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  const groups = $derived.by(() => {
    const out: { day: number; label: string; items: Capture[] }[] = [];
    for (const c of items) {
      const day = dayStart(c.time);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(c);
      else out.push({ day, label: dayLabel(c.time), items: [c] });
    }
    return out;
  });

  // ---- navigation: grid → select | view, one history entry per level
  let mode = $state<'grid' | 'select' | 'view'>('grid');
  let index = $state(0);
  let scroller = $state<HTMLElement>();
  const selected = new SvelteSet<string>();
  const picked = $derived(items.filter((c) => selected.has(c.name)));
  const current = $derived(mode === 'view' ? (items[index] ?? null) : null);

  function leave() {
    if (mode !== 'grid') history.back();
  }
  function enterSelect(c: Capture) {
    selected.clear();
    selected.add(c.name);
    mode = 'select';
    history.pushState({ hmc: 'select' }, '');
  }
  function enterView(i: number) {
    index = i;
    chrome = true;
    infoOpen = false;
    dragX = dragY = 0;
    settle = false;
    resetZoom();
    mode = 'view';
    history.pushState({ hmc: 'view' }, '');
  }

  onMount(() => {
    history.pushState({ hmc: 'gallery' }, '');
    const pop = async () => {
      if (mode === 'grid') return onclose();
      const name = mode === 'view' ? items[index]?.name : undefined;
      mode = 'grid';
      selected.clear();
      if (name) {
        // the roll lands on the capture the viewer ended on
        await tick();
        scroller?.querySelector(`[data-name="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') history.back();
      else if (mode === 'view' && e.key === 'ArrowLeft') go(-1);
      else if (mode === 'view' && e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('popstate', pop);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('popstate', pop);
      window.removeEventListener('keydown', key);
    };
  });

  // a deletion elsewhere (or here) may leave the viewer / selection pointing at nothing
  $effect(() => {
    if (mode === 'view') {
      if (items.length === 0) leave();
      else if (index >= items.length) index = items.length - 1;
    } else if (mode === 'select') {
      const names = new Set(items.map((c) => c.name));
      for (const n of [...selected]) if (!names.has(n)) selected.delete(n);
      if (selected.size === 0) leave();
    }
  });

  // two-step delete: the first press arms the key for 3 s
  let armed = $state(false);
  let armTimer: ReturnType<typeof setTimeout>;
  $effect(() => {
    mode;
    index;
    armed = false;
  });
  function confirmed(run: () => void) {
    if (!armed) {
      armed = true;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => (armed = false), 3000);
      return;
    }
    clearTimeout(armTimer);
    armed = false;
    run();
  }
  function remove(list: Capture[]) {
    list.forEach(forgetThumb);
    ondelete(list);
    if (mode === 'select') selected.clear();
  }

  // ---- thumbnails, requested when a cell nears the screen
  let thumbs = $state<Record<string, Thumb>>({});
  function lazy(node: HTMLElement, c: Capture) {
    let alive = true;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        thumbnail(c).then((t) => alive && t && (thumbs[c.name] = t));
      },
      { root: node.closest('.scroll'), rootMargin: '400px 0px' },
    );
    io.observe(node);
    return {
      destroy() {
        alive = false;
        io.disconnect();
      },
    };
  }

  // ---- the grid: tap opens, long press selects
  let press: { x: number; y: number; fired: boolean; timer: ReturnType<typeof setTimeout> } | null = null;
  function cellDown(e: PointerEvent, c: Capture) {
    if (press) clearTimeout(press.timer);
    press = null;
    if (mode !== 'grid') return;
    const p = {
      x: e.clientX,
      y: e.clientY,
      fired: false,
      timer: setTimeout(() => {
        p.fired = true;
        buzz(12);
        enterSelect(c);
      }, 450),
    };
    press = p;
  }
  function cellMove(e: PointerEvent) {
    if (press && !press.fired && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) clearTimeout(press.timer);
  }
  function cellUp() {
    if (press) clearTimeout(press.timer);
  }
  function cellClick(c: Capture) {
    const fired = press?.fired;
    press = null;
    if (fired) return;
    if (mode === 'select') toggle(c);
    else enterView(items.indexOf(c));
  }
  function toggle(c: Capture) {
    if (selected.has(c.name)) selected.delete(c.name);
    else selected.add(c.name);
    if (selected.size === 0) leave();
  }
  const dayAll = (g: { items: Capture[] }) => g.items.every((c) => selected.has(c.name));
  function toggleDay(g: { items: Capture[] }) {
    const all = dayAll(g);
    for (const c of g.items) {
      if (all) selected.delete(c.name);
      else selected.add(c.name);
    }
    if (selected.size === 0) leave();
  }

  // ---- the viewer
  let stage = $state<HTMLElement>();
  let dragX = $state(0);
  let dragY = $state(0);
  let scale = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let settle = $state(false); // steps the release, never the drag
  let chrome = $state(true);
  let infoOpen = $state(false);
  const slides = $derived([index - 1, index, index + 1].filter((i) => i >= 0 && i < items.length));
  const media = $derived(`translate(${panX}px, ${panY}px) scale(${scale})`);

  // full-size files, as object URLs only while the viewer is open
  const fileUrls = new Map<string, string>();
  function fileUrl(c: Capture) {
    let u = fileUrls.get(c.name);
    if (!u) fileUrls.set(c.name, (u = URL.createObjectURL(c.file)));
    return u;
  }
  $effect(() => {
    if (mode === 'view') return;
    fileUrls.forEach((u) => URL.revokeObjectURL(u));
    fileUrls.clear();
  });

  function resetZoom() {
    scale = 1;
    panX = panY = 0;
  }
  function go(d: number) {
    const next = index + d;
    if (mode !== 'view' || next < 0 || next >= items.length) return;
    settle = true;
    index = next;
    dragX = dragY = 0;
    chrome = true;
    infoOpen = false;
    resetZoom();
  }

  const pts = new Map<number, { x: number; y: number }>();
  let g = { x0: 0, y0: 0, t0: 0, moved: false, axis: '' as '' | 'x' | 'y' | 'pan' | 'pinch', panX0: 0, panY0: 0, scale0: 1, dist0: 1, mx0: 0, my0: 0 };
  let lastTap = { t: 0, x: 0, y: 0 };
  let tapTimer: ReturnType<typeof setTimeout>;

  function center() {
    const r = stage!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }
  function pair() {
    const [a, b] = [...pts.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  function down(e: PointerEvent) {
    try {
      stage!.setPointerCapture(e.pointerId);
    } catch {}
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    settle = false;
    if (pts.size === 1) {
      g = { ...g, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, axis: '', panX0: panX, panY0: panY };
    } else if (pts.size === 2) {
      const p = pair();
      g = { ...g, axis: 'pinch', moved: true, scale0: scale, dist0: p.dist, mx0: p.mx, my0: p.my, panX0: panX, panY0: panY };
      dragX = dragY = 0;
    }
  }

  function move(e: PointerEvent) {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2) {
      // the content point under the fingers stays under them
      const c = center();
      const p = pair();
      const s = clamp((g.scale0 * p.dist) / g.dist0, 1, 6);
      panX = p.mx - c.x - (s * (g.mx0 - c.x - g.panX0)) / g.scale0;
      panY = p.my - c.y - (s * (g.my0 - c.y - g.panY0)) / g.scale0;
      scale = s;
      return;
    }
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) > 8) {
      g.moved = true;
      g.axis = scale > 1.02 ? 'pan' : Math.abs(dx) > Math.abs(dy) ? 'x' : dy > 0 ? 'y' : '';
    }
    if (g.axis === 'x') {
      const edge = (dx > 0 && index === 0) || (dx < 0 && index === items.length - 1);
      dragX = edge ? dx / 3 : dx;
    } else if (g.axis === 'y') dragY = Math.max(0, dy);
    else if (g.axis === 'pan') {
      panX = g.panX0 + dx;
      panY = g.panY0 + dy;
    }
  }

  function up(e: PointerEvent) {
    if (!pts.delete(e.pointerId)) return;
    if (pts.size === 1) {
      // one finger left after a pinch: carry on as a pan from where it is
      const [p] = [...pts.values()];
      g = { ...g, x0: p.x, y0: p.y, panX0: panX, panY0: panY, axis: 'pan', moved: true };
      return;
    }
    if (pts.size > 0) return;
    settle = true;
    const c = center();
    if (g.axis === 'pinch' || g.axis === 'pan') {
      if (scale < 1.05) resetZoom();
      else {
        const mx = ((scale - 1) * c.w) / 2;
        const my = ((scale - 1) * c.h) / 2;
        panX = clamp(panX, -mx, mx);
        panY = clamp(panY, -my, my);
      }
    } else if (g.axis === 'x') {
      const dt = Math.max(1, performance.now() - g.t0);
      const fast = Math.abs(dragX) > 30 && Math.abs(dragX) / dt > 0.5;
      if ((Math.abs(dragX) > c.w * 0.2 || fast) && dragX !== 0) {
        const d = dragX < 0 ? 1 : -1;
        if (index + d >= 0 && index + d < items.length) return go(d);
      }
      dragX = 0;
    } else if (g.axis === 'y') {
      if (dragY > 120) return leave();
      dragY = 0;
    } else if (!g.moved && performance.now() - g.t0 < 350) tap(e.clientX, e.clientY);
  }

  function cancel(e: PointerEvent) {
    pts.delete(e.pointerId);
    if (pts.size === 0) {
      settle = true;
      dragX = dragY = 0;
      if (scale < 1.05) resetZoom();
    }
  }

  // a single tap shows / hides the bars (or plays / pauses a video); two taps zoom
  function tap(x: number, y: number) {
    const now = performance.now();
    const c = current;
    if (c?.video) return togglePlay();
    if (now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
      clearTimeout(tapTimer);
      lastTap.t = 0;
      if (scale > 1) resetZoom();
      else {
        const k = center();
        scale = 2.5;
        panX = clamp((x - k.x) * (1 - scale), -((scale - 1) * k.w) / 2, ((scale - 1) * k.w) / 2);
        panY = clamp((y - k.y) * (1 - scale), -((scale - 1) * k.h) / 2, ((scale - 1) * k.h) / 2);
      }
      return;
    }
    lastTap = { t: now, x, y };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => (chrome = !chrome), 300);
  }

  // ---- video
  let video = $state<HTMLVideoElement>();
  let playing = $state(false);
  let vtime = $state(0);
  let vdur = $state(0);
  function togglePlay() {
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }
  function seek(e: PointerEvent) {
    if (!video || !vdur || (e.type === 'pointermove' && !e.buttons)) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    video.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * vdur;
  }
  $effect(() => {
    // a new current capture starts from zero; videos autoplay and hide the bars while they play
    index;
    playing = false;
    vtime = vdur = 0;
  });

  const dims = (c: Capture) => {
    const t = thumbs[c.name];
    return t ? `${t.width}×${t.height}` : '';
  };
</script>

<div class="gallery">
  <header class="bar top grid-bar">
    {#if mode === 'select'}
      <button class="key" type="button" onclick={leave} aria-label="Cancelar selección">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 13 13M13 3 3 13" /></svg>
      </button>
      <span class="sel-count">{two(selected.size)}</span>
      <span class="label muted grow">{selected.size === 1 ? 'SELECCIONADA' : 'SELECCIONADAS'}</span>
      <button class="tool label" type="button" onclick={() => items.forEach((c) => selected.add(c.name))}>TODAS</button>
    {:else}
      <button class="key" type="button" onclick={() => history.back()} aria-label="Volver a la cámara">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8H3M8 3 3 8 8 13" /></svg>
      </button>
      <h1>GALERÍA</h1>
      <span class="grow"></span>
      <span class="total">{String(items.length).padStart(4, '0')}</span>
    {/if}
  </header>

  <div class="scroll" bind:this={scroller}>
    {#if items.length === 0}
      <p class="empty label">NADA TODAVÍA. TOCA PARA FOTO.</p>
    {:else}
      {#each groups as grp (grp.day)}
        <section>
          <h2 class="day label">
            <span>{grp.label}</span>
            <i></i>
            {#if mode === 'select'}
              <button class="daykey label" type="button" onclick={() => toggleDay(grp)}>{dayAll(grp) ? 'QUITAR' : 'TODO'}</button>
            {:else}
              <span class="muted">{String(grp.items.length).padStart(2, '0')}</span>
            {/if}
          </h2>
          <ul class="grid">
            {#each grp.items as c (c.name)}
              {@const t = thumbs[c.name]}
              {@const on = selected.has(c.name)}
              <li>
                <button
                  type="button"
                  class="cell cut-br"
                  class:on
                  data-name={c.name}
                  use:lazy={c}
                  onpointerdown={(e) => cellDown(e, c)}
                  onpointermove={cellMove}
                  onpointerup={cellUp}
                  onpointercancel={cellUp}
                  onclick={() => cellClick(c)}
                  oncontextmenu={(e) => e.preventDefault()}
                  aria-label="{c.video ? 'Vídeo' : 'Foto'} {c.name}, {clock(c.time)}"
                  aria-pressed={mode === 'select' ? on : undefined}
                >
                  <span class="well">{#if t}<img src={t.url} alt="" draggable="false" />{/if}</span>
                  {#if c.video}
                    <span class="badge">
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2 14 8 4 14Z" /></svg>
                      {#if t?.duration}<b>{mmss(t.duration)}</b>{/if}
                    </span>
                  {/if}
                  {#if mode === 'select'}
                    <span class="check" class:on>
                      {#if on}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4" /></svg>{/if}
                    </span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  </div>

  {#if mode === 'select'}
    <footer class="bar bottom grid-bar">
      <button class="tool label" type="button" onclick={() => onshare(picked)}>COMPARTIR</button>
      <button class="tool label" class:armed type="button" onclick={() => confirmed(() => remove(picked))}>{armed ? 'SEGURO' : 'BORRAR'}</button>
    </footer>
  {/if}

  {#if mode === 'view' && current}
    <div class="viewer" class:settle role="dialog" aria-modal="true" aria-label="{current.video ? 'Vídeo' : 'Foto'} {current.name}">
      <div
        class="stage"
        bind:this={stage}
        onpointerdown={down}
        onpointermove={move}
        onpointerup={up}
        onpointercancel={cancel}
        role="presentation"
      >
        {#each slides as i (items[i].name)}
          {@const c = items[i]}
          <div class="slide" style:transform="translate3d(calc({(i - index) * 100}% + {dragX}px), {dragY}px, 0)">
            {#if c.video && i === index}
              <video
                bind:this={video}
                class="media"
                src={fileUrl(c)}
                poster={thumbs[c.name]?.url}
                style:transform={media}
                autoplay
                loop
                muted
                playsinline
                onplay={() => ((playing = true), (chrome = false))}
                onpause={() => ((playing = false), (chrome = true))}
                ontimeupdate={(e) => (vtime = e.currentTarget.currentTime)}
                onloadedmetadata={(e) => (vdur = e.currentTarget.duration)}
              ></video>
            {:else if c.video}
              {#if thumbs[c.name]}<img class="media" src={thumbs[c.name].url} alt="" draggable="false" />{/if}
            {:else}
              <img class="media" src={fileUrl(c)} alt={c.name} draggable="false" style:transform={i === index ? media : null} />
            {/if}
          </div>
        {/each}
      </div>

      {#if current.video && !playing}
        <span class="bigplay" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 2 14 8 4 14Z" /></svg></span>
      {/if}

      <header class="bar top" class:gone={!chrome}>
        <button class="key" type="button" onclick={leave} aria-label="Volver a la galería">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8H3M8 3 3 8 8 13" /></svg>
        </button>
        <div class="when grow">
          <span class="label">{dayLabel(current.time)} · {clock(current.time)}</span>
          <span class="label muted">{current.name}</span>
        </div>
        <span class="total">{two(index + 1)}/{two(items.length)}</span>
      </header>

      <footer class="bar bottom" class:gone={!chrome}>
        {#if infoOpen}
          <dl class="info label">
            <dt>ARCHIVO</dt><dd>{current.name}</dd>
            <dt>FECHA</dt><dd>{dayLabel(current.time)} · {clock(current.time)}</dd>
            <dt>PESO</dt><dd>{weight(current.size)}</dd>
            {#if dims(current)}<dt>TAMAÑO</dt><dd>{dims(current)}</dd>{/if}
            {#if current.video && vdur}<dt>DURACIÓN</dt><dd>{mmss(vdur)}</dd>{/if}
          </dl>
        {/if}
        {#if current.video}
          <div class="player">
            <span class="clock">{mmss(vtime)}</span>
            <div class="seek" role="slider" tabindex="0" aria-label="Posición" aria-valuemin="0" aria-valuemax={Math.round(vdur)} aria-valuenow={Math.round(vtime)} onpointerdown={seek} onpointermove={seek}>
              <i style:width="{vdur ? (vtime / vdur) * 100 : 0}%"></i>
            </div>
            <span class="clock">{mmss(vdur)}</span>
          </div>
        {/if}
        <div class="keys">
          <button class="tool label" type="button" onclick={() => onshare([current])}>COMPARTIR</button>
          <button class="tool label" type="button" onclick={() => onsave(current)}>GUARDAR</button>
          <button class="tool label" class:lit={infoOpen} type="button" onclick={() => (infoOpen = !infoOpen)}>INFO</button>
          <button class="tool label" class:armed type="button" onclick={() => confirmed(() => remove([current]))}>{armed ? 'SEGURO' : 'BORRAR'}</button>
        </div>
      </footer>
    </div>
  {/if}
</div>

<style>
  .gallery {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    background: var(--viewfinder);
    color: var(--ink);
    padding-top: env(safe-area-inset-top, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .muted {
    color: var(--ink-muted);
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: butt;
    stroke-linejoin: miter;
  }

  /* ---- bars: solid plates, no transparency */
  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: var(--panel);
    flex-shrink: 0;
  }
  .grid-bar.top {
    border-bottom: 1px solid var(--lagoon);
  }
  .grid-bar.bottom {
    border-top: 1px solid var(--lagoon);
    padding-bottom: calc(var(--space-2) + env(safe-area-inset-bottom, 0px));
  }
  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 400;
    font-size: 32px;
    line-height: 1;
    text-transform: uppercase;
  }
  .total,
  .sel-count {
    font-family: var(--font-dot);
    font-weight: 800;
    font-size: 24px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .sel-count {
    color: var(--acid);
    font-size: 32px;
  }
  .key,
  .tool,
  .daykey {
    border-radius: var(--radius-0);
    cursor: pointer;
  }
  .key {
    width: 48px;
    height: 48px;
    padding: 0;
    display: grid;
    place-items: center;
    border: 1px solid var(--lagoon);
    background: var(--panel);
    flex-shrink: 0;
  }
  .tool {
    flex: 1;
    min-height: 48px;
    padding: 0 var(--space-2);
    border: 1px solid var(--lagoon);
    background: var(--panel);
    color: var(--ink);
  }
  .key:active,
  .tool:active {
    background: var(--panel-deep);
  }
  .tool.lit {
    border-color: var(--acid);
    color: var(--acid);
  }
  .tool.armed {
    background: var(--flash);
    border-color: var(--flash);
    color: var(--ink-fixed);
  }
  .top .tool {
    flex: 0 0 auto;
  }
  .key:focus-visible,
  .tool:focus-visible,
  .daykey:focus-visible,
  .cell:focus-visible {
    outline: var(--stroke) solid var(--focus);
    outline-offset: calc(var(--stroke) * -1);
  }

  /* ---- the roll */
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: none;
    /* .screen is touch-action: none: the roll scrolls on its own */
    touch-action: pan-y;
  }
  .scroll::-webkit-scrollbar {
    display: none;
  }
  .empty {
    margin: 0;
    padding: var(--space-12) var(--space-6);
    text-align: center;
    color: var(--ink-muted);
  }
  /* the day, as a rule across the roll (the rail of the effect strip) */
  .day {
    position: sticky;
    top: 0;
    z-index: 1;
    margin: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4) var(--space-2);
    background: var(--viewfinder);
    font-weight: 500;
  }
  .day i {
    flex: 1;
    height: 1px;
    background: var(--lagoon);
  }
  .daykey {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--lagoon);
    background: var(--panel);
    color: var(--ink);
  }
  .grid {
    list-style: none;
    margin: 0;
    padding: 0 0 var(--space-2);
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 2px;
  }
  .cell {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 1;
    padding: 0;
    border: 0;
    border-radius: var(--radius-0);
    background: var(--panel);
    cursor: pointer;
    overflow: hidden;
  }
  .well {
    position: absolute;
    inset: 0;
    background: var(--panel);
  }
  .on .well {
    background: var(--panel-deep);
  }
  .cell img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform var(--tick) var(--ease-step);
  }
  /* picked: the picture sinks into its slot, as on the phone's own gallery */
  .cell.on img {
    transform: scale(0.8);
  }
  .badge {
    position: absolute;
    left: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0 var(--space-2) 0 var(--space-1);
    height: 20px;
    background: var(--panel);
  }
  .badge svg {
    width: 10px;
    height: 10px;
    fill: var(--ink);
    stroke: none;
  }
  .badge b {
    font-family: var(--font-dot);
    font-weight: 800;
    font-size: 14px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .check {
    position: absolute;
    left: var(--space-1);
    top: var(--space-1);
    width: 20px;
    height: 20px;
    box-sizing: border-box;
    display: grid;
    place-items: center;
    border: var(--stroke) solid var(--ink);
    background: var(--panel);
  }
  .check.on {
    border-color: var(--acid);
    background: var(--acid);
    color: var(--ink-fixed);
  }
  .check svg {
    width: 12px;
    height: 12px;
  }

  /* ---- the viewer: floor-coloured, bars overlay it */
  .viewer {
    position: absolute;
    inset: 0;
    z-index: 2;
    background: var(--viewfinder);
    overflow: hidden;
  }
  .stage {
    position: absolute;
    inset: 0;
    touch-action: none;
  }
  .slide {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  .media {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
    user-select: none;
    -webkit-user-drag: none;
  }
  .settle .slide,
  .settle .media {
    transition: transform var(--clack) var(--ease-step);
  }
  .viewer .bar {
    position: absolute;
    left: 0;
    right: 0;
    transition: transform var(--clack) var(--ease-step);
  }
  .viewer .top {
    top: 0;
    padding-top: calc(var(--space-2) + env(safe-area-inset-top, 0px));
    border-bottom: 1px solid var(--lagoon);
  }
  .viewer .bottom {
    bottom: 0;
    flex-direction: column;
    align-items: stretch;
    padding-bottom: calc(var(--space-2) + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--lagoon);
  }
  .viewer .top.gone {
    transform: translateY(-100%);
  }
  .viewer .bottom.gone {
    transform: translateY(100%);
  }
  .when {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    overflow: hidden;
  }
  .when .label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .keys {
    display: flex;
    gap: var(--space-2);
  }
  .info {
    margin: 0;
    padding: var(--space-2);
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-1) var(--space-4);
    background: var(--panel-deep);
  }
  .info dt {
    color: var(--ink-muted);
  }
  .info dd {
    margin: 0;
    color: var(--ink);
    text-align: right;
  }
  .player {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .clock {
    font-family: var(--font-dot);
    font-weight: 800;
    font-size: 16px;
    line-height: 1;
    min-width: 36px;
    font-variant-numeric: tabular-nums;
  }
  .clock:last-child {
    text-align: right;
  }
  /* a 2 px rule inside a 48 px strip, so a thumb can find it */
  .seek {
    position: relative;
    flex: 1;
    height: 32px;
    touch-action: none;
    cursor: pointer;
  }
  .seek::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 15px;
    height: var(--stroke);
    background: var(--lagoon);
  }
  .seek i {
    position: absolute;
    left: 0;
    top: 15px;
    height: var(--stroke);
    background: var(--acid);
  }
  .bigplay {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 64px;
    height: 64px;
    transform: translate(-50%, -50%);
    display: grid;
    place-items: center;
    border: 1px solid var(--lagoon);
    background: var(--panel);
    pointer-events: none;
  }
  .bigplay svg {
    width: 28px;
    height: 28px;
    fill: var(--ink);
    stroke: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .settle .slide,
    .settle .media,
    .viewer .bar,
    .cell img {
      transition: none;
    }
  }
</style>
