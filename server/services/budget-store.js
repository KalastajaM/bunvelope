import { packHistoryMeta, unpackHistoryMeta, chunkIds, chunkId, isStoredHistory } from '../../js/storage/history-chunks.js';
import { validCipher } from '../encrypted-payload.js';
import {
  assertCollection, validateTransactionAccountRefs, danglingAccountIds,
} from '../../js/storage/validators.js';
import { normalizeTransactionsForWrite } from '../../js/engine/tx-amounts.js';

export const KIND_TO_DB = Object.freeze({
  envelopes: 'envelopes',
  budgetItems: 'budget_items',
  transactions: 'transactions',
  accounts: 'accounts',
  envelopeTemplates: 'envelope_templates',
  meta: 'meta',
});

const DB_TO_KIND = Object.freeze(Object.fromEntries(
  Object.entries(KIND_TO_DB).map(([key, value]) => [value, key]),
));
const VALID_KINDS = new Set(Object.keys(KIND_TO_DB));
const DEFAULT_BUNDLE = Object.freeze({
  envelopes: [], budgetItems: [], transactions: [], accounts: [],
  envelopeTemplates: [], meta: null,
});
const BACKUP_WINDOW = '5 minutes';
// budgets.id is a uuid column: anything else makes Postgres throw 22P02,
// which callers would report as an internal error for what is simply a
// budget that does not exist.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BACKUP_KEEP = 20;
// Also the limit PATCH /budgets/:id checks (server/routes/budgets.js).
export const MAX_BUDGET_NAME_LEN = 200;

export class BudgetStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BudgetStoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function createBudgetStore({ query, withTx }) {
  if (typeof query !== 'function' || typeof withTx !== 'function') {
    throw new TypeError('createBudgetStore requires query and withTx functions');
  }

  return {
    /**
     * Budgets, newest-opened first, with the owner's email. `userId` or
     * `userEmail` (case-insensitive) narrows to one owner; neither lists
     * every user's budgets, which only the operator CLI does.
     */
    async listBudgets({ userId, userEmail } = {}) {
      const where = [];
      const params = [];
      if (userId) {
        params.push(userId);
        where.push(`b.user_id = $${params.length}`);
      }
      if (userEmail) {
        params.push(String(userEmail).trim().toLowerCase());
        where.push(`lower(u.email) = $${params.length}`);
      }
      const { rows } = await query(
        `select b.id, b.name, b.version, b.last_opened_at, b.created_at, b.user_id,
                u.email as owner_email
           from budgets b join users u on u.id = b.user_id
          ${where.length ? `where ${where.join(' and ')}` : ''}
          order by b.last_opened_at desc`,
        params,
      );
      return rows;
    },

    /**
     * A new budget for `userId`, refused at `maxPerUser` budgets. POST
     * /budgets and the restore command both create through here: locking the
     * owner row keeps two concurrent creates from both seeing room under the
     * cap. Budgets already beyond the cap are left alone; only new ones are
     * refused.
     *
     * With `items`, the collections are written in the same transaction, so
     * a write that fails (a refused blob, a lost connection) creates nothing.
     * The restore command used to create first and write after, and a failed
     * write left an empty budget behind for the owner to delete by hand. No
     * dangling-reference check: a fresh budget has no stored data for it to
     * compare against, and a backup's legacy references are the app's own.
     *
     * @param {object} args
     * @param {Array<{ kind: string, data: any }>} [args.items]
     * @param {boolean} [args.decrypting]  as applyBudget
     * @returns {Promise<{ id: string, name: string, version: number,
     *   last_opened_at: Date, created_at: Date, changedKinds?: string[] }>}
     */
    async createBudget({ userId, name, maxPerUser, items, decrypting = false } = {}) {
      const clean = String(name ?? '').trim();
      if (!clean) throw new BudgetStoreError('bad_arguments', 'name required');
      if (clean.length > MAX_BUDGET_NAME_LEN) {
        throw new BudgetStoreError('bad_arguments', 'name too long', { max: MAX_BUDGET_NAME_LEN });
      }
      if (!Number.isInteger(maxPerUser) || maxPerUser < 1) {
        throw new BudgetStoreError('bad_arguments', 'budget cap required');
      }
      if (!UUID_RE.test(String(userId))) throw new BudgetStoreError('not_found', 'user not found');
      if (items !== undefined) {
        items = normalizeItems(items);
        validateItems(items);
      }
      return withTx(async (client) => {
        const { rows: owner } = await client.query(
          'select id from users where id = $1 for update', [userId],
        );
        if (!owner.length) throw new BudgetStoreError('not_found', 'user not found');
        const { rows: counted } = await client.query(
          'select count(*)::int as n from budgets where user_id = $1', [userId],
        );
        if (counted[0].n >= maxPerUser) {
          throw new BudgetStoreError('budget_limit', 'budget limit reached', { max: maxPerUser });
        }
        const { rows } = await client.query(
          `insert into budgets (user_id, name) values ($1, $2)
           returning id, name, version, last_opened_at, created_at`,
          [userId, clean],
        );
        const budget = rows[0];
        if (!items) return budget;
        await lockEncryptionConfig(client, userId, items.flatMap((item) => [item.data, ...(item.historyChunks || []).map(c => c.data)]), decrypting);
        // Nothing to back up: the budget has no blobs yet.
        await writeBlobs(client, budget.id, items);
        const { rows: bumped } = await client.query(
          'update budgets set version = version + 1 where id = $1 returning version',
          [budget.id],
        );
        return { ...budget, version: bumped[0].version, changedKinds: items.map((item) => item.kind) };
      });
    },

    async probeBudget({ budgetId, userId } = {}) {
      if (!budgetId) throw new BudgetStoreError('bad_arguments', 'budget id required');
      const result = await withTx(async (client) => {
        const budget = await selectBudget(client, budgetId, userId, 'for share');
        if (!budget) return null;
        const { rows } = await client.query(
          `select count(*)::int as blob_count,
                  count(*) filter (where data->>'__enc' = '1')::int as encrypted_count,
                  max(case when kind = 'meta' then data->>'schemaVersion' end) as schema_version
             from budget_blobs where budget_id = $1`,
          [budgetId],
        );
        return { ...budget, ...rows[0] };
      });
      if (!result) throw new BudgetStoreError('not_found', 'budget not found');
      return result;
    },

    async readBudget({ budgetId, userId, touchLastOpened = false, rawHistory = false } = {}) {
      if (!budgetId) throw new BudgetStoreError('bad_arguments', 'budget id required');
      if (!UUID_RE.test(String(budgetId))) throw new BudgetStoreError('not_found', 'budget not found');
      const result = await withTx(async (client) => {
        let budget;
        if (touchLastOpened) {
          const params = userId ? [budgetId, userId] : [budgetId];
          const owner = userId ? 'and user_id = $2' : '';
          const { rows } = await client.query(
            `update budgets set last_opened_at = now()
              where id = $1 ${owner}
              returning id, name, version, user_id, last_opened_at, created_at`,
            params,
          );
          budget = rows[0] || null;
        } else {
          budget = await selectBudget(client, budgetId, userId, 'for share');
        }
        if (!budget) return null;
        const { rows } = await client.query(
          'select kind, data from budget_blobs where budget_id = $1', [budgetId],
        );
        const bundle = structuredClone(DEFAULT_BUNDLE);
        for (const row of rows) {
          const key = DB_TO_KIND[row.kind];
          if (key) bundle[key] = row.data;
        }
        bundle.meta = await readHistoryMeta(client, budgetId, bundle.meta, rawHistory);
        return {
          budgetId: budget.id,
          budgetName: budget.name,
          version: budget.version,
          userId: budget.user_id,
          lastOpenedAt: budget.last_opened_at,
          createdAt: budget.created_at,
          bundle,
        };
      });
      if (!result) throw new BudgetStoreError('not_found', 'budget not found');
      return result;
    },

    /**
     * @param {object} args
     * @param {boolean} [args.checkAccountRefs]  refuse a write that adds a
     *   transaction→account reference resolving to nothing. Off for the web
     *   client, whose own invariant check reports such rows and whose bundle
     *   imports may legitimately carry legacy ones; on for the headless CLI,
     *   whose input is written by scripts and agents rather than the app.
     */
    async applyBudget({
      budgetId, userId, expectedVersion, items, decrypting = false, checkAccountRefs = false,
    } = {}) {
      // Normalise before validating: the session does this on commit,
      // but this is also the CLI's write path, and a negative expense
      // written here would be summed with the wrong sign by every reader.
      items = normalizeItems(items);
      validateApplyInput({ budgetId, expectedVersion, items });
      return withTx(async (client) => {
        const budget = await selectBudget(client, budgetId, userId, 'for update');
        if (!budget) throw new BudgetStoreError('not_found', 'budget not found');
        if (budget.version !== expectedVersion) {
          throw new BudgetStoreError('version_conflict', 'version conflict', {
            current: budget.version,
          });
        }
        await lockEncryptionConfig(
          client, budget.user_id, items.flatMap((item) => [item.data, ...(item.historyChunks || []).map(c => c.data)]), decrypting,
        );
        if (checkAccountRefs) await assertNoNewDanglingRefs(client, budgetId, items);
        await backupBlobs(client, budgetId, items.map((item) => KIND_TO_DB[item.kind]), expectedVersion);
        await writeBlobs(client, budgetId, items);
        const { rows } = await client.query(
          'update budgets set version = version + 1 where id = $1 returning version',
          [budgetId],
        );
        return { version: rows[0].version, changedKinds: items.map((item) => item.kind) };
      });
    },
  };
}

async function writeBlobs(client, budgetId, items) {
  for (const original of items) {
    let item = original;
    if (item.kind === 'meta') item = await prepareHistoryItem(client, budgetId, item);
    await client.query(
      `insert into budget_blobs (budget_id, kind, data)
       values ($1, $2, $3::jsonb)
       on conflict (budget_id, kind) do update set data = excluded.data`,
      [budgetId, KIND_TO_DB[item.kind], JSON.stringify(item.data)],
    );
    if (item.kind === 'meta' && historyRefs(item.data).length) {
      // Backups may still refer to older chunks. Only collect chunks outside
      // both the current manifest and every retained metadata backup.
      await client.query(`with metadata as (
        select data from budget_blobs where budget_id = $1 and kind = 'meta'
        union all select data from budget_blob_backups where budget_id = $1 and kind = 'meta'
      ), refs as (
        select jsonb_path_query(data, '$.historyIds[*]') #>> '{}' as id from metadata
        union select jsonb_path_query(data, '$.financialHistory.segments[*].base') #>> '{}' from metadata
        union select jsonb_path_query(data, '$.financialHistory.segments[*].chunks[*]') #>> '{}' from metadata
      ) delete from budget_history_chunks where budget_id = $1 and id not in (select id from refs)`, [budgetId]);
    }
  }
}

function historyRefs(meta) {
  if (meta?.__enc === 1) return meta.historyIds || [];
  return chunkIds(meta?.financialHistory);
}

async function readHistoryMeta(client, budgetId, meta, rawHistory = false) {
  const ids = historyRefs(meta);
  if (!ids.length) return meta;
  const { rows } = await client.query(
    'select id, data from budget_history_chunks where budget_id = $1 and id = any($2::text[])', [budgetId, ids]);
  if (new Set(rows.map(r => r.id)).size !== new Set(ids).size) throw new Error('Missing financial history chunks');
  if (meta.__enc === 1) return { ...meta, historyChunks: rows };
  if (rawHistory) return { ...meta, __historyChunks: rows };
  const byId = new Map(rows.map(r => [r.id, r.data]));
  return (await unpackHistoryMeta(meta, id => byId.get(id))).meta;
}

async function prepareHistoryItem(client, budgetId, item) {
  let data = item.data;
  let chunks = item.historyChunks || data?.historyChunks || data?.__historyChunks || [];
  if (data?.historyChunks || data?.__historyChunks) {
    const { historyChunks: _chunks, __historyChunks: _plainChunks, ...rest } = data;
    data = rest;
  }
  // Node/older clients write a logical budget. Store it using the same format
  // as the browser and return a logical budget to those callers on reads.
  if (data?.financialHistory && !isStoredHistory(data.financialHistory)) {
    const { rows } = await client.query("select data from budget_blobs where budget_id = $1 and kind = 'meta'", [budgetId]);
    const previous = rows[0]?.data;
    let cache = null;
    if (isStoredHistory(previous?.financialHistory)) {
      const ids = historyRefs(previous);
      const result = await client.query('select id, data from budget_history_chunks where budget_id = $1 and id = any($2::text[])', [budgetId, ids]);
      const byId = new Map(result.rows.map(r => [r.id, r.data]));
      cache = (await unpackHistoryMeta(previous, id => byId.get(id))).cache;
    }
    const packed = await packHistoryMeta(data, cache);
    data = packed.meta; chunks = packed.chunks;
  }
  if (!Array.isArray(chunks)) throw new BudgetStoreError('validation_failed', 'Invalid history chunks');
  for (const chunk of chunks) {
    if (!chunk || !/^[a-f0-9]{64}$/.test(chunk.id) || await chunkId(chunk.data) !== chunk.id) {
      throw new BudgetStoreError('validation_failed', 'Invalid history chunk checksum');
    }
    if (data.__enc === 1 ? (!validCipher(chunk.data) || chunk.data.kid !== data.kid) : chunk.data?.__enc === 1) {
      throw new BudgetStoreError('validation_failed', 'History encryption does not match metadata');
    }
    await client.query('insert into budget_history_chunks (budget_id, id, data) values ($1, $2, $3::jsonb) on conflict (budget_id, id) do nothing',
      [budgetId, chunk.id, JSON.stringify(chunk.data)]);
  }
  const refs = historyRefs(data);
  if (!Array.isArray(refs) || refs.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
    throw new BudgetStoreError('validation_failed', 'Invalid history references');
  }
  if (refs.length) {
    // Check presence and key identity without fetching/replaying old payloads on
    // every browser save. Their hashes were checked when first inserted.
    const { rows } = await client.query("select id, data->>'__enc' as enc, data->>'kid' as kid from budget_history_chunks where budget_id = $1 and id = any($2::text[])", [budgetId, refs]);
    if (new Set(rows.map(r => r.id)).size !== new Set(refs).size) throw new BudgetStoreError('validation_failed', 'Missing history chunks');
    if (rows.some(r => data.__enc === 1 ? (r.enc !== '1' || r.kid !== data.kid) : r.enc === '1')) {
      throw new BudgetStoreError('validation_failed', 'History encryption does not match metadata');
    }
  }
  return { ...item, data };
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => (item?.kind === 'transactions' && Array.isArray(item.data)
    ? { ...item, data: normalizeTransactionsForWrite(item.data) }
    : item));
}

async function assertNoNewDanglingRefs(client, budgetId, items) {
  const incoming = Object.fromEntries(items.map((item) => [item.kind, item.data]));
  if (!('transactions' in incoming) && !('accounts' in incoming)) return;
  const { rows } = await client.query(
    `select kind, data from budget_blobs
      where budget_id = $1 and kind in ('transactions', 'accounts')`,
    [budgetId],
  );
  const stored = Object.fromEntries(rows.map((row) => [DB_TO_KIND[row.kind], row.data]));
  const storedTx = stored.transactions ?? [];
  const storedAccounts = stored.accounts ?? [];
  // References that were already dangling before this write are tolerated,
  // so legacy data never blocks a save; only new ones are refused.
  const tolerate = danglingAccountIds(storedTx, storedAccounts);
  const result = validateTransactionAccountRefs(
    incoming.transactions ?? storedTx,
    incoming.accounts ?? storedAccounts,
    { tolerate },
  );
  if (!result.ok) {
    throw new BudgetStoreError(
      'validation_failed',
      `Invalid transactions write: ${result.errors.slice(0, 5).join('; ')}`,
    );
  }
}

async function selectBudget(client, budgetId, userId, lock) {
  if (!UUID_RE.test(String(budgetId))) return null;
  const params = userId ? [budgetId, userId] : [budgetId];
  const owner = userId ? 'and user_id = $2' : '';
  const { rows } = await client.query(
    `select id, name, version, user_id, last_opened_at, created_at
       from budgets where id = $1 ${owner} ${lock}`,
    params,
  );
  return rows[0] || null;
}

function validateApplyInput({ budgetId, expectedVersion, items }) {
  if (!budgetId) throw new BudgetStoreError('bad_arguments', 'budget id required');
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new BudgetStoreError('bad_arguments', 'expected version required');
  }
  validateItems(items);
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new BudgetStoreError('bad_arguments', 'items required');
  }
  const kinds = new Set();
  for (const item of items) {
    if (!VALID_KINDS.has(item?.kind)) {
      throw new BudgetStoreError('validation_failed', `bad kind: ${item?.kind}`);
    }
    if (kinds.has(item.kind)) {
      throw new BudgetStoreError('validation_failed', 'duplicate kind');
    }
    if (item.historyChunks !== undefined && (item.kind !== 'meta' || !Array.isArray(item.historyChunks)
        || item.historyChunks.some(c => !c || typeof c.id !== 'string' || !c.data || typeof c.data !== 'object'))) {
      throw new BudgetStoreError('validation_failed', 'Invalid history chunks');
    }
    kinds.add(item.kind);
    assertBlob(item.kind, item.data);
  }
}


export function assertBlob(kind, data) {
  try {
    if (data && typeof data === 'object' && Object.hasOwn(data, '__enc')) {
      if (!validCipher(data)) throw new Error('invalid encrypted data');
    } else {
      assertCollection(kind, data);
      if (kind === 'meta') chunkIds(data?.financialHistory);
    }
  } catch (error) {
    throw new BudgetStoreError('validation_failed', error.message);
  }
}

async function lockEncryptionConfig(client, userId, blobs, decrypting) {
  const { rows } = await client.query(
    `select encryption_enabled, encryption_salt, encryption_verifier
       from users where id = $1 for share`,
    [userId],
  );
  const config = rows[0];
  const keyId = config?.encryption_verifier?.keyId
    || config?.encryption_salt?.toString('base64');
  const wrongKey = blobs.some((blob) => blob?.__enc === 1
    && (!config?.encryption_enabled || blob.kid !== keyId));
  const unexpectedPlaintext = config?.encryption_enabled && !decrypting
    && blobs.some((blob) => blob?.__enc !== 1);
  if (wrongKey || unexpectedPlaintext) {
    throw new BudgetStoreError(
      'encryption_conflict', 'Encryption configuration changed; reload before saving',
    );
  }
}

/**
 * Back up the current blob of each kind about to be overwritten, in ONE
 * statement for all of them (it used to be three queries per kind, so a
 * six-collection write spent eighteen round trips here). Same rules as
 * before, per kind:
 *   - skipped when that kind already has a backup inside BACKUP_WINDOW, so a
 *     burst of saves keeps the state from before the burst;
 *   - skipped when the kind has no blob yet (nothing to back up);
 *   - afterwards only the newest BACKUP_KEEP backups of the kind are kept.
 *
 * A data-modifying CTE's siblings see the table as it was before the
 * statement, so the prune cannot see the row being inserted. It therefore
 * keeps BACKUP_KEEP minus however many rows this statement adds for the kind,
 * which leaves exactly BACKUP_KEEP afterwards, as the old insert-then-prune did.
 */
async function backupBlobs(client, budgetId, dbKinds, version) {
  if (!dbKinds.length) return;
  await client.query(
    `with fresh as (
       select k.kind from unnest($2::text[]) as k(kind)
        where not exists (
          select 1 from budget_blob_backups b
           where b.budget_id = $1 and b.kind = k.kind
             and b.backed_up_at > now() - $3::interval)
     ),
     added as (
       insert into budget_blob_backups (budget_id, kind, data, version)
       select bb.budget_id, bb.kind, bb.data, $4
         from budget_blobs bb join fresh f on f.kind = bb.kind
        where bb.budget_id = $1
       returning kind
     ),
     added_count as (select kind, count(*)::int as n from added group by kind),
     ranked as (
       select b.id, b.kind, row_number() over (
         partition by b.kind order by b.backed_up_at desc, b.id desc
       ) as rn
         from budget_blob_backups b
        where b.budget_id = $1 and b.kind = any($2::text[])
     )
     delete from budget_blob_backups d
      using ranked r left join added_count a on a.kind = r.kind
      where d.id = r.id and r.rn > $5 - coalesce(a.n, 0)`,
    [budgetId, dbKinds, BACKUP_WINDOW, version, BACKUP_KEEP],
  );
}
