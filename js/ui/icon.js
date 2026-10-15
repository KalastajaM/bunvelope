// js/ui/icon.js
const SVG_NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  home: ['M3 10.5 L12 3 L21 10.5 V20 a1 1 0 0 1 -1 1 H4 a1 1 0 0 1 -1 -1 Z', 'M9 21 V13 H15 V21'],
  tx: ['M4 7 H20','M17 4 L20 7 L17 10','M20 17 H4','M7 14 L4 17 L7 20'],
  budget: ['M4 4 h16 v16 H4 z','M4 10 H20','M10 4 V20'],
  calendar: ['M3 5 h18 v16 H3 z','M3 10 H21','M8 3 V7','M16 3 V7'],
  chart: ['M4 20 V10','M10 20 V4','M16 20 V14','M20 20 H4'],
  // Eight-tooth cog around the hub; the hub alone read as a stray dot.
  settings: [
    'M10.27 4.8 L10.72 2.49 L13.28 2.49 L13.73 4.8 L15.87 5.69 L17.82 4.37 L19.63 6.18 L18.31 8.13 L19.2 10.27 L21.51 10.72 L21.51 13.28 L19.2 13.73 L18.31 15.87 L19.63 17.82 L17.82 19.63 L15.87 18.31 L13.73 19.2 L13.28 21.51 L10.72 21.51 L10.27 19.2 L8.13 18.31 L6.18 19.63 L4.37 17.82 L5.69 15.87 L4.8 13.73 L2.49 13.28 L2.49 10.72 L4.8 10.27 L5.69 8.13 L4.37 6.18 L6.18 4.37 L8.13 5.69 Z',
    'M12 9 a3 3 0 1 0 0 6 a3 3 0 0 0 0 -6 z',
  ],
  plus: ['M12 5 V19','M5 12 H19'],
  sliders: ['M4 6 H20','M4 12 H20','M4 18 H20'],
  moon: ['M21 12.8 A9 9 0 1 1 11.2 3 a7 7 0 0 0 9.8 9.8 z'],
  close: ['M6 6 L18 18','M6 18 L18 6'],
  check: ['M5 12 L10 17 L19 7'],
  save: ['M5 3 H17 L21 7 V21 H3 V3 Z', 'M7 3 V9 H16 V3', 'M7 21 V14 H17 V21'],
  undo: ['M3 10 H14 a6 6 0 0 1 0 12', 'M8 5 L3 10 L8 15'],
  chevronR: ['M9 6 L15 12 L9 18'],
  grid: ['M3 3 h7 v7 H3 z', 'M14 3 h7 v7 h-7 z', 'M3 14 h7 v7 H3 z', 'M14 14 h7 v7 h-7 z'],
  rows: ['M3 7 h18', 'M3 12 h18', 'M3 17 h18'],
  pencil: ['M4 20 L4 16 L15 5 L19 9 L8 20 Z', 'M13 7 L17 11'],
  calculator: ['M5 3 H19 V21 H5 Z', 'M5 9 H19', 'M9 13 H10', 'M14 13 H15', 'M9 17 H10', 'M14 17 H15'],
  pulse: ['M3 12 H7 L10 5 L14 19 L17 12 H21'],
  scale: ['M12 4 V20', 'M5 20 H19', 'M6 8 H18', 'M3 14 L9 14', 'M15 14 L21 14'],
  merge: ['M6 4 V12 a4 4 0 0 0 4 4 H18', 'M14 12 L18 16 L14 20'],
  send: ['M22 2 L2 9 L11 13 L15 22 L22 2 Z', 'M22 2 L11 13'],
  refresh: ['M4 12 a8 8 0 0 1 14 -5', 'M18 4 V8 H14', 'M20 12 a8 8 0 0 1 -14 5', 'M6 20 V16 H10'],
  bank: ['M3 10 L12 4 L21 10', 'M3 20 H21', 'M4 13 V18', 'M9 13 V18', 'M15 13 V18', 'M20 13 V18', 'M3 13 H21'],
  trendUp: ['M3 17 L9 11 L13 14 L21 5', 'M15 5 H21 V11'],
  trash: [
    'M3 6 H21',
    'M8 6 V4 a1 1 0 0 1 1 -1 H15 a1 1 0 0 1 1 1 V6',
    'M5 6 V20 a2 2 0 0 0 2 2 H17 a2 2 0 0 0 2 -2 V6',
    'M10 11 V18',
    'M14 11 V18',
  ],
  flag: ['M5 21 V3', 'M5 3 H17 L13 7 L17 11 H5'],
  shield: ['M12 3 L20 6 V11 C20 16 16.5 19.5 12 21 C7.5 19.5 4 16 4 11 V6 Z'],
  // Transaction types (js/ui/tx-type-picker.js).
  'tx-expense': ['M4 20 H20', 'M12 15 V4', 'M7 9 L12 4 L17 9'],
  'tx-income': ['M4 20 H20', 'M12 4 V15', 'M7 10 L12 15 L17 10'],
  'tx-envelope-transfer': ['M3 4 H13 V11 H3 Z', 'M3 4 L8 8 L13 4', 'M9 17 H21', 'M18 14 L21 17 L18 20'],
  'tx-investment': ['M3 17 L9 11 L13 15 L21 7', 'M15 7 H21 V13'],
  'tx-loan-payment': ['M3 9 L12 4 L21 9', 'M3 9 H21', 'M5 12 V16', 'M12 12 V16', 'M19 12 V16', 'M3 19 H21'],
  'tx-loan-given': ['M15 5 a3 3 0 1 0 0.01 0', 'M10 20 a5 5 0 0 1 10 0', 'M2 12 H9', 'M6 9 L9 12 L6 15'],
};

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('ic');
  svg.setAttribute('aria-hidden', 'true');

  if (name === 'envelope') {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', '3'); rect.setAttribute('y', '5');
    rect.setAttribute('width', '18'); rect.setAttribute('height', '14'); rect.setAttribute('rx', '2');
    svg.appendChild(rect);
    appendPath(svg, 'M3 7 L12 13 L21 7');
    return svg;
  }
  if (name === 'search') {
    appendCircle(svg, 11, 11, 7);
    appendPath(svg, 'M20 20 L16 16');
    return svg;
  }
  if (name === 'clock') {
    appendCircle(svg, 12, 12, 9);
    appendPath(svg, 'M12 7 V12 L15 14');
    return svg;
  }
  if (name === 'target') {
    appendCircle(svg, 12, 12, 9);
    appendCircle(svg, 12, 12, 5);
    appendCircle(svg, 12, 12, 1.5, 'currentColor');
    return svg;
  }
  if (name === 'help') {
    appendCircle(svg, 12, 12, 9);
    appendPath(svg, 'M9.5 9 a2.5 2.5 0 1 1 3.5 2.3 c-0.7 0.3 -1 0.9 -1 1.7');
    appendCircle(svg, 12, 17, 0.6, 'currentColor');
    return svg;
  }
  if (name === 'warn') {
    appendPath(svg, 'M12 4 L22 20 H2 Z');
    appendPath(svg, 'M12 10 V14');
    appendCircle(svg, 12, 17, 0.6, 'currentColor');
    return svg;
  }

  (PATHS[name] || []).forEach(d => appendPath(svg, d));
  return svg;
}

function appendPath(svg, d) {
  const el = document.createElementNS(SVG_NS, 'path');
  el.setAttribute('d', d);
  svg.appendChild(el);
}
function appendCircle(svg, cx, cy, r, fill) {
  const el = document.createElementNS(SVG_NS, 'circle');
  el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('r', r);
  if (fill) el.setAttribute('fill', fill);
  svg.appendChild(el);
}
