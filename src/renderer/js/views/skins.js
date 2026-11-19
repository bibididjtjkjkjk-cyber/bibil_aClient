import { h, modal, confirmDialog, toast, selectEl, field, safe } from '../ui.js';
import { t } from '../i18n.js';
import { skinPreview } from '../skin-preview.js';

const api = window.bibil;

function renameSkin(skin, reload) {
  const input = h('input', { type: 'text', value: skin.name, maxlength: '48' });
  modal({
    title: t('Переименовать скин'),
    body: field(t('Название'), input),
    actions: [
      { label: t('Отмена'), onClick: (close) => close() },
      { label: t('Сохранить'), primary: true, onClick: async (close) => {
        if (await safe(api.invoke('skins:rename', skin.id, input.value), t('Не удалось переименовать скин'))) {
          close();
          await reload();
        }
      } },
    ],
  });
}

function editSkin(skin, reload) {
  const name = h('input', { type: 'text', value: skin.name, maxlength: '48' });
  const model = selectEl([
    { value: 'classic', label: t('Classic / Steve') },
    { value: 'slim', label: t('Slim / Alex') },
  ], skin.model, () => {});
  modal({
    title: t('Редактировать скин'),
    body: h('div', {}, field(t('Название'), name), field(t('Тип модели'), model),
      h('p', { class: 'muted small' }, t('Выбери PNG-файл с новой текстурой; размер должен быть 64×64 или 64×32.'))),
    actions: [
      { label: t('Отмена'), onClick: (close) => close() },
      { label: t('Заменить PNG'), primary: true, onClick: async (close) => {
        const result = await safe(api.invoke('skins:replace', skin.id, name.value, model.value), t('Не удалось изменить скин'));
        if (result) { close(); await reload(); }
      } },
    ],
  });
}

export async function skinsView(root) {
  let skins = [];
  let accounts = [];
  let selectedAccountId = null;
  let activeSkin = null;
  let walking = false;
  let showCape = false;
  let disposePreview = () => {};
  const reload = async () => {
    disposePreview();
    const [listedSkins, accountData] = await Promise.all([api.invoke('skins:list'), api.invoke('accounts:list')]);
    skins = listedSkins;
    accounts = accountData.accounts || [];
    selectedAccountId = accounts.some((a) => a.id === selectedAccountId)
      ? selectedAccountId : accountData.active || accounts[0]?.id || null;
    activeSkin = skins.find((s) => s.id === activeSkin?.id) || skins[0] || null;
    render();
  };
  const content = h('div');
  root.append(content);

  function render() {
    disposePreview();
    const heading = h('div', { class: 'row wrap' },
      h('div', { class: 'grow' }, h('h1', { class: 'screen-title' }, t('Скины')),
        h('p', { class: 'screen-subtitle' }, t('Управляй скинами профиля и примеряй их перед применением.'))),
      h('button', { class: 'btn primary', onclick: openImport }, t('Добавить скин')));
    const stage = h('div', { class: 'skin-preview-stage', title: t('Перетаскивайте мышью, чтобы вращать модель') });
    const previewControls = h('div', { class: 'skin-preview-controls' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: walking, onchange: (e) => {
        walking = e.target.checked;
        const model = stage.querySelector('.skin-model');
        if (model) model.classList.toggle('walking', walking);
      } }), t('Анимация ходьбы')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: showCape, onchange: (e) => {
        showCape = e.target.checked;
        render();
      } }), t('Плащ')));
    if (activeSkin) disposePreview = skinPreview(stage, activeSkin, { walking, cape: showCape });
    else stage.append(h('div', { class: 'empty-state' }, t('Добавь скин, чтобы увидеть 3D-превью.')));
    const accountsOptions = accounts.map((a) => ({ value: a.id, label: a.name || a.username }));
    const accountSelect = selectEl(accountsOptions, selectedAccountId, (id) => { selectedAccountId = id; });
    accountSelect.disabled = !accounts.length;
    const applyButton = h('button', { class: 'btn primary', disabled: !activeSkin || !accounts.length, onclick: async () => {
      const result = await safe(api.invoke('skins:apply', activeSkin.id, accountSelect.value), t('Не удалось применить скин'));
      if (result !== undefined) toast(t('Скин применён к аккаунту.'), 'success');
    } }, t('Применить к аккаунту'));
    const previewPanel = h('section', { class: 'skin-preview-panel' },
      h('div', { class: 'section-heading' }, h('h2', {}, activeSkin?.name || t('Предпросмотр модели'))),
      stage, previewControls,
      h('div', { class: 'row wrap' }, accountSelect, applyButton));

    const grid = h('div', { class: 'skin-grid' }, skins.map((skin) => {
      const selected = skin.id === activeSkin?.id;
      return h('article', { class: `skin-card${selected ? ' selected' : ''}` },
        h('button', { class: 'skin-thumb-button', title: t('Предпросмотр'), onclick: () => { activeSkin = skin; render(); } },
          h('img', { class: 'skin-thumb', src: skin.dataUrl, alt: skin.name })),
        h('div', { class: 'skin-card-content' },
          h('h3', {}, skin.name),
          h('span', { class: 'chip' }, skin.model === 'slim' ? t('Slim / Alex') : t('Classic / Steve')),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn sm primary', disabled: !accounts.length, onclick: async () => {
              const result = await safe(api.invoke('skins:apply', skin.id, accountSelect.value), t('Не удалось применить скин'));
              if (result !== undefined) toast(t('Скин применён к аккаунту.'), 'success');
            } }, t('Применить')),
            h('button', { class: 'btn sm', onclick: () => editSkin(skin, reload) }, t('Редактировать')),
            h('button', { class: 'btn sm', onclick: () => renameSkin(skin, reload) }, t('Переименовать')),
            h('button', { class: 'btn sm danger', onclick: async () => {
              if (!await confirmDialog(t('Удалить скин «{name}»?', { name: skin.name }), { okLabel: 'Удалить', danger: true })) return;
              if (await safe(api.invoke('skins:remove', skin.id).then(() => true), t('Не удалось удалить скин'))) await reload();
            } }, t('Удалить')))));
    }));
    content.replaceChildren(heading, h('div', { class: 'skin-layout' },
      previewPanel,
      h('section', { class: 'skin-library' }, h('div', { class: 'section-heading' },
        h('h2', {}, t('Моя библиотека')), h('span', { class: 'muted' }, t('Скинов: {n}', { n: skins.length }))),
      skins.length ? grid : h('div', { class: 'empty-state' }, t('Пока нет сохранённых скинов. Добавь PNG-файл или импортируй скин по нику.')))));
  }

  function openImport() {
    const name = h('input', { type: 'text', maxlength: '48', placeholder: t('Название (необязательно)') });
    const nickname = h('input', { type: 'text', maxlength: '16', placeholder: t('Ник Minecraft') });
    const url = h('input', { type: 'url', maxlength: '2048', placeholder: 'https://textures.minecraft.net/...' });
    const model = selectEl([{ value: 'classic', label: t('Classic / Steve') }, { value: 'slim', label: t('Slim / Alex') }], 'classic', () => {});
    const body = h('div', { class: 'stack', style: { gap: '12px' } },
      field(t('Название'), name, t('Можно оставить пустым.')),
      field(t('Тип модели'), model),
      field(t('Импорт по нику'), nickname),
      field(t('Или прямая ссылка PNG'), url),
      h('p', { class: 'muted small' }, t('Импорт по нику копирует скин в локальную библиотеку; для применения нужен Microsoft-аккаунт.')));
    const dialog = modal({
      title: t('Добавить скин'),
      body,
      actions: [
        { label: t('Загрузить PNG с диска'), onClick: async (close) => {
          const result = await safe(api.invoke('skins:importFile', name.value, model.value), t('Не удалось импортировать скин'));
          if (result) { close(); await reload(); }
        } },
        { label: t('Импортировать'), primary: true, onClick: async (close) => {
          let result;
          if (nickname.value.trim()) result = await safe(api.invoke('skins:importNickname', nickname.value.trim()), t('Не удалось импортировать скин по нику'));
          else if (url.value.trim()) result = await safe(api.invoke('skins:importUrl', url.value.trim(), name.value.trim() || undefined, model.value), t('Не удалось импортировать скин по ссылке'));
          else { toast(t('Укажи ник, URL или выбери PNG-файл.'), 'error'); return; }
          if (result) { close(); await reload(); }
        } },
        { label: t('Отмена'), onClick: (close) => close() },
      ],
    });
    return dialog;
  }

  try { await reload(); }
  catch (e) { content.replaceChildren(h('div', { class: 'notice err' }, e.message)); }
  return () => disposePreview();
}
