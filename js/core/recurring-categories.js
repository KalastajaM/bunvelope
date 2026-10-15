// One key for case-insensitive grouping, filtering and saved display order.
export const recurringCategoryKey = category => JSON.stringify(category?.trim().toLowerCase() || null);

export const recurringGroupModes = ['category', 'account', 'envelope', 'envelopeCategory', 'none'];

export function recurringGroupKey(item, mode) {
  if (mode === 'account') return JSON.stringify(item.accountId);
  if (mode === 'envelope') return JSON.stringify(item.envelopeId);
  if (mode === 'envelopeCategory') return item.envelopeId ? recurringCategoryKey(item.envelopeCategory) : 'unallocated';
  if (mode === 'none') return 'all';
  return recurringCategoryKey(item.category);
}
