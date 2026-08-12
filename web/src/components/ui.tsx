import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { C, cornerTL, cornerBR, pill } from '../theme';

/** Bordered panel with the design's purple corner brackets. */
export function Panel({ children, style, both = true }: { children: ReactNode; style?: CSSProperties; both?: boolean }) {
  return (
    <div style={{ position: 'relative', border: `1px solid ${C.line}`, background: C.panel, ...style }}>
      <i style={cornerTL} />
      {both && <i style={cornerBR} />}
      {children}
    </div>
  );
}

/** Standard panel header: "<icon> TITLE  subtitle" + optional right slot. */
export function PanelHead({ icon, iconColor = C.purple, title, sub, right }: {
  icon: string; iconColor?: string; title: string; sub?: ReactNode; right?: ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap',
      padding: '9px 12px', borderBottom: `1px solid ${C.line2}`, fontSize: 11, letterSpacing: '.03em',
    }}>
      <div>
        <span style={{ color: iconColor }}>{icon}</span>{' '}
        <span style={{ color: C.text, fontWeight: 600 }}>{title}</span>
        {sub != null && <span style={{ color: C.faint }}> {sub}</span>}
      </div>
      {right}
    </div>
  );
}

export interface PillOpt { label: string; value: string | number; }

/** Row of selectable pills (DCLogic pillOn/pillOff). */
export function Pills({ options, value, onChange, sm = false }: {
  options: (PillOpt | string)[]; value: string | number; onChange: (v: any) => void; sm?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: sm ? 3 : 4 }}>
      {options.map((o) => {
        const opt = typeof o === 'string' ? { label: o, value: o } : o;
        return (
          <button key={String(opt.value)} type="button" aria-pressed={value === opt.value}
            onClick={() => onChange(opt.value)} style={pill(value === opt.value, sm)}>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** A tiny labelled control group (LABEL  <pills>). */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 9, color: C.faint2, letterSpacing: '.08em' }}>{label}</span>
      {children}
    </div>
  );
}

/** Coloured BUY/SELL chip. */
export function SideTag({ side }: { side: string }) {
  const buy = side.toLowerCase() === 'buy';
  return (
    <span style={{
      fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
      border: `1px solid ${buy ? 'var(--green-border)' : 'var(--red-border)'}`,
      color: buy ? C.green : C.red,
    }}>{side.toUpperCase()}</span>
  );
}

export const PAGE_PAD = 18;

/**
 * Field legend — a "?" in a panel header that reveals what each column means
 * and, critically, WHAT UNIT it is in.
 *
 * These tables carry ~20 columns whose units are invisible (a percentile block
 * reading "-0.29" is bps, POOL PNL is USD, EXEC PX is quote-per-base) and whose
 * sign convention differs per page. The obvious fix — a "?" on every header —
 * does not survive contact with this design: both tables are fixed-width grids
 * inside `overflowX: auto`, so per-column glyphs widen them and push content
 * further off-screen; the header type is 8.5-9px, far below a usable tap
 * target; and `title` tooltips are hover-only, i.e. dead on touch, which is
 * exactly where the horizontal scrolling already hurts. ONE affordance per
 * panel costs one glyph, works on touch, and has room to explain the concepts
 * (markout, horizon, sign) that per-column tooltips carry badly.
 *
 * Renders as a fragment: the button sits inline in the header, the panel drops
 * to its own line (flexBasis 100% covers both flex and block headers).
 */
export function FieldLegend({ items, note }: {
  items: readonly { term: string; unit?: string; desc: ReactNode }[];
  /** conventions that apply to the whole table (sign, reference, exclusions). */
  note?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* The glyph stays 15px so it disappears into an 11px header, but the
          BUTTON is padded out to a 25px hit area (negative margin keeps the
          layout unchanged) — a 15px tap target is the same mistake per-column
          icons would have made. */}
      <button
        type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        aria-label={open ? 'Hide field definitions' : 'Show field definitions'}
        title="what do these fields mean?"
        style={{
          padding: 5, margin: '-5px 0 -5px 1px', border: 0, background: 'none',
          lineHeight: 0, cursor: 'pointer', flex: 'none', verticalAlign: 'middle',
        }}
      >
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 15, height: 15, borderRadius: 3, fontSize: 10, fontFamily: 'inherit',
          border: `1px solid ${open ? 'var(--accent)' : 'var(--pill-border)'}`,
          background: open ? 'var(--accent-dim)' : 'transparent',
          color: open ? C.accent : C.dim2,
        }}>?</span>
      </button>
      {open && (
        <div style={{ flexBasis: '100%', width: '100%', marginTop: 9, padding: '9px 11px', border: `1px solid ${C.line2}`, background: C.overlay }}>
          <dl style={{
            display: 'grid', gridTemplateColumns: 'max-content max-content 1fr',
            gap: '5px 10px', margin: 0, fontSize: 10, lineHeight: 1.5, alignItems: 'baseline',
          }}>
            {items.flatMap((f) => ([
              <dt key={`${f.term}-term`} style={{ color: C.text2, letterSpacing: '.04em', whiteSpace: 'nowrap' }}>{f.term}</dt>,
              <dd key={`${f.term}-unit`} style={{ margin: 0, color: C.accent, whiteSpace: 'nowrap' }}>{f.unit ?? ''}</dd>,
              <dd key={`${f.term}-desc`} style={{ margin: 0, color: C.dim3 }}>{f.desc}</dd>,
            ]))}
          </dl>
          {note && <div style={{ marginTop: 8, paddingTop: 7, borderTop: `1px solid ${C.line3}`, fontSize: 10, lineHeight: 1.5, color: C.dim3 }}>{note}</div>}
        </div>
      )}
    </>
  );
}
