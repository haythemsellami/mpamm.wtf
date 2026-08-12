export const TOUR_DISMISS_KEY = 'pamm-tour-dismissed';

type TourStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function isTourDismissed(storage: TourStorage = localStorage): boolean {
  try { return storage.getItem(TOUR_DISMISS_KEY) === '1'; } catch { return false; }
}

/** Persist and read back the choice so the control never claims a preference
 * was remembered when browser storage rejected or ignored the write. */
export function persistTourDismissed(dismissed: boolean, storage: TourStorage = localStorage): boolean {
  try {
    if (dismissed) storage.setItem(TOUR_DISMISS_KEY, '1');
    else storage.removeItem(TOUR_DISMISS_KEY);
    return storage.getItem(TOUR_DISMISS_KEY) === (dismissed ? '1' : null);
  } catch {
    return false;
  }
}
