// js/core/investments-meta.js — the shape of meta.investments, read defensively.
// Pure. js/state/investments.js re-exports these for its callers.

/**
 * `meta.investments` with every part present, whatever is stored.
 * @param {Record<string, any> | null | undefined} meta
 */
export function getInvestmentsMeta(meta) {
  const inv = meta?.investments || {};
  const part = (v) => (v && typeof v === 'object' ? v : {});
  return {
    prices: part(inv.prices),
    holdingOverrides: part(inv.holdingOverrides),
    payeeRules: part(inv.payeeRules),
    manualRows: part(inv.manualRows),
    priceHistory: part(inv.priceHistory),
  };
}

/** `{ [lowercasedPayee]: SYMBOL }` */
export function getPayeeRules(meta) {
  return getInvestmentsMeta(meta).payeeRules;
}
