import { h, clear, toast, icon } from './ui.js';
import { t } from './i18n.js';
import { init, state, subscribe } from './state.js';
import { bindUpdateUi } from './update-ui.js';
import { homeView } from './views/home.js';
import { versionsView } from './views/versions.js';
import { profilesView } from './views/profiles.js';
import { modsView } from './views/mods.js';
import { resourcepacksView } from './views/resourcepacks.js';
import { accountsView } from './views/accounts.js';
import { settingsView } from './views/settings.js';
import { cosmeticsView } from './views/cosmetics.js';
import { consoleView } from './views/console.js';

const api = window.bibil;

const ROUTES = [
  { id: 'home', icon: 'play', label: 'Играть', view: homeView },
  { id: 'profiles', icon: 'profiles', label: 'Профили', view: profilesView },
  { id: 'versions', icon: 'versions', label: 'Версии', view: versionsView },
  { id: 'mods', icon: 'mods', label: 'Моды', view: modsView },
  { id: 'resourcepacks', icon: 'resourcepacks', label: 'Ресурспаки', view: resourcepacksView },
  { id: 'cosmetics', icon: 'cosmetics', label: 'Косметика', view: cosmeticsView },
  { id: 'accounts', icon: 'accounts', label: 'Аккаунты', view: accountsView },
  { id: 'console', icon: 'console', label: 'Консоль', view: consoleView },
  { id: 'settings', icon: 'settings', label: 'Настройки', view: settingsView },
];

let current = null;
let cleanup = null;

export function go(id) {
  const route = ROUTES.find((r) => r.id === id) || ROUTES[0];
  if (current === route.id) return;
  current = route.id;
  if (cleanup) {
    try { cleanup(); } catch { /* ignore */ }
    cleanup = null;
  }
  const root = clear(document.getElementById('view'));
  const wrap = h('div', { class: 'view' });
  root.append(wrap);
  try {
    cleanup = route.view(wrap, { go }) || null;
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
  for (const r of ROUTES) {
    nav.append(h('button', { class: `nav-item ${r.id === current ? 'active' : ''}`, onclick: () => go(r.id) }, icon(r.icon), t(r.label)));
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

const DISCORD_LABEL = {
  connected: ['ok', 'Discord: статус активен'], connecting: ['warn', 'Discord: подключение…'], disabled: ['', 'Discord: выключен'],
  'no-client-id': ['warn', 'Discord: нужен Application ID'], unavailable: ['bad', 'Discord: не найден'],
};

let discordState = null;

function showDiscord(st) {
  discordState = st;
  const chip = document.getElementById('discordChip');
  const [cls, label] = DISCORD_LABEL[st.state] || ['', 'Discord'];
  const text = t(label);
  chip.className = `dchip ${cls}`;
  chip.lastChild.textContent = text;
  chip.title = st.detail || text;
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
  document.getElementById('discordChip').addEventListener('click', () => go('settings'));
  api.invoke('discord:status').then(showDiscord).catch(() => {});
  api.on('discord:status', showDiscord);
  subscribe((what) => {
    if (what !== 'language') return;
    const id = current;
    current = null;
    go(id);
    renderWindowControls();
    if (discordState) showDiscord(discordState);
  });
  api.on('launch:state', (s) => {
    if (s.status === 'error' && s.message) toast(s.message, 'error');
  });
  const start = location.hash.slice(1);
  current = null;
  go(ROUTES.some((r) => r.id === start) ? start : 'home');
}

boot();
