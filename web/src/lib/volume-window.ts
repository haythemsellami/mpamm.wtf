/**
 * Default brush window for the Volume tab's two bar charts (DAILY_VOLUME,
 * QUOTE_UPDATE_BURN).
 *
 * Until the user drags a brush, the window is DERIVED on every render rather
 * than stored: it is anchored on the LATEST day present, so it keeps sliding
 * forward as new UTC days arrive instead of freezing on the day the tab was
 * first opened. Full history used to be the default, which squeezed a year of
 * bars into one plot and made the recent months — the part anyone looks at —
 * unreadable.
 *
 * "Six months" is calendar months, not 180 days: the window opens on the same
 * day-of-month `months` earlier (clamped to that month's last day), which is
 * what a reader expects from the x-axis label. Days are looked up by ISO date,
 * not by counting rows back, because the series omits dormant days.
 */
export const DEFAULT_WINDOW_MONTHS = 6;

/** The ISO day `months` calendar months before `iso`, day-of-month clamped. */
export const monthsBefore = (iso: string, months: number): string => {
  const d = new Date(iso + 'T00:00:00Z');
  const y = d.getUTCFullYear(), m = d.getUTCMonth() - months, day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, lastDay))).toISOString().slice(0, 10);
};

/**
 * Index into an ascending `utcDay` series where the default window opens:
 * the first day on or after `months` before the last day. Falls back to 0
 * (full history) when the series is shorter than the window.
 */
export const defaultWindowStart = (days: ReadonlyArray<{ utcDay: string }>, months = DEFAULT_WINDOW_MONTHS): number => {
  const n = days.length;
  if (n === 0) return 0;
  const from = monthsBefore(days[n - 1].utcDay, months);
  const i = days.findIndex((x) => x.utcDay >= from);
  return i < 0 ? 0 : i;
};
