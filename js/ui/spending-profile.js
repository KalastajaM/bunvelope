import { ask } from './query.js';
import { t } from './i18n.js';
import { disclosure, node } from './planning-workspace.js';

// Figures and eligible accounts come from core; this form only edits assumptions.
export function spendingProfileFields(env, field) {
  const profile = ask('spending.profile', env.id ? { id: env.id } : {});
  if (!profile) return { element: node('p', 'muted', t('spendingProfile.unavailable')), fields: () => ({}) };
  const mode = document.createElement('select'); mode.name = 'forecastProfileMode';
  for (const key of ['history', 'override']) {
    const option = document.createElement('option'); option.value = key;
    option.textContent = t(`spendingProfile.${key}`); mode.append(option);
  }
  mode.value = env.forecast_account_shares?.length ? 'override' : 'history';
  const hint = node('p', 'sub', t('spendingProfile.explanation'));
  const evidence = node('p', 'sub', t('spendingProfile.evidence')(profile));
  const confidence = node('p', 'sub', t(`spendingProfile.${profile.confidence}`));
  const inputs = profile.accounts.map(account => {
    const input = document.createElement('input'); input.type = 'number'; input.step = '0.01'; input.min = '0'; input.max = '100';
    input.name = `forecastShare:${account.id}`;
    input.value = String(env.forecast_account_shares?.find(s => s.account_id === account.id)?.percent
      ?? profile.shares.find(s => s.accountId === account.id)?.percent ?? 0);
    return { id: account.id, input, field: field(`${account.name} (%)`, input) };
  });
  const update = () => {
    const historical = mode.value === 'history';
    confidence.textContent = t(`spendingProfile.${historical ? profile.history.confidence : 'override'}`);
    inputs.forEach(({ id, input, field }) => {
      input.disabled = historical;
      if (historical) input.value = String(profile.history.shares.find(s => s.accountId === id)?.percent ?? 0);
      field.hidden = historical && Number(input.value) === 0;
    });
  };
  mode.addEventListener('change', update); update();
  const element = disclosure(t('spendingProfile.title'), [hint, field(t('spendingProfile.mode'), mode), evidence, confidence,
    ...inputs.map(i => i.field), node('p', 'sub', t('spendingProfile.overrideHint'))]);
  return { element, fields: () => ({ forecast_account_shares: mode.value === 'history' ? null
    : inputs.map(({ id, input }) => ({ account_id: id, percent: Number(input.value) })).filter(s => s.percent !== 0) }) };
}
