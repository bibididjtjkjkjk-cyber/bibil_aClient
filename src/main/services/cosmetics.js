'use strict';
/** Косметика профілів: каталог із релізу + локальний вибір у cosmetics.json. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { JsonStore } = require('../store');
const { VERSION, ENV_UPDATE_URL } = require('../config');
const log = require('../logger');

const GITHUB_API = `https://api.github.com/repos/${process.env.BIBIL_GITHUB_OWNER || 'bibididjtjkjkjk-cyber'}/${process.env.BIBIL_GITHUB_REPO || 'bibil_aClient'}`;

const DEFAULTS = { enabled: true, active: {} };

function localize(value, locale) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value[locale] || value.ru || value.en || Object.values(value)[0] || '';
}

function normalizeCatalog(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.filter((x) => x && typeof x.id === 'string' && x.id.trim() && x.id.length <= 80).slice(0, 200).map((x) => ({
    id: x.id,
    type: ['cape', 'wings', 'effect', 'skin', 'accessory', 'preset'].includes(x.type) ? x.type : 'accessory',
    rarity: ['common', 'rare', 'epic', 'legendary'].includes(x.rarity) ? x.rarity : 'common',
    icon: String(x.icon || '✨').slice(0, 8),
    colors: Array.isArray(x.colors) ? x.colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 4) : [],
    name: x.name || String(x.id),
    description: x.description || '',
  }));
}

class CosmeticsService {
  constructor({ paths, settings, updater } = {}) {
    this.paths = paths;
    this.settings = settings;
    this.updater = updater;
    this.store = new JsonStore(path.join(paths.userData, 'cosmetics.json'), DEFAULTS, log);
    this.cache = path.join(paths.userData, 'cosmetics-remote.json');
    this.bundled = this._loadBundled();
    this.remote = this._loadCache();
  }

  _loadBundled() {
    try {
      const file = path.join(__dirname, '..', 'data', 'cosmetics.json');
      return normalizeCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      log.warn('[cosmetics] не вдалося завантажити вбудований каталог:', e.message);
      return [];
    }
  }

  _loadCache() {
    try {
      const data = JSON.parse(fs.readFileSync(this.cache, 'utf8'));
      return normalizeCatalog(data);
    } catch { return []; }
  }

  catalog() {
    const byId = new Map();
    for (const item of this.bundled) byId.set(item.id, item);
    for (const item of this.remote) byId.set(item.id, item); // реліз має пріоритет
    return [...byId.values()];
  }

  async refresh() {
    const feed = String(this.settings?.get?.()?.updater?.url || '').trim() || ENV_UPDATE_URL || '';
    const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN
      || this.settings?.get?.()?.updater?.githubToken || '').trim();
    const fetchJson = async (url) => {
      const headers = { 'User-Agent': `bibil-aClient/${VERSION} (cosmetics)`, Accept: 'application/json' };
      if (token && /api\.github\.com/i.test(url)) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    let found = null;
    try {
      const direct = this.updater?.candidate?.cosmetics;
      if (direct) found = await fetchJson(direct);
    } catch { /* fallback нижче */ }
    if (!found && feed) {
      try { found = await fetchJson(new URL('cosmetics.json', feed.replace(/\/+$/, '') + '/').toString()); }
      catch { /* fallback нижче */ }
    }
    if (!found) {
      try {
        const rel = await fetchJson(`${GITHUB_API}/releases/latest`);
        const asset = (rel.assets || []).find((a) => /^cosmetics\.json$/i.test(a.name));
        if (asset) found = await fetchJson(asset.browser_download_url);
      } catch (e) { log.warn('[cosmetics] каталог з релізу недоступний:', e.message); }
    }
    if (found) {
      const items = normalizeCatalog(found);
      if (items.length) {
        this.remote = items;
        await fsp.writeFile(this.cache, JSON.stringify({ version: found.version || 1, items }, null, 2));
      }
    }
    return { count: this.catalog().length, source: this.remote.length ? 'release' : 'bundled' };
  }

  list(profileId = null, locale = 'ru') {
    const active = this.active(profileId);
    const enabled = this.store.data.enabled !== false;
    return {
      enabled,
      profileId,
      source: this.remote.length ? 'release' : 'bundled',
      items: this.catalog().map((x) => ({
        ...x,
        name: localize(x.name, locale),
        description: localize(x.description, locale),
        active: enabled && active.includes(x.id),
      })),
      active,
    };
  }

  active(profileId) {
    const all = this.store.data.active || {};
    const ids = profileId ? all[profileId] : Object.values(all).flat();
    const valid = new Set(this.catalog().map((x) => x.id));
    return Array.isArray(ids) ? [...new Set(ids.filter((id) => valid.has(id)))].slice(0, 4) : [];
  }

  async setActive(profileId, ids) {
    if (!profileId || typeof profileId !== 'string') throw new Error('Профіль не знайдено');
    const valid = new Set(this.catalog().map((x) => x.id));
    const clean = [...new Set(Array.isArray(ids) ? ids.filter((id) => valid.has(id)).slice(0, 4) : [])];
    this.store.data.active = this.store.data.active || {};
    this.store.data.active[profileId] = clean;
    this.store.save();
    if (this.paths?.instanceDir) {
      try {
        const dir = this.paths.instanceDir(profileId);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, 'bibil-cosmetics.json'), JSON.stringify({
          version: 1, enabled: this.store.data.enabled !== false, active: clean,
          items: clean.map((id) => this.catalog().find((x) => x.id === id)),
        }, null, 2));
      } catch (e) {
        log.warn('[cosmetics] не вдалося записати конфіг профілю:', e.message);
      }
    }
    return this.list(profileId, this.settings?.get?.()?.launcher?.language || 'ru');
  }

  setEnabled(value) {
    this.store.data.enabled = !!value;
    this.store.save();
    return this.list(null, this.settings?.get?.()?.launcher?.language || 'ru');
  }
}

module.exports = { CosmeticsService, normalizeCatalog, localize };
