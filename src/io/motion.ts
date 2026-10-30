// Phone tilt from DeviceOrientation, in degrees relative to a reference pose
// (how the phone was held at the first reading, or at the last recalibration).
// Android Chrome delivers it without a permission prompt; iOS would need
// DeviceOrientationEvent.requestPermission() from a gesture.

import type { MotionSnapshot } from '../signals';

export class Tilt {
  private ref: { beta: number; gamma: number } | null = null;
  private last: { beta: number; gamma: number } | null = null;

  constructor(private onChange: (m: MotionSnapshot) => void) {
    window.addEventListener('deviceorientation', this.handle);
  }

  /** The current pose becomes level. */
  recalibrate() {
    this.ref = this.last;
    this.onChange({ x: 0, y: 0 });
  }

  destroy() {
    window.removeEventListener('deviceorientation', this.handle);
  }

  private handle = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    this.last = { beta: e.beta, gamma: e.gamma };
    if (!this.ref) this.ref = this.last;
    this.onChange({ x: e.gamma - this.ref.gamma, y: e.beta - this.ref.beta });
  };
}
