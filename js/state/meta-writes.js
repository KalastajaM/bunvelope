// js/state/meta-writes.js — the app's single meta write queue.
import { saveMeta } from '../data.js';
import { createMetaQueue } from './meta-queue.js';

export { StaleBudgetError } from './meta-queue.js';
const queue = createMetaQueue((folder, meta) => saveMeta(folder, meta));
export const updateMeta = queue.update;
// For the browser session's meta-primary commits, which write meta in the
// same batch as the collections (js/session/browser-session.js).
export const runMetaExclusive = queue.runExclusive;
