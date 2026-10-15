// bin/cli-legacy.mjs — which command lines belong to protocol 1. Deliberately
// tiny and import-free: bin/bunvelope.mjs loads it first to decide the route,
// so a fault in the core layer (js/core, js/ui, server/session) can never
// break `budget read|apply`, which Budget runs in production.

export const PROTOCOL_LEGACY = Object.freeze(['budgets list', 'budget probe', 'budget read', 'budget apply']);

/** The protocol-1 commands keep their own parser and exit codes. @param {string[]} args */
export function isLegacyCommand(args) {
  // Positionals found the way the protocol-1 parser finds them (flags may come
  // first; a flag takes the next arg as its value unless that starts with --),
  // without throwing: a duplicate flag must still reach run(), which reports it.
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) i += 1;
    } else positional.push(args[i]);
  }
  return PROTOCOL_LEGACY.includes(positional.slice(0, 2).join(' '));
}
