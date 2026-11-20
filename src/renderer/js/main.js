import { h, clear, toast, icon } from './ui.js';
import { t } from './i18n.js';
import { init, state, subscribe } from './state.js';
import { bindUpdateUi } from './update-ui.js';
import { versionsView } from './views/versions.js';
import { playView } from './views/play.js';
import { diagnosticsView } from './views/diagnostics.js';
import { updatesView } from './views/updates.js';
import { profilesView } from './views/profiles.js';
import { modsView } from './views/mods.js';
import { resourcepacksView } from './views/resourcepacks.js';
import { accountsView } from './views/accounts.js';
import { settingsView } from './views/settings.js';
import { consoleView } from './views/console.js';

const api = window.bibil;

const ROUTES = [
  { id: 'home', icon: 'play', label: 'Играть', group: 'Основное', view: playView },
  { id: 'versions', icon: 'versions', label: 'Версии', group: 'Основное', view: versionsView },
  { id: 'accounts', icon: 'accounts', label: 'Аккаунты', group: 'Основное', view: accountsView },
  { id: 'profiles', icon: 'profiles', label: 'Профили', group: 'Библиотека', view: profilesView },
  { id: 'mods', icon: 'mods', label: 'Моды', group: 'Библиотека', view: modsView },
  { id: 'resourcepacks', icon: 'resourcepacks', label: 'Ресурспаки', group: 'Библиотека', view: resourcepacksView },
  { id: 'console', icon: 'console', label: 'Консоль', group: 'Система', view: consoleView },
  { id: 'diagnostics', icon: 'diagnostics', label: 'Диагностика', group: 'Система', view: diagnosticsView },
  { id: 'updates', icon: 'updates', label: 'Обновления', group: 'Система', view: updatesView },
  { id: 'settings', icon: 'settings', label: 'Настройки', group: 'Система', view: settingsView },
];

let current = null;
let cleanup = null;
let viewGeneration = 0;

export function go(id) {
  const route = ROUTES.find((r) => r.id === id) || ROUTES[0];
  if (current === route.id) return;
  current = route.id;
  const generation = ++viewGeneration;
  if (cleanup) {
    try { cleanup(); } catch { /* ignore */ }
    cleanup = null;
  }
  const root = clear(document.getElementById('view'));
  const wrap = h('div', { class: 'view' });
  root.append(wrap);
  try {
    const result = route.view(wrap, { go });
    if (result && typeof result.then === 'function') {
      result.then((dispose) => {
        if (generation === viewGeneration && wrap.isConnected) cleanup = dispose || null;
        else if (typeof dispose === 'function') dispose();
      }).catch((e) => {
        if (generation === viewGeneration && wrap.isConnected) {
          wrap.append(h('div', { class: 'notice err' }, t('Ошибка отображения: {msg}', { msg: e.message })));
        }
      });
    } else cleanup = result || null;
  } catch (e) {
    wrap.append(h('div', { class: 'notice err' }, t('Ошибка отображения: {msg}', { msg: e.message })));
  }
  renderNav();
  location.hash = route.id;
}

function renderNav() {
  const nav = clear(document.getElementById('nav'));
  nav.append(h('div', { class: 'side-logo' }, h('img', { src: 'assets/logo-small.png', alt: '' }),
    h('div', {}, 'bibil_aClient', h('small', {}, 'Minecraft launcher'))));
  let lastGroup = null;
  for (const r of ROUTES) {
    if (r.group && r.group !== lastGroup) {
      nav.append(h('div', { class: 'nav-extra-group' }, t(r.group)));
      lastGroup = r.group;
    }
    nav.append(h('button', {
      class: `nav-item ${r.id === current ? 'active' : ''}`,
      'aria-current': r.id === current ? 'page' : null,
      title: t(r.label),
      onclick: () => go(r.id),
    }, icon(r.icon), t(r.label)));
  }
  nav.append(h('div', { class: 'nav-spacer' }), h('div', { class: 'nav-foot' }, `v${state.info.version}`));
}

function renderWindowControls() {
  const box = clear(document.getElementById('winControls'));
  const max = h('button', { title: t('Развернуть'), onclick: () => api.invoke('win:toggleMaximize') }, '▢');
  box.append(
    h('button', { title: t('Свернуть'), onclick: () => api.invoke('win:minimize') }, '—'),
    max,
    h('button', { class: 'close', title: t('Закрыть'), onclick: () => api.invoke('win:close') }, '✕'));
}

async function boot() {
  try {
    await init();
  } catch (e) {
    document.getElementById('view').append(h('div', { class: 'notice err' }, t('Не удалось запустить интерфейс: {msg}', { msg: e.message })));
    return;
  }
  renderWindowControls();
  bindUpdateUi();
  subscribe((what) => {
    if (what !== 'language') return;
    const id = current;
    current = null;
    go(id);
    renderWindowControls();
  });
  api.on('launch:state', (s) => {
    if (s.status === 'error' && s.message) toast(s.message, 'error');
  });
  const start = location.hash.slice(1);
  current = null;
  go(ROUTES.some((r) => r.id === start) ? start : 'home');
}

boot();
