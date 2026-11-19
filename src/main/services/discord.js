'use strict';
/**
 * Discord Rich Presence через локальный IPC (библиотека discord-rpc).
 * Ничего не отправляется на сторонние серверы: статус передаётся только запущенному клиенту Discord.
 * Application ID создаётся в Discord Developer Portal (см. README).
 */
const EventEmitter = require('events');
const { buildActivity } = require('./discord-activity');
const { ENV_DISCORD_CLIENT_ID } = require('../config');
const log = require('../logger');

let RPC = null;
try {
  RPC = require('discord-rpc');
} catch (e) {
  log.warn('Модуль discord-rpc не установлен: Rich Presence недоступен');
}

const RECONNECT_MS = 5000; // Discord запущен позже лаунчера — статус появится сам в течение нескольких секунд
const LOGIN_TIMEOUT_MS = 10000;
const MIN_UPDATE_MS = 4000; // Discord ограничивает частоту обновлений

class DiscordPresence extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.client = null;
    this.ready = false;
    this.connecting = false;
    this.connectedId = null;
    this.reconnectTimer = null;
    this.flushTimer = null;
    this.lastFlush = 0;
    this.status = { state: 'disabled', detail: '' };
    this.ctx = { phase: 'launcher', launcherStartedAt: Date.now() };
    this.destroyed = false;
  }

  _cfg() {
    const d = this.settings.get().discord;
    return { ...d, clientId: d.clientId || ENV_DISCORD_CLIENT_ID };
  }

  _setStatus(state, detail = '') {
    this.status = { state, detail };
    this.emit('status', this.status);
  }

  getStatus() {
    return this.status;
  }

  /** Вызывать при старте и при каждом изменении настроек. */
  async apply() {
    if (this.destroyed) return;
    const cfg = this._cfg();
    if (!RPC) return this._setStatus('unavailable', 'Модуль discord-rpc не установлен');
    if (!cfg.enabled) {
      await this._disconnect(true);
      return this._setStatus('disabled');
    }
    if (!cfg.clientId) {
      await this._disconnect(true);
      return this._setStatus('no-client-id', 'Укажите Discord Application ID в настройках');
    }
    if (this.client && this.connectedId !== cfg.clientId) await this._disconnect(true);
    if (!this.client) await this._connect(cfg.clientId);
    else this._scheduleFlush(true);
  }

  async _connect(clientId) {
    if (this.connecting || this.destroyed) return;
    this.connecting = true;
    this._setStatus('connecting');
    clearTimeout(this.reconnectTimer);
    const client = new RPC.Client({ transport: 'ipc' });
    client.on('ready', () => {
      if (this.client !== client) return;
      this.ready = true;
      this._setStatus('connected', client.user?.username || '');
      this._scheduleFlush(true);
    });
    client.on('disconnected', () => {
      if (this.client !== client) return;
      log.warn('Discord RPC: соединение потеряно');
      this._dropClient();
      this._scheduleReconnect();
    });
    this.client = client;
    this.connectedId = clientId;
    try {
      await Promise.race([
        client.login({ clientId }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут подключения')), LOGIN_TIMEOUT_MS)),
      ]);
    } catch (e) {
      log.info(`Discord RPC: не удалось подключиться (${e.message}). Повтор через ${RECONNECT_MS / 1000} с`);
      if (this.client === client) {
        this._dropClient();
        this._setStatus('unavailable', 'Discord не запущен или Application ID неверный');
        this._scheduleReconnect();
      }
    } finally {
      this.connecting = false;
    }
  }

  _dropClient() {
    const c = this.client;
    this.client = null;
    this.ready = false;
    this.connectedId = null;
    if (c) Promise.resolve(c.destroy()).catch(() => {});
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    if (this.destroyed) return;
    this.reconnectTimer = setTimeout(() => this.apply().catch((e) => log.error(e)), RECONNECT_MS);
  }

  async _disconnect(clear) {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.flushTimer);
    const c = this.client;
    if (!c) return;
    if (clear && this.ready) {
      try {
        await Promise.race([c.clearActivity(), new Promise((r) => setTimeout(r, 1500))]);
      } catch {
        /* ignore */
      }
    }
    this._dropClient();
  }

  _scheduleFlush(immediate = false) {
    clearTimeout(this.flushTimer);
    const wait = immediate ? Math.max(0, this.lastFlush + 1000 - Date.now()) : Math.max(0, this.lastFlush + MIN_UPDATE_MS - Date.now());
    this.flushTimer = setTimeout(() => this._flush().catch((e) => log.warn('Discord RPC:', e.message)), wait);
  }

  async _flush() {
    if (!this.client || !this.ready) return;
    this.lastFlush = Date.now();
    const act = buildActivity(this._cfg(), this.ctx);
    if (!act) await this.client.clearActivity();
    else await this.client.setActivity(act);
  }

  // ---------- состояние ----------

  setLauncher() {
    this.ctx = { phase: 'launcher', launcherStartedAt: this.ctx.launcherStartedAt };
    this._scheduleFlush();
  }

  setGame({ mc, loader, profile, startedAt }) {
    this.ctx = { phase: 'game', mc, loader, profile, startedAt: startedAt || Date.now(), launcherStartedAt: this.ctx.launcherStartedAt };
    this._scheduleFlush(true);
  }

  /** Корректное отключение при выходе: очищает статус и закрывает соединение. */
  async destroy() {
    this.destroyed = true;
    await this._disconnect(true);
  }
}

module.exports = { DiscordPresence };
