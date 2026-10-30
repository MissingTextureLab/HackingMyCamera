// Multi-touch gestures on the viewfinder (DESIGN.md, Gestos):
//   1 finger drag   → macros A (x) and B (inverted y), absolute position
//   2 finger pinch  → zoom, relative to the zoom when the pinch began
//   2 finger twist  → macro C, relative
//   double tap      → reset macros and zoom
// It also keeps the raw touch state that the `touch.*` signals read.

export interface TouchState {
  down: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  count: number;
  pinch: number;
}

export interface GestureHandlers {
  onDrag(x: number, y: number): void;
  onPinch(scale: number): void;
  onTwist(radians: number): void;
  onDoubleTap(): void;
  onStart(kind: 'drag' | 'pinch'): void;
  onEnd(): void;
  /** After every pointer event, with the updated touch state. */
  onTouch(state: TouchState): void;
}

interface Pt {
  x: number;
  y: number;
}

const DOUBLE_TAP_MS = 300;
const TAP_SLOP_PX = 12;

export class Gestures {
  readonly touch: TouchState = { down: 0, x: 0.5, y: 0.5, vx: 0, vy: 0, count: 0, pinch: 1 };
  private pts = new Map<number, Pt>();
  private start: { dist: number; angle: number } | null = null;
  private mode: 'none' | 'drag' | 'pinch' = 'none';
  private lastTap = 0;
  private tapOrigin: Pt | null = null;
  private moved = false;
  private lastMove = 0;

  constructor(
    private el: HTMLElement,
    private h: GestureHandlers,
  ) {
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.up);
  }

  destroy() {
    this.el.removeEventListener('pointerdown', this.down);
    this.el.removeEventListener('pointermove', this.move);
    this.el.removeEventListener('pointerup', this.up);
    this.el.removeEventListener('pointercancel', this.up);
  }

  private norm(p: Pt): Pt {
    const r = this.el.getBoundingClientRect();
    return { x: (p.x - r.left) / r.width, y: (p.y - r.top) / r.height };
  }

  private pair(): [Pt, Pt] {
    const [a, b] = [...this.pts.values()];
    return [a, b];
  }

  private down = (e: PointerEvent) => {
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {}
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.touch.count = this.pts.size;
    this.touch.down = 1;

    if (this.pts.size === 1) {
      this.tapOrigin = { x: e.clientX, y: e.clientY };
      this.moved = false;
      this.mode = 'drag';
      this.h.onStart('drag');
      this.emitDrag(e);
    } else if (this.pts.size === 2) {
      // a second finger turns the drag into a pinch/twist
      const [a, b] = this.pair();
      this.start = { dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
      this.mode = 'pinch';
      this.moved = true;
      this.h.onStart('pinch');
    }
    this.h.onTouch(this.touch);
  };

  private move = (e: PointerEvent) => {
    const p = this.pts.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.tapOrigin && Math.hypot(e.clientX - this.tapOrigin.x, e.clientY - this.tapOrigin.y) > TAP_SLOP_PX) this.moved = true;

    if (this.mode === 'drag' && this.pts.size === 1) {
      this.emitDrag(e);
    } else if (this.mode === 'pinch' && this.pts.size >= 2 && this.start) {
      const [a, b] = this.pair();
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const scale = dist / Math.max(this.start.dist, 1);
      let twist = angle - this.start.angle;
      if (twist > Math.PI) twist -= 2 * Math.PI;
      if (twist < -Math.PI) twist += 2 * Math.PI;
      this.touch.pinch = scale;
      this.h.onPinch(scale);
      this.h.onTwist(twist);
    }
    this.h.onTouch(this.touch);
  };

  private up = (e: PointerEvent) => {
    if (!this.pts.delete(e.pointerId)) return;
    this.touch.count = this.pts.size;
    if (this.pts.size > 0) {
      // lifting one finger of a pinch must not jump into a drag
      if (this.mode === 'pinch') this.mode = 'none';
      this.h.onTouch(this.touch);
      return;
    }
    this.touch.down = 0;
    this.touch.vx = 0;
    this.touch.vy = 0;
    this.touch.pinch = 1;
    this.start = null;
    this.mode = 'none';
    this.h.onEnd();
    this.h.onTouch(this.touch);

    if (!this.moved) {
      const now = performance.now();
      if (now - this.lastTap < DOUBLE_TAP_MS) {
        this.lastTap = 0;
        this.h.onDoubleTap();
      } else {
        this.lastTap = now;
      }
    }
  };

  private emitDrag(e: PointerEvent) {
    const n = this.norm({ x: e.clientX, y: e.clientY });
    const x = Math.min(1, Math.max(0, n.x));
    const y = Math.min(1, Math.max(0, n.y));
    const now = performance.now();
    const dt = Math.max(now - this.lastMove, 1) / 1000;
    this.touch.vx = (x - this.touch.x) / dt;
    this.touch.vy = (y - this.touch.y) / dt;
    this.lastMove = now;
    this.touch.x = x;
    this.touch.y = y;
    this.h.onDrag(x, 1 - y);
  }
}
