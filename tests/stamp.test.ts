import { describe, expect, it } from 'vitest';
import { STAMP_CHARS, stampCodes } from '../src/gpu/glyphs';

describe('date-back stamp', () => {
  it('maps text onto the Doto alphabet, uppercase', () => {
    const codes = stampCodes('fx07 Señal 26.10.30');
    expect(codes.map((c) => STAMP_CHARS[c]).join('')).toBe('FX07 SEÑAL 26.10.30');
  });

  it('prints unknown characters as spaces', () => {
    expect(stampCodes('A€B').map((c) => STAMP_CHARS[c]).join('')).toBe('A B');
  });
});
