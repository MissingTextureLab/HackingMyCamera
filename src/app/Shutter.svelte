<script lang="ts">
  // Tap only (the fingers stay free for the parameters): in photo mode a tap
  // shoots; in video mode a tap starts the recording and the next one stops it.
  interface Props {
    recording: boolean;
    mode: 'photo' | 'video';
    onphoto: () => void;
    onrecstart: () => void;
    onrecstop: () => void;
  }
  let { recording, mode, onphoto, onrecstart, onrecstop }: Props = $props();

  let down = $state(false);

  function press(e: PointerEvent) {
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    down = true;
  }

  function fire() {
    if (mode === 'video' || recording) {
      if (recording) onrecstop();
      else onrecstart();
    } else onphoto();
  }

  function release() {
    if (!down) return;
    down = false;
    fire();
  }

  function cancel() {
    down = false;
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fire();
    }
  }
</script>

<button
  class="shutter"
  class:down
  class:rec={recording}
  class:video={mode === 'video'}
  type="button"
  aria-label={recording ? 'Parar grabación' : mode === 'video' ? 'Empezar a grabar' : 'Foto'}
  onpointerdown={press}
  onpointerup={release}
  onpointercancel={cancel}
  onkeydown={key}
><i></i></button>

<style>
  .shutter {
    justify-self: center;
    width: 76px;
    height: 76px;
    border-radius: var(--radius-knob);
    background: var(--panel);
    border: 2px solid var(--ink);
    display: grid;
    place-items: center;
    padding: 0;
    cursor: pointer;
    touch-action: none;
    position: relative;
  }
  /* reticle ring around the main piece; flash while recording */
  .shutter::before {
    content: '';
    position: absolute;
    inset: -10px;
    border-radius: var(--radius-knob);
    border: 1px solid var(--lagoon);
    pointer-events: none;
  }
  .rec::before,
  .video::before {
    border-color: var(--flash);
  }
  .video:not(.rec) i {
    background: var(--flash);
  }
  .shutter:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 3px;
  }
  i {
    display: block;
    width: 52px;
    height: 52px;
    border-radius: var(--radius-knob);
    background: var(--ink);
    transition:
      background var(--tick) var(--ease-step),
      width var(--tick) var(--ease-step),
      height var(--tick) var(--ease-step),
      border-radius var(--tick) var(--ease-step);
  }
  .down i {
    background: var(--panel-deep);
  }
  .rec i {
    background: var(--flash);
    width: 28px;
    height: 28px;
    border-radius: var(--radius-0);
  }
</style>
