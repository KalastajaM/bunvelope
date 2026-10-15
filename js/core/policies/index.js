// js/core/policies/index.js — policies by name, for sessions and the CLI.

import { ok, fail } from '../result.js';
import strictLedger from './strict-ledger.js';

const POLICIES = Object.freeze({ [strictLedger.name]: strictLedger });

/** @param {string[] | undefined} names */
export function resolvePolicies(names) {
  const list = [];
  for (const name of names || []) {
    if (!Object.hasOwn(POLICIES, name)) return fail('unknown_policy', { name });
    const policy = POLICIES[name];
    if (!list.includes(policy)) list.push(policy);
  }
  return ok(list);
}

export function policyNames() {
  return Object.keys(POLICIES);
}
