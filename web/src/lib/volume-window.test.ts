import { describe, expect, it } from 'vitest';
import { defaultWindowStart, monthsBefore } from './volume-window';

const days = (from: string, count: number) => {
  const t0 = new Date(from + 'T00:00:00Z').getTime();
  return Array.from({ length: count }, (_, i) => ({ utcDay: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10) }));
};

describe('monthsBefore', () => {
  it('steps back whole calendar months', () => {
    expect(monthsBefore('2026-09-11', 6)).toBe('2026-03-11');
    expect(monthsBefore('2026-02-15', 6)).toBe('2025-08-15');
  });

  it('clamps to the last day of a shorter target month', () => {
    expect(monthsBefore('2026-08-31', 6)).toBe('2026-02-28');
    expect(monthsBefore('2024-08-31', 6)).toBe('2024-02-29');
  });
});

describe('defaultWindowStart', () => {
  it('opens six months before the latest day', () => {
    const series = days('2025-06-01', 468); // → 2026-09-11
    expect(series[series.length - 1].utcDay).toBe('2026-09-11');
    expect(series[defaultWindowStart(series)].utcDay).toBe('2026-03-11');
  });

  it('skips forward to the next recorded day when the boundary is dormant', () => {
    const series = days('2025-06-01', 468).filter((x) => x.utcDay !== '2026-03-11');
    expect(series[defaultWindowStart(series)].utcDay).toBe('2026-03-12');
  });

  it('falls back to full history when the series is shorter than the window', () => {
    expect(defaultWindowStart(days('2026-07-01', 40))).toBe(0);
    expect(defaultWindowStart([])).toBe(0);
  });
});
