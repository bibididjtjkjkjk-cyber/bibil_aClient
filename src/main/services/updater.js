'use strict';
/**
 * Автооновлення встановленої Windows-версії (NSIS Setup).
 *
 * Джерело — будь-який HTTPS-хостинг із файлами electron-builder:
 *   latest.yml + bibil_aClient Setup X.Y.Z.exe
 * Адресу можна задати в config.js (BUNDLED_UPDATE_URL), через BIBIL_UPDATE_URL
 * або в Налаштування → Оновлення. Портативний exe не оновлюється (обмеження electron-updater).
 */
const EventEmitter = require('events');
const { VERSION, ENV_UPDATE_URL, PACKAGED_UPDATE_PROVIDER } = require('../config');
const log = require('../logger');

let electronApp = null;
try {
  const electron = require('electron');
  if (electron && electron.app) electronApp = electron.app;
} catch {
  /* запуск поза Electron (тести) */
}

let updater = null;
let loadError = '';
try {
  updater = require('electron-updater').autoUpdater;
} catch (e) {
  loadError = e.message || String(e);
  log.warn('electron-updater недоступний:', loadError);
}

const isHttps = (url) => {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
};

class UpdaterService extends EventEmitter {
  /** @param {{settings: object, isBusy?: () => boolean}} opts */
  constructor({ settings, isBusy }) {
    super();
    this.settings = settings;
    this.isBusy = typeof isBusy === 'function' ? isBusy : () => false;
    this.installing = false;
    this._timer = null;
    this.state = {
      state: 'idle', // idle | checking | available | up-to-date | downloading | downloaded | installing | error | unavailable
      version: VERSION,
      latest: null,
      progress: 0,
      message: '',
      supported: this.supported(),
      url: this.sourceLabel(),
    };
    this._bind();
  }

  /** Тільки встановлений застосунок Windows має app-update.yml і може запустити NSIS. */
  supported() {
    return !!(updater && electronApp && electronApp.isPackaged
      && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR);
  }

  feedUrl() {
    const configured = String(this.settings.get()?.updater?.url || '').trim();
    const url = configured || ENV_UPDATE_URL || '';
    return isHttps(url) ? url.replace(/\/+$/, '') + '/' : '';
  }

  /** Чи може працювати перевірка: явна HTTPS-адреса АБО provider, зашитий у збірку. */
  hasPackagedProvider() {
    return !this.feedUrl() && ['github', 'gitlab', 'bitbucket'].includes(PACKAGED_UPDATE_PROVIDER);
  }

  sourceLabel() {
    const label = PACKAGED_UPDATE_PROVIDER === 'github' ? 'GitHub Releases' : PACKAGED_UPDATE_PROVIDER;
    return this.feedUrl() || (this.hasPackagedProvider() ? label : '');
  }

  canCheck() {
    return !!(this.feedUrl() || this.hasPackagedProvider());
  }

  info() {
    return { ...this.state, supported: this.supported(), url: this.sourceLabel() };
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.info());
  }

  _bind() {
    if (!updater) return;
    updater.autoDownload = true;
    // Встановленням керуємо самі: так не конфліктуємо з before-quit очищенням Discord.
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;

    updater.on('checking-for-update', () => this._set({ state: 'checking', message: 'Перевіряємо оновлення…' }));
    updater.on('update-available', (info) => {
      log.info(`Знайдено оновлення ${info?.version}`);
      this._set({ state: 'available', latest: info?.version || null, message: `Знайдено версію ${info?.version}` });
    });
    updater.on('update-not-available', (info) => {
      this._set({ state: 'up-to-date', latest: info?.version || null, message: 'У вас найновіша версія' });
    });
    updater.on('download-progress', (p) => {
      this._set({ state: 'downloading', progress: Math.round(p.percent || 0), message: `Завантаження: ${Math.round(p.percent || 0)}%` });
    });
    updater.on('update-downloaded', (info) => {
      log.info(`Оновлення ${info?.version} завантажено`);
      this._set({ state: 'downloaded', latest: info?.version || null, progress: 100, message: 'Оновлення завантажено' });
      const u = this.settings.get()?.updater || {};
      if (u.enabled && u.autoInstall && !this.isBusy()) {
        clearTimeout(this._timer);
        this._timer = setTimeout(() => {
          this.install().catch((e) => log.error('Не вдалося встановити оновлення:', e));
        }, 5000);
      }
    });
    updater.on('error', (e) => {
      log.error('Помилка оновлення:', e);
      this._set({ state: 'error', message: e?.message || String(e) });
    });
  }

  /** Перевірити наявність нової версії. */
  async check() {
    if (!this.supported()) {
      const msg = this.state.supported ? '' : (process.env.PORTABLE_EXECUTABLE_DIR
        ? 'Портативна версія не оновлюється автоматично — завантажте новий exe вручну.'
        : 'Автооновлення працює тільки у встановленій Windows-версії (Setup).');
      this._set({ state: 'unavailable', message: msg });
      throw new Error(msg || 'Автооновлення недоступне');
    }
    const url = this.feedUrl();
    if (!this.canCheck()) {
      const msg = 'Не вказано адресу оновлень. Додайте її в Настройки → Оновлення або в config.js (BUNDLED_UPDATE_URL).';
      this._set({ state: 'unavailable', message: msg });
      throw new Error(msg);
    }
    if (this.installing) return this.info();
    // Явна адреса перекриває провайдера зі збірки. Без адреси electron-updater
    // використовує app-update.yml (GitHub Releases) — друзям нічого вводити не треба.
    if (url) updater.setFeedURL({ provider: 'generic', url });
    await updater.checkForUpdates();
    return this.info();
  }

  /** Тиха перевірка при старті: без помилок у консоль, якщо адресу не налаштовано. */
  async checkOnStart() {
    const u = this.settings.get()?.updater || {};
    if (!u.enabled || !u.autoCheck || !this.canCheck() || !this.supported()) return;
    try {
      await this.check();
    } catch (e) {
      log.warn('Автоперевірка оновлень пропущена:', e.message);
    }
  }

  /** Встановити завантажене оновлення й перезапустити лаунчер. */
  async install() {
    if (!this.supported() || !updater) throw new Error('Оновлення недоступне');
    clearTimeout(this._timer);
    this.installing = true;
    this._set({ state: 'installing', message: 'Встановлюємо оновлення…' });
    try {
      // isForceRunAfter=true — лаунчер сам перезапуститься після роботи інсталятора.
      updater.quitAndInstall(false, true);
    } catch (e) {
      this.installing = false;
      this._set({ state: 'error', message: e?.message || String(e) });
      throw e;
    }
    return true;
  }
}

module.exports = { UpdaterService };
