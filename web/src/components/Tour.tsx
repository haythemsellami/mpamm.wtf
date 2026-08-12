import { useEffect, useRef, useState } from 'react';
import { C, SANS, LOGO_PURPLE } from '../theme';
import { isTourDismissed, persistTourDismissed } from '../lib/tour-preference';

/**
 * First-visit onboarding tour (design: FIRST-VISIT TOUR block) — a one-shot
 * 4-slide modal over the whole app. Strictly one-shot: dismissal with the
 * checkbox checked persists 'pamm-tour-dismissed' and there is NO replay
 * entry point anywhere in the UI.
 *
 * One deliberate upgrade over the design file: the slide visuals are REAL
 * captures of the live dashboard (short muted webm loops, bright-theme
 * canonical set) instead of the design's stylized miniature mocks. Only the
 * active slide's <video> is mounted, so slides 2-4 lazy-load by construction.
 */

// slide copy is VERBATIM from the design file; assets are self-hosted loops.
const SLIDES = [
  {
    n: '01', title: 'EXECUTION', sub: 'live quote bands vs Bybit',
    caption: 'bid/ask bands · 60s · step quotes', src: '/tour/01-execution.webm',
    body: 'Every block, each venue is quoted at the chosen size. Step bands show bid/ask per propAMMs against the CEX benchmark and a UNI-V4 band for standard-DEX comparison. Tightest spread is starred live.',
  },
  {
    n: '02', title: 'VOLUME', sub: 'daily notional + quote-update burn',
    caption: 'daily volume · burn · share', src: '/tour/02-volume.webm',
    body: 'Daily filled volume by protocol, cumulative and market-share views, plus QUOTE_UPDATE_BURN',
  },
  {
    n: '03', title: 'MARKOUTS', sub: 'fill quality at 0–60s horizons',
    caption: 'markouts vs Bybit · 0–60s', src: '/tour/03-markouts.webm',
    body: 'A live tape of on-chain swaps joined to the CEX reference price. Markouts at 0/5/10/30/60s show whether takers got favorable or adverse fills; the outlier feed surfaces the biggest single-swap P&L.',
  },
  {
    n: '04', title: 'LEADERBOARD', sub: 'who executes best',
    caption: 'percentiles · pool PnL · top swaps', src: '/tour/04-leaderboard.webm',
    body: 'Percentile distributions of markouts grouped by protocol, pool, address, or category over 24h, 7d, or 30d windows.',
  },
] as const;

export function Tour() {
  const [open, setOpen] = useState(() => !isTourDismissed());
  const [slide, setSlide] = useState(0);
  const [noShow, setNoShow] = useState(false); // unchecked by default
  const [rememberError, setRememberError] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const slideRef = useRef(slide);
  slideRef.current = slide;

  const close = () => {
    setOpen(false);
    // the quote canvas repaints on window resize — force one paint next frame
    // in case a data tick landed while the overlay was up.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };
  const remember = (value: boolean) => {
    if (!persistTourDismissed(value)) {
      setRememberError(true);
      return;
    }
    setNoShow(value);
    setRememberError(false);
  };
  const next = () => { const n = slideRef.current + 1; if (n > SLIDES.length - 1) close(); else setSlide(n); };
  const prev = () => setSlide((s) => Math.max(0, s - 1));

  useEffect(() => {
    if (!open) return;
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') {
        // focus trap: cycle within the card
        const items = cardRef.current?.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]');
        if (!items || !items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      // a modal owns the keyboard: keep global shortcuts ([1]-[4] tab switch)
      // from acting on the page behind it. Immediate variant: App's handler is
      // also on window, and same-target listeners ignore the capture flag.
      e.stopImmediatePropagation();
    };
    // capture phase so this runs before App's global tab-key handler
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const s = SLIDES[slide];

  return (
    <div role="dialog" aria-modal="true" aria-label="Welcome tour" style={{
      position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(8,9,11,.62)', backdropFilter: 'blur(3px)',
    }}>
      <div ref={cardRef} tabIndex={-1} style={{
        width: 680, maxWidth: 'calc(100vw - 40px)', background: C.panel, border: `1px solid ${C.line}`,
        position: 'relative', outline: 'none',
      }}>
        <div style={{ position: 'absolute', top: -1, left: -1, width: 10, height: 10, borderTop: `1px solid ${C.accent}`, borderLeft: `1px solid ${C.accent}` }} />
        <div style={{ position: 'absolute', bottom: -1, right: -1, width: 10, height: 10, borderBottom: `1px solid ${C.accent}`, borderRight: `1px solid ${C.accent}` }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${C.line2}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            {/* brand mark stays #836EF9 in both themes (same as the top bar) */}
            <svg width="18" height="18" viewBox="0 0 24 24" role="img" aria-label="Monad">
              <path fill={LOGO_PURPLE} d="M11.782 0C8.37963 0 0 8.53443 0 11.9999C0 15.4654 8.37963 24 11.782 24C15.1844 24 23.5642 15.4653 23.5642 11.9999C23.5642 8.53458 15.1845 0 11.782 0ZM9.94598 18.8619C8.51124 18.4637 4.65378 11.5912 5.04481 10.1299C5.43584 8.66856 12.1834 4.73984 13.6181 5.1381C15.0529 5.5363 18.9104 12.4087 18.5194 13.87C18.1283 15.3314 11.3807 19.2602 9.94598 18.8619Z" />
            </svg>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: C.text, fontFamily: SANS }}>
              WELCOME TO PROPAMM <span style={{ color: C.dim2 }}>/ MONAD</span>
            </span>
          </div>
          <button type="button" onClick={close} className="tour-skip"
            style={{ fontSize: 10, color: C.dim, cursor: 'pointer', letterSpacing: '.06em', whiteSpace: 'nowrap' }}>
            SKIP TOUR ✕
          </button>
        </div>

        <div style={{ height: 190, margin: '16px 16px 0', border: `1px solid ${C.line2}`, background: C.bg, position: 'relative', overflow: 'hidden' }}>
          {/* only the active slide's video exists — slides 2-4 lazy-load by construction */}
          <video key={s.src} src={s.src} autoPlay muted loop playsInline
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          <div style={{ position: 'absolute', top: 6, right: 8, fontSize: 8.5, color: C.faint, background: C.overlay, padding: '1px 5px' }}>{s.caption}</div>
        </div>

        <div style={{ padding: '16px 18px 4px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 10, color: C.accent, fontWeight: 600 }}>{s.n}</span>
            <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '.06em', color: C.text }}>{s.title}</span>
            <span style={{ fontSize: 10, color: C.dim2 }}>{s.sub}</span>
          </div>
          <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.6, marginTop: 8, minHeight: 72 }}>{s.body}</div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px 16px' }}>
          <div>
            <label className="tour-remember" style={{
              position: 'relative', display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 9.5, color: C.faint, cursor: 'pointer', userSelect: 'none',
            }}>
              <input className="tour-remember-input" type="checkbox" checked={noShow}
                aria-describedby={rememberError ? 'tour-remember-error' : undefined}
                onChange={(e) => remember(e.currentTarget.checked)} />
              <span className="tour-remember-glyph" aria-hidden="true"
                style={{ color: C.accent, fontSize: 11, lineHeight: 1 }}>{noShow ? '■' : '□'}</span>
              <span>don't show this again</span>
            </label>
            {rememberError && <div id="tour-remember-error" role="status"
              style={{ marginTop: 3, fontSize: 8.5, color: C.amber }}>browser could not save this preference</div>}
          </div>
          <div style={{ display: 'flex', gap: 5, marginLeft: 'auto', marginRight: 14, alignItems: 'center' }}>
            {SLIDES.map((sl, j) => (
              <button key={sl.n} type="button" aria-label={`Go to slide ${j + 1}`} aria-current={j === slide ? 'step' : undefined}
                onClick={() => setSlide(j)}
                style={{ width: 22, height: 3, padding: 0, cursor: 'pointer', background: j === slide ? C.accent : C.ghost, border: 'none' }} />
            ))}
          </div>
          {/* visibility (not display) so the footer never shifts */}
          <button type="button" onClick={prev} style={{
            padding: '6px 14px', border: `1px solid var(--pill-border)`, cursor: 'pointer', fontSize: 10,
            letterSpacing: '.06em', color: C.dim, visibility: slide === 0 ? 'hidden' : 'visible',
          }}>← BACK</button>
          <button type="button" onClick={next} style={{
            padding: '6px 14px', background: C.accent, color: C.accentFg, cursor: 'pointer',
            fontSize: 10, fontWeight: 600, letterSpacing: '.06em', border: 'none',
          }}>{slide === SLIDES.length - 1 ? 'START EXPLORING →' : 'NEXT →'}</button>
        </div>
      </div>
    </div>
  );
}
