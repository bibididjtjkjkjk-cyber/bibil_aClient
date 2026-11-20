import { h, clear, toast } from './ui.js';
import { t } from './i18n.js';

const api = window.bibil;
const PHASES = ['download', 'verify', 'install', 'restart'];
const PHASE_LABEL = {
  download: 'Завантаження', verify: 'Перевірка', install: 'Встановлення', restart: 'Перезапуск',
};

let host = null;
let chip = null;
let info = null;
let lastError = '';

function ensureHost() {
  if (!host) host = document.getElementById('updateOverlay');
  return host;
}

function phaseIndex(phase) {
  const i = PHASES.indexOf(phase);
  if (i >= 0) return i;
  if (info?.state === 'installing') return 2;
  if (info?.state === 'downloaded') return 1;
  return 0;
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function render() {
  if (!info) return;
  const box = ensureHost();
  if (!box) return;
  clear(box);

  const activeState = ['checking', 'available', 'downloading', 'downloaded', 'installing', 'error'].includes(info.state);
  if (chip) {
    const available = info.state === 'available' || info.state === 'downloaded';
    const busy = ['checking', 'downloading', 'installing'].includes(info.state);
    chip.hidden = !info.supported;
    chip.disabled = busy;
    chip.classList.toggle('available', available);
    chip.querySelector('span').textContent = available
      ? t('Оновлення {v}', { v: info.latest || '' })
      : busy ? t('Перевірка…') : t('Перевірити оновлення');
    chip.title = available ? t('Натисніть, щоб завантажити та встановити') : t('Перевірити оновлення');
  }

  if (!activeState) return;
  if (info.state === 'available' || info.state === 'downloaded') {
    renderAvailable(box);
    return;
  }

  const idx = phaseIndex(info.phase);
  const pct = Math.max(0, Math.min(100, Number(info.progress) || 0));
  const detail = info.detail || {};
  const total = Number(detail.total || info.release?.size || 0);
  const downloaded = Number(detail.downloaded || 0);
  const size = total ? ` · ${fmtSize(downloaded || (pct === 100 ? total : 0))} / ${fmtSize(total)}` : (downloaded ? ` · ${fmtSize(downloaded)}` : '');
  const speed = info.speed ? ` · ${info.speed} КБ/с` : '';

  const steps = h('ol', { class: 'update-steps' }, PHASES.map((p, i) => h('li', {
    class: `${i < idx ? 'done' : ''} ${i === idx && info.state !== 'error' ? 'active' : ''}`,
  }, h('i'), h('span', {}, t(PHASE_LABEL[p])))));

  const notes = (info.release?.notes || '').trim();

  const card = h('div', { class: `update-card ${info.state === 'error' ? 'has-error' : ''}` },
    h('div', { class: 'update-head' },
      h('span', { class: info.state === 'error' ? 'err-dot' : 'spinner' }),
      h('div', { class: 'grow' },
        h('h3', {}, info.state === 'error' ? t('Помилка оновлення') : t('Оновлення лаунчера')),
        h('div', { class: 'small muted' }, `${info.version || ''}${info.latest ? ` → ${info.latest}` : ''}`))),
    info.state === 'checking'
      ? h('div', { class: 'skeleton-wrap' }, h('div', { class: 'skeleton w70' }), h('div', { class: 'skeleton w40' }))
      : h('div', {},
        h('div', { class: 'progress-track' }, h('div', { class: 'progress-fill', style: { width: `${pct}%` } })),
        h('div', { class: 'progress-meta' }, h('b', {}, `${pct}%`), h('span', {}, `${info.message || ''}${speed}${size}`))),
    steps,
    notes && h('div', { class: 'update-notes small muted' }, notes.slice(0, 500)),
    info.error && h('div', { class: 'update-error' },
      h('b', {}, `${info.error.code || 'ERROR'} · ${info.error.stage || 'update'}${info.error.httpStatus ? ` · HTTP ${info.error.httpStatus}` : ''}`),
      h('div', {}, info.error.message || ''),
      info.error.detail && h('div', { class: 'small muted' }, String(info.error.detail).slice(0, 300))),
    info.log && h('pre', { class: 'update-log' }, info.log.slice(-600)),
    h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px', gap: '8px' } },
      info.state === 'downloading' && h('button', { class: 'btn sm danger', onclick: () => api.invoke('update:cancel').catch(() => {}) }, t('Скасувати')),
      info.state === 'error' && h('button', { class: 'btn sm', onclick: () => checkUpdates() }, t('Повторити')),
      h('button', { class: 'btn sm', onclick: () => { clear(box); } }, t(info.state === 'error' ? 'Закрити' : 'Приховати'))));

  const overlay = h('div', { class: 'update-overlay' }, card);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) clear(box); });
  box.append(overlay);
}

function renderAvailable(box) {
  const notes = (info.release?.notes || '').trim();
  const size = fmtSize(info.release?.size || info.detail?.size || 0);
  const title = info.state === 'downloaded' ? t('Оновлення завантажено') : t('Знайдено нову версію');
  const subtitle = info.state === 'downloaded'
    ? t('Версія {v} готова до встановлення', { v: info.latest || '' })
    : t('Версія {v} готова до завантаження', { v: info.latest || '' });
  const card = h('div', { class: 'update-card compact' },
    h('div', { class: 'row' },
      h('span', { class: 'ok-dot' }),
      h('div', { class: 'grow' },
        h('h3', {}, title),
        h('div', { class: 'small muted' }, `${info.version || ''} → ${info.latest || ''}`),
        h('div', { class: 'small muted' }, subtitle))),
    (size || notes) && h('div', { class: 'update-notes' },
      size && h('div', { class: 'small muted' }, `${t('Розмір')}: ${size}`),
      notes && h('div', { class: 'small', style: { marginTop: size ? '6px' : '0' } }, notes.slice(0, 600))),
    h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px', gap: '8px' } },
      h('button', { class: 'btn sm', onclick: () => clear(box) }, t('Пізніше')),
      h('button', { class: 'btn primary sm', onclick: () => installUpdate() }, t(info.state === 'downloaded' ? 'Встановити та перезапустити' : 'Завантажити та встановити'))));
  const overlay = h('div', { class: 'update-overlay' }, card);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) clear(box); });
  box.append(overlay);
}

function handle(next) {
  info = next;
  if (info.state === 'error' && info.error?.message && info.error.message !== lastError) {
    lastError = info.error.message;
    toast(`${info.error.code || 'ERROR'}: ${info.error.message}`, 'error', 10000);
  }
  if (info.state !== 'error') lastError = '';
  render();
}

export async function installUpdate() {
  try {
    await api.invoke('update:install');
  } catch (e) {
    toast(`${e.code || 'ERROR'}: ${e.message}`, 'error', 10000);
  }
}

function checkUpdates() {
  api.invoke('update:check').catch((e) => {
    if (info?.error?.message !== e.message) toast(`${e.code || 'ERROR'}: ${e.message}`, 'error', 10000);
  });
}

export function bindUpdateUi() {
  chip = document.getElementById('updateChip');
  if (chip) chip.addEventListener('click', () => {
    if (info?.state === 'available' || info?.state === 'downloaded') installUpdate();
    else checkUpdates();
  });
  api.on('update:state', handle);
  api.invoke('update:info').then((i) => { if (i) handle(i); }).catch(() => {});
}
