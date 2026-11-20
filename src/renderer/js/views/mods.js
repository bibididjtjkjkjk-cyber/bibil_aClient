import { h, clear, modal, toast, debounce, formatNumber, formatBytes, confirmDialog, safe, selectEl, skeleton } from '../ui.js';
import { t, dateLocale } from '../i18n.js';
import { state, subscribe, activeProfile } from '../state.js';

const api = window.bibil;
const PAGE = 20;

export function modsView(root, { go }) {
  const view = h('div');
  root.append(view);
  view.append(skeleton());

  let tab = 'catalog';
  const q = { query: '', index: 'relevance', category: '', offset: 0 };
  let hits = [];
  let total = 0;
  let loading = false;
  let installed = []; // установленные моды активного профиля
  let updates = new Map(); // fileName → {latest}
  let categories = [];
  let reqToken = 0;
  let progressEl = null;
  let profileId = null;

  const off = api.on('mods:progress', (p) => {
    if (progressEl) progressEl.textContent = `${t('Загрузка')} ${p.name}: ${p.total ? Math.round((p.done / p.total) * 100) + '%' : formatBytes(p.done)}`;
  });

  const installedIds = () => new Set(installed.map((m) => m.projectId).filter(Boolean));

  async function loadInstalled() {
    const p = activeProfile();
    if (!p || p.loader !== 'fabric') return;
    installed = (await safe(api.invoke('mods:list', p.id), t('Не удалось прочитать список модов'))) || [];
  }

  function render() {
    clear(view);
    const p = activeProfile();
    view.append(h('h1', {}, t('Моды')), h('p', { class: 'sub' }, t('Каталог Modrinth: поиск, установка с зависимостями, обновление и управление.')));

    if (!p) {
      view.append(h('div', { class: 'notice' }, t('Сначала создайте профиль.')), h('button', { class: 'btn primary', onclick: () => go('profiles') }, t('К профилям')));
      return;
    }
    if (p.loader !== 'fabric') {
      view.append(
        h('div', { class: 'notice' }, t('Профиль «{name}» использует Vanilla — моды недоступны. Выберите профиль с загрузчиком Fabric или измените этот профиль.', { name: p.name })),
        h('button', { class: 'btn primary', onclick: () => go('profiles') }, t('К профилям')));
      return;
    }

    view.append(
      h('div', { class: 'row wrap' },
        h('span', { class: 'chip' }, t('Профиль: {name}', { name: p.name })), h('span', { class: 'chip' }, `Minecraft ${p.version}`), h('span', { class: 'chip' }, 'Fabric'),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => api.invoke('app:openPath', 'mods', p.id).catch((e) => toast(e.message, 'error')) }, t('Открыть папку модов'))),
      h('div', { class: 'tabs' },
        h('button', { class: `tab ${tab === 'catalog' ? 'active' : ''}`, onclick: () => { tab = 'catalog'; render(); } }, t('Каталог')),
        h('button', { class: `tab ${tab === 'installed' ? 'active' : ''}`, onclick: () => { tab = 'installed'; render(); } }, t('Установленные ({n})', { n: installed.length }))));
    progressEl = h('div', { class: 'small muted', style: { minHeight: '18px', marginBottom: '6px' } });
    view.append(progressEl);
    view.append(tab === 'catalog' ? catalogPanel(p) : installedPanel(p));
  }

  // ---------------- Каталог ----------------

  function catalogPanel(p) {
    const results = h('div', { class: 'grid' });
    const more = h('button', { class: 'btn', style: { margin: '16px auto', display: 'none' }, onclick: () => search(false) }, t('Показать ещё'));
    const status = h('div', { class: 'muted', style: { margin: '12px 0' } });

    const input = h('input', { type: 'text', placeholder: t('Поиск модов…'), value: q.query, oninput: debounce((e) => { q.query = e.target.value; search(true); }, 350) });
    const sort = selectEl([
      { value: 'relevance', label: t('По релевантности') }, { value: 'downloads', label: t('По загрузкам') }, { value: 'follows', label: t('По подпискам') },
      { value: 'newest', label: t('Новые') }, { value: 'updated', label: t('Обновлённые') }], q.index, (v) => { q.index = v; search(true); });
    const cat = selectEl([{ value: '', label: t('Все категории') }, ...categories.map((c) => ({ value: c.name, label: c.name }))], q.category, (v) => { q.category = v; search(true); });

    const wrap = h('div', {}, h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, input), h('div', { style: { width: '190px' } }, sort), h('div', { style: { width: '190px' } }, cat)), status, results, h('div', { style: { textAlign: 'center' } }, more));

    function paint() {
      const ids = installedIds();
      if (q.offset === 0) results.replaceChildren();
      results.replaceChildren(...hits.map((m) => modCard(m, p, ids.has(m.id))));
      status.textContent = loading ? t('Загрузка…') : hits.length ? t('Найдено: {n}', { n: formatNumber(total) }) : t('Ничего не найдено');
      more.style.display = !loading && hits.length < total ? '' : 'none';
    }

    async function search(reset) {
      if (reset) { q.offset = 0; hits = []; }
      const token = ++reqToken;
      loading = true;
      paint();
      try {
        const r = await api.invoke('mods:search', { query: q.query, gameVersion: p.version, loader: 'fabric', category: q.category, index: q.index, offset: q.offset, limit: PAGE });
        if (token !== reqToken) return;
        hits = reset ? r.hits : hits.concat(r.hits);
        total = r.total;
        q.offset = hits.length;
      } catch (e) {
        if (token === reqToken) toast(t('Ошибка поиска: {msg}', { msg: e.message }), 'error');
      } finally {
        if (token === reqToken) { loading = false; paint(); }
      }
    }

    search(true);
    return wrap;
  }

  function modCard(m, p, isInstalled) {
    const icon = m.iconUrl ? h('img', { src: m.iconUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div', { class: 'ph' }, '🧩');
    const btn = h('button', { class: `btn sm ${isInstalled ? '' : 'primary'}`, disabled: isInstalled, onclick: () => installMod(m.id, m.title, btn) }, isInstalled ? t('Установлен') : t('Установить'));
    return h('div', { class: 'card hover mod' }, icon,
      h('div', { class: 'grow' },
        h('div', { class: 'title', onclick: () => showDetails(m, p) }, m.title),
        h('div', { class: 'small muted' }, `${m.author} · ⬇ ${formatNumber(m.downloads)}`),
        h('div', { class: 'desc' }, m.description),
        h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, m.categories.slice(0, 3).map((c) => h('span', { class: 'chip' }, c))), btn)));
  }

  async function installMod(projectId, title, btn, versionId) {
    const p = activeProfile();
    btn.disabled = true;
    btn.textContent = t('Установка…');
    const res = await safe(api.invoke('mods:install', p.id, projectId, versionId), t('Не удалось установить «{title}»', { title }));
    if (res) {
      const deps = res.length - 1;
      const depsText = deps > 0 ? (deps === 1 ? t(' (+{n} зависимость)', { n: deps }) : t(' (+{n} зависимости)', { n: deps })) : '';
      toast(t('Установлено: {title}{deps}', { title, deps: depsText }), 'success');
      await loadInstalled();
      render();
    } else {
      btn.disabled = false;
      btn.textContent = t('Установить');
    }
  }

  async function showDetails(m, p) {
    const body = h('div', {}, h('div', { class: 'muted' }, t('Загрузка…')));
    const dlg = modal({ title: m.title, body, actions: [{ label: t('Закрыть'), onClick: (c) => c() }] });
    try {
      const [info, versions] = await Promise.all([api.invoke('mods:project', m.id), api.invoke('mods:projectVersions', p.id, m.id)]);
      const sel = selectEl(versions.map((v) => ({ value: v.id, label: `${v.versionNumber} · ${v.type}${v.date ? ' · ' + new Date(v.date).toLocaleDateString(dateLocale()) : ''}` })), versions[0]?.id, () => {});
      const isInst = installedIds().has(m.id);
      const inst = h('button', { class: 'btn primary', disabled: isInst || !versions.length, onclick: async () => { dlg.close(); await installMod(m.id, m.title, inst, sel.value); } }, isInst ? t('Установлен') : t('Установить'));
      clear(body);
      body.append(
        h('p', {}, info.description),
        h('div', { class: 'small muted' }, `⬇ ${formatNumber(info.downloads)} · ♥ ${formatNumber(info.follows)}${info.license ? ' · ' + info.license : ''}`),
        h('div', { class: 'row wrap', style: { margin: '10px 0' } },
          h('button', { class: 'btn sm', onclick: () => api.invoke('app:openExternal', info.pageUrl) }, t('Страница на Modrinth')),
          info.sourceUrl && /^https:/.test(info.sourceUrl) && h('button', { class: 'btn sm', onclick: () => api.invoke('app:openExternal', info.sourceUrl) }, t('Исходный код'))),
        versions.length ? field2(t('Версия (Minecraft {v}, Fabric)', { v: p.version }), sel) : h('div', { class: 'notice' }, t('Нет версий для этой версии игры.')),
        inst);
    } catch (e) {
      clear(body);
      body.append(h('div', { class: 'notice err' }, e.message));
    }
  }

  function field2(label, el) {
    return h('label', { class: 'field' }, h('span', {}, label), el);
  }

  // ---------------- Установленные ----------------

  function installedPanel(p) {
    const list = h('div', { class: 'list' });
    const top = h('div', { class: 'row wrap', style: { marginBottom: '12px' } });
    const checkBtn = h('button', { class: 'btn', onclick: checkUpdates }, t('Проверить обновления'));
    const updAll = h('button', { class: 'btn primary', style: { display: updates.size ? '' : 'none' }, onclick: updateAll }, t('Обновить все ({n})', { n: updates.size }));
    top.append(checkBtn, updAll);

    async function checkUpdates() {
      checkBtn.disabled = true;
      checkBtn.textContent = t('Проверка…');
      const r = await safe(api.invoke('mods:checkUpdates', p.id), t('Не удалось проверить обновления'));
      if (r) {
        updates = new Map(r.map((u) => [u.fileName, u]));
        toast(r.length ? t('Доступно обновлений: {n}', { n: r.length }) : t('Все моды актуальны'), r.length ? 'info' : 'success');
        render();
      } else { checkBtn.disabled = false; checkBtn.textContent = t('Проверить обновления'); }
    }

    async function updateOne(file) {
      const r = await safe(api.invoke('mods:update', p.id, file), t('Не удалось обновить'));
      if (r) { updates.delete(file); await loadInstalled(); render(); }
      return !!r;
    }

    async function updateAll() {
      updAll.disabled = true;
      let ok = 0;
      for (const f of [...updates.keys()]) if (await updateOne(f)) ok++;
      toast(t('Обновлено модов: {n}', { n: ok }), 'success');
    }

    if (!installed.length) list.append(h('div', { class: 'empty' }, t('Модов пока нет. Установите их из каталога.')));
    for (const m of installed) {
      const upd = updates.get(m.fileName);
      list.append(h('div', { class: 'card' }, h('div', { class: 'row' },
        m.icon ? h('img', { src: m.icon, alt: '', style: { width: '36px', height: '36px', borderRadius: '8px' }, referrerpolicy: 'no-referrer' }) : h('div', { class: 'ph', style: { width: '36px', height: '36px', borderRadius: '8px', background: 'var(--panel-2)', display: 'grid', placeItems: 'center' } }, '🧩'),
        h('div', { class: 'grow' }, h('b', {}, m.title), h('div', { class: 'small muted' }, `${m.fileName} · ${formatBytes(m.size)}${m.versionNumber ? ' · ' + m.versionNumber : ''}${m.known ? '' : t(' · не найден на Modrinth')}`)),
        upd && h('button', { class: 'btn sm primary', title: `${upd.current} → ${upd.latest}`, onclick: async (e) => { e.target.disabled = true; await updateOne(m.fileName); } }, t('Обновить до {v}', { v: upd.latest })),
        h('label', { class: 'switch', title: m.enabled ? t('Включён') : t('Выключен') },
          h('input', { type: 'checkbox', checked: m.enabled, onchange: async (e) => {
            const ok = await safe(api.invoke('mods:toggle', p.id, m.fileName, e.target.checked).then(() => true));
            if (ok) m.enabled = e.target.checked; else e.target.checked = m.enabled;
          } }), h('i')),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!(await confirmDialog(t('Удалить мод «{title}»?', { title: m.title }), { okLabel: 'Удалить', danger: true }))) return;
          if (await safe(api.invoke('mods:remove', p.id, m.fileName).then(() => true), t('Не удалось удалить'))) { updates.delete(m.fileName); await loadInstalled(); render(); }
        } }, t('Удалить')))));
    }
    return h('div', {}, top, list);
  }

  async function boot() {
    const p = activeProfile();
    profileId = p?.id || null;
    if (p?.loader === 'fabric') {
      const [cats] = await Promise.all([api.invoke('mods:categories').catch(() => []), loadInstalled()]);
      categories = Array.isArray(cats) ? cats : [];
    }
    render();
  }
  boot();

  const unsub = subscribe((w) => {
    if (w === 'profiles' && activeProfile()?.id !== profileId) { updates = new Map(); hits = []; boot(); }
  });
  return () => { off(); unsub(); };
}
