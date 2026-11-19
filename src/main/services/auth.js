'use strict';
/**
 * Авторизация Microsoft → Xbox Live → XSTS → Minecraft Services и локальные игровые профили.
 * Microsoft Application ID задаётся сборщиком через конфигурацию или переменную окружения.
 * Refresh-токены хранятся зашифрованными через Electron safeStorage (DPAPI / Keychain / libsecret).
 */
const crypto = require('crypto');
const { safeStorage } = require('electron');
const { JsonStore } = require('../store');
const { request, postJson, HttpError, sleep } = require('../util/http');
const { ENV_AZURE_CLIENT_ID } = require('../config');
const log = require('../logger');

const MS_DEVICE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const MS_TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const SCOPE = 'XboxLive.signin offline_access';

const XSTS_ERRORS = {
  2148916233: 'У этой учётной записи Microsoft нет профиля Xbox. Создайте его на xbox.com.',
  2148916235: 'Xbox Live недоступен в вашей стране.',
  2148916236: 'Для аккаунта нужна проверка возраста / семейные настройки (Xbox).',
  2148916237: 'Для аккаунта нужна проверка возраста / семейные настройки (Xbox).',
  2148916238: 'Детский аккаунт: добавьте его в семейную группу Microsoft и разрешите мультиплеер.',
};

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

function offlineUuid(name) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('hex');
}

function offlineAuthorization(name, clientToken) {
  const uuid = offlineUuid(name);
  return {
    access_token: uuid,
    client_token: clientToken || uuid,
    uuid,
    name,
    user_properties: '{}',
    meta: { type: 'mojang', demo: false },
  };
}

function seal(text) {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64');
  log.warn('safeStorage недоступен: токен сохранён без шифрования');
  return 'plain:' + Buffer.from(text, 'utf8').toString('base64');
}

function unseal(value) {
  if (!value) return '';
  const [kind, data] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
  const buf = Buffer.from(data, 'base64');
  if (kind === 'enc') return safeStorage.decryptString(buf);
  return buf.toString('utf8');
}

async function formPost(url, params) {
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  return res.json().catch(() => ({ error: `http_${res.status}` }));
}

/** MS access token → Xbox → XSTS → Minecraft token + профиль. */
async function msToMinecraft(msAccessToken) {
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });

  let xsts;
  try {
    xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    });
  } catch (e) {
    if (e instanceof HttpError) {
      try {
        const code = JSON.parse(e.body).XErr;
        if (XSTS_ERRORS[code]) throw new AuthError(XSTS_ERRORS[code]);
      } catch (inner) {
        if (inner instanceof AuthError) throw inner;
      }
    }
    throw e;
  }

  const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;
  if (!uhs) throw new AuthError('Xbox не вернул идентификатор пользователя');

  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xsts.Token}`,
  });

  const profRes = await request('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mc.access_token}`, Accept: 'application/json' },
  });
  if (profRes.status === 404) throw new AuthError('На этом аккаунте не найден Minecraft: Java Edition.');
  if (!profRes.ok) throw new HttpError(profRes.status, 'api.minecraftservices.com/minecraft/profile');
  const profile = await profRes.json();

  return {
    token: mc.access_token,
    expiresAt: Date.now() + (mc.expires_in || 86400) * 1000,
    profile: { id: profile.id, name: profile.name },
  };
}

class AuthService {
  constructor(file) {
    this.store = new JsonStore(file, { accounts: [], active: null, clientToken: '' }, log);
    this.cache = new Map(); // accountId → { token, expiresAt }
    this.pending = null;
    if (!this.store.data.clientToken) {
      this.store.data.clientToken = crypto.randomUUID().replace(/-/g, '');
      this.store.save();
    }
  }

  _clientId() {
    const id = ENV_AZURE_CLIENT_ID;
    if (!id) {
      throw new AuthError(
        'В этой сборке не настроен Microsoft Application ID; используйте локальный аккаунт или обратитесь к автору сборки.'
      );
    }
    return id;
  }

  _pub(a) {
    return { id: a.id, type: a.type, name: a.name, uuid: a.uuid };
  }

  list() {
    return { accounts: this.store.data.accounts.map((a) => this._pub(a)), active: this.getActive()?.id ?? null };
  }

  getActive() {
    const { accounts, active } = this.store.data;
    return accounts.find((a) => a.id === active) || accounts[0] || null;
  }

  setActive(id) {
    if (!this.store.data.accounts.some((a) => a.id === id)) throw new Error('Аккаунт не найден');
    this.store.data.active = id;
    this.store.save();
  }

  remove(id) {
    const d = this.store.data;
    d.accounts = d.accounts.filter((a) => a.id !== id);
    this.cache.delete(id);
    if (d.active === id) d.active = d.accounts[0]?.id ?? null;
    this.store.save();
  }

  /** Локальный профиль по нику: Microsoft-вход не требуется. */
  addOffline(name) {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new AuthError('Ник: 3–16 символов (латиница, цифры, _)');
    const existing = this.store.data.accounts.find(
      (a) => a.type === 'offline' && a.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      this.store.data.active = existing.id;
      this.store.save();
      return this._pub(existing);
    }
    const acc = { id: crypto.randomUUID(), type: 'offline', name, uuid: offlineUuid(name) };
    this.store.data.accounts.push(acc);
    this.store.data.active = acc.id;
    this.store.save();
    return this._pub(acc);
  }

  cancelLogin() {
    if (this.pending) this.pending.cancelled = true;
  }

  /** Вход через Device Code. emit('auth:code', {...}) отдаёт код пользователю. */
  async loginMicrosoft(emit) {
    if (this.pending) throw new AuthError('Вход уже выполняется');
    const clientId = this._clientId();
    const ctl = { cancelled: false };
    this.pending = ctl;
    try {
      const dev = await formPost(MS_DEVICE, { client_id: clientId, scope: SCOPE });
      if (dev.error) throw new AuthError(`Microsoft: ${dev.error_description || dev.error}`);
      emit('auth:code', { userCode: dev.user_code, verificationUri: dev.verification_uri, expiresIn: dev.expires_in });

      const deadline = Date.now() + dev.expires_in * 1000;
      let interval = (dev.interval || 5) * 1000;
      let tok = null;
      while (Date.now() < deadline) {
        await sleep(interval);
        if (ctl.cancelled) throw new AuthError('Вход отменён');
        const r = await formPost(MS_TOKEN, {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: clientId,
          device_code: dev.device_code,
        });
        if (r.access_token) {
          tok = r;
          break;
        }
        if (r.error === 'authorization_pending') continue;
        if (r.error === 'slow_down') {
          interval += 5000;
          continue;
        }
        throw new AuthError(`Microsoft: ${r.error_description || r.error}`);
      }
      if (!tok) throw new AuthError('Время ожидания входа истекло');

      const mc = await msToMinecraft(tok.access_token);
      const d = this.store.data;
      let acc = d.accounts.find((a) => a.type === 'msa' && a.uuid === mc.profile.id);
      if (!acc) {
        acc = { id: crypto.randomUUID(), type: 'msa', uuid: mc.profile.id, name: mc.profile.name };
        d.accounts.push(acc);
      }
      acc.name = mc.profile.name;
      acc.refreshToken = seal(tok.refresh_token);
      d.active = acc.id;
      this.store.save();
      this.cache.set(acc.id, { token: mc.token, expiresAt: mc.expiresAt });
      return this._pub(acc);
    } finally {
      this.pending = null;
    }
  }

  /** Возвращает объект authorization для minecraft-launcher-core. */
  async getAuthorization(accountId) {
    const acc = this.store.data.accounts.find((a) => a.id === accountId);
    if (!acc) throw new AuthError('Аккаунт не найден');
    if (acc.type === 'offline') {
      const authorization = offlineAuthorization(acc.name, this.store.data.clientToken);
      if (acc.uuid !== authorization.uuid) {
        acc.uuid = authorization.uuid;
        this.store.save();
      }
      return authorization;
    }

    const cached = this.cache.get(acc.id);
    let mcToken;
    if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) {
      mcToken = cached.token;
    } else {
      const tok = await formPost(MS_TOKEN, {
        client_id: this._clientId(),
        grant_type: 'refresh_token',
        refresh_token: unseal(acc.refreshToken),
        scope: SCOPE,
      });
      if (!tok.access_token) {
        throw new AuthError(`Сессия истекла, войдите в аккаунт заново (${tok.error_description || tok.error || 'ошибка'})`.split('\r')[0]);
      }
      if (tok.refresh_token) {
        acc.refreshToken = seal(tok.refresh_token);
        this.store.save();
      }
      const mc = await msToMinecraft(tok.access_token);
      this.cache.set(acc.id, { token: mc.token, expiresAt: mc.expiresAt });
      mcToken = mc.token;
    }
    return {
      access_token: mcToken,
      client_token: this.store.data.clientToken,
      uuid: acc.uuid,
      name: acc.name,
      user_properties: '{}',
      meta: { type: 'msa', demo: false },
    };
  }
}

module.exports = { AuthService, AuthError, offlineUuid, offlineAuthorization };
