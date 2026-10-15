import { node } from './planning-workspace.js';
import { t, fmtDateLang } from './i18n.js';

// The overview consumes the same due flags as the recurring-cost view.
export function recurringReminderNotice(answer, onOpen) {
  const items = (answer?.items || []).filter(it => !it.hidden && it.attention);
  if (!items.length) return null;
  const card = node('section', 'card dashboard-act-card recurring-reminder-notice');
  card.append(node('h3', '', t('recurring.noticeTitle')));
  card.append(node('p', '', `${t('recurring.noticeCount')}: ${items.length}`));
  const list = node('ul');
  for (const item of items.slice(0, 3)) {
    const reminder = item.reminders.find(r => r.due);
    if (reminder) list.append(node('li', '', `${item.name} · ${t('recurring.' + reminder.kind)}: ${fmtDateLang(reminder.date)}`));
  }
  card.append(list);
  const open = node('button', 'btn btn-sm btn-ghost', t('recurring.noticeOpen'));
  open.type = 'button'; open.addEventListener('click', onOpen); card.append(open);
  return card;
}
