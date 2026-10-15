// js/ui/logo.js
const SVG_NS = 'http://www.w3.org/2000/svg';

export function bunvelopeLogo(size = 32) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size * 0.75);
  svg.setAttribute('viewBox', '0 0 32 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('logo');

  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x','1'); rect.setAttribute('y','3');
  rect.setAttribute('width','30'); rect.setAttribute('height','20'); rect.setAttribute('rx','3');
  rect.setAttribute('fill','var(--accent)');
  rect.setAttribute('stroke','var(--ink)');
  rect.setAttribute('stroke-width','1.2');

  const flap = document.createElementNS(SVG_NS, 'path');
  flap.setAttribute('d','M1 5 L16 15 L31 5');
  flap.setAttribute('stroke','var(--ink)');
  flap.setAttribute('stroke-width','1.2');
  flap.setAttribute('fill','none');
  flap.setAttribute('stroke-linejoin','round');

  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx','16'); dot.setAttribute('cy','15.5'); dot.setAttribute('r','2.2');
  dot.setAttribute('fill','var(--ink)');

  svg.append(rect, flap, dot);
  return svg;
}
