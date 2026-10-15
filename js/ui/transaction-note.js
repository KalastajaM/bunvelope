// Keep an empty note optional; show stored notes immediately when editing.
// The original input stays in the form, including while the section is folded.
export function transactionNote(field) {
  const input = field.querySelector('input');
  const label = field.querySelector('label');
  const details = document.createElement('details');
  details.className = 'tx-note';
  details.open = !!input.value.trim();
  const summary = document.createElement('summary');
  summary.textContent = label.textContent;
  input.setAttribute('aria-label', label.textContent);
  label.remove();
  details.append(summary, field);
  return details;
}
