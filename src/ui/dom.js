/**
 * Tiny DOM helpers.
 *
 * Everything user-supplied (client names, file names, bext descriptions, iXML
 * text) reaches the page through textContent, never innerHTML. A file name or a
 * metadata field containing "<script>" is content, not markup, and this is the
 * single place that guarantee is enforced.
 *
 * `el()` deliberately offers no way to set innerHTML. It once accepted an
 * `html:` prop for literal markup; no call site ever used it, and it was
 * removed so that the guarantee above is structural rather than a convention
 * someone could reach past without noticing. Markup that genuinely needs
 * building should be composed from el() calls, as the help tab does.
 */

import { lookUpTerm } from './glossary.js';

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'hidden') node.hidden = Boolean(value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Definition list from [label, value] pairs. Null values render as a dash. */
export function kv(pairs) {
  const dl = el('dl', { class: 'kv' });
  for (const [label, value, opts = {}] of pairs) {
    if (value === undefined) continue;
    dl.append(el('dt', {}, labelWithInfo(label)));
    const known = value !== null && value !== '' && value !== '—';
    dl.append(
      el('dd', {
        class: [opts.mono ? 'mono' : '', known ? '' : 'unknown'].filter(Boolean).join(' ') || null,
        text: known ? String(value) : '—',
      }),
    );
  }
  return dl;
}

/** Collapsible section. */
export function section(title, body, { open = false, count = null } = {}) {
  const summary = el('summary', {}, labelWithInfo(title));
  if (count !== null) summary.append(el('span', { class: 'count', text: ` ${count}` }));
  return el('details', { class: 'detail-section', open }, [summary, el('div', { class: 'detail-body' }, [body])]);
}

export function table(headers, rows, { rowClass = null, onRowClick = null } = {}) {
  // Headers carry the same class as their cells, so a numeric column's heading
  // right-aligns over its numbers instead of drifting to the far left of it.
  const thead = el('thead', {}, [
    el('tr', {}, headers.map((h) =>
      typeof h === 'string'
        ? el('th', { text: h })
        : el('th', { class: h.class, text: h.label }))),
  ]);
  const tbody = el('tbody');
  rows.forEach((row, i) => {
    const tr = el('tr', {
      class: [rowClass?.(row, i), onRowClick ? 'clickable' : null].filter(Boolean).join(' ') || null,
    });
    row.forEach((cell, ci) => {
      const spec = headers[ci];
      const cls = typeof spec === 'object' ? spec.class : null;
      tr.append(
        cell instanceof Node
          ? el('td', { class: cls }, [cell])
          : el('td', { class: cls, text: cell === null || cell === undefined ? '—' : String(cell) }),
      );
    });
    if (onRowClick) tr.addEventListener('click', () => onRowClick(row, i));
    tbody.append(tr);
  });
  return el('div', { class: 'table-scroll' }, [el('table', { class: 'data' }, [thead, tbody])]);
}

// ------------------------------------------------------- what is this?

/**
 * The "i" that explains a term.
 *
 * The report is written in the vocabulary of the trade, and it stays that way:
 * renaming "true peak" to something gentler would make it useless to the people
 * who most need it. So the explanation sits beside the term instead, silent
 * until asked for.
 *
 * Returns null when nothing has been written for this label, which is what
 * keeps the icons scarce. They appear exactly where there is something to say,
 * and no call site has to decide.
 *
 * @param {string} label the label already on screen
 * @returns {HTMLButtonElement|null}
 */
export function infoDot(label) {
  const term = lookUpTerm(label);
  if (!term) return null;

  const button = el('button', {
    type: 'button',
    class: 'info-dot',
    // Screen readers get the question, not the letter "i" on its own.
    'aria-label': `What is ${term.title}?`,
    'aria-expanded': 'false',
    // The glyph is drawn by CSS rather than set as text. A text node here would
    // land inside the label, so selecting and copying a report off the screen
    // would pick up a stray "i" after every term that has one, and every test
    // that reads a label would have to know about it.
  });

  button.addEventListener('click', (event) => {
    // Both matter, and for different reasons. preventDefault stops a dot inside
    // a <summary> from collapsing the section it is explaining; stopPropagation
    // stops the document-level dismissal below from treating this very click as
    // a click elsewhere and closing the popover as fast as it opened.
    event.preventDefault();
    event.stopPropagation();
    if (openInfo?.button === button) closeInfo();
    else showInfo(button, term);
  });

  return button;
}

/**
 * A label with its icon after it, ready to drop into any element.
 * Returns a plain array so the caller can spread it into el()'s children.
 */
export function labelWithInfo(label) {
  // kv() and section() are general helpers and a caller may hand either one a
  // built node rather than a string. Pass it through untouched: stringifying a
  // node would put "[object HTMLDivElement]" on the screen.
  if (label instanceof Node) return [label];
  const dot = infoDot(label);
  return dot ? [String(label), dot] : [String(label)];
}

let openInfo = null;

export function closeInfo() {
  if (!openInfo) return;
  openInfo.node.remove();
  openInfo.button.setAttribute('aria-expanded', 'false');
  openInfo = null;
}

function showInfo(button, term) {
  closeInfo();

  const node = el('div', {
    class: 'info-pop',
    role: 'dialog',
    'aria-label': term.title,
  }, [
    el('button', {
      type: 'button',
      class: 'info-pop-close',
      'aria-label': 'Close',
      text: '\u00d7',
      onclick: (e) => { e.stopPropagation(); closeInfo(); button.focus(); },
    }),
    el('h4', { class: 'info-pop-title', text: term.title }),
    el('p', { class: 'info-pop-lead', text: term.lead }),
    ...term.body.map((paragraph) => el('p', { text: paragraph })),
  ]);

  // Clicks inside stay inside, so selecting text does not dismiss it.
  node.addEventListener('click', (e) => e.stopPropagation());

  document.body.append(node);
  // Measured once. Reading offsetWidth forces layout, and the reposition below
  // can run on every scroll event.
  const size = { width: node.offsetWidth, height: node.offsetHeight };
  positionInfo(node, button, size);
  button.setAttribute('aria-expanded', 'true');
  openInfo = { node, button, size };
}

/**
 * Put the popover under its icon, or above it when there is no room below,
 * and never off the side of the window.
 *
 * Deliberately hand-positioned. The browser's own popover and anchor
 * positioning would do this in a few lines, and neither exists in the Safari
 * that ships with the macOS this app is built for.
 */
function positionInfo(node, button, size) {
  const gap = 6;
  const edge = 8;
  const anchor = button.getBoundingClientRect();
  const { width, height } = size;

  let left = anchor.left + anchor.width / 2 - width / 2;
  left = Math.max(edge, Math.min(left, window.innerWidth - width - edge));

  let top = anchor.bottom + gap;
  if (top + height > window.innerHeight - edge) {
    const above = anchor.top - height - gap;
    top = above >= edge ? above : Math.max(edge, window.innerHeight - height - edge);
  }

  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

// Anything else the user does puts it away again.
document.addEventListener('click', () => closeInfo());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInfo(); });

/**
 * Follow the icon on scroll rather than closing.
 *
 * Closing was the first attempt and it was wrong twice over. Focusing a button
 * near the edge of the window makes the browser scroll it into view, so the
 * popover shut itself the instant it opened for any icon not already fully
 * visible — which is most of them in a long report. And as behaviour it is
 * simply worse: the natural thing to do while reading an explanation is to
 * scroll the thing it explains back into view.
 *
 * It does give up once its icon has left the window, since a popover pointing
 * at nothing is worse than no popover.
 */
function trackInfo() {
  if (!openInfo) return;
  const anchor = openInfo.button.getBoundingClientRect();
  const offScreen = anchor.bottom < 0
    || anchor.top > window.innerHeight
    || anchor.right < 0
    || anchor.left > window.innerWidth;
  if (offScreen) closeInfo();
  else positionInfo(openInfo.node, openInfo.button, openInfo.size);
}

window.addEventListener('scroll', trackInfo, true);
window.addEventListener('resize', trackInfo);

// ------------------------------------------------------------------ toasts

export function toast(message, kind = '') {
  const host = $('#toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${kind}`.trim(), text: message });
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 250);
  }, kind === 'error' ? 7000 : 3600);
}

// ------------------------------------------------------------------ modals

let closeCurrentModal = null;

/**
 * Promise-based modal. Resolves with the dialog's value, or null if cancelled.
 * Used instead of window.prompt/confirm so the app can present multi-field
 * forms and spell out the consequences of a delete.
 */
export function modal({ title, body, fields = [], confirmLabel = 'OK', danger = false, cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    const backdrop = $('#modal-backdrop');
    const host = clear($('#modal'));

    const inputs = new Map();
    const form = el('form', { class: 'modal-form' });

    form.append(el('h3', { text: title }));
    if (body) form.append(typeof body === 'string' ? el('p', { text: body }) : body);

    for (const field of fields) {
      const id = `f-${field.name}`;
      const input = field.multiline
        ? el('textarea', { id, rows: field.rows ?? 3, placeholder: field.placeholder ?? '' })
        : el('input', { type: 'text', id, placeholder: field.placeholder ?? '' });
      input.value = field.value ?? '';
      inputs.set(field.name, input);
      form.append(el('div', { class: 'field' }, [el('label', { for: id, text: field.label }), input]));
    }

    const done = (value) => {
      closeCurrentModal = null;
      backdrop.hidden = true;
      clear(host);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(null);
    };

    form.append(
      el('div', { class: 'modal-actions' }, [
        el('button', { type: 'button', class: 'btn', text: cancelLabel, onclick: () => done(null) }),
        el('button', {
          type: 'submit',
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          text: confirmLabel,
        }),
      ]),
    );

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const values = {};
      for (const [name, input] of inputs) values[name] = input.value;
      done(fields.length ? values : true);
    });

    host.append(form);
    backdrop.hidden = false;
    closeCurrentModal = () => done(null);
    document.addEventListener('keydown', onKey);
    (inputs.values().next().value ?? host.querySelector('button[type="submit"]'))?.focus();
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Delete', danger = true }) {
  const body = el('div', {}, [el('div', { class: danger ? 'warning' : '', text: message })]);
  return modal({ title, body, confirmLabel, danger, fields: [] });
}

// Clicking the backdrop cancels.
document.addEventListener('click', (e) => {
  if (e.target?.id === 'modal-backdrop') closeCurrentModal?.();
});
