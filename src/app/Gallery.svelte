<script lang="ts">
  // The captured photos and recordings: a grid, and a viewer with share / save / delete.
  import type { Capture } from '../capture/store';

  interface Props {
    items: Capture[];
    onclose: () => void;
    onshare: (c: Capture) => void;
    onsave: (c: Capture) => void;
    ondelete: (c: Capture) => void;
    onclear: () => void;
  }
  let { items, onclose, onshare, onsave, ondelete, onclear }: Props = $props();

  // one object URL per file, revoked when the list changes or the gallery closes
  let urls = $state<Record<string, string>>({});
  $effect(() => {
    const made: Record<string, string> = {};
    for (const c of items) made[c.name] = URL.createObjectURL(c.file);
    urls = made;
    return () => Object.values(made).forEach((u) => URL.revokeObjectURL(u));
  });

  let openName = $state<string | null>(null);
  const open = $derived(items.find((c) => c.name === openName) ?? null);
  let armed = $state(false); // two-step "borrar todo"

  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  const when = (t: number) => {
    const d = new Date(t);
    const two = (n: number) => String(n).padStart(2, '0');
    return `${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`;
  };

  function remove(c: Capture) {
    openName = null;
    ondelete(c);
  }
  function clearAll() {
    if (!armed) {
      armed = true;
      setTimeout(() => (armed = false), 3000);
      return;
    }
    armed = false;
    onclear();
  }
</script>

<div class="gallery">
  <header>
    <button class="label tool" type="button" onclick={() => (open ? (openName = null) : onclose())}>
      {open ? 'ATRÁS' : 'CERRAR'}
    </button>
    <span class="label count">{items.length} {items.length === 1 ? 'CAPTURA' : 'CAPTURAS'}</span>
    {#if !open && items.length}
      <button class="label tool" class:armed type="button" onclick={clearAll}>{armed ? 'SEGURO' : 'BORRAR TODO'}</button>
    {/if}
  </header>

  {#if open}
    <div class="viewer">
      {#if open.video}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={urls[open.name]} controls playsinline autoplay loop></video>
      {:else}
        <img src={urls[open.name]} alt={open.name} />
      {/if}
      <div class="meta label"><span>{open.name}</span><span>{when(open.time)} · {mb(open.size)}</span></div>
      <div class="actions">
        <button class="label tool" type="button" onclick={() => onshare(open)}>COMPARTIR</button>
        <button class="label tool" type="button" onclick={() => onsave(open)}>GUARDAR</button>
        <button class="label tool danger" type="button" onclick={() => remove(open)}>BORRAR</button>
      </div>
    </div>
  {:else if items.length === 0}
    <p class="empty label">NADA TODAVÍA. TOCA PARA FOTO, MANTÉN PARA GRABAR.</p>
  {:else}
    <ul class="grid">
      {#each items as c (c.name)}
        <li>
          <button type="button" class="cell" onclick={() => (openName = c.name)} aria-label="Abrir {c.name}">
            {#if urls[c.name]}
              {#if c.video}
                <video src="{urls[c.name]}#t=0.1" preload="metadata" muted playsinline></video>
              {:else}
                <img src={urls[c.name]} alt="" loading="lazy" />
              {/if}
            {/if}
            <span class="n label">{c.name.slice(4, 8)}{c.video ? ' MP4' : ''}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .gallery {
    position: absolute;
    inset: 0;
    z-index: 5;
    background: var(--viewfinder);
    color: var(--ink);
    display: flex;
    flex-direction: column;
    padding-top: env(safe-area-inset-top, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4);
    border-bottom: 1px solid var(--lagoon);
  }
  .count {
    flex: 1;
    color: var(--ink-muted);
  }
  .tool {
    min-height: 48px;
    padding: 0 var(--space-3);
    border: 1px solid var(--lagoon);
    border-radius: var(--radius-0);
    background: none;
    color: var(--ink);
    cursor: pointer;
  }
  .tool:active,
  .tool.armed {
    border-color: var(--acid);
    color: var(--acid);
  }
  .tool.danger:active,
  .tool.armed {
    border-color: var(--flash);
    color: var(--flash);
  }
  .tool:focus-visible {
    outline: var(--stroke) solid var(--focus);
  }
  .empty {
    margin: auto;
    padding: var(--space-6);
    text-align: center;
    color: var(--ink-muted);
  }
  .grid {
    list-style: none;
    margin: 0;
    padding: var(--space-2);
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-2);
    overflow-y: auto;
    touch-action: pan-y;
  }
  .cell {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 3 / 4;
    padding: 0;
    border: 1px solid var(--lagoon);
    border-radius: var(--radius-0);
    background: var(--panel);
    cursor: pointer;
    overflow: hidden;
  }
  .cell:focus-visible {
    outline: var(--stroke) solid var(--focus);
  }
  .cell img,
  .cell video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .cell .n {
    position: absolute;
    left: 0;
    bottom: 0;
    background: var(--panel);
    padding: 0 var(--space-1);
    font-size: 10px;
    line-height: 12px;
  }
  .viewer {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2);
  }
  .viewer img,
  .viewer video {
    flex: 1;
    min-height: 0;
    width: 100%;
    object-fit: contain;
    background: var(--panel-deep);
  }
  .meta {
    display: flex;
    justify-content: space-between;
    color: var(--ink-muted);
  }
  .actions {
    display: flex;
    gap: var(--space-2);
    padding-bottom: var(--space-4);
  }
  .actions .tool {
    flex: 1;
    padding: 0;
  }
</style>
