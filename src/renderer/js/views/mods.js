import { h, clear, modal, toast, debounce, formatNumber, formatBytes, confirmDialog, safe, selectEl } from '../ui.js';
import { state, subscribe, activeProfile } from '../state.js';

const api = window.bibil;
const PAGE = 20;

export function modsView(root, { go }) {
  const view = h('div');
  root.append(view);

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
    if (progressEl) progressEl.textContent = `Загрузка ${p.name}: ${p.total ? Math.round((p.done / p.total) * 100) + '%' : formatBytes(p.done)}`;
  });

  const installedIds = () => new Set(installed.map((m) => m.projectId).filter(Boolean));

  async function loadInstalled() {
    const p = activeProfile();
    if (!p || p.loader !== 'fabric') return;
    installed = (await safe(api.invoke('mods:list', p.id), 'Не удалось прочитать список модов')) || [];
  }

  function render() {
    clear(view);
    const p = activeProfile();
    view.append(h('h1', {}, 'Моды'), h('p', { class: 'sub' }, 'Каталог Modrinth: поиск, установка с зависимостями, обновление и управление.'));

    if (!p) {
      view.append(h('div', { class: 'notice' }, 'Сначала создайте профиль.'), h('button', { class: 'btn primary', onclick: () => go('profiles') }, 'К профилям'));
      return;
    }
    if (p.loader !== 'fabric') {
      view.append(
        h('div', { class: 'notice' }, `Профиль «${p.name}» использует Vanilla — моды недоступны. Выберите профиль с загрузчиком Fabric или измените этот профиль.`),
        h('button', { class: 'btn primary', onclick: () => go('profiles') }, 'К профилям'));
      return;
    }

    view.append(
      h('div', { class: 'row wrap' },
        h('span', { class: 'chip' }, `Профиль: ${p.name}`), h('span', { class: 'chip' }, `Minecraft ${p.version}`), h('span', { class: 'chip' }, 'Fabric'),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => api.invoke('app:openPath', 'mods', p.id).catch((e) => toast(e.message, 'error')) }, 'Открыть папку модов')),
      h('div', { class: 'tabs' },
        h('button', { class: `tab ${tab === 'catalog' ? 'active' : ''}`, onclick: () => { tab = 'catalog'; render(); } }, 'Каталог'),
        h('button', { class: `tab ${tab === 'installed' ? 'active' : ''}`, onclick: () => { tab = 'installed'; render(); } }, `Установленные (${installed.length})`)));
    progressEl = h('div', { class: 'small muted', style: { minHeight: '18px', marginBottom: '6px' } });
    view.append(progressEl);
    view.append(tab === 'catalog' ? catalogPanel(p) : installedPanel(p));
  }

  // ---------------- Каталог ----------------

  function catalogPanel(p) {
    const results = h('div', { class: 'grid' });
    const more = h('button', { class: 'btn', style: { margin: '16px auto', display: 'none' }, onclick: () => search(false) }, 'Показать ещё');
    const status = h('div', { class: 'muted', style: { margin: '12px 0' } });

    const input = h('input', { type: 'text', placeholder: 'Поиск модов…', value: q.query, oninput: debounce((e) => { q.query = e.target.value; search(true); }, 350) });
    const sort = selectEl([
      { value: 'relevance', label: 'По релевантности' }, { value: 'downloads', label: 'По загрузкам' }, { value: 'follows', label: 'По подпискам' },
      { value: 'newest', label: 'Новые' }, { value: 'updated', label: 'Обновлённые' }], q.index, (v) => { q.index = v; search(true); });
    const cat = selectEl([{ value: '', label: 'Все категории' }, ...categories.map((c) => ({ value: c.name, label: c.name }))], q.category, (v) => { q.category = v; search(true); });

    const wrap = h('div', {}, h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, input), h('div', { style: { width: '190px' } }, sort), h('div', { style: { width: '190px' } }, cat)), status, results, h('div', { style: { textAlign: 'center' } }, more));

    function paint() {
      const ids = installedIds();
      if (q.offset === 0) results.replaceChildren();
      results.replaceChildren(...hits.map((m) => modCard(m, p, ids.has(m.id))));
      status.textContent = loading ? 'Загрузка…' : hits.length ? `Найдено: ${formatNumber(total)}` : 'Ничего не найдено';
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
        if (token === reqToken) toast(`Ошибка поиска: ${e.message}`, 'error');
      } finally {
        if (token === reqToken) { loading = false; paint(); }
      }
    }

    search(true);
    return wrap;
  }

  function modCard(m, p, isInstalled) {
    const icon = m.iconUrl ? h('img', { src: m.iconUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div', { class: 'ph' }, '🧩');
    const btn = h('button', { class: `btn sm ${isInstalled ? '' : 'primary'}`, disabled: isInstalled, onclick: () => installMod(m.id, m.title, btn) }, isInstalled ? 'Установлен' : 'Установить');
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
    btn.textContent = 'Установка…';
    const res = await safe(api.invoke('mods:install', p.id, projectId, versionId), `Не удалось установить «${title}»`);
    if (res) {
      const deps = res.length - 1;
      toast(`Установлено: ${title}${deps > 0 ? ` (+${deps} зависимост${deps === 1 ? 'ь' : 'и'})` : ''}`, 'success');
      await loadInstalled();
      render();
    } else {
      btn.disabled = false;
      btn.textContent = 'Установить';
    }
  }

  async function showDetails(m, p) {
    const body = h('div', {}, h('div', { class: 'muted' }, 'Загрузка…'));
    const dlg = modal({ title: m.title, body, actions: [{ label: 'Закрыть', onClick: (c) => c() }] });
    try {
      const [info, versions] = await Promise.all([api.invoke('mods:project', m.id), api.invoke('mods:projectVersions', p.id, m.id)]);
      const sel = selectEl(versions.map((v) => ({ value: v.id, label: `${v.versionNumber} · ${v.type}${v.date ? ' · ' + new Date(v.date).toLocaleDateString('ru-RU') : ''}` })), versions[0]?.id, () => {});
      const isInst = installedIds().has(m.id);
      const inst = h('button', { class: 'btn primary', disabled: isInst || !versions.length, onclick: async () => { dlg.close(); await installMod(m.id, m.title, inst, sel.value); } }, isInst ? 'Установлен' : 'Установить');
      clear(body);
      body.append(
        h('p', {}, info.description),
        h('div', { class: 'small muted' }, `⬇ ${formatNumber(info.downloads)} · ♥ ${formatNumber(info.follows)}${info.license ? ' · ' + info.license : ''}`),
        h('div', { class: 'row wrap', style: { margin: '10px 0' } },
          h('button', { class: 'btn sm', onclick: () => api.invoke('app:openExternal', info.pageUrl) }, 'Страница на Modrinth'),
          info.sourceUrl && /^https:/.test(info.sourceUrl) && h('button', { class: 'btn sm', onclick: () => api.invoke('app:openExternal', info.sourceUrl) }, 'Исходный код')),
        versions.length ? field2('Версия (Minecraft ' + p.version + ', Fabric)', sel) : h('div', { class: 'notice' }, 'Нет версий для этой версии игры.'),
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
    const checkBtn = h('button', { class: 'btn', onclick: checkUpdates }, 'Проверить обновления');
    const updAll = h('button', { class: 'btn primary', style: { display: updates.size ? '' : 'none' }, onclick: updateAll }, `Обновить все (${updates.size})`);
    top.append(checkBtn, updAll);

    async function checkUpdates() {
      checkBtn.disabled = true;
      checkBtn.textContent = 'Проверка…';
      const r = await safe(api.invoke('mods:checkUpdates', p.id), 'Не удалось проверить обновления');
      if (r) {
        updates = new Map(r.map((u) => [u.fileName, u]));
        toast(r.length ? `Доступно обновлений: ${r.length}` : 'Все моды актуальны', r.length ? 'info' : 'success');
        render();
      } else { checkBtn.disabled = false; checkBtn.textContent = 'Проверить обновления'; }
    }

    async function updateOne(file) {
      const r = await safe(api.invoke('mods:update', p.id, file), 'Не удалось обновить');
      if (r) { updates.delete(file); await loadInstalled(); render(); }
      return !!r;
    }

    async function updateAll() {
      updAll.disabled = true;
      let ok = 0;
      for (const f of [...updates.keys()]) if (await updateOne(f)) ok++;
      toast(`Обновлено модов: ${ok}`, 'success');
    }

    if (!installed.length) list.append(h('div', { class: 'empty' }, 'Модов пока нет. Установите их из каталога.'));
    for (const m of installed) {
      const upd = updates.get(m.fileName);
      list.append(h('div', { class: 'card' }, h('div', { class: 'row' },
        m.icon ? h('img', { src: m.icon, alt: '', style: { width: '36px', height: '36px', borderRadius: '8px' }, referrerpolicy: 'no-referrer' }) : h('div', { class: 'ph', style: { width: '36px', height: '36px', borderRadius: '8px', background: 'var(--panel-2)', display: 'grid', placeItems: 'center' } }, '🧩'),
        h('div', { class: 'grow' }, h('b', {}, m.title), h('div', { class: 'small muted' }, `${m.fileName} · ${formatBytes(m.size)}${m.versionNumber ? ' · ' + m.versionNumber : ''}${m.known ? '' : ' · не найден на Modrinth'}`)),
        upd && h('button', { class: 'btn sm primary', title: `${upd.current} → ${upd.latest}`, onclick: async (e) => { e.target.disabled = true; await updateOne(m.fileName); } }, `Обновить до ${upd.latest}`),
        h('label', { class: 'switch', title: m.enabled ? 'Включён' : 'Выключен' },
          h('input', { type: 'checkbox', checked: m.enabled, onchange: async (e) => {
            const ok = await safe(api.invoke('mods:toggle', p.id, m.fileName, e.target.checked).then(() => true));
            if (ok) m.enabled = e.target.checked; else e.target.checked = m.enabled;
          } }), h('i')),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!(await confirmDialog(`Удалить мод «${m.title}»?`, { okLabel: 'Удалить', danger: true }))) return;
          if (await safe(api.invoke('mods:remove', p.id, m.fileName).then(() => true), 'Не удалось удалить')) { updates.delete(m.fileName); await loadInstalled(); render(); }
        } }, 'Удалить'))));
    }
    return h('div', {}, top, list);
  }

  async function boot() {
    const p = activeProfile();
    profileId = p?.id || null;
    if (p?.loader === 'fabric') {
      const [cats] = await Promise.all([api.invoke('mods:categories').catch(() => []), loadInstalled()]);
      categories = cats;
    }
    render();
  }
  boot();

  const unsub = subscribe((w) => {
    if (w === 'profiles' && activeProfile()?.id !== profileId) { updates = new Map(); hits = []; boot(); }
  });
  return () => { off(); unsub(); };
}
