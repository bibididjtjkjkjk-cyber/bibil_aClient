import { h, modal, confirmDialog, toast, selectEl, safe, skeleton } from '../ui.js';
import { t, dateLocale } from '../i18n.js';
const api = window.bibil;

export async function screenshotsView(root) {
  let profiles = [];
  let shots = [];
  let profileId = null;
  let order = 'newest';
  let selected = null;
  const content = h('div');
  root.append(content);
  content.append(skeleton());

  async function load() {
    if (!profileId) { shots = []; render(); return; }
    shots = await api.invoke('screenshots:list', profileId);
    render();
  }

  function showShot(shot) {
    selected = shot;
    api.invoke('screenshots:read', profileId, shot.name).then((src) => {
      if (selected !== shot) return;
      const image = h('img', { class: 'lightbox-image', src, alt: shot.name });
      modal({
        title: shot.name,
        body: h('div', { class: 'lightbox-body' }, image,
          h('div', { class: 'muted small' }, `${new Date(shot.modifiedAt).toLocaleString(dateLocale())} · ${Math.max(1, Math.round(shot.size / 1024))} KB`)),
        actions: [
          { label: t('Скопировать изображение'), onClick: async (close) => {
            if (await safe(api.invoke('screenshots:copy', profileId, shot.name).then(() => true), t('Не удалось скопировать изображение'))) {
              toast(t('Скопировано в буфер обмена.'), 'success');
            }
          } },
          { label: t('Открыть в проводнике'), onClick: async () => {
            if (await safe(api.invoke('screenshots:open', profileId, shot.name).then(() => true), t('Не удалось открыть файл'))) {
              toast(t('Файл открыт в проводнике.'), 'success');
            }
          } },
          { label: t('Переименовать'), onClick: (close) => { close(); rename(shot); } },
          { label: t('Удалить'), danger: true, onClick: async (close) => {
            if (!await confirmDialog(t('Удалить скриншот «{name}»?', { name: shot.name }), { okLabel: 'Удалить', danger: true })) return;
            const result = await safe(api.invoke('screenshots:remove', profileId, shot.name).then(() => true), t('Не удалось удалить скриншот'));
            if (result) { close(); await load(); }
          } },
          { label: t('Закрыть'), primary: true, onClick: (close) => close() },
        ],
      });
    }).catch((e) => toast(e.message, 'error'));
  }

  function rename(shot) {
    const input = h('input', { type: 'text', value: shot.name.replace(/\.png$/i, ''), maxlength: '120' });
    modal({
      title: t('Переименовать скриншот'),
      body: h('label', { class: 'field' }, h('span', {}, t('Название')), input),
      actions: [
        { label: t('Отмена'), onClick: (close) => close() },
        { label: t('Сохранить'), primary: true, onClick: async (close) => {
          const next = await safe(api.invoke('screenshots:rename', profileId, shot.name, input.value), t('Не удалось переименовать скриншот'));
          if (next) { close(); await load(); }
        } },
      ],
    });
  }

  function render() {
    const profileSelect = selectEl(profiles.map((p) => ({ value: p.id, label: `${p.name} · ${p.version}` })), profileId, async (id) => {
      profileId = id;
      try { await load(); } catch (e) { toast(e.message, 'error'); }
    });
    profileSelect.disabled = profiles.length === 0;
    const sortSelect = selectEl([
      { value: 'newest', label: t('Сначала новые') },
      { value: 'oldest', label: t('Сначала старые') },
    ], order, (value) => { order = value; render(); });
    const sorted = [...shots].sort((a, b) => order === 'newest' ? b.modifiedAt - a.modifiedAt : a.modifiedAt - b.modifiedAt);
    const grid = h('div', { class: 'screenshot-grid' }, sorted.map((shot) =>
      h('button', { class: 'shot-card', onclick: () => showShot(shot), title: shot.name },
        h('img', { src: shot.preview, alt: shot.name, loading: 'lazy' }),
        h('span', { class: 'shot-caption' }, h('strong', {}, shot.name),
          h('small', {}, new Date(shot.modifiedAt).toLocaleString(dateLocale()))))));
    content.replaceChildren(
      h('div', { class: 'row wrap' },
        h('div', { class: 'grow' }, h('h1', { class: 'screen-title' }, t('Скриншоты')),
          h('p', { class: 'screen-subtitle' }, t('Скриншоты игровых профилей, отсортированные по дате.'))),
        profileSelect, sortSelect),
      profiles.length ? (sorted.length ? grid : h('div', { class: 'empty-state' }, t('В этом профиле пока нет скриншотов.')))
        : h('div', { class: 'empty-state' }, t('Сначала создай игровой профиль.')));
  }

  try {
    const result = await api.invoke('profiles:list');
    profiles = result.profiles || [];
    profileId = result.active || profiles[0]?.id || null;
    await load();
  } catch (e) {
    content.replaceChildren(h('div', { class: 'notice err' }, e.message));
  }
  return () => { selected = null; };
}
