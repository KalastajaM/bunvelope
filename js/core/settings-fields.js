// js/core/settings-fields.js — the budget-meaning settings (Settings → Budget
// and Emergency fund) as core data: the option lists the page shows, the input
// schema of settings.update, and applySettingsFields, which stores each field
// exactly as the page does. Pure.

/** @param {[string, string][]} pairs @returns {ReadonlyArray<readonly [string, string]>} */
const freezePairs = (pairs) => Object.freeze(pairs.map(p => Object.freeze(p)));

export const CURRENCIES = freezePairs([
  ['EUR', 'Euro'],
  ['USD', 'US Dollar'],
  ['GBP', 'British Pound'],
  ['SEK', 'Swedish Krona'],
  ['NOK', 'Norwegian Krone'],
  ['DKK', 'Danish Krone'],
  ['CHF', 'Swiss Franc'],
  ['JPY', 'Japanese Yen'],
  ['AUD', 'Australian Dollar'],
  ['CAD', 'Canadian Dollar'],
]);

export const COUNTRIES = freezePairs([
  ['FI', 'Finland'],
  ['SE', 'Sweden'],
  ['NO', 'Norway'],
  ['DK', 'Denmark'],
  ['DE', 'Germany'],
  ['GB', 'United Kingdom'],
  ['US', 'United States'],
  ['EE', 'Estonia'],
  ['LV', 'Latvia'],
  ['LT', 'Lithuania'],
]);

export const DEFAULT_COUNTRY = 'FI';

// The schema carries no `default` for country: a default would fill the field
// into every update that does not mention it.
export const SETTINGS_FIELD_PROPERTIES = Object.freeze({
  currency: { enum: CURRENCIES.map(([code]) => code), description: 'Budget currency (ISO code)' },
  locale: { type: 'string', nullable: true, description: 'Number-format locale, e.g. fi-FI; null (or empty) follows the currency' },
  country: { enum: COUNTRIES.map(([code]) => code), nullable: true, description: `Country for public holidays and working days; null resets to ${DEFAULT_COUNTRY}` },
  emergency_envelope_id: { type: 'ref', kind: 'envelope', nullable: true, description: 'Envelope that holds the emergency fund; null clears it' },
  emergency_duration_months: { type: 'integer', minimum: 1, maximum: 120, description: 'Months of spending the fund should cover' },
  emergency_credit_source: { enum: ['all', 'flagged'], description: 'Which credit counts toward the fund: all accounts or only flagged ones' },
  auto_close_after_months: { type: 'integer', minimum: 1, nullable: true, description: 'Close months automatically once they ended more than this many months ago; null turns it off' },
});

/**
 * The meta after setting `fields`, each stored as Settings stores it: an empty
 * locale and a null auto-close delete the key, a null country is the default,
 * a null emergency envelope is stored as null. Fields not given stay as they
 * are. `fields` is already validated against SETTINGS_FIELD_PROPERTIES.
 * @param {Record<string, any>} meta
 * @param {Record<string, any>} fields
 * @returns {Record<string, any>}
 */
export function applySettingsFields(meta, fields) {
  /** @type {Record<string, any>} */
  const next = { ...meta };
  for (const [key, value] of Object.entries(fields)) {
    switch (key) {
      case 'locale':
        if (value) next.locale = value; else delete next.locale;
        break;
      case 'country':
        next.country = value || DEFAULT_COUNTRY;
        break;
      case 'emergency_envelope_id':
        next.emergency_envelope_id = value || null;
        break;
      case 'auto_close_after_months':
        if (value > 0) next.auto_close_after_months = value; else delete next.auto_close_after_months;
        break;
      default:
        next[key] = value;
    }
  }
  return next;
}
