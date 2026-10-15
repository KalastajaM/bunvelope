// js/session/audit.js — the change-log entries a commit produces, shared by
// both sessions so a CLI edit is logged exactly like one made in the app
// (see js/state/change-log.js).

import { diffTransactionWrite } from '../state/change-log.js';

/**
 * @param {Record<string, any>} before
 * @param {Record<string, any>} changes
 * @param {string} at  ISO timestamp
 */
export function changeLogEntries(before, changes, at) {
  return changes.transactions ? diffTransactionWrite(before.transactions || [], changes.transactions, at) : [];
}
