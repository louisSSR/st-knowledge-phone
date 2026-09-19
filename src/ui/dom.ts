export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = '', text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, onClick: () => void, className = 'button'): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

export function icon(name: string): SVGSVGElement {
  const paths: Record<string, string> = {
    search: 'm21 21-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
    library: 'M4 4h4v16H4z M11 4h4v16h-4z M18 4l3 15',
    bookmark: 'M6 3h12v18l-6-4-6 4z',
    history: 'M3 4v5h5 M3 9a9 9 0 1 1 0 6 M12 7v5l3 2',
    settings: 'M4 7h16 M4 17h16 M9 4v6 M16 14v6',
    close: 'm6 6 12 12 M6 18 18 6',
    arrow: 'M5 12h14 M14 7l5 5-5 5',
    back: 'M19 12H5 M10 7l-5 5 5 5',
    book: 'M12 5v16 M12 5C9 3 5 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 1',
    pin: 'M12 22s7-8 7-13a7 7 0 1 0-14 0c0 5 7 13 7 13 M14 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    check: 'm5 12 4 4L19 6',
    plus: 'M12 5v14 M5 12h14',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[name] ?? paths.book!);
  svg.append(path);
  return svg;
}

export function iconButton(label: string, glyph: string, action: () => void, className = 'icon-button'): HTMLButtonElement {
  const node = button('', action, className);
  node.setAttribute('aria-label', label);
  node.title = label;
  node.append(icon(glyph));
  return node;
}

export function emptyState(title: string, detail: string, action?: HTMLElement): HTMLElement {
  const node = el('section', 'empty-state');
  node.append(icon('book'), el('h3', '', title), el('p', '', detail));
  if (action) node.append(action);
  return node;
}

export function sectionHeading(title: string, caption?: string): HTMLElement {
  const node = el('div', 'section-heading');
  node.append(el('h2', '', title));
  if (caption) node.append(el('span', 'muted', caption));
  return node;
}
