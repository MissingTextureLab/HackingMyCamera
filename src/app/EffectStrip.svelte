<script lang="ts">
  import type { EffectGraph } from '../graph/types';

  interface Props {
    effects: EffectGraph[];
    selected: string;
    favs: string[];
    onselect: (id: string) => void;
    /** Long press: add to / remove from the favourites (they lead the strip). */
    onfav: (id: string) => void;
    /** Each thumbnail canvas, handed over once so the render worker can draw it live. */
    onthumb: (id: string, canvas: OffscreenCanvas) => void;
  }
  let { effects, selected, favs, onselect, onfav, onthumb }: Props = $props();

  const HOLD_MS = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let held = false;
  function press(id: string) {
    held = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      held = true;
      onfav(id);
    }, HOLD_MS);
  }
  const release = () => clearTimeout(timer);
  function choose(id: string) {
    // the click that ends a long press must not select the effect
    if (held) held = false;
    else onselect(id);
  }

  const SIZE = 48;

  function live(canvas: HTMLCanvasElement, id: string) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(SIZE * dpr);
    canvas.height = Math.round(SIZE * dpr);
    onthumb(id, canvas.transferControlToOffscreen());
  }
</script>

<div class="strip" role="group" aria-label="Efectos">
  {#each effects as fx (fx.id)}
    <button
      class="fx"
      type="button"
      aria-pressed={fx.id === selected}
      aria-label="{fx.code} {fx.name}{favs.includes(fx.id) ? ', favorito' : ''}. Mantén pulsado para marcar favorito"
      onpointerdown={() => press(fx.id)}
      onpointerup={release}
      onpointerleave={release}
      onpointercancel={release}
      oncontextmenu={(e) => e.preventDefault()}
      onclick={() => choose(fx.id)}
    >
      <i class="tick" aria-hidden="true"></i>
      <span class="slot cut-br"><canvas class="thumb cut-br" use:live={fx.id} aria-hidden="true"></canvas></span>
      {#if favs.includes(fx.id)}<i class="fav" aria-hidden="true"></i>{/if}
      <span class="code label">{fx.code} {fx.name}</span>
    </button>
  {/each}
</div>

<style>
  .strip {
    display: flex;
    gap: var(--space-2);
    overflow-x: auto;
    scrollbar-width: none;
    touch-action: pan-x;
    /* reaches up over the rail (App .rail) so each thumbnail can put its tick
       on the line; the extra 4px on the sides are room for the brackets */
    padding: 24px 4px 0;
    margin: -24px -4px 0;
  }
  .fx {
    position: relative;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-start;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  /* favourite: an acid square on the slot's top right corner */
  .fav {
    position: absolute;
    top: 0;
    right: 0;
    width: 8px;
    height: 8px;
    background: var(--acid);
    pointer-events: none;
  }
  .fx:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 4px;
  }
  /* inventory slot: 1px lagoon frame that follows the chamfer */
  .slot {
    display: block;
    width: 48px;
    height: 48px;
    padding: 1px;
    box-sizing: border-box;
    background: var(--lagoon);
  }
  .thumb {
    display: block;
    width: 100%;
    height: 100%;
    background: var(--panel);
  }
  /* timeline tick on the rail line, centred over the thumbnail; the selected
     one is the playhead */
  .tick {
    position: absolute;
    top: -16px;
    left: 23px;
    width: 1px;
    height: 4px;
    background: var(--lagoon);
  }
  .fx[aria-pressed='true'] .tick {
    top: -18px;
    width: var(--stroke);
    height: 8px;
    background: var(--acid);
  }
  .code {
    background: var(--panel);
    color: var(--ink);
    font-size: 10px;
    padding: 0 var(--space-1);
    white-space: nowrap;
  }
  .fx[aria-pressed='true'] .slot {
    background: var(--acid);
  }
  /* selection: two acid brackets on opposite corners of the slot */
  .fx[aria-pressed='true']::before,
  .fx[aria-pressed='true']::after {
    content: '';
    position: absolute;
    width: var(--bracket);
    height: var(--bracket);
    border: 0 solid var(--acid);
  }
  .fx[aria-pressed='true']::before {
    top: -4px;
    left: -4px;
    border-top-width: var(--stroke);
    border-left-width: var(--stroke);
  }
  .fx[aria-pressed='true']::after {
    top: 40px;
    left: 40px;
    border-right-width: var(--stroke);
    border-bottom-width: var(--stroke);
  }
  .fx[aria-pressed='true'] .code {
    background: var(--acid);
    color: var(--ink-fixed);
  }
</style>
