import { h, clear, skeleton } from '../ui.js';
import { t } from '../i18n.js';
import { state } from '../state.js';

const api = window.bibil;

export async function diagnosticsView(root) {
  root.append(skeleton());
  let data = null;
  let gpu = null;
  try {
    data = await api.invoke('diagnostics:gather');
    gpu = await api.invoke('diagnostics:gpu');
  } catch (e) {
    root.replaceChildren(h('div', { class: 'notice err' }, t('Не удалось собрать диагностику: {msg}', { msg: e.message })));
    return () => {};
  }

  const osInfo = data?.os || {};
  const java = data?.java || {};
  const mc = data?.minecraft || {};
  const checks = Array.isArray(data?.checks) ? data.checks : [];
  const launch = state.launch || {};

  const value = (v) => (v === null || v === undefined || v === '' ? t('—') : String(v));
  const okText = (ok) => (ok ? t('Установлена') : t('Не установлена'));

  const diagRow = (label, val, hint) => {
    const left = h('div', { class: 'grow' },
      h('div', { class: 'small muted' }, label),
      h('div', { style: { fontSize: '15px', fontWeight: 600, marginTop: 2 } }, val));
    const row = h('div', { class: 'row', style: { alignItems: 'flex-start', padding: '9px 0', borderBottom: '1px solid var(--border)' } }, left);
    if (hint) row.append(h('div', { class: 'small muted', style: { maxWidth: '55%' } }, hint));
    return row;
  };

  const statusText = () => {
    const s = launch.status || 'idle';
    const map = {
      idle: t('Остановлена'), running: t('Запущена'), preparing: t('Подготавливается'),
      downloading: t('Загружается'), error: t('Ошибка'),
    };
    return `${s} — ${launch.message || ''}`;
  };

  const osCard = h('div', { class: 'card' },
    h('h3', {}, t('Компьютер')),
    h('div', { class: 'diag-list' },
      diagRow(t('Процессор'), [osInfo.cpu?.model, osInfo.cpu?.cores ? `${osInfo.cpu.cores} ядер` : ''].filter(Boolean).join(' · '), null),
      diagRow(t('Видеокарта'), gpu?.available ? [gpu.renderer, gpu.vendor, gpu.version].filter(Boolean).join(' · ') : t('Не определена'), null),
      diagRow(t('Объём оперативной памяти'), `${osInfo.totalMemMb || 0} ${t('МБ')}`, `${osInfo.freeMemMb || 0} ${t('МБ')} ${t('свободно')}`),
      diagRow('OS', `${osInfo.platform || ''} · ${osInfo.arch || ''} · ${osInfo.release || ''}`, null)),
    h('div', { class: 'small muted', style: { marginTop: 8 } }, t('Диагностика собирается автоматически при открытии раздела.')));

  const javaCard = h('div', { class: 'card' },
    h('h3', {}, t('Java и Minecraft')),
    h('div', { class: 'diag-list' },
      diagRow(t('Версия Java'), java?.latest ? String(java.latest.major) : t('Не установлена'), java?.required ? t('Требуется Java {v}', { v: java.required }) : null),
      diagRow(t('Версия Minecraft'), mc?.version || t('—'), mc?.installed ? okText(true) : okText(false))),
    h('div', { class: 'small muted', style: { marginTop: 8 } }, t('Проверка компонентов выполняется автоматически при запуске игры.')));

  const stateRow = h('div', { class: 'row', style: { alignItems: 'flex-start' } },
    h('div', { class: 'grow' }, h('div', { class: 'small muted' }, t('Статус'))),
    h('div', { style: { fontSize: '15px', fontWeight: 600, marginTop: 2 } }, statusText()));
  const stateCard = h('div', { class: 'card' }, h('h3', {}, t('Состояние лаунчера')), stateRow);

  const checkCard = h('div', { class: 'card' },
    h('h3', {}, t('Проверка компонентов')),
    h('div', { class: 'diag-list' },
      checks.map((c) => {
        const row = h('div', { class: 'row', style: { padding: '9px 0', borderBottom: '1px solid var(--border)' } },
          h('span', { class: c.ok ? 'ok-dot' : 'err-dot', style: { marginTop: 2 } }),
          h('div', { class: 'grow' },
            h('div', { style: { fontWeight: 600, fontSize: '14px' } }, c.label || ''),
            h('div', { class: 'small muted' }, c.hint || '')));
        return row;
      })));

  root.append(
    h('h1', {}, t('Диагностика')),
    h('p', { class: 'screen-subtitle' }, t('Технические характеристики компьютера и проверка компонентов лаунчера.')),
    h('div', { class: 'grid' }, osCard, javaCard, stateCard),
    checkCard);

  return () => {};
}
