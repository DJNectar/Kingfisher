/**
 * Tiny DOM helpers.
 *
 * Everything user-supplied (client names, file names, bext descriptions, iXML
 * text) reaches the page through textContent, never innerHTML. A file name or a
 * metadata field containing "<script>" is content, not markup, and this is the
 * single place that guarantee is enforced.
 */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // only ever called with literals
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
    dl.append(el('dt', { text: label }));
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
  const summary = el('summary', {}, [title]);
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
