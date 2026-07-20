// Destination-set change mechanics (gas.ts): signature canonicalization,
// change classification (addition = partial rebuild, removal = full), and the
// store's partial wipe. These are the pieces that decide how much accrued
// burn history a venue keeps when its adapter's gasSources() list changes.
import { describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapRebuildDay, classifyGasSourceChange, gasSourcesSignature } from '../gas.js';
import { VolumeStore } from '../db.js';
import type { GasSource } from '../venues/adapter.js';

const A = '0x04fdeac24e4e57364b4f22844106583d88f747d7' as const;
const B = '0x48cba27861983367c3fb063877b144a628e2b48b' as const;
const C = '0x33176be288e54c440941d407df33456a23ede078' as const;

describe('gasSourcesSignature', () => {
  it('lowercases, sorts, and joins across sources and address arrays', () => {
    const sources: GasSource[] = [
      { mode: 'blocks', address: [B, '0x04fdEAC24E4e57364B4F22844106583d88F747d7'] },
      { mode: 'blocks', address: C },
    ];
    expect(gasSourcesSignature(sources)).toBe([A, C, B].sort().join(','));
  });

  it('is invariant under reordering, checksum casing, and duplicates — none of these are a change', () => {
    const a: GasSource[] = [{ mode: 'blocks', address: [A, B] }];
    const b: GasSource[] = [{ mode: 'blocks', address: ['0x48CBA27861983367C3FB063877B144A628E2B48B', A, A] }];
    expect(gasSourcesSignature(a)).toBe(gasSourcesSignature(b));
  });
});

describe('classifyGasSourceChange', () => {
  it('identical signatures → none', () => {
    expect(classifyGasSourceChange(`${A},${B}`, `${A},${B}`)).toEqual({ kind: 'none', added: [] });
  });

  it('set-equal but string-different (duplicate survived an old bug) → none, not a wipe', () => {
    expect(classifyGasSourceChange(`${A},${A},${B}`, `${A},${B}`).kind).toBe('none');
  });

  it('pure addition (the migration case) → partial, reporting the added address', () => {
    expect(classifyGasSourceChange(A, `${A},${B}`)).toEqual({ kind: 'partial', added: [B] });
  });

  it('multiple additions → partial with all of them (boundary = earliest creation)', () => {
    const r = classifyGasSourceChange(A, [A, B, C].sort().join(','));
    expect(r.kind).toBe('partial');
    expect(new Set(r.added)).toEqual(new Set([B, C]));
  });

  it('pure removal → full (the removed share cannot be unmixed from day rows)', () => {
    expect(classifyGasSourceChange(`${A},${B}`, A)).toEqual({ kind: 'full', added: [] });
  });

  it('replacement (add + remove) → full, the removal dominates', () => {
    expect(classifyGasSourceChange(A, B)).toEqual({ kind: 'full', added: [] });
  });

  it('everything removed → full', () => {
    expect(classifyGasSourceChange(A, '')).toEqual({ kind: 'full', added: [] });
  });
});

describe('bootstrapRebuildDay', () => {
  it('all destinations predate the anchor → null (series covered them from birth)', () => {
    expect(bootstrapRebuildDay(['2026-03-10', '2026-05-01'], '2026-06-05')).toBeNull();
  });

  it('creation ON the anchor day → null (scan started at the day open, inclusive)', () => {
    expect(bootstrapRebuildDay(['2026-06-05'], '2026-06-05')).toBeNull();
  });

  it('picks the EARLIEST post-anchor creation so every younger destination is covered', () => {
    expect(bootstrapRebuildDay(['2026-07-16', '2026-06-28', '2026-01-01'], '2026-06-05')).toBe('2026-06-28');
  });

  it('unsorted input is fine; no destinations at all → null', () => {
    expect(bootstrapRebuildDay(['2026-07-19', '2026-07-16'], '2026-06-05')).toBe('2026-07-16');
    expect(bootstrapRebuildDay([], '2026-06-05')).toBeNull();
  });
});

describe('VolumeStore.deleteMetaPrefix', () => {
  it('removes only keys with the prefix; epoch key named outside the prefix survives', () => {
    const path = join(tmpdir(), `meta-prefix-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new VolumeStore(path);
    store.setMeta('gas_srcs_hanji', 'a');
    store.setMeta('gas_srcs_poe', 'b');
    store.setMeta('gas_cov_epoch', '1');
    store.setMeta('gas_cursor_hanji', '123');
    store.deleteMetaPrefix('gas_srcs_');
    expect(store.getMeta('gas_srcs_hanji')).toBeUndefined();
    expect(store.getMeta('gas_srcs_poe')).toBeUndefined();
    expect(store.getMeta('gas_cov_epoch')).toBe('1');   // not under the prefix
    expect(store.getMeta('gas_cursor_hanji')).toBe('123'); // cursors untouched
    unlinkSync(path);
  });

  it('is literal, not a LIKE pattern: % and _ in the prefix do not wildcard', () => {
    const path = join(tmpdir(), `meta-prefix2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new VolumeStore(path);
    store.setMeta('gasXsrcsXhanji', 'a'); // would match 'gas_srcs_' if _ were a wildcard
    store.deleteMetaPrefix('gas_srcs_');
    expect(store.getMeta('gasXsrcsXhanji')).toBe('a');
    unlinkSync(path);
  });
});

describe('VolumeStore.resetGasFrom', () => {
  const freshStore = () => {
    const path = join(tmpdir(), `gas-reset-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new VolumeStore(path);
    return { store, path };
  };
  const seed = (store: VolumeStore) => {
    store.applyGas(
      [
        { utcDay: '2026-06-30', venueId: 'hanji', mon: 21.6, txs: 4000 },
        { utcDay: '2026-07-10', venueId: 'hanji', mon: 600, txs: 100000 },
        { utcDay: '2026-07-16', venueId: 'hanji', mon: 700, txs: 107000 },
        { utcDay: '2026-07-19', venueId: 'hanji', mon: 5, txs: 1000 },
        { utcDay: '2026-07-10', venueId: 'poe', mon: 800, txs: 210000 },
      ],
      'gas_cursor_hanji', '88200000',
    );
    store.setMeta('gas_from_hanji', '2026-06-05');
    store.setMeta('gas_cursor_poe', '88300000');
  };
  const hanjiDays = (store: VolumeStore) =>
    store.gasDays('2026-07-20').flatMap((d) => (d.byVenue['hanji'] ? [d.utcDay] : []));

  it('wipes only rows >= fromDay for that venue, drops its cursor, keeps gas_from and other venues', () => {
    const { store, path } = freshStore();
    seed(store);
    store.resetGasFrom('hanji', '2026-07-16');

    expect(hanjiDays(store)).toEqual(['2026-06-30', '2026-07-10']);
    expect(store.getMeta('gas_cursor_hanji')).toBeUndefined();
    expect(store.getMeta('gas_from_hanji')).toBe('2026-06-05'); // series anchor untouched
    const poe = store.gasDays('2026-07-20').find((d) => d.utcDay === '2026-07-10')?.byVenue['poe'];
    expect(poe?.mon).toBe(800); // other venue untouched
    expect(store.getMeta('gas_cursor_poe')).toBe('88300000');
    unlinkSync(path);
  });

  it('fromDay at the series start behaves like a full row wipe (boundary day inclusive)', () => {
    const { store, path } = freshStore();
    seed(store);
    store.resetGasFrom('hanji', '2026-06-30');
    expect(hanjiDays(store)).toEqual([]);
    unlinkSync(path);
  });

  it('fromDay after every row wipes nothing but still drops the cursor (rescan of an empty tail)', () => {
    const { store, path } = freshStore();
    seed(store);
    store.resetGasFrom('hanji', '2026-07-20');
    expect(hanjiDays(store)).toEqual(['2026-06-30', '2026-07-10', '2026-07-16', '2026-07-19']);
    expect(store.getMeta('gas_cursor_hanji')).toBeUndefined();
    unlinkSync(path);
  });

  it('full resetGas still wipes everything including gas_from', () => {
    const { store, path } = freshStore();
    seed(store);
    store.resetGas('hanji');
    expect(hanjiDays(store)).toEqual([]);
    expect(store.getMeta('gas_from_hanji')).toBeUndefined();
    expect(store.getMeta('gas_cursor_hanji')).toBeUndefined();
    unlinkSync(path);
  });
});
