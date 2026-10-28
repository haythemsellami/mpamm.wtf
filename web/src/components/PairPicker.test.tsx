// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKETS } from '@shared';
import { PairPicker, groupPairs, matchPair } from './PairPicker';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('pair filter', () => {
  it('groups by the displayed base token in registry order, keeping wrappers apart', () => {
    const bases = groupPairs(MARKETS).map((g) => g.base);
    expect(bases.slice(0, 5)).toEqual(['MON', 'BTC', 'ETH', 'cbBTC', 'WBTC']);
    expect(bases).toContain('NVDAx');
    expect(groupPairs(MARKETS).flatMap((g) => g.markets)).toHaveLength(MARKETS.length);
  });

  it('matches every term anywhere, or base/quote parts around a slash', () => {
    expect(MARKETS.filter((m) => matchPair(m, 'nvda usdc'))).toEqual(['NVDAx/USDC']);
    expect(MARKETS.filter((m) => matchPair(m, 'btc/ mon'))).toEqual(['BTC/MON', 'cbBTC/MON']);
    expect(MARKETS.filter((m) => matchPair(m, '/mon')).every((m) => m.endsWith('/MON'))).toBe(true);
    expect(MARKETS.filter((m) => matchPair(m, 'tsla/'))).toEqual(MARKETS.filter((m) => m.startsWith('TSLAx/')));
    expect(groupPairs(MARKETS, 'nope')).toEqual([]);
  });
});

describe('PairPicker', () => {
  const input = () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const key = (k: string) => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
  const type = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
  const render = async (onChange = vi.fn()) => {
    await act(async () => root.render(<PairPicker markets={MARKETS} value="MON/USDC" onChange={onChange} />));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-haspopup]')!.click());
    return onChange;
  };

  it('hides the list until opened, then filters it and picks with the keyboard', async () => {
    await act(async () => root.render(<PairPicker markets={MARKETS} value="MON/USDC" onChange={() => {}} />));
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
    const onChange = await render();
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(MARKETS.length);
    expect(document.activeElement).toBe(input());
    await type('nvda');
    const nvda = MARKETS.filter((m) => m.includes('NVDA'));
    expect(nvda).toContain('TSLAx/NVDAx');
    expect([...container.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(nvda);
    await key('ArrowDown');
    await key('Enter');
    expect(onChange).toHaveBeenCalledWith(nvda[1]);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('describes the venues quoting each pair without changing its name', async () => {
    const venuesFor = (m: string) => (m === 'MON/USDC'
      ? [{ id: 'a', name: 'Alpha', color: '#000' }, { id: 'b', name: 'Beta', color: '#fff' }]
      : [{ id: 'a', name: 'Alpha', color: '#000' }]);
    await act(async () => root.render(<PairPicker markets={['MON/USDC', 'BTC/USDC']} value="MON/USDC" onChange={() => {}} venuesFor={venuesFor} />));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-haspopup]')!.click());
    const description = (o: Element) => document.getElementById(o.getAttribute('aria-describedby')!)?.textContent;
    const [mon, btc] = container.querySelectorAll('[role="option"]');
    expect(description(mon)).toBe('2 venues: Alpha, Beta');
    expect(description(btc)).toBe('1 venue: Alpha');
    // hidden: out of the option's name-from-content, still read as its description
    expect(document.getElementById(mon.getAttribute('aria-describedby')!)?.hidden).toBe(true);
  });

  it('closes on Escape without changing the pair', async () => {
    const onChange = await render();
    await key('Escape');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(container.querySelector('button[aria-haspopup]'));
  });

  it('closes on a click outside', async () => {
    const onChange = await render();
    await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
