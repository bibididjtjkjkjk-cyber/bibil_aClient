import { h, modal, field, toast, confirmDialog, safe } from '../ui.js';
import { t } from '../i18n.js';
import { state, subscribe, refreshProfiles } from '../state.js';

const api = window.bibil;
const LOADER = { vanilla: 'Vanilla', fabric: 'Fabric' };

export function profilesView(root, { go }) {
  const list = h('div', { class: 'grid' });
  root.append(
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h1', {}, t('Профили')), h('p', { class: 'sub' }, t('Каждый профиль — отдельная игровая папка со своими модами, настройками и сохранениями.'))),
      h('button', { class: 'btn primary', onclick: () => editProfile() }, t('+ Новый профиль'))),
    list);

  function render() {
    list.replaceChildren();
    if (!state.profiles.length) {
      list.append(h('div', { class: 'empty', style: { gridColumn: '1/-1' } }, t('Профилей пока нет. Нажмите «Новый профиль».')));
      return;
    }
    for (const p of state.profiles) {
      const active = p.id === state.activeProfileId;
      list.append(h('div', { class: 'card hover' },
        h('div', { class: 'row' }, h('b', { class: 'grow' }, p.name), active && h('span', { class: 'chip ok' }, t('Выбран'))),
        h('div', { class: 'muted', style: { margin: '6px 0 10px' } }, `Minecraft ${p.version} · ${LOADER[p.loader] || p.loader}${p.loaderVersion ? ' ' + p.loaderVersion : ''}`),
        h('div', { class: 'row wrap' },
          !active && h('button', { class: 'btn sm primary', onclick: async () => { await safe(api.invoke('profiles:setActive', p.id)); await refreshProfiles(); } }, t('Выбрать')),
          p.loader === 'fabric' && h('button', { class: 'btn sm', onclick: async () => { await safe(api.invoke('profiles:setActive', p.id)); await refreshProfiles(); go('mods'); } }, t('Моды')),
          h('button', { class: 'btn sm', onclick: () => editProfile(p) }, t('Изменить')),
          h('button', { class: 'btn sm', onclick: () => safe(api.invoke('app:openPath', 'instance', p.id)) }, t('Папка')),
          h('button', { class: 'btn sm', onclick: async () => { if (await safe(api.invoke('profiles:duplicate', p.id))) { await refreshProfiles(); toast(t('Профиль скопирован'), 'success'); } } }, t('Копия')),
          h('button', { class: 'btn sm danger', onclick: () => removeProfile(p) }, t('Удалить')))));
    }
  }

  async function removeProfile(p) {
    if (!(await confirmDialog(t('Удалить профиль «{name}»? Файлы игры (сохранения, моды) тоже будут удалены.', { name: p.name }), { okLabel: 'Удалить', danger: true }))) return;
    if (await safe(api.invoke('profiles:remove', p.id, { deleteFiles: true }).then(() => true))) {
      await refreshProfiles();
      toast(t('Профиль удалён'), 'success');
    }
  }

  async function editProfile(existing) {
    const isNew = !existing;
    const d = existing ? { ...existing } : { name: '', version: '', loader: 'fabric', loaderVersion: '', ramMax: null, ramMin: null, javaPath: '', jvmArgs: null };

    const name = h('input', { type: 'text', value: d.name, placeholder: t('Например, Выживание'), maxlength: 40 });
    const snapshots = h('input', { type: 'checkbox', checked: state.settings.launcher.showSnapshots, onchange: loadVersions });
    const version = h('select', { onchange: loadLoaders });
    const loader = h('select', { onchange: loadLoaders }, h('option', { value: 'vanilla' }, 'Vanilla'), h('option', { value: 'fabric' }, 'Fabric'));
    loader.value = d.loader;
    const loaderVersion = h('select');
    const ram = h('input', { type: 'number', min: 512, step: 256, placeholder: t('глобально: {n}', { n: state.settings.game.ramMax }), value: d.ramMax ?? '' });
    const java = h('input', { type: 'text', value: d.javaPath || '', placeholder: t('Авто (или глобальная из настроек)') });
    const jvm = h('input', { type: 'text', value: d.jvmArgs ?? '', placeholder: t('Пусто — глобальные аргументы') });
    const loaderNote = h('div', { class: 'small muted' });

    async function loadVersions() {
      version.replaceChildren(h('option', {}, t('Загрузка…')));
      const list = await safe(api.invoke('versions:list', { snapshots: snapshots.checked }), t('Не удалось загрузить версии'));
      if (!list) return;
      version.replaceChildren(...list.map((v) => h('option', { value: v.id }, v.type === 'snapshot' ? `${v.id}${t(' (снапшот)')}` : v.id)));
      version.value = list.some((v) => v.id === d.version) ? d.version : list[0]?.id;
      await loadLoaders();
    }

    async function loadLoaders() {
      loaderVersion.replaceChildren();
      loaderNote.textContent = '';
      const useFabric = loader.value === 'fabric';
      loaderVersion.disabled = !useFabric;
      if (!useFabric || !version.value) return;
      try {
        const loaders = await api.invoke('versions:fabricLoaders', version.value);
        if (!loaders.length) {
          loaderNote.textContent = t('Fabric пока не поддерживает Minecraft {v}.', { v: version.value });
          return;
        }
        loaderVersion.append(h('option', { value: '' }, t('Последняя стабильная')),
          ...loaders.map((l) => h('option', { value: l.version }, `${l.version}${l.stable ? '' : t(' (нестабильная)')}`)));
        loaderVersion.value = loaders.some((l) => l.version === d.loaderVersion) ? d.loaderVersion : '';
      } catch (e) {
        loaderNote.textContent = t('Не удалось получить версии Fabric: {msg}', { msg: e.message });
      }
    }

    const body = h('div', {},
      field(t('Название'), name),
      field(t('Версия Minecraft'), version),
      h('label', { class: 'row small muted', style: { margin: '-4px 0 12px' } }, snapshots, t('Показывать снапшоты')),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field(t('Загрузчик'), loader)), h('div', { class: 'grow' }, field(t('Версия загрузчика'), loaderVersion))),
      loaderNote,
      h('h2', { style: { marginTop: '12px' } }, t('Переопределение (необязательно)')),
      field(t('Память, МБ'), ram), field(t('Путь к Java'), java), field(t('JVM-аргументы'), jvm));

    modal({
      title: isNew ? t('Новый профиль') : t('Изменить профиль'),
      body,
      actions: [
        { label: t('Отмена'), onClick: (c) => c() },
        {
          label: t('Сохранить'), primary: true,
          onClick: async (close) => {
            const data = {
              name: name.value, version: version.value, loader: loader.value, loaderVersion: loaderVersion.value,
              ramMax: ram.value ? Number(ram.value) : null, javaPath: java.value, jvmArgs: jvm.value.trim() ? jvm.value : null,
            };
            const res = await safe(isNew ? api.invoke('profiles:create', data) : api.invoke('profiles:update', d.id, data));
            if (res) {
              close();
              await refreshProfiles();
              toast(isNew ? t('Профиль создан. Устанавливаю игру…') : t('Профиль сохранён'), 'success');
              api.invoke('versions:install', data.version, data.loader, data.loaderVersion)
                .then(() => toast(t('Minecraft {v} готов к запуску', { v: data.version }), 'success'))
                .catch((e) => toast(t('Не удалось установить {v}: {msg}', { v: data.version, msg: e.message }), 'error'));
            }
          },
        },
      ],
    });
    loadVersions();
  }

  render();
  return subscribe((w) => (w === 'profiles' || w === 'settings' || w === 'language') && render());
}
