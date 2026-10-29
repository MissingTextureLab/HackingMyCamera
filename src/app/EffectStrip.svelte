<script lang="ts">
  import type { EffectGraph } from '../graph/types';

  interface Props {
    effects: EffectGraph[];
    selected: string;
    onselect: (id: string) => void;
  }
  let { effects, selected, onselect }: Props = $props();

  // Static thumbnails in each effect's own Citrink ramp; live thumbnails come in H2.
  const THUMBS: Record<string, string> = {
    crudo: 'linear-gradient(180deg, #254d70 0 50%, #166e7a 50%)',
    trama: 'repeating-conic-gradient(#b2d942 0 25%, #201533 0 50%) 0 0 / 6px 6px',
    espejo: 'conic-gradient(from 45deg, #201533 0 25%, #166e7a 0 50%, #52c33f 0 75%, #fcf660 0)',
    muda: 'repeating-linear-gradient(0deg, #201533 0 6px, #254d70 6px 12px, #166e7a 12px 18px, #b2d942 18px 24px)',
  };
</script>

<div class="strip" role="group" aria-label="Efectos">
  {#each effects as fx (fx.id)}
    <button class="fx" type="button" aria-pressed={fx.id === selected} onclick={() => onselect(fx.id)}>
      <span class="thumb" style:background={THUMBS[fx.id]}></span>
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
  }
  .fx {
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
  .thumb {
    width: 48px;
    height: 48px;
    border-radius: var(--radius-0);
    outline: 1px solid var(--lagoon);
    background: var(--panel);
  }
  .code {
    background: var(--panel);
    color: var(--ink);
    font-size: 9px;
    padding: 0 var(--space-1);
  }
  .fx[aria-pressed='true'] .thumb {
    outline: 2px solid var(--acid);
    outline-offset: 2px;
  }
  .fx[aria-pressed='true'] .code {
    background: var(--acid);
    color: var(--ink-fixed);
  }
</style>
