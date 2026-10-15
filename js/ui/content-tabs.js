// Content sections use tabs; view toggles and result filters remain pressed buttons.
let nextId = 0;

export function contentTabs(entries, initial, { label, onSelect = () => {} } = {}) {
  const nav = document.createElement('div');
  nav.className = 'content-tabs';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', label);
  nav.setAttribute('data-scroll-cue', '');
  const prefix = `content-tabs-${++nextId}`;
  const enabled = entries.filter(entry => !entry[3]?.disabled);
  let selected = enabled.some(([key]) => key === initial) ? initial : enabled[0]?.[0];
  const buttons = new Map();
  const reveal = button => {
    if (!button || nav.scrollWidth <= nav.clientWidth) return;
    const strip = nav.getBoundingClientRect(), tab = button.getBoundingClientRect();
    if (tab.left < strip.left) nav.scrollLeft -= strip.left - tab.left;
    else if (tab.right > strip.right) nav.scrollLeft += tab.right - strip.right;
  };
  const paint = () => {
    for (const [key,,panel] of entries) {
      const active = key === selected, button = buttons.get(key);
      panel.hidden = !active;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      button.classList.toggle('is-active', active);
    }
  };
  const select = (key, focus = false) => {
    const button = buttons.get(key);
    if (!button || button.disabled) return;
    const changed = selected !== key;
    selected = key; paint();
    if (changed) onSelect(key);
    if (focus) button.focus({ preventScroll: true });
    reveal(button);
  };
  entries.forEach(([key, text, panel, options], index) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'content-tab'; button.textContent = text;
    button.dataset.tab = key; button.id = `${prefix}-tab-${index}`;
    button.setAttribute('role', 'tab');
    button.disabled = !!options?.disabled;
    panel.id = `${prefix}-panel-${index}`;
    panel.classList.add('content-tabpanel');
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panel.tabIndex = 0;
    button.setAttribute('aria-controls', panel.id);
    button.addEventListener('click', () => select(key));
    button.addEventListener('focus', () => {
      button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      reveal(button);
    });
    button.addEventListener('keydown', event => {
      const keys = enabled.map(([k]) => k), at = keys.indexOf(key);
      let target;
      if (event.key === 'Home') target = keys[0];
      else if (event.key === 'End') target = keys.at(-1);
      else if (event.key === 'ArrowRight') target = keys[(at + 1) % keys.length];
      else if (event.key === 'ArrowLeft') target = keys[(at - 1 + keys.length) % keys.length];
      else return;
      event.preventDefault(); select(target, true);
    });
    buttons.set(key, button); nav.append(button);
  });
  paint();
  // Call after mounting, and on a page rerender only if focus belonged to its old tabs.
  nav.restoreSelectedTab = ({ focus = false } = {}) => {
    const button = buttons.get(selected);
    if (focus) button?.focus({ preventScroll: true });
    reveal(button);
  };
  return nav;
}
