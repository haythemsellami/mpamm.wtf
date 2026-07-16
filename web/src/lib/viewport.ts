import { useEffect, useState } from 'react';

/** JS-driven breakpoints — the app styles inline (no media queries), so
 *  responsiveness is conditional rendering keyed on the viewport, the same
 *  approach as the pamm.wtf reference. Below MOBILE the layout swaps to
 *  stacked panels + bottom navigation; below TABLET the top bar trims. */
export const MOBILE_W = 700;
export const TABLET_W = 1000;

export function useViewport(): { mobile: boolean; tablet: boolean } {
  const [w, setW] = useState(() => document.documentElement.clientWidth);
  useEffect(() => {
    const on = () => setW(document.documentElement.clientWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return { mobile: w < MOBILE_W, tablet: w < TABLET_W };
}
