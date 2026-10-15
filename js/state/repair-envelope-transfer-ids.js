// The pure repair moved into core with the command that applies it
// (transaction.repairTransferEndpoints). Kept here so existing importers keep
// working; new code imports from js/core/.
export { repairEnvelopeTransferIds } from '../core/repair-envelope-transfer-ids.js';
