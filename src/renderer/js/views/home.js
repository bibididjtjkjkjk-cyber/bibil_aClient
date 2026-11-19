import { h, selectEl, formatDuration, toast } from '../ui.js';
import { t, dateLocale } from '../i18n.js';
import { state, subscribe, activeProfile, activeAccount, refreshProfiles, refreshAccounts, saveSettings } from '../state.js';

const api = window.bibil;
const LOADER = { vanilla: 'Vanilla', fabric: 'Fabric' };

export function homeView(root, { go }) {
  const title = h('h1');
  const sub = h('p', { class: 'sub' });
  const playBtn = h('button', { class: 'btn primary play' });
  const safeBtn = h('button', { class: 'btn', title: t('Чистая ваниль: моды и ресурспаки временно выключаются, пользовательские аргументы игнорируются') }, t('Безопасно'));
  const offlineBtn = h('button', { class: 'btn', title: t('Локальный аккаунт для одиночной игры и LAN (без Microsoft)') }, t('Играть офлайн'));
  const profileSlot = h('div', { style: { minWidth: '240px' } });
  const status = h('div', { class: 'muted small', style: { marginTop: '12px', minHeight: '18px' } });
  const crashBox = h('div', { class: 'notice err', style: { display: 'none', marginTop: '10px' } });
  const barFill = h('div');
  const bar = h('div', { class: 'bar', style: { display: 'none' } }, barFill);
  const stats = h('div', { class: 'stats' });

  const hero = h('div', { class: 'hero' }, title, sub,
    h('div', { class: 'row wrap', style: { marginTop: '18px' } }, playBtn, safeBtn, offlineBtn, profileSlot),
    bar, status, crashBox);
  root.append(hero, stats);

  const busy = () => ['running', 'preparing', 'downloading'].includes(state.launch.status);

  async function start(safe = false) {
    const p = activeProfile();
    if (!p) return quickStart(false, safe);
    if (!activeAccount()) return quickStart(true, safe);
    try {
      await api.invoke('launch:start', p.id, { safe });
    } catch { /* ошибка уже показана через launch:state */ }
  }

  playBtn.addEventListener('click', () => {
    if (busy()) {
      api.invoke('launch:stop').catch((e) => toast(e.message, 'error'));
      return;
    }
    start(false);
  });
  safeBtn.addEventListener('click', () => { if (!busy()) start(true); });
  offlineBtn.addEventListener('click', () => { if (!busy()) quickStart(true, false); });

  async function quickStart(offline = false, safe = false) {
    const buttons = [playBtn, safeBtn, offlineBtn];
    buttons.forEach((b) => (b.disabled = true));
    try {
      if (offline && !activeAccount()) {
        if (!state.settings?.auth?.allowOffline) await saveSettings({ auth: { allowOffline: true } });
        const name = 'Player' + Math.floor(1000 + Math.random() * 9000);
        await api.invoke('accounts:addOffline', name);
        await refreshAccounts();
        toast(t('Создан локальный аккаунт {name} (одиночная игра и LAN)', { name }), 'info');
      }
      let p = activeProfile();
      if (!p) {
        const vs = await api.invoke('versions:list', { snapshots: false });
        if (!vs.length) throw new Error(t('Не удалось получить список версий Minecraft'));
        await api.invoke('profiles:create', { name: t('Мой профиль'), version: vs[0].id, loader: 'vanilla' });
        await refreshProfiles();
        p = activeProfile();
      }
      if (!activeAccount()) {
        toast(t('Добавьте аккаунт во вкладке «Аккаунты»'), 'error');
        return go('accounts');
      }
      toast(t('Запуск… первый раз скачиваются файлы игры — это может занять несколько минут.'), 'info', 8000);
      await api.invoke('launch:start', p.id, { safe });
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function renderProfileSelect() {
    profileSlot.replaceChildren();
    if (!state.profiles.length) return;
    const locked = busy();
    const sel = selectEl(
      state.profiles.map((p) => ({ value: p.id, label: `${p.name} — ${p.version}${p.loader !== 'vanilla' ? ' · ' + LOADER[p.loader] : ''}` })),
      state.activeProfileId,
      async (id) => {
        await api.invoke('profiles:setActive', id).catch((e) => toast(e.message, 'error'));
        await refreshProfiles();
      });
    sel.disabled = locked;
    profileSlot.append(sel);
  }

  function update() {
    const p = activeProfile();
    const acc = activeAccount();
    const st = state.launch;
    const working = st.status === 'preparing' || st.status === 'downloading';
    const installing = !working && st.status !== 'running' && !!state.install;

    title.textContent = p ? p.name : t('Добро пожаловать в bibil_aClient');
    sub.textContent = p
      ? `Minecraft ${p.version}${p.loader !== 'vanilla' ? ' · ' + LOADER[p.loader] : ''}${acc ? ' · ' + acc.name : ''}`
      : t('Нажмите «Быстрый старт» — лаунчер сам создаст профиль, скачает игру и запустит её.');

    playBtn.textContent = !p ? t('Быстрый старт') : st.status === 'running' ? t('Остановить') : working ? t('Отмена') : t('Играть');
    playBtn.classList.toggle('running', st.status === 'running' || working);
    safeBtn.style.display = p ? '' : 'none';
    safeBtn.disabled = busy();
    offlineBtn.style.display = acc ? 'none' : '';
    offlineBtn.disabled = busy();

    const prog = working ? st.progress : installing ? state.install.progress : null;
    bar.style.display = working || installing ? '' : 'none';
    bar.classList.toggle('indeterminate', (working || installing) && prog == null);
    barFill.style.width = prog != null ? `${Math.round(prog * 100)}%` : '';
    status.textContent = installing ? t('Установка Minecraft {id}: {message}', { id: state.install.id, message: state.install.message })
      : st.status === 'error' ? st.message
        : st.message || (acc ? '' : t('Нет аккаунта — нажмите «Играть офлайн» или добавьте аккаунт.'));
    status.style.color = st.status === 'error' ? 'var(--danger)' : '';

    const crash = st.crash;
    crashBox.style.display = crash ? '' : 'none';
    if (crash) crashBox.textContent = t('Последний вылет: {file}. {hint}', { file: crash.file, hint: crash.hint });

    renderProfileSelect();
    renderStats(p);
  }

  function renderStats(p) {
    stats.replaceChildren();
    if (!p) return;
    const s = state.settings;
    const stat = (label, value) => h('div', { class: 'card stat' }, h('span', { class: 'muted small' }, label), h('b', {}, value));
    stats.append(
      stat(t('Оперативная память'), `${((p.ramMax || s.game.ramMax) / 1024).toFixed(1)} ${t('ГБ')}`),
      stat(t('Время в игре'), formatDuration(p.playTimeMs || 0)),
      stat(t('Последний запуск'), p.lastPlayed ? new Date(p.lastPlayed).toLocaleString(dateLocale()) : '—'),
      stat('Discord', s.discord.enabled ? t('Статус включён') : t('Выключен')));
  }

  update();
  return subscribe(update);
}
