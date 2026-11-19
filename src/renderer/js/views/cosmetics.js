import { h, clear, toast, safe, switchEl } from '../ui.js';
import { t, getLocale } from '../i18n.js';
import { state, subscribe, activeProfile } from '../state.js';

const api = window.bibil;
const TYPES = [
  ['all', 'Все'], ['cape', 'Плащи'], ['wings', 'Крылья'], ['effect', 'Эффекты'],
  ['skin', 'Скины'], ['accessory', 'Аксессуары'], ['preset', 'Пресеты'],
];
const RARITY = { legendary: 'Legendary', epic: 'Epic', rare: 'Rare', common: 'Common' };

export function cosmeticsView(root, { go }) {
  const view = h('div');
  root.append(view);
  let data = { items: [], active: [], enabled: true, source: 'bundled' };
  let filter = 'all';

  async function load() {
    const p = activeProfile();
    data = await safe(api.invoke('cosmetics:list', p?.id || null), t('Не удалось загрузить каталог косметики')) || data;
    render();
  }

  function toggle(id) {
    const p = activeProfile();
    if (!p) return toast(t('Сначала создайте профиль.'), 'error');
    const active = new Set(data.active);
    if (active.has(id)) active.delete(id);
    else {
      if (active.size >= 4) return toast(t('Можно одновременно включить не более 4 элементов.'), 'error');
      active.add(id);
    }
    api.invoke('cosmetics:setActive', p.id, [...active])
      .then((next) => { data = next; render(); toast(t('Выбор косметики сохранён'), 'success'); })
      .catch((e) => toast(`${e.code || 'ERROR'}: ${e.message}`, 'error'));
  }

  function card(item) {
    const colors = item.colors?.length ? item.colors : ['#7c5cff', '#ffb02e'];
    const gradient = `linear-gradient(135deg, ${colors.join(', ')})`;
    const active = !!item.active;
    return h('div', { class: `card cosmetic-card ${active ? 'active' : ''}` },
      h('div', { class: 'cosmetic-preview', style: { background: gradient } },
        h('div', { class: 'cosmetic-glow', style: { background: colors[0] } }),
        h('span', { style: { position: 'relative', zIndex: '1' } }, item.icon || '✨')),
      h('div', { class: 'cosmetic-body' },
        h('div', { class: 'cosmetic-meta' },
          h('span', { class: `cosmetic-rarity ${item.rarity}` }, t(RARITY[item.rarity] || item.rarity)),
          h('span', { class: 'chip' }, t(TYPES.find((x) => x[0] === item.type)?.[1] || item.type)),
          active && h('span', { class: 'chip ok' }, t('Активно'))),
        h('b', {}, item.name),
        h('div', { class: 'small muted', style: { margin: '4px 0 10px', minHeight: '32px' } }, item.description),
        h('button', {
          class: `btn sm ${active ? '' : 'primary'}`,
          onclick: () => toggle(item.id),
        }, active ? t('Выключить') : t('Включить'))));
  }

  function render() {
    clear(view);
    const p = activeProfile();
    view.append(
      h('h1', {}, t('Косметика')),
      h('p', { class: 'sub' }, t('Плащи, крылья, эффекты и пресеты. Выбор сохраняется отдельно для каждого профиля и доступен модам через config профиля.')),
      h('div', { class: 'row wrap' },
        h('span', { class: 'chip' }, p ? t('Профиль: {name}', { name: p.name }) : t('Профиль не выбран')),
        h('span', { class: 'chip' }, data.source === 'release' ? t('Каталог из релиза') : t('Встроенный каталог')),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: async () => {
          const r = await safe(api.invoke('cosmetics:refresh'), t('Не удалось обновить каталог'));
          if (r) { toast(t('Каталог обновлён: {n}', { n: r.count }), 'success'); load(); }
        } }, t('Обновить каталог')),
        h('div', { class: 'row' }, switchEl(data.enabled, async (v) => {
          data = await safe(api.invoke('cosmetics:setEnabled', v), t('Не удалось сохранить')) || data;
          render();
        }), h('span', { class: 'small muted' }, t('Использовать косметику')))),
      h('div', { class: 'cosmetic-toolbar' }, TYPES.map(([id, label]) => h('button', {
        class: `tab ${filter === id ? 'active' : ''}`,
        onclick: () => { filter = id; render(); },
      }, t(label)))));

    const items = data.items.filter((x) => filter === 'all' || x.type === filter);
    if (!items.length) view.append(h('div', { class: 'empty' }, t('Ничего не найдено')));
    else view.append(h('div', { class: 'cosmetic-grid' }, items.map(card)));
  }

  load();
  const off = subscribe((what) => {
    if (what === 'profiles' || what === 'language') load();
  });
  return off;
}
