import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { C, cornerTL } from '../theme';

/**
 * The ASSET control: the selected pair on a trigger that opens a filterable
 * list, grouped by base token.
 *
 * It replaced a pill per market. The xStocks listing crosses every stock with
 * every quote, so the registry went from ~20 markets to ~70 and the pills grew
 * into a five-row wall above the chart, re-read on every visit to change one
 * thing. A native <select> would hold 70 rows but cannot be filtered or carry
 * the venue dots, so desktop gets this listbox and phones keep the native
 * select (grouped the same way, via `groupPairs`), where the OS picker wins.
 *
 * Focus stays in the filter input while the list is open; the highlighted
 * option is announced through aria-activedescendant (the ARIA combobox
 * pattern), so options are never focusable themselves.
 */

export interface PairGroup { base: string; markets: string[] }
export interface PairVenue { id: string; name: string; color: string }

/** Whether a market matches the filter. A "/" splits it into base and quote
 *  parts ("btc/" = any BTC wrapper as base, "/mon" = MON-quoted); otherwise
 *  every whitespace-separated term must appear in the symbol ("nvda usdc"). */
export function matchPair(market: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const symbol = market.toLowerCase();
  if (q.includes('/')) {
    const [base, quote = ''] = symbol.split('/');
    const [qb, qq] = q.split('/', 2).map((s) => s.trim());
    return base.includes(qb) && quote.includes(qq);
  }
  return q.split(/\s+/).every((term) => symbol.includes(term));
}

/** The matching markets grouped by their displayed base token, in the order
 *  given (the registry's). cbBTC and WBTC are separate groups from BTC: they
 *  are different markets with different references. */
export function groupPairs(markets: readonly string[], query = ''): PairGroup[] {
  const groups = new Map<string, string[]>();
  for (const market of markets) {
    if (!matchPair(market, query)) continue;
    const base = market.split('/')[0];
    const list = groups.get(base);
    if (list) list.push(market);
    else groups.set(base, [market]);
  }
  return [...groups].map(([base, list]) => ({ base, markets: list }));
}

// keeps an option scrolled into view clear of the sticky group header above it
const GROUP_HEAD_H = 24;

export function PairPicker({ markets, value, onChange, venuesFor }: {
  markets: readonly string[];
  value: string;
  onChange: (market: string) => void;
  /** the venues quoting a market, drawn as dots so pairs with a comparison stand out. */
  venuesFor?: (market: string) => PairVenue[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(value);
  const groups = useMemo(() => groupPairs(markets, query), [markets, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.markets), [groups]);
  // the highlight follows the filter: when it narrows past the highlighted
  // option, the first match takes over, so Enter always picks something visible.
  const highlighted = flat.includes(active) ? active : flat[0];
  const id = useId();
  const optionId = (market: string) => `${id}-o${flat.indexOf(market)}`;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const show = () => { setQuery(''); setActive(value); setOpen(true); };
  const hide = (refocus: boolean) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const choose = (market: string) => { onChange(market); hide(true); };
  const scrollTo = (market: string | undefined, block: ScrollLogicalPosition) => {
    if (market) document.getElementById(optionId(market))?.scrollIntoView?.({ block });
  };

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    scrollTo(value, 'center');
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) hide(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => { if (open) scrollTo(highlighted, 'nearest'); }, [highlighted]); // eslint-disable-line react-hooks/exhaustive-deps

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const i = highlighted ? flat.indexOf(highlighted) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = flat[Math.min(flat.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) setActive(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlighted) choose(highlighted);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hide(true);
    }
  };

  const [base, quote] = value.split('/');
  return (
    <div ref={root} style={{ position: 'relative' }}
      // Tab (or any focus move) out of the picker closes it; a click inside
      // moves focus nowhere (options keep it in the input), so it stays open.
      onBlur={(e) => { if (open && e.relatedTarget && !root.current?.contains(e.relatedTarget)) hide(false); }}>
      <button ref={trigger} type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={`Asset pair: ${value}`}
        onClick={() => (open ? hide(true) : show())}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); show(); } }}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minWidth: 128,
          padding: '4px 9px', borderRadius: 4, cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap',
          border: `1px solid ${open ? C.accent : 'var(--pill-border)'}`, color: C.text,
        }}>
        <span><span style={{ fontWeight: 600 }}>{base}</span><span style={{ color: C.dim2 }}>/{quote}</span></span>
        <span aria-hidden="true" style={{ color: open ? C.accent : C.faint2, fontSize: 9 }}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 30, width: 252,
          background: C.panel, border: `1px solid ${C.line}`, boxShadow: '0 10px 28px rgba(0,0,0,0.18)',
        }}>
          <i style={cornerTL} />
          <input ref={input} role="combobox" aria-expanded="true" aria-autocomplete="list"
            aria-controls={`${id}-list`} aria-activedescendant={highlighted ? optionId(highlighted) : undefined}
            aria-label="Filter pairs" placeholder="filter · nvda · btc/ · /mon" spellCheck={false} autoComplete="off"
            value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onInputKey}
            style={{
              display: 'block', width: '100%', padding: '9px 11px', border: 0, borderBottom: `1px solid ${C.line2}`,
              background: 'transparent', color: C.text, font: 'inherit', fontSize: 11, outline: 'none',
            }} />
          <div id={`${id}-list`} role="listbox" aria-label="Asset pairs" style={{ maxHeight: 340, overflowY: 'auto', paddingBottom: 4 }}>
            {groups.map((g) => (
              <div key={g.base} role="group" aria-labelledby={`${id}-g-${g.base}`}>
                <div id={`${id}-g-${g.base}`} style={groupHead}>
                  <span>{g.base}</span>
                  <span aria-hidden="true" style={{ color: C.ghost }}>{g.markets.length}</span>
                </div>
                {g.markets.map((market) => (
                  <PairOption key={market} id={optionId(market)} market={market}
                    selected={market === value} highlighted={market === highlighted} venues={venuesFor?.(market) ?? []}
                    onHover={() => setActive(market)} onPick={() => choose(market)} />
                ))}
              </div>
            ))}
            {!flat.length && <div style={{ padding: '12px 11px', fontSize: 10.5, color: C.faint2 }}>no pair matches “{query.trim()}”</div>}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 11px', borderTop: `1px solid ${C.line3}`, fontSize: 9, color: C.faint2, letterSpacing: '.04em' }}>
            <span>{flat.length === markets.length ? `${markets.length} pairs` : `${flat.length} of ${markets.length}`}</span>
            <span aria-hidden="true">↑↓ move · ↵ pick · esc</span>
          </div>
        </div>
      )}
    </div>
  );
}

const groupHead: CSSProperties = {
  position: 'sticky', top: 0, zIndex: 1, height: GROUP_HEAD_H, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '0 11px', background: C.panel, fontSize: 9, letterSpacing: '.08em', color: C.faint2, borderTop: `1px solid ${C.line3}`,
};

function PairOption({ id, market, selected, highlighted, venues, onHover, onPick }: {
  id: string; market: string; selected: boolean; highlighted: boolean; venues: PairVenue[];
  onHover: () => void; onPick: () => void;
}) {
  const [base, quote] = market.split('/');
  return (
    <div id={id} role="option" aria-selected={selected}
      // mousedown would blur the input (and lose the keyboard); the click still fires.
      onMouseDown={(e) => e.preventDefault()}
      // mousemove, not mouseenter: arrow keys scroll the list under a resting
      // pointer, and mouseenter would steal the highlight back on every step.
      onMouseMove={highlighted ? undefined : onHover} onClick={onPick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 11px 5px 9px', cursor: 'pointer', fontSize: 11,
        scrollMarginTop: GROUP_HEAD_H, background: highlighted ? 'var(--accent-dim)' : 'transparent',
        borderLeft: `2px solid ${selected ? C.accent : 'transparent'}`,
      }}>
      <span style={{ flex: 1, minWidth: 0, color: selected ? C.accent : C.text2, fontWeight: selected ? 600 : 400 }}>
        {base}<span style={{ color: selected ? undefined : C.dim2 }}>/{quote}</span>
      </span>
      {venues.length > 0 && (
        <span aria-hidden="true" title={venues.map((v) => v.name).join(' · ')} style={{ display: 'flex', gap: 3, flex: 'none' }}>
          {venues.map((v) => <span key={v.id} style={{ width: 6, height: 6, borderRadius: '50%', background: v.color }} />)}
        </span>
      )}
    </div>
  );
}
