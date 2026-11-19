'use strict';
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { JsonStore } = require('../store');
const log = require('../logger');

const MAX_SKIN_BYTES = 2 * 1024 * 1024;
const OFFICIAL_HOSTS = new Set(['api.mojang.com', 'sessionserver.mojang.com', 'textures.minecraft.net']);

function validatePng(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (b.length > MAX_SKIN_BYTES) throw new Error('PNG скина должен быть меньше 2 МБ');
  if (b.length < 33 || !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || b.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Выберите корректный PNG-файл скина');
  }
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (width !== 64 || ![32, 64].includes(height)) {
    throw new Error('Размер скина должен быть 64×64 или 64×32 пикселя');
  }
  return b;
}

function safeSkinName(value) {
  const name = String(value || '').trim().replace(/\.png$/i, '').slice(0, 48);
  if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('Введите корректное название скина');
  return name;
}

class SkinManager {
  constructor({ paths, auth, fetchImpl = globalThis.fetch }) {
    this.paths = paths;
    this.auth = auth;
    this.fetch = fetchImpl;
    this.dir = path.join(paths.config, 'skins');
    this.store = new JsonStore(path.join(paths.config, 'skins.json'), { skins: [] }, log);
    if (!Array.isArray(this.store.data.skins)) this.store.data.skins = [];
  }

  _file(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('Некорректный идентификатор скина');
    return path.join(this.dir, `${id}.png`);
  }

  async _save(data, name, model = 'classic') {
    const bytes = validatePng(data);
    const skin = {
      id: crypto.randomUUID(),
      name: safeSkinName(name),
      model: model === 'slim' ? 'slim' : 'classic',
      createdAt: Date.now(),
    };
    await fs.mkdir(this.dir, { recursive: true });
    const file = this._file(skin.id);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, bytes, { flag: 'wx' });
    try {
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
    this.store.data.skins.unshift(skin);
    try { this.store.save(); } catch (e) {
      this.store.data.skins = this.store.data.skins.filter((x) => x.id !== skin.id);
      await fs.rm(file, { force: true });
      throw e;
    }
    return skin;
  }

  async _fetch(url, { json = false } = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !OFFICIAL_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new Error('Разрешены только HTTPS-ссылки на официальные серверы Minecraft');
    }
    const response = await this.fetch(url, {
      headers: { Accept: json ? 'application/json' : 'image/png', 'User-Agent': 'bibil_aClient/skin-import' },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Сервер Minecraft вернул HTTP ${response.status}`);
    if (json) return response.json();
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    if (!type.includes('image/png')) throw new Error('Ссылка не ведёт на PNG-скин');
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_SKIN_BYTES) throw new Error('PNG скина должен быть меньше 2 МБ');
    return validatePng(Buffer.from(await response.arrayBuffer()));
  }

  async importFile(source, name, model = 'classic') {
    const skin = await this._save(await fs.readFile(source), name || path.basename(source, path.extname(source)), model);
    return skin;
  }

  async importUrl(url, name, model = 'classic') {
    const parsed = new URL(String(url || ''));
    if (parsed.hostname.toLowerCase() !== 'textures.minecraft.net') {
      throw new Error('Для импорта по URL используйте прямую ссылку textures.minecraft.net на PNG-скин');
    }
    const data = await this._fetch(parsed.toString());
    const skinName = name || decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || 'skin').slice(0, 48);
    return this._save(data, skinName, model);
  }

  async importNickname(nickname) {
    const name = String(nickname || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Ник должен содержать 3–16 латинских букв, цифр или _');
    const profile = await this._fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, { json: true });
    if (!/^[0-9a-f]{32}$/i.test(profile.id || '')) throw new Error('Профиль Minecraft не найден');
    const session = await this._fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${profile.id}`, { json: true });
    const encoded = session.properties?.find((p) => p.name === 'textures')?.value;
    if (!encoded) throw new Error('В профиле нет скина');
    let texture;
    try { texture = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); } catch { throw new Error('Не удалось прочитать данные скина профиля'); }
    const skinUrl = texture.textures?.SKIN?.url;
    if (!skinUrl) throw new Error('В профиле нет скина');
    const model = texture.textures.SKIN.metadata?.model === 'slim' ? 'slim' : 'classic';
    const image = await this._fetch(skinUrl);
    return this._save(image, name, model);
  }

  async replace(id, source, name, model) {
    const skin = this.store.data.skins.find((x) => x.id === id);
    if (!skin) throw new Error('Скин не найден');
    const bytes = validatePng(await fs.readFile(source));
    const previousBytes = await fs.readFile(this._file(id));
    const previousName = skin.name;
    const previousModel = skin.model;
    const nextName = name ? safeSkinName(name) : previousName;
    const nextModel = model === 'slim' ? 'slim' : 'classic';
    const temp = `${this._file(id)}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, bytes, { flag: 'wx' });
    try {
      await fs.rename(temp, this._file(id));
      skin.name = nextName;
      skin.model = nextModel;
      try {
        this.store.save();
      } catch (e) {
        skin.name = previousName;
        skin.model = previousModel;
        await fs.writeFile(this._file(id), previousBytes);
        throw e;
      }
    } finally {
      await fs.rm(temp, { force: true });
    }
    return skin;
  }

  async list() {
    const skins = [];
    for (const skin of this.store.data.skins) {
      try {
        const data = await fs.readFile(this._file(skin.id));
        skins.push({ ...skin, dataUrl: `data:image/png;base64,${data.toString('base64')}` });
      } catch (e) {
        log.warn(`Файл скина «${skin.name}» недоступен: ${e.message}`);
      }
    }
    return skins;
  }

  rename(id, name) {
    const skin = this.store.data.skins.find((x) => x.id === id);
    if (!skin) throw new Error('Скин не найден');
    skin.name = safeSkinName(name);
    this.store.save();
    return skin;
  }

  async remove(id) {
    const skin = this.store.data.skins.find((x) => x.id === id);
    if (!skin) throw new Error('Скин не найден');
    await fs.rm(this._file(id), { force: true });
    this.store.data.skins = this.store.data.skins.filter((x) => x.id !== id);
    this.store.save();
  }

  async apply(id, accountId) {
    const skin = this.store.data.skins.find((x) => x.id === id);
    if (!skin) throw new Error('Скин не найден');
    const authorization = await this.auth.getAuthorization(accountId);
    if (authorization.meta?.type !== 'msa') {
      throw new Error('Чтобы применить скин, войдите в лицензионный Microsoft-аккаунт');
    }
    const bytes = validatePng(await fs.readFile(this._file(id)));
    const form = new FormData();
    form.append('variant', skin.model);
    form.append('file', new Blob([bytes], { type: 'image/png' }), `${skin.name}.png`);
    const response = await this.fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authorization.access_token}` },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Не удалось применить скин (Minecraft Services: HTTP ${response.status})`);
    return true;
  }
}

module.exports = { SkinManager, validatePng, safeSkinName, MAX_SKIN_BYTES };
