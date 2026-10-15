// js/ui/envelope-card.js
import { moneyEl } from './money.js';
import { trCat, trEnv, t, fmtDateLang, fmtDateShortLang } from './i18n.js';
import { fmt } from '../utils.js';
import { now } from '../app.js';
import { icon } from './icon.js';
import { itemFundingSummary } from './item-funding-view.js';
import { envelopeMeterState } from './envelope-meter.js';

export function envelopeCard({ envelope, balance, planned, monthPlanned = null, spent, upcomingDelta, spare, showCoveredDate = false, showBalanceCovered = false, fundsTemplates, itemFunding = null, goal = null, isEmergency, onClick, onToggleFavorite, onEdit, onShowCalculation, onHealthCheck }) {
  const el = document.createElement('div');
  el.className = 'env';
  // The card is not itself a role="button": it holds the star, edit and
  // health buttons, and nested interactive controls are misannounced by
  // screen readers. The name is the card's primary <button> instead; a click
  // anywhere on the card still opens it (the click bubbles to `el`).

  // Cent-level tolerance: a balance of -0.0000001 from float math shouldn't
  // flag an envelope as over. Treat anything within half a cent of zero as
  // zero so the "over" pill stays quiet when the envelope is balanced.
  //
  // Under Booked a negative balance is not always a hole: a bill entered
  // ahead of the scheduled fill that pays for it reads "over" until the fill
  // is created (Metsäreuna, 2026-09-25: −30.60 until 1 Oct, then exactly 0).
  // When the forecast never goes short, name the date it is covered instead
  // of flagging it; `balanceCoveredDate` is only set when Booked is negative.
  const balanceCovered = showBalanceCovered && balance < -0.005
    && !!spare && Number.isFinite(spare.spare) && spare.spare >= -0.005
    ? spare.balanceCoveredDate || null : null;
  const { isOver, isTight, isFunded, overPlan, meterPct } = envelopeMeterState({
    balance, planned, monthPlanned, spent, spare, balanceCovered: !!balanceCovered,
  });
  if (isOver) el.classList.add('over');
  else if (isTight) el.classList.add('low');
  else if (isFunded) el.classList.add('funded');
  if (isEmergency) el.classList.add('env--emergency');

  const head = document.createElement('div');
  head.className = 'env-head';
  const col = document.createElement('div');
  col.className = 'col';
  const cat = document.createElement('div');
  cat.className = 'env-cat';
  cat.append(document.createTextNode(trCat(envelope.category || 'other')));
  const name = document.createElement(onClick ? 'button' : 'div');
  name.className = 'env-name';
  if (onClick) { name.type = 'button'; name.classList.add('env-open'); }
  if (isEmergency) {
    const shield = document.createElement('span');
    shield.append(icon('shield', 14));
    shield.title = t('envelopes.emergencyFund');
    shield.style.cssText = 'margin-right:4px;display:inline-flex;vertical-align:-2px;';
    name.append(shield);
  }
  name.append(document.createTextNode(trEnv(envelope)));
  if (envelope.code) {
    const codeTag = document.createElement('span');
    codeTag.className = 'code-tag';
    codeTag.textContent = envelope.code;
    name.prepend(codeTag);
  }
  col.append(cat, name);
  head.append(col);

  if (onToggleFavorite) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'env-fav' + (envelope.favorite ? ' is-on' : '');
    star.setAttribute('aria-label', t(envelope.favorite ? 'accountCard.favoriteRemove' : 'accountCard.favoriteAdd'));
    star.setAttribute('aria-pressed', envelope.favorite ? 'true' : 'false');
    star.title = t(envelope.favorite ? 'accountCard.favoriteRemoveTitle' : 'accountCard.favoriteAddTitle');
    star.textContent = envelope.favorite ? '★' : '☆';
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggleFavorite(envelope);
    });
    head.append(star);
  }
  el.append(head);

  // Amount block
  const secondary = document.createElement('div');
  secondary.className = 'env-secondary';
  const signals = document.createElement('div');
  signals.className = 'env-signals';
  const amt = document.createElement('div');
  amt.className = 'env-amt';
  // Every computed line on the card carries its own explanation. They are all
  // derived figures whose wording ("left", "planned", "upcoming") reads as
  // self-evident and is not: each answers a different question about the same
  // envelope, and the difference between them is where the confusion lives.
  //
  // "Spare" is the most an ad-hoc, unscheduled expense this envelope could
  // absorb right now without ever projecting below its floor, given
  // everything already scheduled (computeSpareByEnvelope in
  // engine/envelope-forecast.js). Negative names the size of the hole.
  //
  // Balance and spare share the headline at equal weight (owner decision
  // 2026-09-24, superseding the spare-first headline of 2026-09-23, ux-review
  // U3). Spare alone hid the balance in a footnote-sized line, yet the balance
  // is what the envelope actually holds; spare alone answers "can I spend
  // more", the balance "what is in it", and the card needs both to read the
  // "short" figure at all (€400 in envelope, −€175 short on Groceries).
  // Without a projection the balance stands alone, as before.
  //
  // Spare is measured from today whatever the lens, so under Booked or
  // Forecast a short figure can sit beside a balance that already counts the
  // refill closing it (Heinola, 2026-09-25: 9 523,57 in envelope, −476,43
  // short, 10 000 arriving 1 Oct). `showCoveredDate` names that date in the
  // label. Under Today both figures start from today, so the caller leaves it
  // off.
  const hasSpare = !!spare && Number.isFinite(spare.spare);
  const isShort = hasSpare && spare.spare < -0.005;
  const coveredDate = showCoveredDate && isShort ? spare.coveredDate || null : null;
  const statusSuffix = balanceCovered ? t('envelopes.coveredSuffix')(fmtDateShortLang(balanceCovered))
    : isOver ? t('envelopes.overSuffix') : (isTight ? t('envelopes.tightSuffix') : '');
  const balanceTitle = t(balanceCovered ? 'envelopes.balanceCoveredTitle' : 'envelopes.balanceTitle');

  const figure = (cls, label, value, title) => {
    const box = document.createElement('div');
    box.className = 'env-fig money-metric ' + cls;
    box.title = title;
    const lbl = document.createElement('div');
    lbl.className = 'env-fig-lbl';
    const labelText = document.createElement('span');
    labelText.textContent = label;
    lbl.append(labelText);
    const amount = moneyEl(value, { role: 'summary' });
    if (amount.textContent.length > 12) box.classList.add('env-fig--long');
    box.append(lbl, amount);
    return box;
  };

  if (hasSpare) {
    const figs = document.createElement('div');
    figs.className = 'env-figs';
    figs.append(
      figure('env-fig--balance', t('envelopes.headInEnvelope') + (statusSuffix ? ` ${statusSuffix}` : ''),
        balance, balanceTitle),
      figure('env-fig--spare' + (isShort ? ' is-short' : ''),
        coveredDate ? t('envelopes.headShortUntil')(fmtDateShortLang(coveredDate))
          : t(isShort ? 'envelopes.headShort' : 'envelopes.headSpare'),
        spare.spare, t('envelopes.spareTitle')),
    );
    amt.append(figs);
  } else {
    amt.title = balanceTitle;
    amt.append(moneyEl(balance, { size: 'md' }));
    const suffix = document.createElement('span');
    suffix.className = 'env-amt-suffix';
    suffix.textContent = ' ' + (statusSuffix || t('envelopes.leftSuffix'));
    amt.append(suffix);
  }

  // Spent against plan. The forecast charges "plan − spent this month" as
  // still to come, so this is the missing operand of the spare figure above:
  // €400 in envelope, €224.62 of €800 spent → €575.38 still planned → short.
  // A caller that passes no `spent` keeps the plain "of X planned" line
  // rather than showing the `planned − balance` guess as fact.
  //
  // The comparison is this month's calendar plan (`monthPlanned`), not the
  // annual average: see envelope-meter.js. A month the plan leaves empty says
  // so rather than "no plan set".
  const hasSpent = Number.isFinite(spent);
  const hasMonthPlan = Number.isFinite(monthPlanned);
  const monthPlan = hasMonthPlan ? /** @type {number} */ (monthPlanned) : planned;
  const sub = document.createElement('div');
  sub.className = 'sub env-spent-line';
  if (monthPlan > 0 && hasSpent) {
    sub.textContent = t('envelopes.spentOfPlanned')({ spent: fmt(spent), amt: fmt(monthPlan) });
    sub.title = t('envelopes.spentTitle');
    if (spent > monthPlan + 0.005) sub.classList.add('is-over-plan');
  } else if (hasMonthPlan && planned > 0 && hasSpent) {
    sub.textContent = spent > 0.005
      ? `${t('envelopes.spentOnly')(fmt(spent))} · ${t('envelopes.nothingPlannedMonth')}`
      : t('envelopes.nothingPlannedMonth');
    sub.title = t('envelopes.spentTitle');
  } else if (planned > 0) {
    const fn = t('envelopes.ofPlanned');
    sub.textContent = typeof fn === 'function' ? fn({ amt: fmt(planned) }) : `of ${fmt(planned)} planned`;
    sub.title = t('envelopes.plannedTitle');
  } else if (hasSpent && spent > 0.005) {
    sub.textContent = `${t('envelopes.spentOnly')(fmt(spent))} · ${t('env.noPlan')}`;
    sub.title = t('envelopes.spentTitle');
  } else {
    sub.textContent = t('env.noPlan');
  }
  el.append(amt, sub);

  // Future-dated activity hint. `upcomingDelta` is the net effect of any tx
  // dated after today on this envelope's balance: negative = committed
  // outflow that's already baked into the displayed balance, positive = a
  // scheduled top-up. Render only when the net is materially non-zero so
  // the card stays calm for envelopes with no pending activity.
  if (Number.isFinite(upcomingDelta) && Math.abs(upcomingDelta) > 0.005) {
    const upcoming = document.createElement('div');
    upcoming.className = 'sub env-upcoming';
    upcoming.title = t('envelopes.upcomingTitle');
    // Signed either way: an unsigned outflow read as money arriving (U4).
    const fn = t('envelopes.upcomingHint');
    const formatted = fmt(upcomingDelta, { signed: true });
    upcoming.textContent = typeof fn === 'function' ? fn(formatted) : `incl. ${formatted} upcoming`;
    signals.append(upcoming);
  }

  // Source-envelope funding. This envelope bankrolls a scheduled template
  // fill, so its balance falls every month with no spending behind it — the
  // drain is by design, and without naming the template responsible it reads
  // as money leaking. `fundsTemplates` comes from computeTemplateSourceDraws.
  if (Array.isArray(fundsTemplates) && fundsTemplates.length > 0) {
    const line = document.createElement('div');
    line.className = 'sub env-funds';
    line.title = t('envelopes.fundsTemplateTitle');
    line.textContent = fundsLabel(fundsTemplates);
    secondary.append(line);
  }

  // Fill %: how many of the envelope's budget items its balance keeps on
  // track (js/engine/item-funding.js); the health sheet has the breakdown.
  const fundingSummary = itemFundingSummary(itemFunding);
  if (fundingSummary) {
    const line = document.createElement('div');
    line.className = 'sub env-items' + (fundingSummary.problem ? ' is-short' : '');
    line.textContent = fundingSummary.text;
    (fundingSummary.problem ? signals : secondary).append(line);
  }


  // Spend-fill meter (fills as money is spent; red once past the plan).
  const meter = document.createElement('div');
  meter.className = 'env-meter env-meter--spend'
    + (isOver || overPlan ? ' is-over' : isTight ? ' is-tight' : isFunded ? ' is-funded' : '');
  const fillEl = document.createElement('div');
  fillEl.className = 'fill';
  fillEl.style.width = '0%';
  meter.append(fillEl);
  el.append(meter);
  requestAnimationFrame(() => { fillEl.style.width = meterPct + '%'; });

  // Goal progress (optional). Renders a one-line summary plus a small status
  // indicator when the envelope has a goal. `goal` is the caller's
  // `envelopes.month` row's goal (its progress against the balance shown),
  // null without one. The dot color comes from its `status` so users can spot
  // an off-track goal from the card grid without reading the numbers.
  const goalLine = envelopeGoalLine(goal);
  if (goalLine) signals.append(goalLine);
  el.append(signals, secondary);

  // Footer action buttons
  const showCalcBtn = isEmergency && typeof onShowCalculation === 'function';
  if (onEdit || showCalcBtn || onHealthCheck) {
    const cardActions = document.createElement('div');
    cardActions.className = 'env-card-actions';
    if (onEdit) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-ghost btn-sm btn-icon';
      const editLabel = t('envelopes.editTitle');
      editBtn.title = editLabel;
      editBtn.setAttribute('aria-label', editLabel);
      editBtn.append(icon('pencil', 22));
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onEdit(envelope);
      });
      cardActions.append(editBtn);
    }
    if (showCalcBtn) {
      const calcBtn = document.createElement('button');
      calcBtn.type = 'button';
      calcBtn.className = 'btn btn-ghost btn-sm btn-icon';
      const calcLabel = t('envelopes.emergencyCalcTitle');
      calcBtn.title = calcLabel;
      calcBtn.setAttribute('aria-label', calcLabel);
      calcBtn.append(icon('calculator', 22));
      calcBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onShowCalculation(envelope);
      });
      cardActions.append(calcBtn);
    }
    if (onHealthCheck) {
      const healthBtn = document.createElement('button');
      healthBtn.type = 'button';
      healthBtn.className = 'btn btn-ghost btn-sm btn-icon';
      const healthLabel = t('workspace.reviewFocus');
      healthBtn.title = healthLabel;
      healthBtn.setAttribute('aria-label', healthLabel);
      healthBtn.append(icon('pulse', 22));
      healthBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onHealthCheck(envelope);
      });
      cardActions.append(healthBtn);
    }
    el.append(cardActions);
  }

  if (onClick) {
    el.addEventListener('click', () => onClick(envelope));
  }
  return el;
}

/**
 * One line naming what this envelope funds. A single template is worth naming
 * outright; several are only worth counting, since the point of the line is
 * "the drain is deliberate", not an inventory. A future `sourceSince` is
 * called out so a buffer that has not started draining yet does not look like
 * one that already is.
 */
export function fundsLabel(list) {
  if (list.length === 1) {
    const only = list[0];
    const name = only.name || only.id;
    if (only.sourceSince && only.sourceSince > todayStr()) {
      return t('envelopes.fundsTemplateFrom')({ name, date: fmtDateLang(only.sourceSince) });
    }
    return t('envelopes.fundsTemplate')(name);
  }
  return t('envelopes.fundsTemplateMulti')(list.length);
}

function todayStr() {
  const d = now();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Shared with the compact Overview rows; goal math remains query-owned.
export function envelopeGoalLine(goal) {
  const goalProgress = goal;
  if (goalProgress) {
    const goalLine = document.createElement('div');
    goalLine.className = 'env-goal-line';
    const dot = document.createElement('span');
    dot.className = 'env-goal-dot env-goal-dot--' + goalProgress.status;
    goalLine.append(dot);
    if (goalProgress.status === 'reached') {
      const span = document.createElement('span');
      span.textContent = t('envelopes.goalReachedTag');
      goalLine.append(span);
    } else {
      const pct = Math.max(0, Math.min(100, Math.round(goalProgress.fraction * 100)));
      const parts = [t('envelopes.goalProgressShort')(pct)];
      if (goalProgress.monthlyRequired != null && goalProgress.monthlyRequired > 0) {
        parts.push(t('envelopes.goalNeed')(fmt(goalProgress.monthlyRequired)));
      }
      const span = document.createElement('span');
      span.textContent = parts.join(' · ');
      goalLine.append(span);
      if (goalProgress.status === 'behind') {
        const tag = document.createElement('span');
        tag.className = 'env-goal-tag env-goal-tag--behind';
        tag.textContent = t('envelopes.goalBehind');
        goalLine.append(tag);
      } else if (goalProgress.status === 'on-track') {
        const tag = document.createElement('span');
        tag.className = 'env-goal-tag env-goal-tag--ontrack';
        tag.textContent = t('envelopes.goalOnTrack');
        goalLine.append(tag);
      }
    }
    return goalLine;
  }

  return null;
}
