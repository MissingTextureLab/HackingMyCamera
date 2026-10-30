<script lang="ts">
  import type { EffectGraph } from '../graph/types';

  interface Props {
    effects: EffectGraph[];
    selected: string;
    onselect: (id: string) => void;
    /** Each thumbnail canvas, handed over once so the render worker can draw it live. */
    onthumb: (id: string, canvas: OffscreenCanvas) => void;
  }
  let { effects, selected, onselect, onthumb }: Props = $props();

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
    <button class="fx" type="button" aria-pressed={fx.id === selected} onclick={() => onselect(fx.id)}>
      <i class="tick" aria-hidden="true"></i>
      <span class="slot cut-br"><canvas class="thumb cut-br" use:live={fx.id} aria-hidden="true"></canvas></span>
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
