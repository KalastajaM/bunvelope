// settings.update — set the budget-meaning settings, each stored exactly as
// Settings stores it (applySettingsFields). Only meta changes. A value that
// leaves meta as it was changes nothing, so a repeated update is ok and
// leaves no diff.

import { ok } from '../result.js';
import { SETTINGS_FIELD_PROPERTIES, applySettingsFields } from '../settings-fields.js';
import { deepEqual } from '../diff.js';

export default {
  name: 'settings.update',
  summary: 'Change budget settings: currency, locale, country, the emergency fund (envelope, months, credit source) and the automatic month close. null clears locale, the emergency envelope and auto_close_after_months (country goes back to FI). Fields not given stay as they are.',
  input: {
    type: 'object',
    required: ['fields'],
    properties: {
      fields: { type: 'object', properties: SETTINGS_FIELD_PROPERTIES },
    },
  },
  execute(data, input) {
    const meta = applySettingsFields(data.meta, input.fields);
    if (deepEqual(meta, data.meta)) return ok({ changes: {}, value: { changed: [] } });
    const changed = Object.keys(input.fields).filter(key => !deepEqual(meta[key], data.meta?.[key]));
    return ok({ changes: { meta }, value: { changed } });
  },
};
