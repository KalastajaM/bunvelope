# Bunvelope v2 — Architecture

> **Status of this document set.** This is a *normative* specification: it states
> how the app is **supposed** to behave, not how the current implementation
> behaves. Where the two diverge because the current behaviour is a defect, the
> divergence is marked:
>
> > ⚠️ **DIVERGES FROM v1** — *what v1 does, why it is wrong, what v2 must do.*
>
> Those markers matter operationally. The v1 app is the acceptance oracle for
> the rebuild (run both on the same budget, reconcile to the cent) — and at every
> marked point the oracle is **wrong** and must not be matched.

---

## 1. What the product is

An envelope budgeter. Money lives in **accounts** (where it is) and is assigned
to **envelopes** (what it is for). One identity governs everything:

```
sum(account balances) = sum(envelope balances) + unallocated
```

Driving `unallocated` to zero is the job the product exists to do. Everything
else — the annual plan, recurring bills, allocation templates, reconciliation,
import, forecasting — serves that loop.

**Investment accounts sit outside the identity.** Their balance is tracked for
net-worth purposes but is not "available" cash, and they are excluded from the
account side of the sum.

---

## 2. The spine

```
commands ──▶ op log ──fold──▶ snapshot ──engine──▶ derived values ──▶ adapters
   ▲                                                                     │
   └─────────────────────────── queries ◀────────────────────────────────┘
```

Four stages, each a hard boundary:

| Stage | Purity | Responsibility |
|---|---|---|
| **Op log** | append-only data | Every mutation, ordered. Sync, undo and audit substrate. |
| **Snapshot** | pure fold | Deterministic entity state. Immutable to everything downstream. |
| **Engine** | pure functions | Balances, projections, aggregates. No I/O, no clock, no DOM. |
| **Adapters** | impure, thin | UI, CLI, MCP, HTTP. Read derived values; write only by dispatching commands. |

### 2.1 Balances fold from the snapshot, never from the log

This is the load-bearing decision. Full event sourcing — deriving balances by
folding domain events directly — would couple every future change in the money
math to log-replay semantics. Folding into entities first keeps the engine a
plain function of plain data and leaves the log free to change shape.

### 2.2 The engine is pure, and that is enforced

No `new Date()` inside the engine. The caller supplies the clock as a required
parameter.

> ⚠️ **DIVERGES FROM v1** — v1 defaults `today`/`refDate` to `new Date()` in 13
> exported functions, and three `idGen` parameters silently fall back to
> `Date.now() + Math.random()` when omitted. The discipline is optional, so a
> caller that forgets gets nondeterminism with no error. In v2 the clock and the
> id generator are **required parameters with no defaults**.

No in-place mutation of arguments.

> ⚠️ **DIVERGES FROM v1** — `envelope-forecast.js` mutates `row.amount` in place
> during netting, and documents the precondition in a docblock. An unenforceable
> invariant propagated across a module boundary is a defect, not a contract. v2
> netting returns new rows.

No display strings or colours out of the engine. Domain code returns
`{ code, params }`; the presentation layer resolves them.

> ⚠️ **DIVERGES FROM v1** — v1 writes English payee text (`'Rollover: sweep to
> unallocated'`, `'Template allocation'`, `'Estimated fill'`) **into persisted
> transaction records**, permanently untranslatable in an app carrying 1,755 keys
> across three locales (English, Finnish, Dutch — all three carry over). v2
> stores a structured origin on the record and renders the label at display time.

### 2.3 Caching is keyed on snapshot identity — and nothing else

The snapshot is immutable, so memoisation is trivially safe under exactly one
discipline: **every memo is keyed on the snapshot object's identity** plus the
query inputs. No cache may key on anything mutable, and no cache outlives its
snapshot. The projection walks need this from day one; the rule is what makes
them affordable without ever serving a stale figure.

> ⚠️ **DIVERGES FROM v1** — v1's lens cache keys on mutable state and served a
> stale forecast array after a planned budget item was edited (a live, logged
> defect). The class disappears when the cache key *is* the immutable snapshot.

---

## 3. API-first

The core exposes a **transport-agnostic command/query surface**. The UI, a CLI,
an MCP server and (later) an HTTP API are peer adapters over one registry.

```
                    ┌──────────────┐
    Web UI ────────▶│              │
    CLI ───────────▶│   Registry   │──▶ engine ──▶ snapshot ──▶ op log
    MCP server ────▶│ commands +   │
    HTTP (later) ──▶│   queries    │
                    └──────────────┘
```

### 3.1 Command contract

```ts
type Command<I, O> = {
  name:    string                  // 'transaction.record'
  summary: string                  // one line — used by --help AND as the MCP tool description
  input:   Schema<I>               // the same schema that generates types, validators, CLI flags, MCP inputSchema
  execute(snapshot: Snapshot, input: I, ctx: Ctx): Result<Effect<O>, DomainError>
}

type Effect<O> = { ops: Op[]; value: O }
type Ctx       = { now: Instant; newId: () => Id; device: DeviceId }
```

**`execute` is pure and does not write.** It takes a snapshot and produces ops.
The runtime commits them. Four consequences, all of which the current app pays
for separately:

1. **Testable** — a command test is `(snapshot, input) → ops`, with no I/O.
2. **Dry-runnable for free** — `--dry-run` prints the ops; the UI renders them
   as a diff; nothing special is built.
3. **Undoable for free** — invert the ops.
4. **AI proposals need no separate subsystem.** Every command is inherently a
   proposal until its ops are committed.

> ⚠️ **DIVERGES FROM v1** — v1 has a bespoke `propose_*` tool family, a
> proposal-review UI, and a separate commit path, built because the model must
> not write directly. In v2 that property is structural: the model dispatches
> ordinary commands, and the approval gate sits at the commit step for every
> caller equally. The v1 arrangement also has a live defect — the proposal
> writer emits `from_envelope`/`to_envelope` while the engine reads
> `from_envelope_id`/`to_envelope_id`, so AI-proposed envelope transfers move no
> money. A generated write path makes that class of drift impossible.

### 3.2 Query contract

```ts
type Query<I, O> = {
  name:    string                  // 'envelope.balances'
  summary: string
  input:   Schema<I>
  run(snapshot: Snapshot, input: I, ctx: Ctx): O
}
```

Queries are pure. Every query takes an explicit **lens** (§4) — there is no
ambient default, because an ambient default is how two surfaces come to report
different numbers under the same label.

### 3.3 Errors

Structured, never thrown strings:

```ts
type DomainError = { code: string; params: Record<string, unknown> }
```

`Result<T, E>` at the boundary; exceptions only for programmer error. The CLI
renders `code` via the same catalogue the UI uses; MCP returns it as structured
content.

### 3.4 The runtime

```ts
class Session {
  dispatch<I, O>(name: string, input: I): Promise<Result<O, DomainError>>
  query<I, O>(name: string, input: I): Promise<O>
  subscribe(fn: (snapshot: Snapshot) => void): Unsubscribe
}
```

`dispatch` = load snapshot → validate input → `execute` → **commit ops
atomically** → refold → notify. One write discipline for the whole application.

> ⚠️ **DIVERGES FROM v1** — v1 has 21 optimistic (mutate-then-save) call sites
> and 19 pessimistic ones, and 15 of the optimistic ones have no rollback, so a
> failed write leaves memory permanently claiming data that never reached disk.
> In v2 the question does not exist per call site: the snapshot changes only as
> a consequence of a committed op.

### 3.5 One schema, four consumers

A single machine-readable schema per command and entity generates:

- TypeScript types
- runtime input validation
- CLI flags and `--help`
- MCP `inputSchema` and tool descriptions

Nothing is hand-written twice, so nothing can drift. This is the direct answer
to the v1 failure class in which the same rule was re-implemented at a call site
and diverged — eight copies of the forecast dedup rule, five of the per-type
envelope math, four of `isCloudMode`, three of the portfolio value, two of
`fmt()`.

### 3.6 Adapters

| Adapter | Shape | Notes |
|---|---|---|
| **In-process** | imports `Session` | The web UI. No serialization. |
| **CLI** | one subcommand per command/query | `bunvelope tx record --amount 12.50 --envelope groceries --account checking`. `--json` for machine output, `--dry-run` prints ops. |
| **MCP** | one tool per command/query | `inputSchema` generated. Writes gated behind commit approval. |
| **HTTP** | `POST /command/:name`, `POST /query/:name` | Only needed when cloud sync arrives. |

Because commands are serializable and pure, **the CLI and the MCP server are
generated, not written.** Adding a command adds a CLI verb and an MCP tool with
no extra code.

---

## 4. The lens

Three named display modes. A call site chooses a **name**, never a combination
of filters.

| Lens | Meaning |
|---|---|
| `today` | Cleared, as of today. What the bank says. |
| `booked` | Everything entered, including future-dated rows. The default. |
| `forecast` | Booked plus generated occurrences through a horizon. |

Horizons: `eom`, `3m`, `6m`, `12m`, or a custom ISO date. The horizon caps
**booked** rows as well as generated ones — `forecast(D)` means one thing, the
balance as of D, and every row in it is dated on or before D.

The lens concept carries over from v1 intact; it was the right fix for a real
bug. What changes is what it returns.

> ⚠️ **DIVERGES FROM v1** — v1's forecast lens *synthesizes fake transactions and
> merges them into the same array as real ones*, so every downstream consumer
> must remember to filter `is_forecast` and `status`. This is the structural root
> of the double-counting bug family. In v2 a forecast query returns
> `{ actual: Transaction[], projected: Occurrence[] }` as **separate streams**.
> Nothing can forget to filter, because nothing is mixed.
>
> v1 also has four overlapping and non-orthogonal status ideas — `status`,
> `cleared`, `is_forecast`, and a `scheduled` flag that nothing ever sets. v2 has
> two orthogonal fields: `posted | pending` on the transaction, and `cleared` as
> a separate reconciliation flag.

---

## 5. Money

**Integer minor units.** Money is `bigint` cents. Never a float, at any layer.

> ⚠️ **DIVERGES FROM v1** — v1 accumulates unrounded floats across the whole
> ledger and applies `round2` only at boundaries. The tell is already in the
> source: the invariant checker compares against `-0.005` rather than `0`. A
> long-lived budget will eventually show a cent no transaction explains.

**Branded unit types.** A balance, a per-month rate and an annual total are
different types:

```ts
type Cents         = bigint & { readonly __unit: 'cents' }
type CentsPerMonth = bigint & { readonly __unit: 'cents/month' }
type CentsPerYear  = bigint & { readonly __unit: 'cents/year' }
```

A solver that bisects a balance while claiming to return a monthly rate fails to
compile.

> ⚠️ **DIVERGES FROM v1** — this retires a class that cost six incidents,
> including a recommendation to set a monthly fill to **−€49,200** (a search
> bounded by a balance while solving for a per-month delta), a quarterly fill
> reported at 3× its rate while its delta moved ⅓ of the stated amount, and a
> case where `round2(Infinity) === 0` silently zeroed every fill and projected a
> year of no income.

**Currency is global** (`settings.currency`) in v2 as in v1. Multi-currency is
explicitly out of scope; a per-account currency is the change that would open it.

---

## 6. Dates

One `PlainDate` type — a branded ISO `YYYY-MM-DD` string. All comparison is
lexicographic. **All arithmetic lives in one module.**

> ⚠️ **DIVERGES FROM v1** — v1 has three incompatible date representations
> coexisting: ISO strings compared lexicographically (correct and cheap), local
> `Date` objects, and millisecond arithmetic. Every function needing day
> *arithmetic* rather than comparison drops to `Date` and re-introduces the zone.
> Five incidents, each of which hid for months.

Two rules, both enforced by lint:

- `new Date(string)`, `Date.parse`, and `/ 86400000` appear only in the date
  module.
- Whole-day spans use a calendar-day difference, never millisecond division —
  between two local midnights the span is a whole number of days only if no
  clock change intervenes.

**CI runs a timezone matrix**: UTC, `Europe/Helsinki`, `America/Los_Angeles`,
and a half-hour zone (`Australia/Lord_Howe`), all required.

> ⚠️ **DIVERGES FROM v1** — a v1 DST test was failing locally and passing in CI
> for an unknown period **because CI runs UTC** — the one zone in which the whole
> date bug class is invisible.

---

## 7. Layers, and how they stay that way

The v1 layering exists only in prose, and every boundary that was merely
documented has been crossed. In v2 each rule below is machine-enforced and
CI-blocking.

| Rule | Enforced by |
|---|---|
| The composition root may depend on everything; **nothing** depends on the composition root | `dependency-cruiser` |
| No import cycles | `import/no-cycle` |
| Importing a module has no observable effect; wiring happens in an explicit entry function | lint: no top-level side effects outside the root |
| The engine imports nothing but pure utilities | path restriction |
| No adapter computes a money figure inline — every derived number comes from a query | path restriction |
| Raw ledger amounts are read only inside the postings module | lint rule |
| `new Date(string)` / `Date.parse` / `/ 86400000` only in the date module | lint rule |
| Domain code returns codes, never display strings | lint rule on the engine path |

> ⚠️ **DIVERGES FROM v1** — v1's entry point exports a mutable global `state`
> imported by 34 modules, producing a **39-module import cycle** in which every
> member transitively pulls in 134 of 151 modules. It also performs I/O and DOM
> side effects at module evaluation. The measurable consequence: **zero** of 93
> test files test a page module that imports it, and the only two tested
> page-layer modules are the only two that don't.

---

## 8. Persistence

A single narrow port. Everything above it speaks domain commands; nothing above
it knows about files, HTTP or SQL.

```ts
interface Store {
  load(): Promise<{ snapshot: Snapshot; seq: Seq }>
  commit(ops: Op[], baseSeq: Seq): Promise<Seq>   // atomic; rejects on seq mismatch
  since(seq: Seq): Promise<Op[]>
  subscribe(fn: (ops: Op[]) => void): Unsubscribe
}
```

**`commit` takes the sequence the command was validated against.** Append-only
interleaving already prevents the two-tab data-loss case, but a command
validated against a stale snapshot can commit ops whose preconditions no
longer hold — an `envelope.delete` checked as unreferenced while another tab
posted to it. On a `baseSeq` mismatch the runtime refolds with the new ops and
**re-runs `execute`** (rebase-and-re-execute; `execute` is pure, so this is
cheap), then commits or surfaces the domain error. This is what makes the
RESTRICT delete rules in `01-domain-model.md` actually reliable rather than
usually-true.

**Local-only is the initial target.** One adapter over the local store. Cloud
later is a second adapter plus a sequence endpoint — not a storage rewrite.

**Guest/demo mode is a third adapter** — an in-memory `Store` seeded with the
shipped example budget (or empty), gone on reload by design. It costs a page
of code against this port and it is the onboarding funnel; it ships with v2,
not later.

**Migrations live above the port**, applied to the domain model.

> ⚠️ **DIVERGES FROM v1** — v1's schema migrations (v2→v7) exist **only** inside
> the local-folder adapter; the cloud adapter refuses to migrate and tells the
> user to "open this budget locally… then re-import", which a cloud-only user
> cannot do. `CURRENT_SCHEMA_VERSION` is hardcoded independently in three
> adapters with no cross-check.

**One contract test suite runs against every adapter**, asserting identically:
batch atomicity, concurrent-write detection, migration idempotence, round-trip
fidelity, partial-failure rollback.

> ⚠️ **DIVERGES FROM v1** — v1's local adapter would fail atomicity and
> concurrency outright. It has **no version or mtime check at all**: two tabs on
> the same folder silently clobber each other's entire ledger, last-writer-wins,
> with no detection and no warning. This is a total-data-loss bug that has never
> been triaged, and it is invisible today because each adapter has its own tests,
> if any.

See `06-change-log.md` for the op format, ordering and merge rules.

---

## 9. AI is a process, not a mode

The AI relay is built **once, as a process**, and deployed either locally (a
sidecar holding the key in the OS keychain) or remotely. Local-only therefore
keeps every AI feature.

> ⚠️ **DIVERGES FROM v1** — v1 has two AI transports and hard-gates eight card
> features to cloud because they call a server-only endpoint. That split is an
> accident of build order, not a constraint: the intent table is already shared
> and the direct path already resolves prompts client-side from it.

Two v1 properties carry over exactly, because they are sound:

- **The client sends an intent name, never prompt text.** The relay resolves the
  system prompt and enforces a per-intent tool allowlist. This is what stops the
  relay being an open proxy for the caller's key.
- **The model cannot write.** In v2 this is free (§3.1) rather than a subsystem.

State plainly in the product: *local-only* protects data at rest and does nothing
for context deliberately sent to a model. Envelope names, balances, payees — and,
on the agent surface, free-text notes — leave the machine either way.

The realistic residual risk is **manipulation, not exfiltration**: a crafted
receipt persuading the model to propose a misattributed transaction. Approval
fatigue is therefore the actual security boundary, and the review surface should
be designed on that assumption — show the ops, not a summary of them.

The sidecar's transport hardening — loopback bind, per-install token, origin
and Host checks, body limits — is specified in `08-security.md` §3; the
commit-gate ownership rule (a trusted Bunvelope surface renders approval,
never the MCP host) is §4 there.

### 9.1 The sidecar's jobs — the full inventory

The relay process carries **every capability that needs a server in v1**, so
local-only loses none of them:

- **The four intents**: `agent` (the ⌘K tool loop over the registry),
  `search` (natural-language → a `transaction.list` filter), `categorize`
  (payee-digest-driven envelope assignment for import rows), and
  `parse_document` (receipt photos, PDF bank statements and unparseable CSVs
  → rows that feed `import.plan` — the model also returns the document's
  printed total, cross-checked against the row sum to catch misread digits).
- **The insight cards** — monthly briefing, anomaly alerts, envelope health,
  subscription detection, what-if, reconcile assist, portfolio insight,
  onboarding — each a prompt over registry queries, individually togglable
  and dismissable.
- **The price proxy.** Yahoo Finance, Danske Invest and FT are not
  CORS-fetchable from a browser; the sidecar is the host-whitelisted fetcher,
  exactly as v1's server is. Without this line, local-only silently degrades
  investment pricing to manual entry — it is a sidecar job, not a cloud
  feature.

Consent (versioned, re-prompted on change), per-feature toggles, per-item
dismissals and the session cost meter carry over as **per-user runtime
state**, never budget data — a v1 export carries its owner's consent state
with it, which is exactly the mistake `01-domain-model.md` §3.10 unwinds.

---

## 10. Document set

| Doc | Contents |
|---|---|
| `00-architecture.md` | This document |
| `01-domain-model.md` | Entities, fields, constraints, relationships |
| `02-business-rules/` | The algorithms, stated for reimplementation (one file per domain area, see its `README.md`) |
| `03-api-surface.md` | The command and query registry |
| `04-invariants-and-proof.md` | Formal invariants and the test strategy |
| `05-migration.md` | Mapping v1 data into v2, and the reconciliation oracle |
| `06-change-log.md` | Op format, ordering, merge, compaction, sync |
| `07-ui-spec.md` | The UI capability contract — what every adapter UI must be able to do, with the visual identity left free |
| `08-security.md` | Threat model and the SEC requirements — local listeners, the commit gate, untrusted inputs, keys, logs |
