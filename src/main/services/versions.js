'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { getJson } = require('../util/http');
const { MOJANG_MANIFEST, FABRIC_META } = require('../config');
const log = require('../logger');
const os = require('os');

const TTL = 60 * 60 * 1000;
const enc = encodeURIComponent;
const VERSION_ID = /^[\w.+\- ]{1,64}$/;

/** Запасная эвристика требуемой Java, если метаданные недоступны. */
function guessJava(id) {
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(id);
  if (!m) return 21; // снапшоты нового формата (26.x и т.п.)
  const minor = +m[1];
  const patch = +(m[2] || 0);
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

/** Імена ОС у метаданих Mojang відрізняються від process.platform. */
function osName() {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
}

function versionInRange(release, range) {
  if (!range) return true;
  const a = String(release).split('.').map(Number);
  const cmp = (b) => {
    const c = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, c.length); i++) {
      const d = (a[i] || 0) - (c[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  };
  if (range.min && cmp(range.min) < 0) return false;
  if (range.max && cmp(range.max) > 0) return false;
  return true;
}

function ruleAllowed(rule) {
  const cond = rule?.os;
  if (!cond) return true;
  if (cond.name && cond.name !== osName()) return false;
  const range = cond.versionRange || cond.version; // Mojang використовує versionRange
  if (range && !versionInRange(os.release(), range)) return false;
  return true;
}

function rulesAllowed(rules) {
  if (!Array.isArray(rules)) return true; // відсутні rules = завжди дозволено
  let allow = false; // за замовчуванням заборонено, останнє спрацьоване правило вирішує
  for (const r of rules) if (ruleAllowed(r)) allow = r.action === 'allow';
  return allow;
}

/**
 * Довідковий парсер JVM-прапорців з arguments.default-user-jvm (наявні з MC 26.x).
 * minecraft-launcher-core 3.x це поле не читає. НЕ застосовуємо їх при запуску:
 * на Java 25 + LWJGL 3.4.3 вони викликали native-краш 0xC0000005 (див. launcher.js).
 */
function defaultJvmArgsFromMeta(meta) {
  const list = meta?.arguments?.['default-user-jvm'];
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || !rulesAllowed(entry.rules)) continue;
    const values = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const v of values) {
      if (typeof v !== 'string' || !v) continue;
      // Пам'ять задаємо самі (з урахуванням налаштувань користувача).
      if (/^-Xm[xs]/i.test(v)) continue;
      out.push(v);
    }
  }
  return out;
}

class VersionService {
  constructor(paths) {
    this.paths = paths;
  }

  async _cached(file, fetcher, { ttl = TTL, force = false } = {}) {
    let cached = null;
    try {
      cached = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      /* нет кэша */
    }
    if (!force && cached && Date.now() - cached.fetchedAt < ttl) return cached.data;
    try {
      const data = await fetcher();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify({ fetchedAt: Date.now(), data }));
      return data;
    } catch (e) {
      if (cached) {
        log.warn(`Используется устаревший кэш ${path.basename(file)}: ${e.message}`);
        return cached.data;
      }
      throw e;
    }
  }

  getManifest(force = false) {
    return this._cached(path.join(this.paths.cache, 'version_manifest.json'), () => getJson(MOJANG_MANIFEST), { force });
  }

  async list({ snapshots = false } = {}) {
    const m = await this.getManifest();
    return m.versions
      .filter((v) => v.type === 'release' || (snapshots && v.type === 'snapshot'))
      .map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
  }

  async getType(id) {
    try {
      const m = await this.getManifest();
      return m.versions.find((v) => v.id === id)?.type === 'snapshot' ? 'snapshot' : 'release';
    } catch {
      return 'release';
    }
  }

  async getMeta(id) {
    if (!VERSION_ID.test(id)) throw new Error('Некорректная версия');
    const m = await this.getManifest();
    const entry = m.versions.find((v) => v.id === id);
    if (!entry) throw new Error(`Версия ${id} не найдена в манифесте Mojang`);
    return this._cached(path.join(this.paths.cache, 'meta', `${id}.json`), () => getJson(entry.url), { ttl: 30 * 24 * 3600e3 });
  }

  async requiredJava(id) {
    try {
      const meta = await this.getMeta(id);
      return meta.javaVersion?.majorVersion || 8;
    } catch (e) {
      log.warn(`Не удалось определить Java для ${id}, используется эвристика: ${e.message}`);
      return guessJava(id);
    }
  }

  /** Довідково: прапорці JVM з метаданих версії (не застосовуються при запуску). */
  async defaultJvmArgs(id) {
    try {
      return defaultJvmArgsFromMeta(await this.getMeta(id));
    } catch {
      return [];
    }
  }

  // ---------------- Fabric ----------------

  async fabricLoaders(mc) {
    if (!VERSION_ID.test(mc)) throw new Error('Некорректная версия');
    const list = await getJson(`${FABRIC_META}/versions/loader/${enc(mc)}`);
    return list.map((e) => ({ version: e.loader.version, stable: !!e.loader.stable }));
  }

  /** Скачивает профиль Fabric и кладёт его в versions/. Возвращает id версии для запуска. */
  async installFabric(mc, loaderVersion) {
    let loader = loaderVersion;
    if (!loader) {
      const loaders = await this.fabricLoaders(mc);
      const pick = loaders.find((l) => l.stable) || loaders[0];
      if (!pick) throw new Error(`Fabric пока не поддерживает Minecraft ${mc}`);
      loader = pick.version;
    }
    const json = await getJson(`${FABRIC_META}/versions/loader/${enc(mc)}/${enc(loader)}/profile/json`);
    const id = json.id;
    if (!VERSION_ID.test(id)) throw new Error('Fabric вернул некорректный идентификатор версии');
    const dir = path.join(this.paths.root, 'versions', id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify(json, null, 2));
    return id;
  }
}

module.exports = { VersionService, guessJava, defaultJvmArgsFromMeta, rulesAllowed, versionInRange };
