// js/ai/agent/dialog.js — the prompt dialog.
//
// A conversation about the budget that can also propose changes to it. The
// conversation lives in module memory for the session and is not persisted:
// there is no value in resuming a thread days later against changed balances,
// and it keeps transcripts out of the budget folder.
//
// Everything the agent proposes renders inline through the same review
// component the importer uses, and nothing is written until the user approves
// it there.

import { openSheet } from '../../ui/sheet.js';
import { t, getLang } from '../../ui/i18n.js';
import { knownAiErrorText } from '../render.js';
import { icon } from '../../ui/icon.js';
import { toast } from '../../ui/toast.js';
import { alertDialog } from '../../ui/dialog.js';
import { renderProposalReview } from '../../ui/proposal-review.js';
import { proposalToRecordSteps } from '../proposal.js';
import { session, now, navigate, updateStatusBar } from '../../app.js';
import { countClosedRows } from '../../state/closed-periods.js';
import { confirmClosedEdit } from '../../ui/closed-period-guard.js';
import { runAgentTurn, resumeAgentTurn } from './loop.js';
import { isAiAvailable } from '../client.js';
import { formatAiText, createAiStreamText } from '../money-text.js';
import { languageName } from '../intents.js';
import { isoDate } from '../../core/context.js';
import { queryAnswer } from '../query.js';
import { currencySymbolFor } from '../context-builder.js';
import { isImageFile, isPdfFile } from '../../import/downscale.js';
import { readDocument, runAiImportPhase, recordImportRows } from '../../import/ai-import-flow.js';
import { getConversation, setConversation } from './conversation.js';
import { getUsage, onUsageChange, formatCost, formatTokens } from '../usage.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * A compact picture of the budget, sent once at the top of the conversation.
 * Deliberately small: names, balances, and the date. Anything more specific is
 * the model's job to fetch with a read tool, which is what keeps a large
 * ledger from having to fit in the context window.
 *
 * The balances are the Booked view of the `balances` query; "today" is the
 * clock's local day.
 *
 * @param {object} state
 * @param {() => Date} clock
 */
export function buildSkeleton(state, clock) {
  const answer = queryAnswer(state, 'balances', { lens: 'booked' }, clock);
  return {
    today: isoDate(clock()),
    // The language the app is showing, as the fallback for a message too short
    // to tell (see AGENT_SYSTEM).
    language: languageName(getLang()),
    currency: state.meta?.currency || 'EUR',
    currency_symbol: currencySymbolFor(state.meta?.currency || 'EUR'),
    accounts: answer.accounts.map((a) => ({ id: a.id, name: a.name, balance: a.balance })),
    envelopes: answer.envelopes.map((e) => ({ id: e.id, name: e.name, balance: e.balance })),
  };
}

function toolLabel(name) {
  const key = `ai.dialog.tool.${name}`;
  const label = t(key);
  return label === key ? t('ai.dialog.tool.default') : label;
}

// One dialog at a time. The flag lives here rather than in the caller because
// only this module sees every way the sheet goes away: openSheet's onClose
// fires for Escape, a backdrop click, and an explicit close alike, whereas a
// caller holding the returned handle only ever sees the last of those.
let openSheetHandle = null;

export function openAgentDialog(state) {
  if (!isAiAvailable()) {
    alertDialog(t('ai.error.noUserApiKey'));
    return null;
  }
  if (openSheetHandle) return openSheetHandle;

  let controller = null;
  let busy = false;

  const wrap = el('div', 'agent-dialog');
  const log = el('div', 'agent-log');
  const composer = el('form', 'agent-composer');

  wrap.append(log, composer);

  const sheet = openSheet({
    title: t('ai.dialog.title'),
    content: wrap,
    wide: true,
    onClose: () => {
      openSheetHandle = null;
      controller?.abort();
      stopWatchingUsage?.();
    },
  });
  openSheetHandle = sheet;

  // ── Composer ───────────────────────────────────────────────────────────
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp,application/pdf,.csv,text/csv';
  fileInput.style.display = 'none';

  const attachBtn = el('button', 'agent-attach');
  attachBtn.type = 'button';
  attachBtn.title = t('ai.dialog.attach');
  attachBtn.setAttribute('aria-label', t('ai.dialog.attach'));
  attachBtn.append(icon('plus', 17));
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleAttachment(e.target.files[0]);
    fileInput.value = '';
  });

  const input = document.createElement('textarea');
  input.className = 'agent-input';
  input.rows = 1;
  input.placeholder = t('ai.dialog.placeholder');
  input.setAttribute('aria-label', t('ai.dialog.title'));

  const sendBtn = el('button', 'agent-send');
  sendBtn.type = 'submit';
  sendBtn.title = t('ai.dialog.send');
  sendBtn.setAttribute('aria-label', t('ai.dialog.send'));
  sendBtn.append(icon('send', 17));

  composer.append(fileInput, attachBtn, input, sendBtn);

  // What this session has cost. The user is spending their own key, so the
  // figure belongs where they can see it while deciding whether to ask again —
  // not buried in Settings. Hidden until there is something to report.
  const meter = el('div', 'agent-meter');
  wrap.append(meter);
  const stopWatchingUsage = onUsageChange(renderMeter);
  renderMeter(getUsage());

  function renderMeter(usage) {
    if (!usage.calls) { meter.hidden = true; return; }
    meter.hidden = false;
    meter.replaceChildren();
    const label = t('ai.dialog.sessionCost');
    meter.append(el('span', 'agent-meter-label', typeof label === 'function'
      ? label(usage.calls) : label));
    meter.append(el('span', 'agent-meter-value', formatCost(usage.costUsd)));
    const detail = el('span', 'agent-meter-detail',
      `${formatTokens(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)} in · ${formatTokens(usage.outputTokens)} out`);
    detail.title = t('ai.dialog.costEstimate');
    meter.append(detail);
  }

  // Grow with the text, up to a point, so a long question stays readable
  // without the composer swallowing the conversation.
  //
  // Clearing the inline height first, and leaving it cleared when the field is
  // empty, means the composer can never get stuck tall: the CSS min-height is
  // the floor and only actual content raises it. Measuring an empty textarea
  // while the sheet is still animating in was enough to pin it at the maximum.
  function autoGrow() {
    input.style.height = '';
    if (!input.value) return;
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }
  input.addEventListener('input', autoGrow);

  // Enter sends, Shift+Enter is a newline. IME composition must not send —
  // pressing Enter to accept a candidate is not pressing Enter to submit.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    autoGrow();
    ask(text);
  });

  renderEmptyState();
  queueMicrotask(() => input.focus());

  // ── Rendering ──────────────────────────────────────────────────────────

  function renderEmptyState() {
    log.replaceChildren();
    const empty = el('div', 'agent-empty');
    empty.append(el('p', 'agent-empty-lead', t('ai.dialog.emptyLead')));

    const list = el('div', 'agent-suggestions');
    for (const key of ['s1', 's2', 's3', 's4']) {
      const suggestion = t(`ai.dialog.suggestion.${key}`);
      const chip = el('button', 'agent-suggestion', suggestion);
      chip.type = 'button';
      chip.addEventListener('click', () => { if (!busy) ask(suggestion); });
      list.append(chip);
    }
    empty.append(list);
    log.append(empty);
  }

  function clearEmptyState() {
    log.querySelector('.agent-empty')?.remove();
  }

  function addBubble(role, text) {
    clearEmptyState();
    const bubble = el('div', `agent-msg agent-msg--${role}`);
    // Paragraph breaks are the only formatting worth honouring here; anything
    // richer belongs in a proposal card, not in prose. An empty string means
    // a bubble that is about to be streamed into, so leave it bare.
    // Assistant prose carries ⟦amt:…⟧ tokens; the app formats them here. Only
    // the displayed text is formatted, the stored conversation keeps the raw.
    if (text) setParagraphs(bubble, role === 'assistant' ? formatAiText(text) : text);
    log.append(bubble);
    scrollToEnd();
    return bubble;
  }

  function addStatus(label) {
    clearEmptyState();
    const status = el('div', 'agent-status');
    status.append(el('span', 'agent-status-dot'));
    status.append(el('span', 'agent-status-text', label));
    log.append(status);
    scrollToEnd();
    return {
      set(next) { status.querySelector('.agent-status-text').textContent = next; },
      // Step aside while text is streaming, then come back for the next tool
      // call — always at the end of the log, so it reads as "what's happening
      // now" rather than a stale line above the conversation.
      detach() { status.remove(); },
      attach() { log.append(status); scrollToEnd(); },
      remove() { status.remove(); },
    };
  }

  // Deltas arrive mid-sentence, and a ⟦amt:…⟧ token can be split across them,
  // so the live bubble is re-rendered from the accumulated raw text (via
  // createAiStreamText) instead of appending each delta. A blank line still
  // starts a new paragraph.
  function setParagraphs(bubble, text) {
    bubble.replaceChildren(...String(text).split(/\n{2,}/).map((para) => el('p', null, para)));
  }

  function scrollToEnd() {
    // rAF so the new node has been laid out before we measure.
    requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
  }

  function setBusy(next) {
    busy = next;
    sendBtn.disabled = next;
    attachBtn.disabled = next;
    input.disabled = next;
    wrap.classList.toggle('agent-dialog--busy', next);
    if (!next) queueMicrotask(() => input.focus());
  }

  // ── Turns ──────────────────────────────────────────────────────────────

  async function ask(text) {
    addBubble('user', text);

    // The skeleton rides along with the first message only; after that it is
    // in the cached prefix and re-sending it would just cost tokens.
    const content = getConversation().length === 0
      ? [
        { type: 'text', text: `Budget:\n${JSON.stringify(buildSkeleton(state, now))}` },
        { type: 'text', text },
      ]
      : text;

    setConversation([...getConversation(), { role: 'user', content }]);
    await drive((signal, onTextDelta, onToolStart) => runAgentTurn({
      messages: getConversation(), state, onTextDelta, onToolStart, signal, clock: now,
    }));
  }

  async function drive(start) {
    setBusy(true);
    controller = new AbortController();
    const status = addStatus(t('ai.dialog.thinking'));

    // The answer streams into a live bubble. The status line stays until the
    // first token, so a turn that opens with tool calls still shows what it is
    // doing, and it comes back between turns for the same reason.
    let live = null;
    let liveText = null;
    const onTextDelta = (delta) => {
      if (!live) {
        status.detach();
        live = addBubble('assistant', '');
        liveText = createAiStreamText();
      }
      const shown = liveText.push(delta);
      if (shown) setParagraphs(live, shown);
      scrollToEnd();
    };
    // Settle the live bubble: a token that never closed is resolved (or
    // dropped) now that no more text is coming.
    const finishLive = () => {
      if (live && liveText) setParagraphs(live, liveText.finish());
    };

    try {
      const out = await start(
        controller.signal,
        onTextDelta,
        (name) => {
          // A tool call after some prose means the next text is a new bubble.
          finishLive();
          live = null;
          status.attach();
          status.set(toolLabel(name));
        },
      );
      status.remove();
      finishLive();
      setConversation(out.messages);

      // Already on screen if it streamed.
      if (out.text && !live) addBubble('assistant', out.text);

      if (out.stopped === 'iteration_cap') {
        addBubble('assistant', t('ai.dialog.tooManySteps'));
      }
      if (out.stopped === 'refusal') {
        addBubble('assistant', t('ai.dialog.refused'));
      }
      if (out.pending) {
        showProposal(out.pending);
        return;
      }
    } catch (err) {
      status.remove();
      finishLive();
      if (err?.name !== 'AbortError') {
        addError(err);
      }
    } finally {
      setBusy(false);
    }
  }

  function addError(err) {
    clearEmptyState();
    const box = el('div', 'agent-error');
    box.append(el('strong', null, t('ai.dialog.failed')));
    // A known code (no key, a rejected key, rate limits ...) gets the same
    // localized text every AI surface shows, never a raw HTTP status line.
    box.append(el('span', null, knownAiErrorText(err) ?? (err?.message || String(err))));
    log.append(box);
    scrollToEnd();
  }

  // ── Recording ──────────────────────────────────────────────────────────

  // Whether to record `rows` (transaction.record inputs): a row dated in a
  // closed month asks first, as the import sheet does.
  const confirmClosed = (rows) => confirmClosedEdit(rows.map((r) => r.date), countClosedRows(state.meta, rows, now()));

  // After rows landed: the page behind the dialog and the status bar show
  // them, the same repaint the loader does after its load-time writes. Called
  // last, and never throws: the rows are written, so a repaint failure must
  // not reach the approve handler's catch and re-enable Approve. Not awaited:
  // the dialog stays open and the conversation goes on.
  function repaint() {
    try {
      updateStatusBar();
      Promise.resolve(navigate(state.currentPage))
        .catch((err) => console.error('repaint after the import failed:', err));
    } catch (err) {
      console.error('repaint after the import failed:', err);
    }
  }

  // ── Proposals ──────────────────────────────────────────────────────────

  function showProposal(pending) {
    clearEmptyState();
    const card = el('div', 'agent-proposal');
    const { root } = renderProposalReview({
      proposal: pending.proposal,
      state,
      onDiscard: () => {
        card.replaceChildren(el('div', 'agent-proposal-done', t('ai.dialog.discarded')));
        resume(pending, { approved: false });
      },
      onApprove: async (edited) => {
        const buttons = root.querySelectorAll('button');
        buttons.forEach((b) => { b.disabled = true; });
        try {
          const rows = proposalToRecordSteps(edited, state).map((s) => s.input);
          // Cancelled: nothing is written and the card stays usable.
          if (!(await confirmClosed(rows))) {
            buttons.forEach((b) => { b.disabled = false; });
            return;
          }
          // The session records the rows (one transaction.import, one
          // write), through recordImportRows like the attach path. They are
          // appended; the old date sort of the whole array is gone, since the
          // transactions array is not a display order. A budget switch (or no
          // budget) removes the card without a word: the rows belonged to a
          // budget that is no longer open.
          const added = await recordImportRows(session, rows);
          if (!added) { card.remove(); return; }
          const count = added.length;
          card.replaceChildren(el(
            'div', 'agent-proposal-done',
            typeof t('ai.dialog.added') === 'function'
              ? t('ai.dialog.added')(count) : t('ai.dialog.added'),
          ));
          toast(t('txImport.success')(count));
          resume(pending, { approved: true, count });
          repaint();
        } catch (err) {
          buttons.forEach((b) => { b.disabled = false; });
          // A version conflict already opened the reload dialog; that is the message.
          if (err?.code !== 'version_conflict') addError(err);
        }
      },
    });
    card.append(root);
    log.append(card);
    scrollToEnd();
    setBusy(false);
  }

  async function resume(pending, outcome) {
    await drive((signal, onTextDelta, onToolStart) => resumeAgentTurn({
      messages: getConversation(), pending, outcome, state, onTextDelta, onToolStart, signal, clock: now,
    }));
  }

  // ── Attachments ────────────────────────────────────────────────────────
  // The model cannot reach the user's disk, so importing from here is an
  // attachment rather than a tool it calls. The file goes through the same
  // pipeline the import sheet uses and renders the same review card.

  async function handleAttachment(file) {
    clearEmptyState();
    addBubble('user', file.name);
    setBusy(true);
    controller = new AbortController();

    const host = el('div', 'agent-proposal');
    log.append(host);
    scrollToEnd();

    try {
      let rows;
      let declaredTotal = null;
      let skipped = 0;
      let source = 'dialog';

      if (isImageFile(file) || isPdfFile(file)) {
        source = isPdfFile(file) ? 'statement' : 'receipt';
        const parsed = await readDocument({
          file, host, state, clock: now, signal: controller.signal,
          onCancel: () => controller.abort(),
        });
        rows = parsed.rows;
        declaredTotal = parsed.declaredTotal;
        skipped = parsed.skipped || 0;
      } else {
        const { readImportFile } = await import('../../import/read-file.js');
        const { detectSeparator, parseCsv, detectColumns, parseRow, withDecimalHint } =
          await import('../../import/csv-parse-generic.js');
        const text = await readImportFile(file);
        const sep = detectSeparator(text);
        const parsedRows = parseCsv(text, sep);
        const headers = parsedRows[0] || [];
        const body = parsedRows.slice(1);
        const names = headers.map((h) => String(h).trim());
        const det = { ...withDecimalHint(body, detectColumns(names, body)), headers: names };
        rows = body
          .map((r) => parseRow(r, det))
          .filter(Boolean);
        skipped = Math.max(0, parsedRows.length - 1 - rows.length);
      }

      if (!rows.length) {
        host.replaceChildren(el('div', 'agent-proposal-done', t('txImport.ai.nothingFound')));
        return;
      }

      await runAiImportPhase({
        host, state, rows, accountId: null, declaredTotal, source, skipped,
        clock: now,
        signal: controller.signal,
        onBack: () => { host.remove(); },
        // A refusal throws, and the review shows it (recordImportRows); a
        // budget switch removes the card without a word. Cancelling the
        // closed-month confirm throws too, as in the import sheet: the review
        // says why and stays usable.
        onApprove: async (rows) => {
          if (!(await confirmClosed(rows))) throw new Error(t('closedPeriod.importCancelled'));
          const added = await recordImportRows(session, rows);
          if (!added) { host.remove(); return; }
          host.replaceChildren(el(
            'div', 'agent-proposal-done',
            typeof t('ai.dialog.added') === 'function'
              ? t('ai.dialog.added')(added.length) : t('ai.dialog.added'),
          ));
          toast(t('txImport.success')(added.length));
          repaint();
        },
      });
    } catch (err) {
      host.remove();
      if (err?.name !== 'AbortError') addError(err);
    } finally {
      setBusy(false);
    }
  }

  return sheet;
}
