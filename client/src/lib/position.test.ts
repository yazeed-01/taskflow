import { describe, expect, it } from 'vitest';
import { hasRoom, positionBetween } from './position';

describe('positionBetween', () => {
  it('uses a default for an empty column', () => {
    expect(positionBetween(undefined, undefined)).toBe(1024);
  });

  it('puts a card at the top / bottom with a gap', () => {
    expect(positionBetween(undefined, 1024)).toBeLessThan(1024);
    expect(positionBetween(3072, undefined)).toBeGreaterThan(3072);
  });

  it('lands strictly between two neighbours', () => {
    const p = positionBetween(1024, 2048);
    expect(p).toBeGreaterThan(1024);
    expect(p).toBeLessThan(2048);
  });

  it('keeps working through many repeated drops in the same slot', () => {
    let lo = 1024;
    const hi = 2048;
    for (let i = 0; i < 40; i++) {
      const p = positionBetween(lo, hi);
      expect(p).toBeGreaterThan(lo);
      expect(p).toBeLessThan(hi);
      lo = p;
    }
  });

  it('reports when precision is exhausted', () => {
    expect(hasRoom(1024, 2048)).toBe(true);
    expect(hasRoom(1, 1 + Number.EPSILON)).toBe(false);
  });
});
