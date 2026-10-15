// Browser dismissal adapter; discovery lives in the shared core.
import { getDismissedPairs } from '../core/duplicate-finder.js';
export { findDuplicateGroups, getDismissedPairs, pairKey, PLAIN_DAY_WINDOW, POSTED_DAY_WINDOW } from '../core/duplicate-finder.js';

/** Meta with a group's pairs added to the dismissed list. */
export function dismissGroup(meta, group) {
  const set = getDismissedPairs(meta);
  for (const p of group.pairs) set.add(p);
  return { ...(meta || {}), duplicateDismissed: [...set].sort() };
}
