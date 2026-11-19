import { h, safe, selectEl, toast } from '../ui.js';
import { t } from '../i18n.js';
import { state, subscribe } from '../state.js';
import { versionsView as versionManagerView } from './versions.js';

const api = window.bibil;
const FEATURED = [
  { id: '1.8.9', tags: ['PvP', 'Классика'], summary: 'Лёгкая версия для дуэлей и мини-игр.' },
  { id: '1.16.5', tags: ['Моды', 'Fabric'], summary: 'Популярная ветка с поддержкой модов.' },
  { id: '1.20.4', tags: ['Fabric', 'Оптимизация'], summary: 'Стабильная современная версия для модпаков.' },
  { id: '1.21.4', tags: ['Свежая', 'Fabric'], summary: 'Современная ветка Minecraft.' },
];

async function loadLauncherData() {
  const [profiles, accounts, installed, launch] = await Promise.all([
    api.invoke('profiles:list'),
    api.invoke('accounts:list'),
    api.invoke('versions:installed'),
    api.invoke('launch:state'),
  ]);
  return { profiles: profiles.profiles || [], activeId: profiles.active, accounts: accounts.accounts || [], installed, launch };
}

async function launchProfile(profile, refresh) {
  if (['running', 'preparing', 'downloading', 'stopping'].includes(state.launch.status)) {
    toast(t('Игра уже запущена.'), 'error');
    return;
  }
  const { accounts } = await api.invoke('accounts:list');
  if (!accounts.length) {
    const settings = await api.invoke('settings:get');
    if (!settings.auth?.allowOffline) await api.invoke('settings:set', { auth: { allowOffline: true } });
    const name = `Player${Math.floor(1000 + Math.random() * 9000)}`;
    await api.invoke('accounts:addOffline', name);
    toast(t('Создан локальный аккаунт {name} (одиночная игра и LAN)', { name }), 'info');
  }
  await api.invoke('profiles:setActive', profile.id);
  await refresh();
  await api.invoke('launch:start', profile.id);
}

async function quickLaunch(version, profiles, refresh) {
  let profile = profiles.find((p) => p.version === version);
  if (!profile) {
    profile = await api.invoke('profiles:create', {
      name: `Minecraft ${version}`.slice(0, 40),
      version,
      loader: /^1\.(?:14|[2-9]\d)\./.test(version) ? 'fabric' : 'vanilla',
    });
  }
  await launchProfile(profile, refresh);
}

function versionCard(version, profiles, installed, refresh, latest) {
  const configured = profiles.filter((p) => p.version === version.id);
  const detail = FEATURED.find((v) => v.id === version.id);
  const tags = [...(detail?.tags || []), ...(version.id === latest ? ['Последняя'] : []), ...(installed.includes(version.id) ? ['Установлена'] : [])];
  return h('article', { class: 'version-card' },
    h('div', { class: 'version-art' }, version.id),
    h('h3', {}, version.id),
    h('p', {}, detail ? t(detail.summary) : t('Профилей: {n}', { n: configured.length })),
    h('div', { class: 'row wrap' }, tags.map((tag) => h('span', { class: 'chip' }, t(tag))),
      configured.length > 0 && h('span', { class: 'chip' }, t('Профилей: {n}', { n: configured.length }))),
    h('div', { class: 'row', style: { marginTop: '14px' } },
      h('button', { class: 'btn primary sm', onclick: () => safe(quickLaunch(version.id, profiles, refresh), t('Не удалось запустить Minecraft {v}', { v: version.id })) }, t('Быстрый запуск'))));
}

export async function playView(root, { go }) {
  let data;
  try { data = await loadLauncherData(); }
  catch (e) {
    root.replaceChildren(h('div', { class: 'notice err' }, e.message));
    return () => {};
  }
  let chosenProfile = data.profiles.find((p) => p.id === data.activeId) || data.profiles[0] || null;
  let currentLaunch = data.launch;
  let installed = data.installed || [];
  let latest = '';
  try { latest = (await api.invoke('versions:list')).find((v) => v.type === 'release')?.id || ''; } catch { /* версии доступны позже */ }

  const refresh = async () => {
    const updated = await loadLauncherData();
    data = { ...updated, installed };
    currentLaunch = updated.launch;
    chosenProfile = updated.profiles.find((p) => p.id === updated.activeId) || chosenProfile;
  };
  const onPlay = async () => {
    if (['running', 'preparing', 'downloading'].includes(currentLaunch.status)) {
      const result = await safe(api.invoke('launch:stop').then(() => true), t('Не удалось остановить игру'));
      if (result) currentLaunch = { status: 'stopping' };
      return;
    }
    if (!chosenProfile) {
      toast(t('Сначала выберите версию или создайте профиль.'), 'error');
      return;
    }
    const result = await safe(launchProfile(chosenProfile, refresh), t('Не удалось запустить игру'));
    if (result !== undefined) toast(t('Игра запускается: {version}', { version: chosenProfile.version }), 'success');
  };

  root.replaceChildren();
  const heading = h('div', { class: 'row wrap' },
    h('div', { class: 'grow' }, h('h1', { class: 'screen-title' }, t('Играть')),
      h('p', { class: 'screen-subtitle' }, t('Выбери сборку и возвращайся в игру.'))));
  const versionOptions = data.profiles.length
    ? data.profiles.map((p) => ({ value: p.id, label: `${p.name} · ${p.version} · ${p.loader}` }))
    : [];
  const profileSelect = selectEl(versionOptions, chosenProfile?.id, (id) => {
    chosenProfile = data.profiles.find((p) => p.id === id) || null;
    description.textContent = chosenProfile
      ? t('Выбран профиль {name} на Minecraft {version}.', { name: chosenProfile.name, version: chosenProfile.version })
      : t('Выбери версию Minecraft или создай первый профиль.');
    art.textContent = chosenProfile?.version || 'MC';
  });
  profileSelect.classList.add('version-select');
  profileSelect.disabled = !versionOptions.length;
  const playButton = h('button', { class: 'btn primary play-cta', onclick: onPlay },
    ['running', 'preparing', 'downloading'].includes(currentLaunch.status) ? t('Остановить игру') : t('ИГРАТЬ'));
  const description = h('p', { class: 'hero-description' }, chosenProfile
    ? t('Выбран профиль {name} на Minecraft {version}.', { name: chosenProfile.name, version: chosenProfile.version })
    : t('Выбери версию Minecraft или создай первый профиль.'));
  const art = h('div', { class: 'hero-art', 'aria-hidden': 'true' }, chosenProfile?.version || 'MC');
  const hero = h('section', { class: 'hero-panel' },
    h('div', {},
      h('div', { class: 'hero-label' }, t('ТВОЯ ИГРОВАЯ БИБЛИОТЕКА')),
      h('h2', { class: 'hero-title' }, t('Время играть')),
      description,
      h('div', { class: 'hero-controls' }, playButton, profileSelect,
        h('button', { class: 'btn', onclick: () => go('versions') }, t('Все версии')))),
    art);
  const grid = h('div', { class: 'version-grid' });
  const featured = new Map(FEATURED.map((x) => [x.id, { id: x.id, type: 'release' }]));
  if (latest) featured.set(latest, { id: latest, type: 'release' });
  grid.append(...[...featured.values()].map((v) => versionCard(v, data.profiles, installed, refresh, latest)));
  root.append(heading, hero,
    h('div', { class: 'section-heading' }, h('h2', {}, t('Быстрый выбор версии')),
      h('button', { class: 'btn sm', onclick: () => go('versions') }, t('Каталог версий'))),
    grid);
  const unsubscribe = subscribe((what) => {
    if (what !== 'launch') return;
    currentLaunch = state.launch;
    const running = ['running', 'preparing', 'downloading'].includes(currentLaunch.status);
    playButton.textContent = running ? t('Остановить игру') : t('ИГРАТЬ');
    playButton.classList.toggle('running', running);
  });
  return unsubscribe;
}

export async function versionsView(root) {
  root.replaceChildren(
    h('h1', { class: 'screen-title' }, t('Версии Minecraft')),
    h('p', { class: 'screen-subtitle' }, t('Выбери игровую ветку или запусти сохранённый профиль.')));
  const status = h('div', { class: 'muted' }, t('Загрузка версий…'));
  const grid = h('div', { class: 'version-grid' });
  root.append(status, grid);
  let listCleanup = () => {};
  try {
    const data = await loadLauncherData();
    let releases = [];
    try { releases = await api.invoke('versions:list'); } catch { /* показываем избранные версии из лаунчера */ }
    const latest = releases.find((v) => v.type === 'release')?.id || '';
    const versions = new Map(FEATURED.map((x) => [x.id, { id: x.id, type: 'release' }]));
    if (latest) versions.set(latest, { id: latest, type: 'release' });
    for (const profile of data.profiles) versions.set(profile.version, { id: profile.version, type: 'release' });
    for (const id of data.installed || []) versions.set(id, { id, type: 'release' });
    grid.replaceChildren(...[...versions.values()].map((v) => versionCard(v, data.profiles, data.installed || [], async () => {}, latest)));
    status.textContent = t('Найдено версий: {n}', { n: versions.size });
  } catch (e) {
    status.className = 'notice err';
    status.textContent = e.message;
  }
  root.append(h('div', { class: 'section-heading' }, h('h2', {}, t('Полный каталог версий'))));
  listCleanup = versionManagerView(root, { header: false });
  return () => listCleanup?.();
}
