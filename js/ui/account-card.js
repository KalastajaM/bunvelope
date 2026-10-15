// js/ui/account-card.js
import { moneyEl } from './money.js';
import { t, fmtDateLang } from './i18n.js';
import { fmt } from '../utils.js';
import { icon } from './icon.js';
import { now } from '../app.js';
import { loanPayoffLine } from './loan-schedule-sheet.js';

const TYPE_LABELS = {
  bank: 'accountEdit.typeBank',
  cash: 'accountEdit.typeCash',
  credit_card: 'accountEdit.typeCreditCard',
  savings: 'accountEdit.typeSavings',
  investment: 'accountEdit.typeInvestment',
  asset: 'accountEdit.typeAsset',
  loan: 'accountEdit.typeLoan',
  loan_given: 'accountEdit.typeLoanGiven',
};

// The rate, the yearly estimate, a loan given's terms and a loan's repayment
// are the page's to give (`accounts.detail`): the card computes none of them.
export function accountCard({ account, currentBalance, budgetBalance, portfolioValue, valuedOn = null, rate = null, estInterest = 0, loanTerms = null, repayment = null, onClick, onToggleFavorite, onReconcile, onAiReconcile, onEdit, onLoanSchedule = null }) {
  const el = document.createElement('div');
  el.className = 'env account-card';
  // The card is not itself a role="button": it holds the star, edit and
  // health buttons, and nested interactive controls are misannounced by
  // screen readers. The name is the card's primary <button> instead; a click
  // anywhere on the card still opens it (the click bubbles to `el`).

  if (budgetBalance < -0.005) el.classList.add('over');

  // Header: name/type col + favorite star only
  const head = document.createElement('div');
  head.className = 'env-head';
  const col = document.createElement('div');
  col.className = 'col';
  const cat = document.createElement('div');
  cat.className = 'env-cat';
  // An asset account shows its group ("Properties", "Gold") where other
  // cards show their type.
  const isAsset = account.type === 'asset';
  cat.append(document.createTextNode(
    isAsset && account.group ? account.group
      : TYPE_LABELS[account.type] ? t(TYPE_LABELS[account.type]) : t('budgetPlan.account'),
  ));
  if (account.type === 'investment' && account.pensionInsurance) {
    const pensionTag = document.createElement('span');
    pensionTag.className = 'code-tag';
    pensionTag.textContent = t('accountCard.pensionBadge');
    cat.append(pensionTag);
  }
  const name = document.createElement(onClick ? 'button' : 'div');
  name.className = 'env-name';
  if (onClick) { name.type = 'button'; name.classList.add('env-open'); }
  name.append(document.createTextNode(account.name || '(unnamed)'));
  if (account.code) {
    const codeTag = document.createElement('span');
    codeTag.className = 'code-tag';
    codeTag.textContent = account.code;
    name.prepend(codeTag);
  }
  col.append(cat, name);
  head.append(col);

  if (onToggleFavorite) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'env-fav' + (account.favorite ? ' is-on' : '');
    star.setAttribute('aria-label', t(account.favorite ? 'accountCard.favoriteRemove' : 'accountCard.favoriteAdd'));
    star.title = t(account.favorite ? 'accountCard.favoriteRemoveTitle' : 'accountCard.favoriteAddTitle');
    star.textContent = account.favorite ? '★' : '☆';
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggleFavorite(account);
    });
    head.append(star);
  }
  el.append(head);

  // Balance — `budgetBalance` is this account through the ACTIVE lens, and
  // `currentBalance` is the same account through the Today lens. The
  // secondary line below is their difference: the part of the headline that
  // has not cleared yet. Envelope cards compute their hint identically, so
  // both card types make the same claim with the same arithmetic, and the
  // unallocated figure (accounts − envelopes, both in the active lens)
  // reconciles against the headline numbers on screen.
  const amt = document.createElement('div');
  amt.className = 'env-amt money-metric';
  const details = document.createElement('div');
  details.className = 'account-details';
  // The balance and the "upcoming" line answer the two questions people
  // actually ask of this card — "what does the app think I have" and "why does
  // that differ from my bank" — so each says so on hover.
  amt.title = t('accountCard.balanceTitle');
  amt.append(moneyEl(budgetBalance, { role: 'summary' }));
  const diff = budgetBalance - currentBalance;
  if (Math.abs(diff) > 0.005) {
    const upcoming = document.createElement('div');
    upcoming.className = 'sub env-upcoming';
    upcoming.title = t('accountCard.upcomingTitle');
    // Signed either way ("€ −66,60", "€ +90 573,64"): an unsigned outflow
    // read as money arriving (ux-review U4).
    const fn = t('accountCard.upcomingHint');
    const formatted = fmt(diff, { signed: true });
    upcoming.textContent = typeof fn === 'function' ? fn(formatted) : `incl. ${formatted} upcoming`;
    details.append(upcoming);
  }

  // When an asset was last valued: its figure is only as good as that date.
  // Past six months the line turns to a warning, like a stale fund price.
  if (isAsset) {
    const valued = document.createElement('div');
    valued.className = 'sub asset-valued';
    if (valuedOn) {
      valued.textContent = t('accountCard.valuedOn')(fmtDateLang(valuedOn));
      const ageDays = (now().getTime() - new Date(`${valuedOn}T00:00:00`).getTime()) / 86400000;
      if (ageDays > 183) {
        valued.classList.add('is-stale');
        valued.title = t('accountCard.valueStale');
      }
    } else {
      valued.textContent = t('accountCard.notValuedYet');
    }
    details.append(valued);
  }

  // Portfolio value (investment accounts with tracking enabled).
  if (account.type === 'investment'
      && account.trackInvestments !== false
      && Number.isFinite(portfolioValue)) {
    const portfolio = document.createElement('div');
    portfolio.className = 'sub';
    portfolio.title = t('accountCard.portfolioTitle');
    portfolio.textContent = t('accountCard.portfolioValue')(fmt(portfolioValue));
    details.append(portfolio);
  }

  // A loan's rate today, from its dated rates.
  if ((account.type === 'loan' || account.type === 'loan_given') && rate !== null) {
    const rateLine = document.createElement('div');
    rateLine.className = 'sub';
    rateLine.textContent = t('accountCard.loanRate')(rate);
    details.append(rateLine);
  }

  // A loan: when its plan item pays it off.
  if (repayment && currentBalance < 0) {
    const text = loanPayoffLine(repayment);
    if (text) {
      const payoff = document.createElement('div');
      payoff.className = 'sub';
      payoff.textContent = text;
      details.append(payoff);
    }
  }

  // A loan given: the interest outstanding (net of what was received) and
  // when the loan is due back, in place of a yearly estimate.
  if (loanTerms) {
    if (loanTerms.dueDate && loanTerms.atDue > 0) {
      const due = document.createElement('div');
      due.className = 'sub';
      due.style.color = 'var(--success, var(--mint-ink))';
      due.textContent = t('accountCard.interestDue')(fmtDateLang(loanTerms.dueDate), fmt(loanTerms.atDue), fmt(loanTerms.accrued));
      details.append(due);
    }
    if (loanTerms.end && loanTerms.owed > 0) {
      const end = document.createElement('div');
      end.className = 'sub';
      end.textContent = t('accountCard.dueBack')(fmtDateLang(loanTerms.end));
      details.append(end);
    }
  } else if (estInterest > 0) {
    const interest = document.createElement('div');
    interest.className = 'sub';
    interest.style.color = 'var(--success, var(--mint-ink))';
    interest.textContent = t('accountCard.estInterest')(fmt(estInterest));
    details.append(interest);
  }

  el.append(amt, details);

  // Notes
  if (account.notes) {
    const notes = document.createElement('div');
    notes.style.cssText = 'font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    notes.textContent = account.notes;
    details.append(notes);
  }

  // Footer action buttons
  const showSchedule = !!onLoanSchedule && repayment?.status === 'ok' && repayment.schedule.rows.length > 0;
  const hasActions = onEdit || (onReconcile && !account.archived) || showSchedule;
  if (hasActions) {
    const cardActions = document.createElement('div');
    cardActions.className = 'account-actions';

    if (onEdit) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-ghost btn-sm btn-icon';
      const editLabel = t('accounts.editTitle');
      editBtn.title = editLabel;
      editBtn.setAttribute('aria-label', editLabel);
      editBtn.append(icon('pencil', 22));
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onEdit(account);
      });
      cardActions.append(editBtn);
    }

    if (showSchedule) {
      const schedBtn = document.createElement('button');
      schedBtn.type = 'button';
      schedBtn.className = 'btn btn-ghost btn-sm btn-icon';
      const schedLabel = t('loanSchedule.title');
      schedBtn.title = schedLabel;
      schedBtn.setAttribute('aria-label', schedLabel);
      schedBtn.append(icon('calendar', 22));
      schedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onLoanSchedule(account, repayment);
      });
      cardActions.append(schedBtn);
    }

    if (onReconcile && !account.archived) {
      const recBtn = document.createElement('button');
      recBtn.type = 'button';
      recBtn.className = 'btn btn-ghost btn-sm btn-icon';
      // Investments and assets are revalued, not reconciled against a statement.
      const isInvestment = account.type === 'investment' || isAsset;
      const recLabel = isInvestment
        ? t(isAsset ? 'assetValue.btnTooltip' : 'investmentValue.btnTooltip')
        : t('reconcile.btnTooltip');
      recBtn.title = recLabel;
      recBtn.setAttribute('aria-label', recLabel);
      recBtn.append(icon(isInvestment ? 'refresh' : 'scale', 22));
      recBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onReconcile(account);
      });
      cardActions.append(recBtn);
    }

    if (onAiReconcile && !account.archived && !isAsset) {
      const aiBtn = document.createElement('button');
      aiBtn.type = 'button';
      aiBtn.className = 'btn btn-ghost';
      aiBtn.style.cssText = 'font-size:11px;padding:4px 8px;line-height:1;border-radius:6px;';
      aiBtn.textContent = t('ai.reconcile.btnAccount');
      aiBtn.title = t('ai.reconcile.btnAccount');
      aiBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onAiReconcile(account);
      });
      cardActions.append(aiBtn);
    }

    el.append(cardActions);
  }

  if (onClick) {
    el.addEventListener('click', () => onClick(account));
  }
  return el;
}
