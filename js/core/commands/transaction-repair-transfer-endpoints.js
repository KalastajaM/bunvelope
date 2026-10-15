// transaction.repairTransferEndpoints — a system command, run on load. Envelope
// transfers written before 2026-08-26 stored their endpoints under the pre-v3
// names (`from_envelope` / `to_envelope`), which the engine does not read, so
// they moved no money. This renames those keys onto `from_envelope_id` /
// `to_envelope_id` (a rename, not a guess: see the pure helper). With nothing
// to repair it changes nothing, so a second run is a no-op. Like the other
// system commands it leaves payees alone: the rows are existing data.
// It takes `force` like the other transaction commands: the loader passes
// force: true, because a key rename is not a history edit and strict-ledger
// would otherwise refuse it on every load of a budget that needs it.

import { ok } from '../result.js';
import { repairEnvelopeTransferIds } from '../repair-envelope-transfer-ids.js';
import { TX_INPUT_PROPERTIES } from '../tx-fields.js';

export default {
  name: 'transaction.repairTransferEndpoints',
  summary: 'Rename pre-v3 envelope-transfer endpoint fields (from_envelope, to_envelope) onto from_envelope_id and to_envelope_id. Returns { repaired, rows, unresolved }.',
  internal: true,
  payeeAliases: false,
  input: { type: 'object', properties: { force: TX_INPUT_PROPERTIES.force } },
  execute(data) {
    const { transactions, repaired, rows, unresolved } = repairEnvelopeTransferIds(data.transactions, { envelopes: data.envelopes });
    return ok({
      changes: rows ? { transactions } : {},
      value: { repaired, rows, unresolved },
    });
  },
};
