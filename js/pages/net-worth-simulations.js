// Saved Net worth simulations are view configurations. Unset assumptions
// always follow the current plan/account settings; no account is mutated.
export const ASSUMPTION_FIELDS = ['expectedGrowth', 'plannedMonthly'];
export const PREVIOUS_SIMULATION_ID = 'previous-projection';

export function cleanAssumptions(rows) {
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) continue;
    const id = row.id.trim();
    const out = { ...byId.get(id), id };
    for (const field of ASSUMPTION_FIELDS) {
      if (Number.isFinite(row[field])) out[field] = row[field];
      else if (row[field] === null) delete out[field];
    }
    byId.set(id, out);
  }
  return [...byId.values()].filter(row => ASSUMPTION_FIELDS.some(field => field in row));
}

export function simulationConfigs(meta, accounts, previousName, prefs = {}) {
  if (!Array.isArray(meta?.netWorthSimulations)) {
    const overrides = cleanAssumptions(accounts);
    return overrides.length ? [{
      id: PREVIOUS_SIMULATION_ID, name: previousName, accounts: overrides,
      contribution: prefs.contributionSource === 'history' ? 'history' : 'plan',
      whatIf: typeof prefs.whatIf === 'string' ? prefs.whatIf : null,
    }] : [];
  }
  const seen = new Set();
  return meta.netWorthSimulations.flatMap(entry => {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim()
      || typeof entry.name !== 'string' || !entry.name.trim() || seen.has(entry.id.trim())) return [];
    seen.add(entry.id.trim());
    return [{ id: entry.id.trim(), name: entry.name.trim(), accounts: cleanAssumptions(entry.accounts),
      contribution: entry.contribution === 'history' ? 'history' : 'plan',
      whatIf: typeof entry.whatIf === 'string' && entry.whatIf ? entry.whatIf : null }];
  });
}

export function editedAssumptions(saved, edits) {
  return cleanAssumptions([...saved, ...edits.filter(edit => edit.valid).map(edit => ({ id: edit.id, [edit.field]: edit.value }))]);
}

// Clear legacy projection overrides before laying a configuration over the
// real accounts. Send only differences, preserving the shared query cache.
export function simulationOverrides(accounts, assumptions) {
  const byId = new Map(assumptions.map(row => [row.id, row]));
  return accounts.filter(a => a && !a.archived).flatMap(account => {
    const wanted = byId.get(account.id) || {};
    const changes = { id: account.id };
    for (const field of ASSUMPTION_FIELDS) {
      const value = wanted[field] ?? null;
      if (value !== (account[field] ?? null)) changes[field] = value;
    }
    return Object.keys(changes).length > 1 ? [changes] : [];
  });
}
