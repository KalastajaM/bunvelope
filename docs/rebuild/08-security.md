# Bunvelope v2 — Security & Privacy

Normative, like the rest of the set. The other documents state what the app
computes; this one states who it must resist and what that costs. It was
produced by a security review of the full spec set (2026-08-27) and follows
the set's convention: requirements are numbered (`SEC1`…) so the acceptance
review in `07-ui-spec.md` §6 can map them, and anything that is a
recommendation rather than a locked decision says so.

Three of the five live v1 defects found by the audit are security defects
(encryption lockout, session cookies in logs, inert-but-confirmed AI writes).
Each reappears below as a named requirement rather than a war story.

---

## 1. Threat model

**Assets.** The budget: years of financial history — payees, amounts,
balances, free-text notes. The **op log**, which additionally holds every
prior state of that history: deleted rows survive as ops, and pre-edit values
survive inside stored inverse ops (`06-change-log.md` §1). The **export
bundle**, which is both of those in one portable file. The **API key** held
by the AI sidecar.

**Adversaries in scope:**

| Adversary | Reaches the app through |
|---|---|
| A crafted document | Bank CSVs, receipt photos, PDF statements — imported content the user did not author. Its payee/note strings persist into the ledger and are later read by the UI, the CLI, and the model. |
| A malicious local process or drive-by web page | Anything listening on localhost. A browser page can POST to `127.0.0.1` without any CORS consent, and DNS rebinding defeats origin-naïve servers. |
| The model as confused deputy | The agent loop reads budget data — which contains imported, attacker-influenced text — and drafts ops. |
| A lost or stolen device | Data at rest, including exports sitting in a Downloads folder. |
| The future sync server | Honest-but-curious baseline. A malicious server can reorder, withhold, or fork history — detected, not prevented (§7). |

**Out of scope:** a compromised OS user account beyond what disk encryption
gives, physical access to an unlocked machine, and availability of the sync
service.

`00-architecture.md` §9 states the residual AI risk correctly —
**manipulation, not exfiltration**, with approval fatigue as the real
boundary. This document supplies the other half of that sentence: the
boundary exists only if the approval gate is held by a *trusted process*
(§3–§4) and the diff it shows is legible (§4).

---

## 2. Structural properties — already specified, must not regress

The architecture already buys most of its security structurally. These are
cheap to keep and quietly expensive to lose; a change that weakens any of
them is a security decision, not a refactor:

| Property | Where | What it prevents |
|---|---|---|
| Commands are pure; only the runtime commits | 00 §3.1 | One write gate. No adapter, model, or import path writes around it. |
| Client sends an intent name, never prompt text | 00 §9 | The sidecar as an open proxy for the caller's key. |
| Per-intent tool allowlist in the relay | 00 §9 | Injected instructions expanding the model's reach mid-loop. |
| Ids in, ids out; name resolution is a query | 03 §4.2 | The model inventing references; silently-null writes. |
| `import.plan` writes nothing; `import.commit` applies an approved subset | 03 §2.11 | A document writing to the ledger without review. |
| `budget.import` restores into an **empty store only** | 03 §2.1 | A hostile bundle merging into a live log. |
| Consent is per-user runtime state, never budget data | 00 §9.1, 01 §3.10 | An export carrying its owner's consent to another user. |
| Engine output is codes; persisted records carry no display strings | 02/README R5 | Strings-as-protocol; injected text becoming load-bearing. |
| Banking calendars are data in a six-primitive algebra, not code | 02/01 §1 | User-supplied calendar files ever becoming an execution vector. |
| `occurrence.unlinked` is assistive, never auto-applied | 03 §3.3 | Crafted payees silently rewriting settlement links. |
| Price proxy is host-whitelisted | 00 §9.1 | SSRF via symbol lookups. |
| The agent loop's tool surface is registry-only — no fetch, no egress | 00 §9.1 | Injected text exfiltrating budget data through a tool side channel. Adding any network-capable tool to an intent is a security decision, not a feature. |

---

## 3. Local listeners — binding and authentication

The sidecar (and any MCP transport that is not stdio) is a process listening
on the user's machine. v1's cloud server already learned these rules
(`helmet`, same-origin gate, per-route body limits); a local listener needs
them *more*, not less, because localhost is reachable by every local process
and — absent origin checks — by any web page the user visits.

- **SEC1 — Bind loopback only.** Any listener binds `127.0.0.1`, never
  `0.0.0.0`. Remote deployment of the relay is an explicit configuration with
  TLS and authentication, never a bind-address change.
- **SEC2 — No ambient authority.** Every request to the sidecar carries a
  per-install secret (bearer token minted at first run, stored beside the
  key in the OS keychain, handed to the app out-of-band of HTTP). An
  unauthenticated request is rejected before parsing. Localhost is an
  address, not an identity.
- **SEC3 — Kill the browser vector.** Reject requests whose `Origin` is
  present and not the app's own, and validate `Host` against the expected
  value (DNS rebinding sends a real-looking request with a wrong `Host`).
  No CORS headers are ever emitted — absence is the correct policy.
- **SEC4 — Per-route body limits and timeouts**, as v1's server already
  does (256 KB AI, 4 KB price, sized to the route's need).
- **SEC5 — MCP is stdio-first.** The MCP server ships on stdio transport
  (spawned by the host, inheriting no network surface). An HTTP MCP
  transport, if ever added, inherits SEC1–SEC4 wholesale.

Without SEC2–SEC3, "the client sends an intent name" protects the prompt but
not the data: any local process could invoke the `agent` intent and read the
budget through the model, on the user's key.

---

## 4. The commit gate — who holds it, and what it shows

`03-api-surface.md` §4.2 states that MCP command tools return ops and do not
commit, and that committing is "a separate, explicit step the human
approves". That is the right design and it is **underspecified by one clause**:
*whose UI renders the approval?* If the answer is "the MCP host's tool-call
prompt", the property evaporates — hosts allow auto-approval, and a
tool-call prompt shows arguments, not resolved ops.

- **SEC6 — The gate is held by a trusted Bunvelope surface.** Committing ops
  that originated from an MCP client or the agent intent requires
  confirmation rendered by Bunvelope's own process (the app, or a native
  dialog raised by the sidecar) — never delegated to the MCP host's
  approval mechanism. A host set to auto-approve every tool call must still
  be unable to commit.
- **SEC7 — The diff is legible.** The approval surface shows the ops with
  ids resolved to names, amounts formatted, and destructive kinds
  (`delete`, settings changes) visually distinct. `07-ui-spec.md` §3.12
  already requires "a diff, not a summary"; this adds: resolved, and
  ranked. A batch above a size threshold is shown grouped with per-group
  expansion — 200 undifferentiated ops is a summary wearing a diff costume.
- **SEC8 — Origin is stamped by the runtime, not the caller.** `origin: 'ai'`
  and `source: {kind: 'ai'}` are assigned by the dispatch path based on the
  authenticated caller, never accepted from input. A model cannot label its
  writes `'user'`.
- **SEC9 — The exposed MCP set stays allowlisted** (03 §4.2's "first cut" is
  the ceiling until revisited): all reads, plus `transaction.record`,
  `transaction.amend`, `allocation.fill`, `occurrence.settle`,
  `occurrence.skip`, `import.commit`. Bulk writes, deletes, `budget.import`,
  and settings stay off the surface. Widening the set is a recorded
  decision.

---

## 5. Untrusted inputs

Three inputs cross the trust boundary: import documents, export bundles, and
model output.

- **SEC10 — The bundle is hostile until proven otherwise.** `budget.import`
  validates the entire bundle against the schema before any op is applied —
  every entity, every op, unknown op kinds and schema versions rejected, a
  size ceiling enforced (**20 MB**). Empty-store-only (already specified) is
  restated here as a security property, not a convenience.
- **SEC11 — Imported HLCs are clamped.** A bundle's ops carry HLC wall
  clocks; `max(now, last, remote)` (`06-change-log.md` §2) means one
  far-future timestamp poisons the local clock and wins every LWW conflict
  until real time catches up. On import — and later, on sync receive — a
  remote `wallMs` more than **1 hour** ahead of local now is clamped
  (import) or rejected (sync), and the event is surfaced.
- **SEC12 — Model output is data.** `parse_document` returns rows and a
  printed total; `search` returns a `TxFilter`; the agent returns tool
  calls into the registry. None of these channels accepts instructions, and
  every one of them is schema-validated at the boundary exactly like a CSV
  row. Rows from `parse_document` enter through `import.plan` — the same
  reviewed path as any file, with the printed-total cross-check.
- **SEC13 — CSV parsing is bounded**: a file-size ceiling, **10,000 rows ×
  64 columns** as caps, and the Windows-1252 fallback never silently
  truncates. If a tabular *export* is ever added, cells beginning
  `= + - @` are escaped — spreadsheet formula injection is an export
  problem, noted now so it is not rediscovered.

SEC10, SEC11 and SEC13's numbers are defaults recorded in one constants
module: implementations may tighten them, never loosen any silently.

**Prompt injection, named.** Indirect injection is not hypothetical here —
the agent loop *routinely* reads attacker-influenced text, because imported
payees and notes are budget data. The defence is not "the model resists
instructions" (it cannot be relied on to); it is three mechanical layers,
each already required, listed together so their joint purpose is visible:
the model **cannot write** without the trusted gate (SEC6), **cannot
exfiltrate** because its only channels are registry calls (§2, registry-only
tools) and rendered output that loads no remote resources (SEC15), and
**cannot smuggle instructions onward** because every model output channel is
schema-validated data (SEC12). Injection can still produce a *bad proposal*
— which is the manipulation risk `00-architecture.md` §9 names, bounded by
the legible diff (SEC7). What remains:

- **SEC27 — The agent loop is bounded.** Per-invocation caps on tool calls,
  tokens, and spend, enforced by the relay (not the prompt), with the v1
  session cost meter carried forward. An injected "repeat until…" burns a
  capped amount, not the API budget.

---

## 6. Rendering — where injected text becomes execution

Persisted payees, notes, envelope names, and model prose all render
somewhere. v1's discipline (`escHtml` + lint rule against raw `innerHTML`)
carries forward and is joined by CSP:

- **SEC14 — CSP from day one**: no `eval`, no inline script, no remote
  script — and no remote *anything*: `connect-src`, `img-src`, `font-src`
  and `style-src` restricted to self, `frame-ancestors 'none'`. The formula
  money input (`07-ui-spec.md` §2) is the canary — it must work under this
  policy, which is why the spec already says "without `eval`".
- **SEC15 — All interpolated user text is escaped or DOM-inserted**, the v1
  lint rule verbatim. Model output renders as plain text or a sanitized
  markdown subset with no raw HTML, no auto-clickable URLs the model
  composed, and **no remote resource loads of any kind** — a model-composed
  image URL is an exfiltration channel (the data rides in the URL; the
  fetch is the leak), and SEC14's `img-src` is the backstop that holds even
  if the sanitizer regresses.
- **SEC16 — The CLI strips control characters** (ANSI escapes and C0/C1)
  from field values before terminal output. A payee named
  `\x1b]0;pwned\x07` arrives via any bank CSV; the cron-to-notifier pipe
  (03 §4.1) makes this reachable without the user ever opening the app.

---

## 7. Sync, E2E, and keys

`06-change-log.md` §5 keeps E2E *possible* — the server stores opaque
envelopes with `{id, hlc, seq}` in the clear. This section makes the key
story a specification now, because **v1's single critical defect is an
encryption lockout** (non-atomic re-key, config written last), and that
class is designed out on paper more cheaply than debugged in production.

- **SEC17 — Key lifecycle, specified before sync ships.** Envelope headers
  carry a key id. Enabling encryption or rotating keys is *atomic in the
  v1-defect-killing sense*: data is written (or re-wrapped) under the new
  key **and verified readable** before any pointer or config flips; a crash
  at any point leaves a store readable by exactly one key. A recovery code
  is generated at enablement and its possession verified (typed back) before
  encryption turns on. No silent rotation.
- **SEC18 — The metadata leak is stated, not hidden.** `{id, hlc, seq}` in
  the clear reveals device ids, device count, and activity timing to the
  server. Accepted for a personal budget; recorded so it is a decision.
- **SEC19 — Fork and withholding are detected.** Clients persist the last
  server `seq` and verify monotonic growth; two devices comparing heads
  (already implied by sync) will surface a forked server. Prevention
  (transparency logs) is explicitly not built.
- **SEC20 — Sync endpoints authenticate** (per-account credential, TLS
  required) and rate-limit. Authentication is token-based, not ambient: no
  cookie-authenticated state-changing endpoint without CSRF protection —
  v1's server needed `requireSameOrigin` on every API route for exactly
  this reason. A hosted deployment also ships `frame-ancestors 'none'`
  (SEC14) against clickjacking. Obvious, therefore written down.

---

## 8. Data at rest, exports, and the right to forget

Local-only rests on FileVault (`05-migration.md` §4) — correct, and
restated. The gaps are the artifacts that *leave* the protected volume, and
what "delete" means over an append-only log:

- **SEC21 — Exports offer encryption.** `budget.export` is the disaster-
  recovery story and the UI nudges it periodically (`07-ui-spec.md` §2) —
  which, unmitigated, seeds Downloads folders with plaintext financial
  history. The export flow offers a passphrase (AEAD, memory-hard KDF,
  versioned format); the periodic-nudge flow **defaults to encrypted**.
  Plaintext export remains available as an explicit choice (it is the
  migration and interop format). *Status: recommended, not locked — the
  alternative (plaintext-only, lean on FileVault) is defensible for a
  single-user tool, but the nudge changes the calculus by multiplying
  copies.*
- **SEC22 — Deletion is honest.** A deleted transaction survives in the op
  log until compaction passes the retention window, survives in stored
  inverse ops, and travels inside every export taken meanwhile. The UI
  never claims otherwise. A user-invoked **compact-now** ("forget history
  before this point") folds and drops the tail immediately, at the
  documented cost of undo depth — the log's retention becomes a user
  control, not only a size heuristic. The sync server's retention, when
  sync arrives, follows the same rule: compacted ranges are deleted
  server-side, not merely superseded.
- **SEC23 — The migration's plaintext interim is cleaned up.** Migrating an
  encrypted v1 cloud budget requires a decrypted export
  (`05-migration.md` §4); the migration tool deletes that intermediate
  after verification, and says so.

---

## 9. Secrets and logs

- **SEC24 — The API key lives in the OS keychain, and nowhere else.** Never
  in budget data, ops, exports, config files, or environment files the app
  writes. The sidecar token (SEC2) follows the same rule.
- **SEC25 — No secrets or budget data in logs.** v1 logged
  `cookie: bv.sid=<token>` on every request into retained platform logs — a
  named defect, now a named rule: structured logging with an **allowlist**
  of fields; request headers, bodies, and query strings are never logged
  wholesale, in the sidecar or any future server. Amounts, payees, and
  notes are budget data and stay out of logs at any level.

---

## 10. Supply chain

The client stays vanilla-JS-lean by existing rule; the build now adds dev
tooling (TypeScript, Zod or codegen, fast-check, StrykerJS). One rule keeps
this from drifting:

- **SEC26 — Runtime dependencies are a budget, dev dependencies are not.**
  Lockfiles committed; CI runs an audit gate; `postinstall` scripts from
  dependencies are disabled by default (`--ignore-scripts` / equivalent);
  adding a *runtime* dependency to the client or sidecar is a recorded
  decision, as it is in v1.

---

## 11. Mapping v1's security defects to v2 requirements

The table below draws on the audit's defect list (`README.md`) — its three
security rows — plus two findings from the persistence audit that never made
README's table (consent travelling inside exports, two tabs clobbering the
ledger). Each is converted from incident to invariant:

| v1 defect | Class | v2 requirement |
|---|---|---|
| Enabling encryption can permanently lock the user out | Key lifecycle | SEC17 |
| Session cookies written to logs on every request | Secret handling | SEC25 |
| AI envelope transfers move no money after confirmation | Trusted display drift | Structural (00 §3.1) + SEC7 — the reviewed ops **are** the committed ops, one representation |
| Consent state travels inside exports | Trust-boundary data mixing | Structural (01 §3.10) |
| Two tabs silently clobber the ledger | Integrity / availability | Structural (06, `commit(baseSeq)`) |

## 12. Acceptance

Every SEC requirement maps to a test, a lint rule, or a manual checklist item
in the `07-ui-spec.md` §6 review, same as every §3 UI capability. Suggested
homes: SEC1–SEC5 and SEC20 in the storage/transport contract suite
(`04-invariants-and-proof.md` §2.6 pattern); SEC6–SEC9 in the e2e set;
SEC10–SEC13 as property tests over hostile generators (fast-check with
adversarial string/HLC arbitraries); SEC14–SEC16 as lint + CSP header
assertions; SEC17 as a kill-the-process-at-every-step crash test, which is
the test v1 never had; SEC27 as a relay integration test that a
runaway tool loop halts at the cap.
