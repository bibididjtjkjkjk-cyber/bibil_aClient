'use strict';
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { JsonStore } = require('../store');
const log = require('../logger');

const LOADERS = ['vanilla', 'fabric'];

const optInt = (v, lo, hi) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
};
const optStr = (v, max) => (v === null || v === undefined ? null : String(v).trim().slice(0, max));

function normalize(input, base = {}) {
  const d = { ...base, ...input };
  const name = String(d.name ?? '').trim().slice(0, 40);
  if (!name) throw new Error('Укажите название профиля');
  const version = String(d.version ?? '').trim();
  if (!/^[\w.+\- ]{1,64}$/.test(version)) throw new Error('Выберите версию Minecraft');
  const loader = LOADERS.includes(d.loader) ? d.loader : 'vanilla';
  return {
    id: base.id,
    name,
    version,
    loader,
    loaderVersion: loader === 'vanilla' ? '' : String(d.loaderVersion ?? '').trim().slice(0, 64),
    // null = использовать глобальные настройки
    ramMax: optInt(d.ramMax, 512, 65536),
    ramMin: optInt(d.ramMin, 128, 65536),
    javaPath: String(d.javaPath ?? '').trim().slice(0, 1000),
    jvmArgs: optStr(d.jvmArgs, 2000),
    created: base.created || Date.now(),
    lastPlayed: base.lastPlayed || 0,
    playTimeMs: base.playTimeMs || 0,
  };
}

class ProfileService {
  constructor(file, paths, settings) {
    this.store = new JsonStore(file, { profiles: [] }, log);
    this.paths = paths;
    this.settings = settings;
    if (!Array.isArray(this.store.data.profiles)) this.store.data.profiles = [];
  }

  list() {
    return JSON.parse(JSON.stringify(this.store.data.profiles));
  }

  get(id) {
    return this.list().find((p) => p.id === id) || null;
  }

  getActive() {
    const id = this.settings.get().state.activeProfile;
    return this.get(id) || this.list()[0] || null;
  }

  create(data) {
    const profile = normalize(data, { id: crypto.randomUUID() });
    this.store.data.profiles.push(profile);
    this.store.save();
    if (!this.get(this.settings.get().state.activeProfile)) {
      this.settings.update({ state: { activeProfile: profile.id } });
    }
    return profile;
  }

  update(id, data) {
    const idx = this.store.data.profiles.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error('Профиль не найден');
    const profile = normalize(data, this.store.data.profiles[idx]);
    this.store.data.profiles[idx] = profile;
    this.store.save();
    return profile;
  }

  async remove(id, { deleteFiles = false } = {}) {
    const idx = this.store.data.profiles.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error('Профиль не найден');
    this.store.data.profiles.splice(idx, 1);
    this.store.save();
    if (this.settings.get().state.activeProfile === id) {
      this.settings.update({ state: { activeProfile: this.store.data.profiles[0]?.id ?? null } });
    }
    if (deleteFiles) await fsp.rm(this.paths.instanceDir(id), { recursive: true, force: true });
  }

  async duplicate(id) {
    const src = this.get(id);
    if (!src) throw new Error('Профиль не найден');
    const copy = this.create({ ...src, name: `${src.name} (копия)`.slice(0, 40) });
    const from = this.paths.instanceDir(src.id);
    if (fs.existsSync(from)) await fsp.cp(from, this.paths.instanceDir(copy.id), { recursive: true });
    return copy;
  }

  touch(id, { playedMs = 0 } = {}) {
    const p = this.store.data.profiles.find((x) => x.id === id);
    if (!p) return;
    p.lastPlayed = Date.now();
    p.playTimeMs = (p.playTimeMs || 0) + Math.max(0, playedMs);
    this.store.save();
  }
}

module.exports = { ProfileService, normalize };
