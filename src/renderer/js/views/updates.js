import { h, skeleton } from '../ui.js';
import { t } from '../i18n.js';

const api = window.bibil;

export async function updatesView(root) {
  root.append(skeleton());
  let entries = [];
  try {
    entries = (await api.invoke('update:history')) || [];
  } catch (e) {
    root.replaceChildren(h('div', { class: 'notice err' }, t('Не удалось загрузить историю обновлений: {msg}', { msg: e.message })));
    return () => {};
  }

  const info = await api.invoke('update:info').catch(() => null);
  const head = h('div', { class: 'card row wrap' },
    h('div', { class: 'grow' }, h('h3', {}, t('Текущая версия')), h('div', { class: 'small muted' }, `v${info?.version || ''}`)),
    h('div', { class: 'grow' }, h('h3', {}, t('Последняя проверенная')), h('div', { class: 'small muted' }, info?.latest ? `v${info.latest}` : t('—'))));

  const list = h('div', { class: 'list' });
  const listCard = h('div', { class: 'card' },
    h('h3', {}, t('История обновлений')),
    h('div', { class: 'diag-list' },
      entries.map((e) => {
        const row = h('div', { class: 'row', style: { padding: '10px 0', borderBottom: '1px solid var(--border)' } },
          h('span', { class: e.ok ? 'ok-dot' : 'err-dot', style: { marginTop: 2 } }),
          h('div', { class: 'grow' },
            h('div', { style: { fontWeight: 600, fontSize: '14px' } }, e.version ? `v${e.version}` : t('—')),
            h('div', { class: 'small muted' }, new Date(e.at || Date.now()).toLocaleString())),
          h('div', { class: 'small muted', style: { maxWidth: '55%' } }, e.notes || ''));
        return row;
      })));

  root.append(
    h('h1', {}, t('Обновления')),
    h('p', { class: 'screen-subtitle' }, t('История проверок и установок обновлений клиента.')),
    head,
    list);
  list.append(listCard);

  return () => {};
}
