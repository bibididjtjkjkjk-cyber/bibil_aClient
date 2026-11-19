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
  return i < 0 ? (info?.state === 'installing' ? 2 : 0) : i;
}

function render() {
  if (!info) return;
  const box = ensureHost();
  if (!box) return;
  clear(box);

  const activeState = ['checking', 'available', 'downloading', 'installing', 'error'].includes(info.state);
  if (chip) {
    const available = info.state === 'available';
    chip.hidden = !available;
    chip.querySelector('span').textContent = available ? t('Оновлення {v}', { v: info.latest || '' }) : t('Оновлення');
    chip.title = available ? t('Натисніть, щоб завантажити та встановити') : t('Оновлення');
  }

  if (!activeState) return;
  if (info.state === 'available') {
    // Показуємо компактну картку, доки користувач не натисне кнопку.
    renderAvailable(box);
    return;
  }

  const idx = phaseIndex(info.phase);
  const pct = Math.max(0, Math.min(100, Number(info.progress) || 0));
  const detail = info.detail || {};
  const size = detail.total ? ` · ${Math.round((detail.downloaded || 0) / 1024 / 1024)} / ${Math.round(detail.total / 1024 / 1024)} МБ` : '';
  const speed = info.speed ? ` · ${info.speed} КБ/с` : '';

  const steps = h('ol', { class: 'update-steps' }, PHASES.map((p, i) => h('li', {
    class: `${i < idx ? 'done' : ''} ${i === idx && info.state !== 'error' ? 'active' : ''}`,
  }, h('i'), h('span', {}, t(PHASE_LABEL[p])))));

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
    info.error && h('div', { class: 'update-error' },
      h('b', {}, `${info.error.code || 'ERROR'} · ${info.error.stage || 'update'}`),
      h('div', {}, info.error.message || ''),
      info.error.detail && h('div', { class: 'small muted' }, String(info.error.detail).slice(0, 300))),
    info.log && h('pre', { class: 'update-log' }, info.log.slice(-600)),
    h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px' } },
      h('button', { class: 'btn sm', onclick: () => { clear(box); } }, t('Приховати'))));

  const overlay = h('div', { class: 'update-overlay' }, card);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) clear(box); });
  box.append(overlay);
}

function renderAvailable(box) {
  const card = h('div', { class: 'update-card compact' },
    h('div', { class: 'row' },
      h('span', { class: 'ok-dot' }),
      h('div', { class: 'grow' },
        h('h3', {}, t('Знайдено нову версію')),
        h('div', { class: 'small muted' }, t('Версія {v} готова до завантаження', { v: info.latest || '' })))),
    h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px' } },
      h('button', { class: 'btn sm', onclick: () => clear(box) }, t('Пізніше')),
      h('button', { class: 'btn primary sm', onclick: () => installUpdate() }, t('Завантажити та встановити'))));
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

export function bindUpdateUi() {
  chip = document.getElementById('updateChip');
  if (chip) chip.addEventListener('click', installUpdate);
  api.on('update:state', handle);
  api.invoke('update:info').then((i) => { if (i) handle(i); }).catch(() => {});
  api.on('sources:state', (s) => {
    if (s.state === 'error') toast(`${s.error?.code || 'SYNC'}: ${s.message}`, 'error', 9000);
    if (s.state === 'done') toast(s.message, 'success');
  });
}
