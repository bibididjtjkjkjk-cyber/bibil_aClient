import { h, clear, modal, toast, debounce, formatNumber, formatBytes, confirmDialog, safe, selectEl } from '../ui.js';
import { state, subscribe, activeProfile } from '../state.js';

const api = window.bibil;
const PAGE = 20;

/** Раздел ресурспаков: каталог Modrinth + список установленных в profile/resourcepacks. */
export function resourcepacksView(root, { go }) {
  const view = h('div');
  root.append(view);

  let tab = 'catalog';
  const q = { query: '', index: 'relevance', category: '', offset: 0 };
  let hits = [];
  let total = 0;
  let loading = false;
  let installed = [];
  let categories = [];
  let reqToken = 0;
  let profileId = null;
  let progressEl = null;

  const offProgress = api.on('resourcepacks:progress', (p) => {
    if (!progressEl) return;
    const pct = p.total ? Math.round((p.done / p.total) * 100) + '%' : formatBytes(p.done);
    progressEl.textContent = `Загрузка ${p.name}: ${pct}`;
  });

  async function loadInstalled() {
    const p = activeProfile();
    if (!p) { installed = []; return; }
    installed = (await safe(api.invoke('resourcepacks:list', p.id), 'Не удалось прочитать список ресурспаков')) || [];
  }

  function render() {
    clear(view);
    const p = activeProfile();
    view.append(h('h1', {}, 'Ресурспаки'),
      h('p', { class: 'sub' }, 'Ставятся в папку resourcepacks и проверяются на совместимость с версией игры.'));
    if (!p) {
      view.append(h('div', { class: 'notice' }, 'Сначала создайте профиль.'),
        h('button', { class: 'btn primary', onclick: () => go('profiles') }, 'К профилям'));
      return;
    }
    view.append(h('div', { class: 'row wrap' },
      h('span', { class: 'chip' }, `Профиль: ${p.name}`), h('span', { class: 'chip' }, `Minecraft ${p.version}`),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: () => safe(api.invoke('app:openPath', 'resourcepacks', p.id)) }, 'Открыть папку')),
      h('div', { class: 'tabs' },
        h('button', { class: `tab ${tab === 'catalog' ? 'active' : ''}`, onclick: () => { tab = 'catalog'; render(); } }, 'Каталог'),
        h('button', { class: `tab ${tab === 'installed' ? 'active' : ''}`, onclick: () => { tab = 'installed'; render(); } }, `Установленные (${installed.length})`)));
    progressEl = h('div', { class: 'small muted', style: { minHeight: '18px', marginBottom: '6px' } });
    view.append(progressEl, tab === 'catalog' ? catalogPanel(p) : installedPanel(p));
  }

  function catalogPanel(p) {
    const results = h('div', { class: 'grid' });
    const status = h('div', { class: 'muted', style: { margin: '12px 0' } });
    const more = h('button', { class: 'btn', style: { margin: '16px auto', display: 'none' }, onclick: () => search(false) }, 'Показать ещё');
    const input = h('input', { type: 'text', placeholder: 'Поиск ресурспаков…', value: q.query,
      oninput: debounce((e) => { q.query = e.target.value; search(true); }, 350) });
    const sort = selectEl([
      { value: 'relevance', label: 'По релевантности' }, { value: 'downloads', label: 'По загрузкам' },
      { value: 'newest', label: 'Новые' }, { value: 'updated', label: 'Обновлённые' }], q.index, (v) => { q.index = v; search(true); });
    const cat = selectEl([{ value: '', label: 'Все категории' }, ...categories.map((c) => ({ value: c.name, label: c.name }))],
      q.category, (v) => { q.category = v; search(true); });

    function paint() {
      results.replaceChildren(...hits.map((m) => card(m, p)));
      status.textContent = loading ? 'Загрузка…' : hits.length ? `Найдено: ${formatNumber(total)}` : 'Ничего не найдено';
      more.style.display = !loading && hits.length < total ? '' : 'none';
    }

    async function search(reset) {
      if (reset) { q.offset = 0; hits = []; }
      const token = ++reqToken;
      loading = true;
      paint();
      try {
        const r = await api.invoke('resourcepacks:search', {
          query: q.query, gameVersion: p.version, category: q.category,
          index: q.index, offset: q.offset, limit: PAGE,
        });
        if (token !== reqToken) return;
        hits = reset ? r.hits : hits.concat(r.hits);
        total = r.total;
        q.offset = hits.length;
      } catch (e) {
        if (token === reqToken) toast(`Ошибка поиска: ${e.message}`, 'error');
      } finally {
        if (token === reqToken) { loading = false; paint(); }
      }
    }
    search(true);
    return h('div', {},
      h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, input),
        h('div', { style: { width: '190px' } }, sort), h('div', { style: { width: '190px' } }, cat)),
      status, results, h('div', { style: { textAlign: 'center' } }, more));
  }

  function card(m, p) {
    const isInstalled = installed.some((x) => x.projectId === m.id);
    const btn = h('button', { class: `btn sm ${isInstalled ? '' : 'primary'}`, disabled: isInstalled,
      onclick: () => install(m.id, m.title, btn) }, isInstalled ? 'Установлен' : 'Установить');
    return h('div', { class: 'card hover mod' },
      m.iconUrl ? h('img', { src: m.iconUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div', { class: 'ph' }, '🖼'),
      h('div', { class: 'grow' },
        h('div', { class: 'title', onclick: () => details(m, p) }, m.title),
        h('div', { class: 'small muted' }, `${m.author} · ⬇ ${formatNumber(m.downloads)}`),
        h('div', { class: 'desc' }, m.description),
        h('div', { class: 'row wrap' },
          h('div', { class: 'grow' }, m.categories.slice(0, 3).map((c) => h('span', { class: 'chip' }, c))), btn)));
  }

  async function install(projectId, title, btn, versionId) {
    const p = activeProfile();
    if (!p) return;
    btn.disabled = true;
    btn.textContent = 'Установка…';
    const res = await safe(api.invoke('resourcepacks:install', p.id, projectId, versionId), `Не удалось установить «${title}»`);
    if (res) {
      toast(`Ресурспак установлен: ${res.title}`, 'success');
      await loadInstalled();
      render();
    } else {
      btn.disabled = false;
      btn.textContent = 'Установить';
    }
  }

  async function details(m, p) {
    const body = h('div', {}, h('div', { class: 'muted' }, 'Загрузка…'));
    const dlg = modal({ title: m.title, body, actions: [{ label: 'Закрыть', onClick: (c) => c() }] });
    try {
      const [info, versions] = await Promise.all([
        api.invoke('resourcepacks:project', m.id),
        api.invoke('resourcepacks:projectVersions', p.id, m.id),
      ]);
      const sel = selectEl(versions.map((v) => ({ value: v.id, label: `${v.versionNumber} · ${v.type}` })), versions[0]?.id, () => {});
      const inst = h('button', { class: 'btn primary', disabled: !versions.length,
        onclick: () => { dlg.close(); install(m.id, m.title, inst, sel.value); } }, 'Установить');
      clear(body);
      body.append(h('p', {}, info.description),
        h('div', { class: 'small muted' }, `⬇ ${formatNumber(info.downloads)} · ♥ ${formatNumber(info.follows)}`),
        h('div', { class: 'row wrap', style: { margin: '10px 0' } },
          h('button', { class: 'btn sm', onclick: () => safe(api.invoke('app:openExternal', info.pageUrl)) }, 'Страница на Modrinth')),
        h('label', { class: 'field' }, h('span', {}, `Версия (Minecraft ${p.version})`), sel), inst);
    } catch (e) {
      clear(body);
      body.append(h('div', { class: 'notice err' }, e.message));
    }
  }

  function installedPanel(p) {
    const list = h('div', { class: 'list' });
    if (!installed.length) {
      list.append(h('div', { class: 'empty' }, 'Ресурспаков нет. Установите из каталога или положите .zip в папку resourcepacks.'));
    }
    for (const r of installed) {
      const badge = r.compatible === false
        ? h('span', { class: 'chip warn', style: { marginLeft: '6px' } }, 'Не подходит')
        : r.compatible === true
          ? h('span', { class: 'chip ok', style: { marginLeft: '6px' } }, 'Совместим') : null;
      list.append(h('div', { class: 'card' }, h('div', { class: 'row' },
        r.icon ? h('img', { src: r.icon, alt: '', style: { width: '36px', height: '36px', borderRadius: '8px' }, referrerpolicy: 'no-referrer' })
          : h('div', { class: 'ph', style: { width: '36px', height: '36px' } }, '🖼'),
        h('div', { class: 'grow' }, h('b', {}, r.title, badge),
          h('div', { class: 'small muted' }, `${r.fileName} · ${formatBytes(r.size)}${r.packFormat != null ? ' · pack_format ' + r.packFormat : ''}${r.versionNumber ? ' · ' + r.versionNumber : ''}`),
          r.reason && h('div', { class: 'small', style: { color: 'var(--danger)', marginTop: '4px' } }, r.reason)),
        h('label', { class: 'switch', title: r.enabled ? 'Включён' : 'Выключен' },
          h('input', { type: 'checkbox', checked: r.enabled, onchange: async (e) => {
            const ok = await safe(api.invoke('resourcepacks:toggle', p.id, r.fileName, e.target.checked).then(() => true));
            if (ok) r.enabled = e.target.checked; else e.target.checked = r.enabled;
          } }), h('i')),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!(await confirmDialog(`Удалить ресурспак «${r.title}»?`, { okLabel: 'Удалить', danger: true }))) return;
          if (await safe(api.invoke('resourcepacks:remove', p.id, r.fileName).then(() => true), 'Не удалось удалить')) {
            await loadInstalled();
            render();
          }
        } }, 'Удалить'))));
    }
    return list;
  }

  async function boot() {
    const p = activeProfile();
    profileId = p?.id || null;
    categories = await api.invoke('resourcepacks:categories').catch(() => []);
    await loadInstalled();
    render();
  }
  boot();

  const unsub = subscribe((what) => {
    if (what === 'profiles' && (activeProfile()?.id || null) !== profileId) {
      hits = [];
      profileId = activeProfile()?.id || null;
      boot();
    }
  });
  return () => { offProgress(); unsub(); };
}
