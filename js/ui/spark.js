// js/ui/spark.js
// sparkBars({ data, labels?, max?, format? })
// Labels are rendered below the bars and on hover via title attribute.
export function sparkBars({ data, labels, max, format }) {
  const m = max || Math.max(...data, 1);
  const fmt = format || ((v) => String(v));
  const wrap = document.createElement('div');
  wrap.className = 'spark-bars';
  // Decorative for assistive tech: sparklines accompany the same values
  // rendered as text in their cards.
  wrap.setAttribute('aria-hidden', 'true');
  if (labels && labels.length === data.length) {
    wrap.classList.add('spark-bars--labeled');
  }
  data.forEach((v, i) => {
    const col = document.createElement('div');
    col.className = 'spark-col';
    const bar = document.createElement('div');
    bar.className = 'spark-bar';
    bar.style.height = `${(v / m) * 100}%`;
    const lbl = labels?.[i] ?? '';
    bar.title = lbl ? `${lbl}: ${fmt(v)}` : fmt(v);
    col.append(bar);
    if (labels && labels[i]) {
      const cap = document.createElement('div');
      cap.className = 'spark-label';
      cap.textContent = labels[i];
      col.append(cap);
    }
    wrap.append(col);
  });
  return wrap;
}
