// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOUR_DISMISS_KEY } from '../lib/tour-preference';
import { Tour } from './Tour';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null;

async function mount() {
  root = createRoot(container);
  await act(async () => root!.render(<Tour />));
}

beforeEach(() => {
  window.localStorage.clear();
  document.body.replaceChildren();
  container = document.createElement('div');
  document.body.append(container);
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  document.body.replaceChildren();
});

describe('Tour', () => {
  it('persists the checkbox immediately and stays dismissed after remount', async () => {
    await mount();
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;

    expect(checkbox).not.toBeNull();
    expect(container.querySelector('.tour-remember-glyph')?.textContent).toBe('□');
    await act(async () => checkbox.click());

    expect(checkbox.checked).toBe(true);
    expect(container.querySelector('.tour-remember-glyph')?.textContent).toBe('■');
    expect(window.localStorage.getItem(TOUR_DISMISS_KEY)).toBe('1');

    await act(async () => root!.unmount());
    root = null;
    container.replaceChildren();
    await mount();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
