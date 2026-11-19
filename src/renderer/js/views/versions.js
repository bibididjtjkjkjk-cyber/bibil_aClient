import { h, clear, toast, confirmDialog, selectEl, debounce } from '../ui.js';
import { t, dateLocale } from '../i18n.js';
import { state } from '../state.js';

const api = window.bibil;

/** Менеджер версий: список версий Mojang, установка (клиент, библиотеки, ассеты, Fabric) и удаление. */
export function versionsView(root, { header = true } = {}) {
  let versions = [];
  let installed = new Set();
  let filter = '';
  let snapshots = state.settings.launcher.showSnapshots;
  let loader = 'vanilla';
  const busy = new Map(); // id → { message, progress }

  const list = h('div', { class: 'list' });
  const status = h('div', { class: 'muted small', style: { margin: '8px 0' } });

  const search = h('input', { type: 'text', placeholder: t('Поиск версии, например 1.21'), oninput: debounce((e) => { filter = e.target.value.trim(); paint(); }, 150) });
  const snap = h('input', { type: 'checkbox', checked: snapshots, onchange: (e) => { snapshots = e.target.checked; load(); } });
  const loaderSel = selectEl([{ value: 'vanilla', label: 'Vanilla' }, { value: 'fabric', label: 'Vanilla + Fabric' }], loader, (v) => { loader = v; });

  root.append(
    header && h('h1', {}, t('Версии Minecraft')),
    header && h('p', { class: 'sub' }, t('Лаунчер сам скачивает клиент, библиотеки и ассеты с серверов Mojang. Установленные версии запускаются без ожидания.')),
    h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, search), h('div', { style: { width: '190px' } }, loaderSel),
      h('label', { class: 'row small muted' }, snap, t('Снапшоты'))),
    status, list);

  const off = api.on('install:progress', (p) => {
    if (!busy.has(p.id)) return;
    busy.set(p.id, { message: p.message, progress: p.progress });
    paintRow(p.id);
  });

  const rows = new Map();

  function paintRow(id) {
    const row = rows.get(id);
    if (!row) return;
    const b = busy.get(id);
    row.msg.textContent = b ? b.message : '';
    row.bar.style.display = b ? '' : 'none';
    row.bar.classList.toggle('indeterminate', !!b && b.progress == null);
    row.fill.style.width = b && b.progress != null ? `${Math.round(b.progress * 100)}%` : '';
  }

  async function install(id) {
    if (busy.has(id)) return;
    busy.set(id, { message: t('Подготовка…'), progress: null });
    paint();
    try {
      await api.invoke('versions:install', id, loader, '');
      toast(t('Minecraft {id} установлен', { id }), 'success');
    } catch (e) {
      toast(t('Не удалось установить {id}: {msg}', { id, msg: e.message }), 'error');
    } finally {
      busy.delete(id);
      await refreshInstalled();
      paint();
    }
  }

  async function uninstall(id) {
    if (!(await confirmDialog(t('Удалить файлы версии {id}? Профили и сохранения не пострадают, версия скачается заново при запуске.', { id }), { okLabel: 'Удалить', danger: true }))) return;
    try {
      await api.invoke('versions:uninstall', id);
      toast(t('Версия {id} удалена', { id }), 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    await refreshInstalled();
    paint();
  }

  function paint() {
    clear(list);
    rows.clear();
    const q = filter.toLowerCase();
    const shown = versions.filter((v) => !q || v.id.toLowerCase().includes(q));
    status.textContent = t('Показано: {a} из {b} · установлено: {c}', {
      a: Math.min(shown.length, 150), b: shown.length,
      c: versions.filter((v) => installed.has(v.id)).length,
    });
    for (const v of shown.slice(0, 150)) {
      const isInst = installed.has(v.id);
      const isBusy = busy.has(v.id);
      const msg = h('div', { class: 'small muted' });
      const fill = h('div');
      const bar = h('div', { class: 'bar', style: { display: 'none' } }, fill);
      rows.set(v.id, { msg, bar, fill });
      list.append(h('div', { class: 'card vrow' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' },
            h('b', {}, v.id), ' ', h('span', { class: 'chip' }, t(v.type === 'snapshot' ? 'снапшот' : 'релиз')),
            isInst && h('span', { class: 'chip ok' }, t('Установлена')),
            h('div', { class: 'small muted' }, new Date(v.releaseTime).toLocaleDateString(dateLocale())), msg),
          h('button', { class: `btn sm ${isInst ? '' : 'primary'}`, disabled: isBusy, onclick: () => install(v.id) }, isBusy ? t('Установка…') : isInst ? t('Проверить файлы') : t('Установить')),
          isInst && h('button', { class: 'btn sm danger', disabled: isBusy, onclick: () => uninstall(v.id) }, t('Удалить'))),
        bar));
      paintRow(v.id);
    }
    if (!shown.length) list.append(h('div', { class: 'empty' }, t('Ничего не найдено')));
  }

  async function refreshInstalled() {
    installed = new Set(await api.invoke('versions:installed').catch(() => []));
  }

  async function load() {
    status.textContent = t('Загрузка списка версий…');
    try {
      [versions] = await Promise.all([api.invoke('versions:list', { snapshots }), refreshInstalled()]);
      paint();
    } catch (e) {
      status.textContent = '';
      clear(list);
      list.append(h('div', { class: 'notice err' }, t('Не удалось загрузить версии: {msg}', { msg: e.message })));
    }
  }

  load();
  return off;
}
