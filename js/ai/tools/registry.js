// js/ai/tools/registry.js — the tools the agent can call.
//
// Every tool declares a `kind`:
//
//   read     answers a question from state and returns JSON.
//   propose  builds a proposal object and returns it. It does not write.
//
// There is no third kind. Nothing in this directory may mutate state — writes
// happen only in the approval handler, after the user has seen what is being
// proposed. That rule is enforced by a test that runs every registered tool
// against a deep-frozen state, so adding a mutating tool fails the suite
// rather than quietly shipping.

const TOOLS = new Map();

/**
 * @param {object} tool
 * @param {string} tool.name
 * @param {string} tool.description
 * @param {object} tool.input_schema
 * @param {'read'|'propose'} tool.kind
 * @param {(state: object, input: object, clock: () => Date) => any} tool.run
 */
export function registerTool(tool) {
  if (!tool || !tool.name) throw new Error('registerTool: tool needs a name');
  if (tool.kind !== 'read' && tool.kind !== 'propose') {
    throw new Error(`registerTool: ${tool.name} has an unknown kind "${tool.kind}"`);
  }
  if (typeof tool.run !== 'function') throw new Error(`registerTool: ${tool.name} has no run()`);
  TOOLS.set(tool.name, tool);
}

export function getTool(name) {
  return TOOLS.get(name) || null;
}

export function listToolNames(kind) {
  const names = [...TOOLS.keys()];
  if (!kind) return names;
  return names.filter((n) => TOOLS.get(n).kind === kind);
}

/** All registered tools, for the invariant test. */
export function allTools() {
  return [...TOOLS.values()];
}

/**
 * The wire form of a tool — what the Messages API needs, and nothing else.
 * `run` and `kind` stay client-side.
 */
export function getToolDefs(names) {
  const wanted = names && names.length ? names : listToolNames();
  return wanted
    .map((name) => TOOLS.get(name))
    .filter(Boolean)
    .map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

// The wall clock a tool reads "now" from. This is the impure edge: the agent
// loop passes the app's own `now`, a test passes a fixed one, and only a
// caller that passes none gets the system clock.
const wallClock = () => new Date();

/**
 * Execute a tool.
 *
 * @param {string} name
 * @param {object} state
 * @param {object} input
 * @param {() => Date} [clock]  where a tool reads "now"; default the system clock
 * @returns {{ kind: string, result: any, proposal?: object }}
 */
export function runTool(name, state, input, clock = wallClock) {
  const tool = TOOLS.get(name);
  if (!tool) {
    const err = new Error(`Unknown tool: ${name}`);
    err.code = 'unknown_tool';
    throw err;
  }
  const result = tool.run(state, input || {}, clock);
  if (tool.kind === 'propose') {
    return { kind: 'propose', proposal: result, result: proposeAck(result) };
  }
  return { kind: 'read', result };
}

// What the model is told after a propose tool runs. It must not read as
// "done" — nothing has been written, and the model should not tell the user
// otherwise. The real outcome comes back later, once the user has decided.
function proposeAck(proposal) {
  const rows = (proposal?.rows || []).length;
  return {
    status: 'awaiting_user_approval',
    rows,
    note: 'The proposal is being shown to the user for review. Nothing has been '
      + 'written yet. You will be told what they decided.',
  };
}
