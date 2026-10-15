// js/core/flow-input.js — what the two Money flow queries share: how many
// income sources and envelopes per category they draw before folding the rest
// into an "Other" node, and the exclusions.
//
//   FLOW_INPUT   the `excludeEnvelopes`, `topSources` and `topPerCategory`
//                schema properties
//   flowOptions  the engine's options for an input (0 = no folding, which
//                the engine spells Infinity; a count left out is the
//                engine's own default)

import { EXCLUDE_ENVELOPES } from './report-input.js';

/** Schema properties of a flow query. */
export const FLOW_INPUT = Object.freeze({
  excludeEnvelopes: EXCLUDE_ENVELOPES,
  topSources: { type: 'integer', minimum: 0, maximum: 100, default: 8, description: 'Income sources drawn before the rest fold into one node (0 = every source; default 8)' },
  topPerCategory: { type: 'integer', minimum: 0, maximum: 100, default: 6, description: 'Envelopes drawn per category before the rest fold into one node (0 = every envelope; default 6)' },
});

/**
 * @param {{ excludeEnvelopes?: string[], topSources: number, topPerCategory: number }} input
 * @returns {{ excludeEnvelopes: Set<string>, topSources: number, topPerCategory: number }}
 */
export function flowOptions(input) {
  return {
    excludeEnvelopes: new Set(input.excludeEnvelopes || []),
    topSources: input.topSources === 0 ? Infinity : input.topSources,
    topPerCategory: input.topPerCategory === 0 ? Infinity : input.topPerCategory,
  };
}
