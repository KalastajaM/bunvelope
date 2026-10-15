import { getPrefs, savePrefs } from '../app.js';

// Fixed section keys only. These are display preferences, never budget data.
export function rememberDetails(details, key) {
  details.open = getPrefs().dailyDetails?.[key] === true;
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    const current = getPrefs().dailyDetails || {};
    if (details.open !== (current[key] === true)) {
      savePrefs({ dailyDetails: { ...current, [key]: details.open } });
    }
  });
  return details;
}
