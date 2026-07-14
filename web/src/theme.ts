import type { CSSProperties } from 'react';
import type { VenueMeta } from '@shared';

/**
 * Theming. All DOM colors flow through CSS custom properties (defined in
 * index.css: bright on `:root`, dark under `:root[data-theme="dark"]`), so a
 * theme flip re-skins the DOM instantly with no React re-render. The `C` keys
 * keep their historical names (components didn't need renaming); each maps to a
 * design token. Values that can't use var() — canvas + SVG presentation
 * attributes — read the theme-aware COL / SEM / CH getters below instead.
 */
export type Theme = 'light' | 'dark';

export const C = {
  bg: 'var(--bg)', panel: 'var(--panel)', overlay: 'var(--overlay)',
  text: 'var(--text)', textStrong: 'var(--text-strong)', text2: 'var(--text2)', text3: 'var(--text3)',
  dim: 'var(--text4)', dim2: 'var(--dim)', dim3: 'var(--dim3)',
  faint: 'var(--dim2)', faint2: 'var(--faint)', faint3: 'var(--faint3)', ghost: 'var(--faint2)',
  line: 'var(--border)', line2: 'var(--border2)', line3: 'var(--border-soft)', hair: 'var(--border-soft)',
  accent: 'var(--accent)', accent2: 'var(--accent2)', accentFg: 'var(--accent-fg)',
  // aliases kept for existing call sites: brackets/glyphs/pills/tab-underline use
  // the theme accent; the badge / cumulative-volume line use accent2.
  purple: 'var(--accent)', purpleL: 'var(--accent2)',
  green: 'var(--green)', red: 'var(--red)', amber: 'var(--amber)', link: 'var(--link)',
} as const;

export const MONO = "'JetBrains Mono','SF Mono',monospace";
export const SANS = "'Space Grotesk',sans-serif";

/** Official Monad logomark fill — the brand kit's logo SVGs ship #836EF9
 *  (monad.xyz/brand-and-media-kit; #6E54FF is the palette-primary swatch, kept
 *  as our theme-color). The mark stays this in BOTH themes (brand mark, not
 *  the theme accent). */
export const LOGO_PURPLE = '#836EF9';

/** Neutral fallback for a missing/unknown venue color (theme-aware) — used when a
 *  venueId has no registry entry yet, so a swatch/line never renders `undefined`. */
const VENUE_FALLBACK: Record<Theme, string> = { light: '#8A8375', dark: '#B9BCC6' };

// ── theme-aware getters: canvas + SVG-attribute colors can't use var() ──────
/**
 * The single source of truth for a venue's line/ribbon/swatch/bar color: read the
 * backend-defined `VenueMeta.color` for the active theme. The frontend keeps NO
 * color table of its own — pass the VenueMeta (from `state.venues`) straight in.
 */
export function venueColor(v: VenueMeta | undefined, theme: Theme): string {
  return v ? v.color[theme] : VENUE_FALLBACK[theme];
}

/** Same, when you only have a venueId + the registry (e.g. coloring a fill by `Fill.venueId`). */
export function venueColorById(venues: VenueMeta[], id: string, theme: Theme): string {
  return venueColor(venues.find((v) => v.id === id), theme);
}

/** Semantic green/red in css + "r,g,b" forms for SVG strokes / alpha math (design SEM). */
export const SEM: Record<Theme, { green: { css: string; rgb: string }; red: { css: string; rgb: string } }> = {
  light: { green: { css: 'rgb(10,133,96)', rgb: '10,133,96' }, red: { css: 'rgb(201,43,72)', rgb: '201,43,72' } },
  dark: { green: { css: 'rgb(53,208,160)', rgb: '53,208,160' }, red: { css: 'rgb(242,86,106)', rgb: '242,86,106' } },
};
/** Quote-canvas chrome: grid lines, axis labels, ribbon fill alpha (design CH). */
export const CH: Record<Theme, { grid: string; grid2: string; label: string; label2: string; ribbon: number; ribbonB: number }> = {
  light: { grid: 'rgba(23,20,15,0.08)', grid2: 'rgba(23,20,15,0.05)', label: 'rgb(122,116,103)', label2: 'rgb(150,143,128)', ribbon: 0.10, ribbonB: 0.17 },
  dark: { grid: 'rgba(255,255,255,0.05)', grid2: 'rgba(255,255,255,0.035)', label: 'rgb(107,109,118)', label2: 'rgb(94,96,104)', ribbon: 0.08, ribbonB: 0.15 },
};
/** rgba() from a #rrggbb hex + alpha — for the venue-color getters (hex inputs only). */
export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Decorative accent corner brackets used on every panel. */
export const cornerTL: CSSProperties = {
  position: 'absolute', top: -1, left: -1, width: 8, height: 8,
  borderTop: `1px solid ${C.accent}`, borderLeft: `1px solid ${C.accent}`,
};
export const cornerBR: CSSProperties = {
  position: 'absolute', bottom: -1, right: -1, width: 8, height: 8,
  borderBottom: `1px solid ${C.accent}`, borderRight: `1px solid ${C.accent}`,
};

/** Selected/unselected pill (design pillOn/pillOff → accent / accent-fg). */
export function pill(active: boolean, sm = false): CSSProperties {
  return {
    background: active ? C.accent : 'transparent',
    color: active ? C.accentFg : C.dim2,
    border: `1px solid ${active ? C.accent : 'var(--pill-border)'}`,
    padding: sm ? '3px 8px' : '4px 9px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: sm ? 10 : 11,
    whiteSpace: 'nowrap',
    userSelect: 'none',
  };
}
