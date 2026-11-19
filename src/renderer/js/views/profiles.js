import { h, modal, field, toast, confirmDialog, safe } from '../ui.js';
import { state, subscribe, refreshProfiles } from '../state.js';

const api = window.bibil;
const LOADER = { vanilla: 'Vanilla', fabric: 'Fabric' };

export function profilesView(root, { go }) {
  const list = h('div', { class: 'grid' });
  root.append(
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h1', {}, 'Профили'), h('p', { class: 'sub' }, 'Каждый профиль — отдельная игровая папка со своими модами, настройками и сохранениями.')),
      h('button', { class: 'btn primary', onclick: () => editProfile() }, '+ Новый профиль')),
    list);

  function render() {
    list.replaceChildren();
    if (!state.profiles.length) {
      list.append(h('div', { class: 'empty', style: { gridColumn: '1/-1' } }, 'Профилей пока нет. Нажмите «Новый профиль».'));
      return;
    }
    for (const p of state.profiles) {
      const active = p.id === state.activeProfileId;
      list.append(h('div', { class: 'card hover' },
        h('div', { class: 'row' }, h('b', { class: 'grow' }, p.name), active && h('span', { class: 'chip ok' }, 'Выбран')),
        h('div', { class: 'muted', style: { margin: '6px 0 10px' } }, `Minecraft ${p.version} · ${LOADER[p.loader] || p.loader}${p.loaderVersion ? ' ' + p.loaderVersion : ''}`),
        h('div', { class: 'row wrap' },
          !active && h('button', { class: 'btn sm primary', onclick: async () => { await safe(api.invoke('profiles:setActive', p.id)); await refreshProfiles(); } }, 'Выбрать'),
          p.loader === 'fabric' && h('button', { class: 'btn sm', onclick: async () => { await safe(api.invoke('profiles:setActive', p.id)); await refreshProfiles(); go('mods'); } }, 'Моды'),
          h('button', { class: 'btn sm', onclick: () => editProfile(p) }, 'Изменить'),
          h('button', { class: 'btn sm', onclick: () => safe(api.invoke('app:openPath', 'instance', p.id)) }, 'Папка'),
          h('button', { class: 'btn sm', onclick: async () => { if (await safe(api.invoke('profiles:duplicate', p.id)) ) { await refreshProfiles(); toast('Профиль скопирован', 'success'); } } }, 'Копия'),
          h('button', { class: 'btn sm danger', onclick: () => removeProfile(p) }, 'Удалить'))));
    }
  }

  async function removeProfile(p) {
    if (!(await confirmDialog(`Удалить профиль «${p.name}»? Файлы игры (сохранения, моды) тоже будут удалены.`, { okLabel: 'Удалить', danger: true }))) return;
    if (await safe(api.invoke('profiles:remove', p.id, { deleteFiles: true }).then(() => true))) {
      await refreshProfiles();
      toast('Профиль удалён', 'success');
    }
  }

  async function editProfile(existing) {
    const isNew = !existing;
    const d = existing ? { ...existing } : { name: '', version: '', loader: 'fabric', loaderVersion: '', ramMax: null, ramMin: null, javaPath: '', jvmArgs: null };

    const name = h('input', { type: 'text', value: d.name, placeholder: 'Например, Выживание', maxlength: 40 });
    const snapshots = h('input', { type: 'checkbox', checked: state.settings.launcher.showSnapshots, onchange: loadVersions });
    const version = h('select', { onchange: loadLoaders });
    const loader = h('select', { onchange: loadLoaders }, h('option', { value: 'vanilla' }, 'Vanilla'), h('option', { value: 'fabric' }, 'Fabric'));
    loader.value = d.loader;
    const loaderVersion = h('select');
    const ram = h('input', { type: 'number', min: 512, step: 256, placeholder: `глобально: ${state.settings.game.ramMax}`, value: d.ramMax ?? '' });
    const java = h('input', { type: 'text', value: d.javaPath || '', placeholder: 'Авто (или глобальная из настроек)' });
    const jvm = h('input', { type: 'text', value: d.jvmArgs ?? '', placeholder: 'Пусто — глобальные аргументы' });
    const loaderNote = h('div', { class: 'small muted' });

    async function loadVersions() {
      version.replaceChildren(h('option', {}, 'Загрузка…'));
      const list = await safe(api.invoke('versions:list', { snapshots: snapshots.checked }), 'Не удалось загрузить версии');
      if (!list) return;
      version.replaceChildren(...list.map((v) => h('option', { value: v.id }, v.type === 'snapshot' ? `${v.id} (снапшот)` : v.id)));
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
          loaderNote.textContent = `Fabric пока не поддерживает Minecraft ${version.value}.`;
          return;
        }
        loaderVersion.append(h('option', { value: '' }, 'Последняя стабильная'),
          ...loaders.map((l) => h('option', { value: l.version }, `${l.version}${l.stable ? '' : ' (нестабильная)'}`)));
        loaderVersion.value = loaders.some((l) => l.version === d.loaderVersion) ? d.loaderVersion : '';
      } catch (e) {
        loaderNote.textContent = `Не удалось получить версии Fabric: ${e.message}`;
      }
    }

    const body = h('div', {},
      field('Название', name),
      field('Версия Minecraft', version),
      h('label', { class: 'row small muted', style: { margin: '-4px 0 12px' } }, snapshots, 'Показывать снапшоты'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Загрузчик', loader)), h('div', { class: 'grow' }, field('Версия загрузчика', loaderVersion))),
      loaderNote,
      h('h2', { style: { marginTop: '12px' } }, 'Переопределение (необязательно)'),
      field('Память, МБ', ram), field('Путь к Java', java), field('JVM-аргументы', jvm));

    modal({
      title: isNew ? 'Новый профиль' : 'Изменить профиль',
      body,
      actions: [
        { label: 'Отмена', onClick: (c) => c() },
        {
          label: 'Сохранить', primary: true,
          onClick: async (close) => {
            const data = {
              name: name.value, version: version.value, loader: loader.value, loaderVersion: loaderVersion.value,
              ramMax: ram.value ? Number(ram.value) : null, javaPath: java.value, jvmArgs: jvm.value.trim() ? jvm.value : null,
            };
            const res = await safe(isNew ? api.invoke('profiles:create', data) : api.invoke('profiles:update', d.id, data));
            if (res) {
              close();
              await refreshProfiles();
              toast(isNew ? 'Профиль создан. Устанавливаю игру…' : 'Профиль сохранён', 'success');
              // Лаунчер сам устанавливает выбранную версию в фоне (прогресс виден на главной).
              api.invoke('versions:install', data.version, data.loader, data.loaderVersion)
                .then(() => toast(`Minecraft ${data.version} готов к запуску`, 'success'))
                .catch((e) => toast(`Не удалось установить ${data.version}: ${e.message}`, 'error'));
            }
          },
        },
      ],
    });
    loadVersions();
  }

  render();
  return subscribe((w) => (w === 'profiles' || w === 'settings') && render());
}
