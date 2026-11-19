// Небольшие помощники для построения DOM. Весь внешний текст вставляется через textContent — без innerHTML (защита от XSS).
import { t, dateLocale } from './i18n.js';

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['value', 'checked', 'disabled', 'selected', 'textContent'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const debounce = (fn, ms = 300) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

export function formatNumber(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

export function formatBytes(b) {
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' ' + t('ГБ');
  return Math.max(1, Math.round(b / 1024)) + ' ' + t('КБ');
}

export function formatDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return t('< 1 мин');
  const hrs = Math.floor(m / 60);
  return hrs ? `${hrs} ${t('ч')} ${m % 60} ${t('мин')}` : `${m} ${t('мин')}`;
}

export function toast(message, type = 'info', timeout = 4500) {
  const el = h('div', { class: `toast ${type}` }, message);
  document.getElementById('toasts').append(el);
  const remove = () => el.remove();
  setTimeout(remove, type === 'error' ? Math.max(timeout, 8000) : timeout);
  el.addEventListener('click', remove);
}

export function modal({ title, body, actions = [], onClose }) {
  const overlay = h('div', { class: 'overlay' });
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const box = h('div', { class: 'modal' }, h('h3', {}, title), body,
    actions.length && h('div', { class: 'actions' }, actions.map((a) =>
      h('button', { class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`, onclick: () => a.onClick(close) }, a.label))));
  overlay.append(box);
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close());
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return { close, box };
}

export function confirmDialog(message, { okLabel, danger = false } = {}) {
  okLabel = okLabel ? t(okLabel) : t('Подтвердить');
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    modal({
      title: t('Подтверждение'),
      body: h('p', {}, message),
      onClose: () => finish(false),
      actions: [
        { label: t('Отмена'), onClick: (c) => c() },
        { label: okLabel, primary: !danger, danger, onClick: (c) => { finish(true); c(); } },
      ],
    });
  });
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint && h('div', { class: 'small muted' }, hint));
}

export function switchEl(checked, onChange) {
  const input = h('input', { type: 'checkbox', checked: !!checked, onchange: (e) => onChange(e.target.checked) });
  return h('span', { class: 'switch' }, input, h('i'));
}

export function settingRow(title, desc, control) {
  return h('div', { class: 'setting' }, h('div', {}, h('div', { class: 't' }, title), desc && h('div', { class: 'd' }, desc)), control);
}

export function selectEl(options, value, onChange) {
  const sel = h('select', { onchange: (e) => onChange(e.target.value) },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  return sel;
}

export async function safe(promise, errMsg) {
  try {
    return await promise;
  } catch (e) {
    toast(`${errMsg ? errMsg + ': ' : ''}${e.message}`, 'error');
    return undefined;
  }
}

const ICONS = {
  play: '<polygon points="7 4 20 12 7 20 7 4"/>',
  versions: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>',
  profiles: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  mods: '<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
  resourcepacks: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 9v12"/><path d="M13 14h4"/><path d="M13 17h4"/>',
  accounts: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  cosmetics: '<path d="M12 3l2.3 5.2L20 9l-4 4 1 6-5-2.8L7 19l1-6-4-4 5.7-.8L12 3z"/>',
  console: '<path d="M4 17l6-5-6-5"/><path d="M12 19h8"/>',
  settings: '<path d="M4 6h9"/><path d="M17 6h3"/><circle cx="15" cy="6" r="2"/><path d="M4 12h3"/><path d="M11 12h9"/><circle cx="9" cy="12" r="2"/><path d="M4 18h10"/><path d="M18 18h2"/><circle cx="16" cy="18" r="2"/>',
};

/** Встроенные SVG-иконки (статические строки, без внешних данных). */
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ico');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}
