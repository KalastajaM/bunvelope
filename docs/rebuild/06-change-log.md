# Bunvelope v2 — The Change Log

The op log is the **sync, undo and audit substrate**. It is deliberately *not*
the thing balances are computed from.

```
ops ──fold──▶ snapshot ──engine──▶ balances
```

**Decision: included from day one, even though the initial target is
local-only.** Retrofitting an ordered log onto a mutable-document model is the
rewrite this whole exercise exists to avoid — and v1 is the counter-example, with
three storage adapters, migrations that exist in only one of them, no way to
commit atomically across two documents, and repair tooling shipped as user
features.

---

## 1. Op format

```ts
type Op = {
  id:       ULID
  hlc:      HLC                    // [wallMs, counter, DeviceId]
  entity:   EntityKind
  entityId: EntityId
  kind:     'put' | 'patch' | 'delete'
  data?:    Entity                 // put: the complete entity
  fields?:  Partial<Entity>        // patch: changed fields only
  origin:   Origin
  batch:    BatchId                // ops committed together share a batch
  seq?:     number                 // server-assigned on ack (§5); absent until synced
}

type Origin = 'user' | 'materializer' | 'import' | 'migration' | 'repair' | 'ai'
```

`put` requires `data`; `patch` requires `fields`; `delete` needs neither —
each kind carries the one payload field that kind uses, and no other. `seq`
lives on the op record itself rather than a side table, set once when the
server acknowledges it; every op still in the outbox simply has none.

**`origin` is not decoration.** In v1 the materializer, the import pipeline,
three repair tools and two migrations all write transactions, and afterwards
nothing can tell which did. Tagging origin makes *"did I enter this, or did the
app?"* answerable — the exact question v1's linking model keeps failing to answer,
and the reason a fuzzy matcher had to be invented to guess at it.

**`batch` is what undo operates on.** One command produces one batch, however
many ops it contains.

**Inversion is computed at commit time, not derived later.** A `patch` op
carries only new field values, so "invert the ops" is not free as stated — the
prior values must come from somewhere. The runtime computes each batch's
inverse ops **against the pre-commit snapshot** and stores them with the
batch. `history.undo` then appends those inverse ops as a *new* batch — undo
is itself an op, visible in the log and syncable like any other. After a merge
has interleaved another device's ops, undo still means "invert my batch":
LWW-per-field makes the outcome deterministic, and the worst case is the same
field-level mix §3 already accepts.

---

## 2. Ordering — hybrid logical clock

```ts
type HLC = [wallMs: number, counter: number, device: DeviceId]
```

Compare lexicographically: wall clock, then counter, then device id.

- On local event: `wallMs = max(now, last.wallMs)`; if unchanged, `counter++`,
  else `counter = 0`.
- On receiving a remote op: `wallMs = max(now, last.wallMs, remote.wallMs)`, with
  the counter advanced past both.

Gives causal consistency and a deterministic total order without coordination,
and is immune to clock skew between devices. Ties break on device id, so every
device computes the same order. Roughly forty lines.

---

## 3. Merge — replay in HLC order, last-writer-wins per field

Deterministic on every device with no coordination. This is a hand-rolled
LWW-register CRDT, and it is *adequate* here for two specific reasons:

1. Two devices editing the same field of the same record concurrently is rare for
   one person.
2. **Balances derive from the entity set, not from the log**, so a merge that
   picks a winner per field can never produce a half-applied transaction. The
   worst case is a transaction whose payee came from one device and whose amount
   came from another — visibly odd, never arithmetically corrupt.

Deletes are **tombstoned ops**, never absences. A delete carries an HLC like any
other op, so a concurrent edit-and-delete resolves deterministically.

**The fold keeps a per-field HLC, not just a per-field value.** Ops do not
always arrive in HLC order — §5's server-seq delivery is one reason they
won't — so folding from a snapshot cannot just "apply ops in order and keep
the last write." Instead the folded state stores, for every entity field, the
HLC of the op that last won that field. A late-arriving op is applied
per-field **iff its HLC is greater than the field's stored HLC**; otherwise
it is a no-op for that field — the same outcome as if it had been replayed at
its true position in a from-scratch fold. This is one HLC per field, not per
op, so it is cheap.

> **What would reopen this.** A shared household budget with two people editing
> simultaneously makes LWW-per-field inadequate and calls for a proper CRDT. And
> if the app is certain to stay single-device forever, the log is overhead and a
> plain snapshot store is simpler.

---

## 4. Compaction

A snapshot at sequence *N* plus the tail. A new device fetches the snapshot and
the ops since *N*.

Sizing: ~200 bytes per op, ~15k ops over several years ≈ 3 MB uncompacted. Not a
constraint. Compact when the tail exceeds 10,000 ops; keep a retention window
of the larger of 90 days or the last 1,000 ops so that undo across a
compaction boundary still works. Both numbers are defaults, implementation-
tunable and recorded in config, not fixed by this document.

**The snapshot carries the same per-field HLC metadata as the live folded
state (§3).** Compaction summarises the ops, not the merge semantics, so a
late-arriving op landing after compaction merges against the snapshot exactly
as it would have against the pre-compaction fold — per field, by comparing
HLCs, with no special case for "the fold has been compacted since."

**The op format itself is versioned** — the log header records the schema
version its segment was written under. A migration to a new entity schema
**compacts first**: fold the tail into a snapshot, migrate the snapshot above
the port (`00-architecture.md` §8), start a fresh tail. Old-shape ops are
never replayed across a schema boundary, so no op-upcasting layer is needed.
Undo retention restarts at the boundary; a migrating release says so in its
notes.

---

## 5. Sync protocol (when cloud arrives)

- The server assigns a **monotonic sequence** on receipt. It does not interpret
  op contents.
- Clients pull `since=seq` and keep unsent ops in a local **outbox**.
- Local-only means the outbox simply never drains. **Nothing in the client
  changes when sync is added** — that is the entire point of paying for the log
  now, and the per-field HLC metadata in §3/§4 is exactly what makes it true:
  a remote op delivered in server-seq order, not HLC order, still merges
  correctly against a compacted snapshot with no sync-specific merge code.

The server stays deliberately ignorant of domain semantics, which is what keeps
end-to-end encryption possible: an op can be an opaque ciphertext envelope with
only `{id, hlc, seq}` in the clear.

The key lifecycle (atomic re-key with verify-before-flip, recovery code,
key ids in envelope headers), the cleartext-metadata stance, fork detection,
remote-HLC skew bounds, and endpoint authentication are specified in
`08-security.md` §5 and §7 (SEC11, SEC17–SEC20) — v1's critical
encryption-lockout defect is the class those exist to kill.

---

## 6. What this retires

| v1 today | v2 |
|---|---|
| Deleting a transaction deletes the only record that its occurrence was handled — hence a parallel tombstone array in the metadata blob | A delete is an op. The record of the deletion survives the deletion. |
| **Two tabs on one local folder silently clobber each other's entire ledger**, last-writer-wins, no detection, no warning — a total-data-loss bug never triaged | Ops merge. Concurrent edits to different records both survive. |
| Every transaction edit rewrites the whole transactions document | Append one op. Write cost is proportional to the edit, not to total history. |
| Batch writes fail mid-loop, leaving envelopes updated and transactions not | One batch is one atomic append. |
| A version conflict means "reload and lose your work" — and every later save in the session keeps failing because the stale version is never refreshed | Merge exists. |
| No undo anywhere | Invert the batch. |
| Repair tools mutate data in place, leaving no record of what they changed | A repair is an op with `origin: 'repair'`. |

---

## 7. Interaction with occurrences

The log and the occurrence entity (`01-domain-model.md` §3.7) compose, and the
composition is the point.

"I paid this bill by hand" becomes an op setting `occurrence.settledBy`. That
link:

- is enforced as a foreign key rather than reconstructed by matching on
  amount-to-the-cent within a ten-day window,
- survives re-dating the payment (it is an id, not a derived string),
- syncs like everything else,
- and does **not** survive deleting the settling transaction. Deleting the
  transaction cascade-deletes the occurrence record itself
  (`01-domain-model.md` §2), and the occurrence reverts to virtual `pending`
  — the bill re-materialises as due. The **ops** survive regardless: history
  and undo still replay them, so nothing is erased from the log. Only the
  current-state snapshot record is gone. Deterministic ids make the revert
  safe rather than risky — the re-materialised occurrence keeps the same id
  as the one that was deleted, so there is no duplicate-posting risk. A user
  who deletes the payment but does not want the bill back **skips** the
  occurrence instead.

`repair-links.js`, the stale-link dialog, the tombstone array and
`validateFromBudgetLink` all stop having a reason to exist.

---

## 8. What it costs

Stated honestly:

- **Discipline.** The snapshot must be read-only to everything except the fold.
  Enforce with `readonly` types, not convention — v1's caches already depend on an
  unwritten "never mutate in place" invariant that is *already broken* in one
  place, silently serving stale forecasts.
- **Compaction logic** and its retention policy.
- **~40 lines of HLC**, plus its own property tests (total order, causality,
  monotonicity under clock skew).
- **A fold that must stay fast.** Fold once at load, then apply ops incrementally.
  Refolding from scratch on every commit would be quadratic.
