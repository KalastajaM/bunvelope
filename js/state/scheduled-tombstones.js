// Tombstones for materialised scheduled transactions and envelope rollover
// adjustments. Both `materializeDueBudgetItems` and `applyEnvelopeRollovers`
// dedupe by the `from_budget` field on existing transactions — but a deletion
// removes the only record of that key, so the next folder open re-creates the
// transaction. Tracking deleted keys here lets the materialisers skip them.
//
// Stored on `state.meta.scheduledTombstones` as a string[] so it travels with
// the budget bundle (no schema bump needed; validateSchema ignores extra meta
// fields). This file only reads them: they are written by commands
// (`transaction.delete`, `template.convertIncomeLinked`) in the same commit as
// the rows they belong to.

export function getTombstones(meta) {
  const arr = meta && Array.isArray(meta.scheduledTombstones) ? meta.scheduledTombstones : [];
  return arr;
}
