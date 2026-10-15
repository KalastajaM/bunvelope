// Read-only learning content. All examples are illustrative, never budget data.
import { t } from './i18n.js';
import { openSheet } from './sheet.js';
import { icon } from './icon.js';

export const GUIDE_KEYS = ['accounts', 'allocation', 'planning', 'review', 'stress'];
let readerSequence = 0;

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

export function guideButton(key = 'accounts') {
  const btn = element('button', 'btn btn-ghost btn-sm guide-link', t('guides.read')(t(`guides.${key}.title`)));
  btn.type = 'button';
  btn.addEventListener('click', () => openBudgetGuide(key));
  return btn;
}

export function buildGuidesCard() {
  const card = element('section', 'card budget-guides');
  const head = element('div', 'card-title');
  head.append(element('h3', '', t('guides.title')));
  card.append(head, element('p', 'guide-intro', t('guides.intro')));
  const list = element('ol', 'guide-list');
  for (const [i, key] of GUIDE_KEYS.entries()) {
    const row = element('li');
    const button = element('button', 'btn btn-ghost guide-row');
    button.type = 'button';
    const number = element('span', 'guide-number', String(i + 1).padStart(2, '0'));
    number.setAttribute('aria-hidden', 'true');
    const text = element('span', 'guide-row-text');
    text.append(element('span', 'guide-row-title', t(`guides.${key}.title`)),
      element('span', 'guide-row-summary', t(`guides.${key}.summary`)));
    button.append(number, text, icon('chevronR', 16));
    button.addEventListener('click', () => openBudgetGuide(key));
    row.append(button);
    list.append(row);
  }
  card.append(list);
  return card;
}

export function buildVisualGuideCard() {
  const card = element('section', 'card visual-guide');
  const head = element('div', 'card-title');
  head.append(element('h3', '', t('guides.visual.title')));
  const imageUrl = new URL('../../css/images/bunvelope-how-it-works-en.png', import.meta.url).href;
  const link = element('button', 'btn btn-ghost visual-guide-preview');
  link.type = 'button';
  link.setAttribute('aria-label', t('guides.visual.open'));
  const image = element('img');
  image.src = imageUrl;
  image.alt = t('guides.visual.alt');
  image.width = 1024;
  image.height = 1536;
  image.loading = 'lazy';
  image.decoding = 'async';
  link.append(image);
  const fullSize = element('button', 'btn btn-ghost btn-sm guide-link', t('guides.visual.open'));
  fullSize.type = 'button';
  const openFullSize = () => {
    const content = element('div', 'visual-guide-full');
    content.tabIndex = 0;
    content.setAttribute('role', 'region');
    content.setAttribute('aria-label', t('guides.visual.title'));
    const fullImage = image.cloneNode();
    fullImage.loading = 'eager';
    content.append(fullImage);
    const zoom = element('button', 'btn btn-ghost btn-sm', t('guides.visual.actualSize'));
    zoom.type = 'button';
    zoom.setAttribute('aria-pressed', 'false');
    zoom.addEventListener('click', () => {
      const actualSize = content.classList.toggle('is-actual-size');
      zoom.setAttribute('aria-pressed', String(actualSize));
      zoom.textContent = t(actualSize ? 'guides.visual.fit' : 'guides.visual.actualSize');
    });
    const close = element('button', 'btn btn-ghost btn-sm', t('common.close'));
    close.type = 'button';
    const sheet = openSheet({ title: t('guides.visual.title'), content, wide: true, headerActions: [zoom, close] });
    close.addEventListener('click', () => sheet.close());
  };
  link.addEventListener('click', openFullSize);
  fullSize.addEventListener('click', openFullSize);
  card.append(head, element('p', 'guide-intro', t('guides.visual.description')),
    link, fullSize, element('p', 'guide-intro', t('guides.visual.summary')));
  return card;
}

export function openBudgetGuide(key = 'accounts') {
  let index = GUIDE_KEYS.indexOf(key);
  if (index < 0) index = 0;
  const wrap = element('div', 'budget-guide');
  const nav = element('div', 'field guide-chapters');
  const label = element('label', '', t('guides.chapters'));
  const chapterSelect = element('select');
  label.htmlFor = chapterSelect.id = `guide-chapter-${++readerSequence}`;
  nav.append(label, chapterSelect);
  const article = element('article');
  const footer = element('div', 'guide-navigation');
  const previous = element('button', 'btn btn-ghost btn-sm', t('guides.previous'));
  const next = element('button', 'btn btn-accent btn-sm', t('guides.next'));
  previous.type = next.type = 'button';
  GUIDE_KEYS.forEach((chapter, i) => {
    const option = element('option', '', `${i + 1}. ${t(`guides.${chapter}.title`)}`);
    option.value = chapter;
    chapterSelect.append(option);
  });
  // Keep focus in the select so keyboard users can browse its options.
  chapterSelect.addEventListener('change', () => show(GUIDE_KEYS.indexOf(chapterSelect.value)));
  footer.append(previous, next);
  wrap.append(nav, article, footer);

  function show(i, focus = false) {
    index = i;
    const path = `guides.${GUIDE_KEYS[index]}`;
    chapterSelect.value = GUIDE_KEYS[index];
    const title = element('h2', 'guide-heading', t(`${path}.title`));
    title.tabIndex = -1;
    article.replaceChildren(element('p', 'guide-progress', t('guides.progress')(index + 1, GUIDE_KEYS.length)), title,
      element('p', 'guide-intro', t(`${path}.summary`)));
    for (const section of ['principle', 'example', 'practice']) {
      const block = element('section', section === 'example' ? 'guide-example' : 'guide-section');
      block.append(element('h3', '', t(`${path}.${section}.title`)));
      for (const paragraph of t(`${path}.${section}.body`).split('\n\n')) {
        block.append(element('p', '', paragraph));
      }
      article.append(block);
    }
    previous.disabled = index === 0;
    next.textContent = index === GUIDE_KEYS.length - 1 ? t('common.close') : t('guides.next');
    if (focus) {
      title.focus({ preventScroll: true });
      title.scrollIntoView?.({ block: 'start' });
    }
  }
  previous.addEventListener('click', () => show(index - 1, true));
  next.addEventListener('click', () => {
    if (index === GUIDE_KEYS.length - 1) sheet.close();
    else show(index + 1, true);
  });
  show(index);
  const sheet = openSheet({ title: t('guides.title'), content: wrap, initialFocus: () => article.querySelector('h2') });
  return sheet;
}
