import { describe, it, expect } from 'vitest';
import { simulationConfigs, simulationOverrides, editedAssumptions } from '../js/pages/net-worth-simulations.js';

describe('simulation configuration compatibility', () => {
  it('preserves legacy assumptions until configurations have been explicitly saved or deleted', () => {
    const accounts = [{ id: 'a', expectedGrowth: 4, plannedMonthly: 120 }];
    expect(simulationConfigs({}, accounts, 'Previous')).toEqual([{ id: 'previous-projection', name: 'Previous', accounts, contribution: 'plan', whatIf: null }]);
    expect(simulationConfigs({ netWorthSimulations: [] }, accounts, 'Previous')).toEqual([]);
  });
  it('clears overrides for all active accounts, including accounts hidden from totals', () => {
    const accounts = [{ id: 'a', expectedGrowth: 5 }, { id: 'b', plannedMonthly: 30 }, { id: 'old', archived: true, expectedGrowth: 2 }];
    expect(simulationOverrides(accounts, [])).toEqual([{ id: 'a', expectedGrowth: null }, { id: 'b', plannedMonthly: null }]);
    expect(simulationOverrides(accounts, [{ id: 'a', expectedGrowth: 5 }, { id: 'b', plannedMonthly: 30 }])).toEqual([]);
  });
  it('removes cleared assumptions while keeping unrelated fields and ignoring invalid drafts', () => {
    expect(editedAssumptions([{ id: 'a', expectedGrowth: 5, plannedMonthly: 30 }], [
      { id: 'a', field: 'expectedGrowth', value: null, valid: true },
      { id: 'a', field: 'plannedMonthly', value: 90, valid: false },
    ])).toEqual([{ id: 'a', plannedMonthly: 30 }]);
  });
});
