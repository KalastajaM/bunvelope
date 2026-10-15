export function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
export function disclosure(label, children, open = false) {
  const el = node('details', 'workspace-details');
  el.open = open;
  el.append(node('summary', '', label), ...children);
  return el;
}
