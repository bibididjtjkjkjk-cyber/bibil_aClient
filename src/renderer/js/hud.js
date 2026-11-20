// Лёгкий игровой HUD мониторинга. FPS считается через requestAnimationFrame
// (самый дешёвый способ), остальные метрики приходят из main-процесса по событию monitor:tick.
// Полностью отключается в настройках: интерфейс → мониторинг.
import { h, clear } from './ui.js';
import { t } from './i18n.js';
import { state, subscribe } from './state.js';

const POS_CLASS = {
  'top-right': 'hud-tr',
  'top-left': 'hud-tl',
  'bottom-right': 'hud-br',
  'bottom-left': 'hud-bl',
  hidden: '',
};

let node = null;
let rafId = null;
let lastFrame = 0;
let fpsAcc = 0;
let fpsFrames = 0;
let fpsDisplay = 0;
let unsub = null;

function fmtBytes(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' ' + t('ГБ');
  return Math.round(mb) + ' ' + t('МБ');
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}${t('ч')} ${m % 60}${t('мин')}`;
  if (m) return `${m} ${t('мин')}`;
  return `${s} ${t('сек')}`;
}

function render() {
  const s = state.settings.monitoring;
  if (!s || !s.enabled || s.position === 'hidden') { hide(); return; }
  if (!node) {
    node = h('div', { class: 'hud', id: 'gameHud' }, h('div', { class: 'hud-group' }));
    document.body.append(node);
  }
  node.className = `hud ${POS_CLASS[s.position] || ''}`;
  node.style.opacity = String(s.overlayOpacity);
  node.style.fontSize = s.fontSize + 'px';
  const g = node.querySelector('.hud-group');
  clear(g);
  const items = [];
  if (s.showFps) items.push(h('span', { class: 'hud-item' }, t('FPS'), h('b', {}, String(fpsDisplay))));
  if (s.showRam) items.push(h('span', { class: 'hud-item' }, t('ОЗУ'), h('b', {}, fmtBytes(state.monitor.ramUsedMb))));
  if (s.showCpu) items.push(h('span', { class: 'hud-item' }, t('CPU'), h('b', {}, `${Math.round(state.monitor.cpu)}%`)));
  if (s.showTemp && (state.monitor.temps.cpu != null || state.monitor.temps.gpu != null)) {
    const parts = [];
    if (state.monitor.temps.cpu != null) parts.push(`CPU ${state.monitor.temps.cpu}°`);
    if (state.monitor.temps.gpu != null) parts.push(`GPU ${state.monitor.temps.gpu}°`);
    items.push(h('span', { class: 'hud-item' }, t('Температура'), h('b', {}, parts.join(' / '))));
  }
  if (s.showUptime) items.push(h('span', { class: 'hud-item' }, t('Время в игре'), h('b', {}, fmtUptime(state.monitor.uptimeMs))));
  g.append(...items);
}

function frame(now) {
  if (!lastFrame) lastFrame = now;
  const dt = now - lastFrame;
  lastFrame = now;
  fpsAcc += 1;
  fpsFrames += dt;
  if (fpsFrames >= 500) {
    fpsDisplay = Math.round((fpsAcc * 1000) / fpsFrames);
    fpsAcc = 0;
    fpsFrames = 0;
    render();
  }
  if (node && node.isConnected) rafId = requestAnimationFrame(frame);
}

function hide() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (node) { node.remove(); node = null; }
}

function sync() {
  const s = state.settings.monitoring;
  const running = state.launch.status === 'running';
  if (!s || !s.enabled || s.position === 'hidden' || !running) { hide(); return; }
  if (!node) { render(); }
  if (!rafId) { lastFrame = 0; rafId = requestAnimationFrame(frame); }
}

export function initHud() {
  sync();
  unsub = subscribe((what) => {
    if (what === 'settings' || what === 'launch' || what === 'monitor') sync();
  });
}

export function destroyHud() {
  if (unsub) unsub();
  hide();
}