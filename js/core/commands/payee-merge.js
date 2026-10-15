// payee.merge — fold payee spellings into one name, exactly as the tidy-up
// sheet does, in one commit: the matching rows are rewritten (envelope-internal
// rows are skipped), investment symbol rules move to the kept name, each
// merged-away spelling becomes an alias of it, and a hidden target is unhidden.
// A merge that rewrites no row changes nothing. `payee` is not a money field,
// so the change log stays untouched; under strict-ledger a merge touching a
// past posted row is refused.

import { ok, fail } from '../result.js';
import {
  payeeKey, mergePayees, mergePayeeRules, addPayeeAliases, getPayeeAliases, getHiddenPayees, setPayeeHidden,
} from '../payee-fields.js';
import { getInvestmentsMeta } from '../investments-meta.js';

export default {
  name: 'payee.merge',
  summary: 'Merge payee spellings into one name: rewrites the matching rows (not envelope fills or transfers), moves the investment symbol rule, remembers the old spellings as aliases of the new name and unhides it. Changes nothing when no row matches.',
  input: {
    type: 'object',
    required: ['from', 'fromNames', 'to'],
    properties: {
      from: { type: 'array', items: { type: 'string' }, description: 'Payee keys to merge away: the trimmed, lowercase spellings' },
      fromNames: { type: 'array', items: { type: 'string' }, description: 'The exact spellings being merged away, remembered as aliases' },
      to: { type: 'string', description: 'The name to keep' },
    },
  },
  execute(data, input, ctx) {
    const to = String(input.to).trim();
    const fromKeys = new Set(input.from.map(payeeKey).filter(Boolean));
    /** @type {{ path: string, message: string }[]} */
    const errors = [];
    if (!to) errors.push({ path: 'to', message: 'needs a payee name' });
    if (fromKeys.size === 0) errors.push({ path: 'from', message: 'needs at least one payee to merge' });
    if (errors.length) return fail('bad_input', { errors });

    const { transactions, changed } = mergePayees(data.transactions, fromKeys, to, ctx.now.toISOString());
    if (!changed) return ok({ changes: {}, value: { changed: 0, to } });

    /** @type {Record<string, any>} */
    const meta = { ...data.meta };
    const rules = getInvestmentsMeta(data.meta).payeeRules;
    // Like the sheet: rules are rewritten only when a merged-away key has one,
    // and then investments is stored in full shape.
    if ([...fromKeys].some(k => rules[k])) {
      meta.investments = { ...getInvestmentsMeta(data.meta), payeeRules: mergePayeeRules(rules, fromKeys, to) };
    }
    meta.payeeAliases = addPayeeAliases(getPayeeAliases(data.meta), input.fromNames, to);
    if (getHiddenPayees(data.meta).has(to.toLowerCase())) {
      meta.payeeHidden = setPayeeHidden(data.meta.payeeHidden, to, false);
    }
    return ok({ changes: { transactions, meta }, value: { changed, to } });
  },
};
