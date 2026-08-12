import { describe, expect, it } from 'vitest';
import { isTourDismissed, persistTourDismissed, TOUR_DISMISS_KEY } from './tour-preference';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('tour preference', () => {
  it('is not dismissed when no preference exists', () => {
    expect(isTourDismissed(memoryStorage())).toBe(false);
  });

  it('persists and removes the dismissal choice immediately', () => {
    const storage = memoryStorage();

    expect(persistTourDismissed(true, storage)).toBe(true);
    expect(storage.getItem(TOUR_DISMISS_KEY)).toBe('1');
    expect(isTourDismissed(storage)).toBe(true);

    expect(persistTourDismissed(false, storage)).toBe(true);
    expect(storage.getItem(TOUR_DISMISS_KEY)).toBeNull();
    expect(isTourDismissed(storage)).toBe(false);
  });

  it('reports a rejected storage write', () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };

    expect(persistTourDismissed(true, storage)).toBe(false);
  });
});
