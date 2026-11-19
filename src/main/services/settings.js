'use strict';
const os = require('os');
const { JsonStore, prune, clone } = require('../store');
const log = require('../logger');

const DEFAULTS = {
  launcher: {
    theme: 'dark', // dark | light | midnight
    language: 'ru', // ru | uk | en — мова інтерфейсу
    accent: '#ffb02e',
    animations: true,
    onLaunch: 'minimize', // keep | minimize | hide
    showSnapshots: false,
    autoRetry: true, // повторний запуск після нативного крашу JVM (0xC0000005)
  },
  game: {
    ramMax: 4096,
    ramMin: 1024,
    // MC 26.x по умолчанию выбирает Vulkan на AMD и падает в amdvlk64.dll — фиксируем OpenGL.
    graphicsBackend: 'opengl', // opengl | vulkan | default
    jvmArgs: '', // дополнительные флаги JVM часто роняют игру — по умолчанию не добавляем ничего
    gameArgs: '',
    width: 854,
    height: 480,
    fullscreen: false,
    optimization: {
      enabled: false,
      preset: 'balanced',
      renderDistance: 10,
      simulationDistance: 6,
      graphics: 'fast',
      particles: 'decreased',
      clouds: 'off',
      entityDistance: 0.75,
      mipmapLevels: 2,
      maxFps: 144,
      vsync: false,
    },
  },
  java: { path: '', autoDownload: true },
  auth: { azureClientId: '', allowOffline: true },
  updater: { enabled: true, url: '', autoCheck: true, autoInstall: true },
  discord: {
    enabled: true,
    clientId: '',
    customText: '',
    showVersion: true,
    showLoader: true,
    showProfile: true,
    showElapsed: true,
    showInLauncher: true,
    largeImageKey: 'logo',
    buttonLabel: '',
    buttonUrl: '',
  },
  state: { activeProfile: null },
};

const clamp = (n, lo, hi, d) => {
  n = Math.round(Number(n));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const str = (v, max) => String(v ?? '').trim().slice(0, max);

/** Безопасный максимум памяти: не больше 70% ОЗУ и не больше 64 ГБ. */
function maxRamMb() {
  const total = Math.floor(os.totalmem() / 1024 / 1024);
  return Math.max(1024, Math.min(65536, Math.floor((total * 0.7) / 256) * 256));
}

/** Убираем управляющие символы и чужие -Xmx/-Xms: они часто роняют игру. */
function cleanArgs(v, max = 2000) {
  return String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max)
    .split(/\s+/).filter((a) => a && !/^-Xm[xs]/i.test(a)).join(' ');
}

function isHttps(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function normalize(s) {
  const l = s.launcher;
  l.theme = ['dark', 'light', 'midnight'].includes(l.theme) ? l.theme : 'dark';
  l.language = ['ru', 'uk', 'en'].includes(l.language) ? l.language : 'ru';
  l.accent = /^#[0-9a-f]{6}$/i.test(l.accent) ? l.accent : DEFAULTS.launcher.accent;
  l.animations = !!l.animations;
  l.onLaunch = ['keep', 'minimize', 'hide'].includes(l.onLaunch) ? l.onLaunch : 'minimize';
  l.showSnapshots = !!l.showSnapshots;
  l.autoRetry = l.autoRetry !== false;

  const g = s.game;
  const cap = maxRamMb();
  g.ramMax = Math.min(clamp(g.ramMax, 512, cap, 4096), cap);
  g.ramMin = Math.min(clamp(g.ramMin, 128, cap, 1024), g.ramMax);
  g.graphicsBackend = ['opengl', 'vulkan', 'default'].includes(g.graphicsBackend) ? g.graphicsBackend : 'opengl';
  g.jvmArgs = cleanArgs(g.jvmArgs, 2000);
  g.gameArgs = cleanArgs(g.gameArgs, 2000);
  g.width = clamp(g.width, 320, 7680, 854);
  g.height = clamp(g.height, 240, 4320, 480);
  g.fullscreen = !!g.fullscreen;

  const o = g.optimization;
  if (!o || typeof o !== 'object' || Array.isArray(o)) g.optimization = { ...DEFAULTS.game.optimization };
  const optimization = g.optimization;
  optimization.enabled = !!optimization.enabled;
  optimization.preset = ['balanced', 'performance', 'custom'].includes(optimization.preset) ? optimization.preset : 'balanced';
  optimization.renderDistance = clamp(optimization.renderDistance, 2, 32, 10);
  optimization.simulationDistance = clamp(optimization.simulationDistance, 5, 32, 6);
  optimization.graphics = ['fast', 'fancy'].includes(optimization.graphics) ? optimization.graphics : 'fast';
  optimization.particles = ['all', 'decreased', 'minimal'].includes(optimization.particles) ? optimization.particles : 'decreased';
  optimization.clouds = ['off', 'fast', 'fancy'].includes(optimization.clouds) ? optimization.clouds : 'off';
  optimization.entityDistance = Math.round(clamp(optimization.entityDistance * 100, 50, 200, 75)) / 100;
  optimization.mipmapLevels = clamp(optimization.mipmapLevels, 0, 4, 2);
  optimization.maxFps = [30, 60, 75, 120, 144, 165, 240, 260].includes(Number(optimization.maxFps)) ? Number(optimization.maxFps) : 144;
  optimization.vsync = !!optimization.vsync;

  s.java.path = str(s.java.path, 1000);
  s.java.autoDownload = !!s.java.autoDownload;

  s.auth.azureClientId = /^[0-9a-f-]{36}$/i.test(str(s.auth.azureClientId, 64)) ? str(s.auth.azureClientId, 64) : '';
  s.auth.allowOffline = s.auth.allowOffline !== false;

  const u = s.updater;
  u.enabled = u.enabled !== false;
  let feed = str(u.url, 512);
  if (feed && !/\/$/.test(feed)) feed += '/';
  u.url = isHttps(feed) ? feed : '';
  u.autoCheck = u.autoCheck !== false;
  u.autoInstall = u.autoInstall !== false;

  const d = s.discord;
  d.enabled = !!d.enabled;
  d.clientId = /^\d{17,20}$/.test(str(d.clientId, 32)) ? str(d.clientId, 32) : '';
  d.customText = str(d.customText, 100);
  for (const k of ['showVersion', 'showLoader', 'showProfile', 'showElapsed', 'showInLauncher']) d[k] = !!d[k];
  d.largeImageKey = /^[\w.-]{1,64}$/.test(d.largeImageKey) ? d.largeImageKey : 'logo';
  d.buttonLabel = str(d.buttonLabel, 32);
  d.buttonUrl = isHttps(d.buttonUrl) ? str(d.buttonUrl, 512) : '';

  s.state.activeProfile = typeof s.state.activeProfile === 'string' ? s.state.activeProfile : null;
  return s;
}

class SettingsService {
  constructor(file) {
    this.store = new JsonStore(file, DEFAULTS, log);
    this.listeners = new Set();
    if (this.store.data.launcher.accent === '#7c5cff') this.store.data.launcher.accent = DEFAULTS.launcher.accent; // старый фиолетовый по умолчанию
    // Старый аргумент по умолчанию вызывал вылет игры (особенно на Java 25) — убираем его при обновлении.
    if (this.store.data.game.jvmArgs === '-XX:+UseG1GC -XX:MaxGCPauseMillis=100') this.store.data.game.jvmArgs = '';
    normalize(this.store.data);
    prune(this.store.data, DEFAULTS);
  }

  /** Копия текущих настроек (изменение копии ничего не меняет). */
  get() {
    return clone(this.store.data);
  }

  update(patch) {
    this.store.patch(patch || {});
    prune(this.store.data, DEFAULTS);
    normalize(this.store.data);
    this.store.save();
    const cur = this.get();
    for (const fn of this.listeners) {
      try {
        fn(cur);
      } catch (e) {
        log.error('Ошибка обработчика настроек', e);
      }
    }
    return cur;
  }

  /** Возврат к безопасным значениям по умолчанию (профили и аккаунты не трогаем). */
  reset() {
    this.store.data = clone(DEFAULTS);
    normalize(this.store.data);
    this.store.save();
    const cur = this.get();
    for (const fn of this.listeners) {
      try {
        fn(cur);
      } catch (e) {
        log.error('Ошибка обработчика настроек', e);
      }
    }
    return cur;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

module.exports = { SettingsService, DEFAULTS, normalize, maxRamMb, cleanArgs };
