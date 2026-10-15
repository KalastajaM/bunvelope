# Local folder publication and recovery

The six budget JSON filenames and their contents remain the public data format.
`.bunvelope-publish.json` is a recovery sidecar, not a seventh budget collection.
Missing, zero-length, or JSON `null` means idle. An active journal (version 2)
has this shape:

```json
{
  "version": 2,
  "before_seq": 41,
  "before": { "envelopes.json": "sha256:…", "budget-items.json": "sha256:…", "transactions.json": "sha256:…", "accounts.json": "sha256:…", "envelope-templates.json": "sha256:…", "budget-meta.json": "sha256:…" },
  "after": { "accounts.json": [], "budget-meta.json": { "write_seq": 42 } }
}
```

`before` fingerprints all six standard files (SHA-256 of the exact bytes on
disk; `null` for a missing file), so recovery can still detect an external
change to any collection, including ones this publication did not touch.
`after` holds the complete intended content of only the collections being
written, plus `budget-meta.json`, whose `write_seq` must be `before_seq + 1`.
Journalling only the changed collections keeps a one-account edit on a large
ledger from writing megabytes of unchanged transactions twice. The journal
preserves array order and does not calculate or transform budget amounts.

Version 1 journals (complete `before` and `after` snapshots of all six files)
are still recovered, so a folder interrupted by an older build opens cleanly.

## Writer sequence

1. Hold the browser folder lock and serialize in-process operations.
2. Recover any active journal before reading the current generation.
3. Compare the loaded `write_seq` with disk, refusing stale writes.
4. Close the journal containing the before fingerprints and the intended after
   content of the changed collections.
5. Write the requested collection files, then close `budget-meta.json` with the
   next `write_seq` and writer stamp.
6. Close the journal with JSON `null`, then acknowledge the save to the caller.

Every standard budget publication uses the journal, including the first save
of a new folder. Writes consisting solely of non-budget filenames keep their
existing behavior. A batch cannot mix budget and arbitrary filenames or contain
duplicate budget filenames.

## Recovery and readers

Before returning a budget snapshot, a standard `readJson` result, or starting a
write, the adapter checks the journal under the same lock. It validates its
version, filenames, collection types and sequence transition. Every disk file
must match either its before fingerprint or, for a changed collection, its
intended after value before recovery writes anything.
An empty newly created destination is treated as missing only when the validated
journal records a missing before value and a non-null intended after value. Empty
or malformed files that existed before publication remain conflicts.
A mismatch blocks recovery and preserves the journal and all files for manual
reconciliation. Invalid JSON or an invalid journal also blocks access.

For a matching interrupted publication, recovery rolls forward missing changes,
closes metadata last and clears the journal. A failure during recovery remains
retryable. If the cleanup close failed after all budget files committed, the next
recovery only clears the journal. A save from a handle that loaded the older
sequence is refused after recovery; reload establishes the recovered baseline.
A fresh handle therefore reads one complete generation, never a partially
published set. Recovery may require write permission even for a read.

The durability boundary is successful File System Access API `close()`. A failed
initial journal close cannot cause this publisher to modify a budget file.
FSAPI creates the destination empty and only replaces it when a writable
closes, so a zero-length journal means that first close never completed and
nothing was published: it is treated as idle and cleared. (Failing closed here
used to lock the folder permanently.) The accepted residual risk is a
filesystem that truncates a completed journal to zero bytes in an OS crash;
FSAPI's swap-file close makes that unlikely. A damaged, non-empty journal
still fails closed rather than guessing which generation is valid.

## External tools

Tools reading or writing the same folder must refuse access while the journal
is active or malformed, including when a force/export override is requested.
They must check before and after reading a multi-file snapshot. Do not delete a
journal to bypass recovery. Open the folder in Bunvelope to finish a matching
publication, or preserve a copy and reconcile an external-change conflict.

The Budget project's `scripts/export-for-app.mjs` creates a separate disposable
snapshot, normally `data/app-snapshot`, which the app is explicitly intended to
open. Its `--out` option can choose another directory. Its import script reads
that snapshot and generates operations elsewhere; it does not write Bunvelope's
six files. Both tools therefore need the journal refusal checks when exchanging
that snapshot with the app. The original ledger is a separate file.

Browser locks coordinate participating tabs within one browser profile. File
System Access API has no compare-and-swap or process-wide lock. Journal checks
cannot guarantee atomicity against a truly simultaneous foreign process that
ignores the protocol, nor against another browser profile. Avoid simultaneous
external exports and app edits. This protocol provides durable interrupted-write
recovery and detection of observed external conflicts, not a cross-process
transaction system.
