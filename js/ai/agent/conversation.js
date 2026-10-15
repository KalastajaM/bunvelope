// js/ai/agent/conversation.js — the dialog's message history.
//
// A tiny module of its own so the budget-load path can reset it without
// importing js/ai/agent/dialog.js, which would drag the tool registry and the
// engine read paths into app startup for every user, including the ones who
// never open the dialog.
//
// Session-scoped and deliberately not persisted: there is no value in
// resuming a thread days later against changed balances, and it keeps
// transcripts out of the budget folder.

let messages = [];

export function getConversation() {
  return messages;
}

export function setConversation(next) {
  messages = next || [];
}

/**
 * Drop the conversation. Called when a different budget is loaded — a thread
 * is about one budget, and carrying it over would leave the agent reasoning
 * from a skeleton of envelopes that no longer exist.
 */
export function resetAgentConversation() {
  messages = [];
}
