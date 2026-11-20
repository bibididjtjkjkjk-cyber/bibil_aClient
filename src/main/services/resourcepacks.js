'use strict';
/**
 * Ресурспаки профиля. Лежат в instances/<id>/resourcepacks, НЕ в mods —
 * иначе Minecraft пытается грузить архив как мод и вылетает.
 */
const fsp = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
const { downloadFile, hashFile } = require('../util/http');
const { readZipEntry } = require('../util/zip');
const { pickBestVersion } = require('./modrinth');
const log = require('../logger');

const DISABLED = '.disabled';

/** pack_format по версиям Minecraft (для предупреждения о несовместимости). */
const PACK_FORMATS = [
  [[1, 6, 1], [1, 8, 99], 1], [[1, 9, 0], [1, 10, 99], 2], [[1, 11, 0], [1, 12, 99], 3],
  [[1, 13, 0], [1, 14, 99], 4], [[1, 15, 0], [1, 16, 1], 5], [[1, 16, 2], [1, 16, 99], 6],
  [[1, 17, 0], [1, 17, 99], 7], [[1, 18, 0], [1, 18, 1], 8], [[1, 18, 2], [1, 19, 2], 9],
  [[1, 19, 3], [1, 19, 3], 12], [[1, 19, 4], [1, 19, 9], 13],
  [[1, 20, 0], [1, 20, 1], 15], [[1, 20, 2], [1, 20, 2], 18], [[1, 20, 3], [1, 20, 4], 22],
  [[1, 20, 5], [1, 20, 9], 32], [[1, 21, 0], [1, 21, 1], 34], [[1, 21, 2], [1, 21, 3], 42],
  [[1, 21, 4], [1, 21, 4], 46], [[1, 21, 5], [1, 21, 5], 55], [[1, 21, 6], [1, 21, 6], 63],
  [[1, 21, 7], [1, 21, 8], 64], [[1, 21, 9], [1, 21, 10], 69], [[1, 21, 11], [1, 21, 99], 75],
  [[26, 1, 0], [26, 1, 99], 84], [[26, 2, 0], [26, 2, 99], 88], [[26, 3, 0], [26, 3, 99], 97],
];

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function packFormatFor(version) {
  const v = parseVersion(version);
  if (!v) return null;
  for (const [lo, hi, format] of PACK_FORMATS) if (cmp(v, lo) >= 0 && cmp(v, hi) <= 0) return format;
  return null;
}

class ResourcePackManager extends EventEmitter {
  constructor({ paths, profiles, modrinth }) {
    super();
    this.paths = paths;
    this.profiles = profiles;
    this.modrinth = modrinth;
    this.locks = new Map();
  }

  _profile(id) {
    const p = this.profiles.get(id);
    if (!p) throw new Error('Профиль не найден');
    return p;
  }
  _dir(p) { return path.join(this.paths.instanceDir(p.id), 'resourcepacks'); }
  _metaFile(p) { return path.join(this.paths.instanceDir(p.id), 'bibil-resourcepacks.json'); }

  async _loadMeta(p) {
    try {
      const m = JSON.parse(await fsp.readFile(this._metaFile(p), 'utf8'));
      if (m && typeof m.files === 'object') return m;
    } catch { /* нет или повреждён */ }
    return { files: {} };
  }
  async _saveMeta(p, meta) {
    await fsp.mkdir(path.dirname(this._metaFile(p)), { recursive: true });
    const tmp = this._metaFile(p) + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(meta, null, 2));
    await fsp.rename(tmp, this._metaFile(p));
  }
  _lock(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(id, next);
    return next;
  }
  _safeName(name) {
    const base = path.basename(String(name));
    if (!/^[^\\/:*?"<>|]+\.zip(\.disabled)?$/i.test(base)) throw new Error(`Недопустимое имя ресурспака: ${base}`);
    return base;
  }
  async _resolve(p, base) {
    for (const n of [base, base + DISABLED]) {
      const full = path.join(this._dir(p), n);
      try { await fsp.access(full); return { full, enabled: n === base }; } catch { /* следующий */ }
    }
    throw new Error('Файл ресурспака не найден');
  }

  list(profileId) { return this._lock(profileId, () => this._list(profileId)); }

  async _list(profileId) {
    const p = this._profile(profileId);
    const dir = this._dir(p);
    await fsp.mkdir(dir, { recursive: true });
    const meta = await this._loadMeta(p);
    const names = (await fsp.readdir(dir)).filter((n) => /\.zip(\.disabled)?$/i.test(n));
    const expected = packFormatFor(p.version);
    const rows = [];
    const toIdentify = [];

    for (const n of names) {
      const base = n.endsWith(DISABLED) ? n.slice(0, -DISABLED.length) : n;
      const full = path.join(dir, n);
      const st = await fsp.stat(full);
      const known = meta.files[base] || {};
      let title = known.title || base;
      let packFormat = null;
      let error = '';
      try {
        const raw = await readZipEntry(full, 'pack.mcmeta');
        if (raw == null) error = 'В архиве нет pack.mcmeta';
        else {
          const mm = JSON.parse(raw);
          const pf = mm.pack?.pack_format;
          packFormat = typeof pf === 'number' ? pf : (pf?.min_inclusive ?? null);
          const d = mm.pack?.description;
          const text = typeof d === 'string' ? d : d?.text || d?.translate;
          if (typeof text === 'string' && text.trim()) title = text.replace(/§./g, '').trim().slice(0, 120);
        }
      } catch (e) { error = e.message || 'Повреждённый архив'; }
      const compatible = expected == null || packFormat == null ? null : expected === packFormat;
      let reason = error;
      if (!error && compatible === false) reason = `Пак рассчитан на pack_format ${packFormat}, а Minecraft ${p.version} использует ${expected}.`;
      if (!known.title || known.unchecked) {
        meta.files[base] = { ...known, sha1: known.sha1 || (await hashFile(full, 'sha1')), size: st.size, title, unchecked: true };
        toIdentify.push(base);
      }
      rows.push({ fileName: base, enabled: n === base, size: st.size, title, packFormat, expectedFormat: expected, compatible, reason, projectId: known.projectId || null, versionNumber: known.versionNumber || null, icon: known.icon || null });
    }

    for (const k of Object.keys(meta.files)) if (!names.includes(k) && !names.includes(k + DISABLED)) delete meta.files[k];

    if (toIdentify.length) {
      try {
        const map = await this.modrinth.versionsByHashes(toIdentify.map((b) => meta.files[b].sha1));
        const ids = [...new Set(Object.values(map).map((v) => v.project_id))];
        const projects = ids.length ? await this.modrinth.projects(ids) : [];
        const pm = new Map(projects.map((x) => [x.id, x]));
        for (const b of toIdentify) {
          const entry = meta.files[b];
          const v = map[entry.sha1];
          delete entry.unchecked;
          if (v) Object.assign(entry, { projectId: v.project_id, versionId: v.id, versionNumber: v.version_number, icon: pm.get(v.project_id)?.icon_url || null });
        }
      } catch (e) { log.warn(`Не удалось опознать ресурспаки: ${e.message}`); }
    }
    await this._saveMeta(p, meta);
    for (const r of rows) {
      const m = meta.files[r.fileName] || {};
      r.projectId = m.projectId || null;
      r.versionNumber = m.versionNumber || null;
      r.icon = m.icon || null;
    }
    return rows.sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Добавляет локальные ZIP-ресурспаки, проверяя pack.mcmeta, дубликаты и формат версии. */
  addLocal(profileId, files) {
    return this._lock(profileId, () => this._addLocal(profileId, files));
  }

  async _addLocal(profileId, files) {
    const p = this._profile(profileId);
    const dir = this._dir(p);
    await fsp.mkdir(dir, { recursive: true });
    await this._list(profileId);
    const meta = await this._loadMeta(p);
    const result = { added: [], skipped: [], conflicts: [] };
    const expected = packFormatFor(p.version);
    const seen = new Set();

    for (const raw of (Array.isArray(files) ? files : []).map((f) => String(f)).slice(0, 50)) {
      let base;
      try {
        base = this._safeName(raw).replace(/\.disabled$/i, '');
      } catch (e) {
        result.skipped.push({ fileName: path.basename(raw), reason: e.message });
        continue;
      }
      if (seen.has(base)) continue;
      seen.add(base);
      let st;
      try {
        st = await fsp.stat(raw);
      } catch {
        result.skipped.push({ fileName: base, reason: 'Файл не найден' });
        continue;
      }
      if (!st.isFile() || st.size > 500 * 1024 * 1024) {
        result.skipped.push({ fileName: base, reason: 'Некорректный или слишком большой файл' });
        continue;
      }
      let rawMcmeta;
      try {
        rawMcmeta = await readZipEntry(raw, 'pack.mcmeta');
      } catch {
        result.skipped.push({ fileName: base, reason: 'Повреждённый ZIP-архив' });
        continue;
      }
      if (rawMcmeta == null) {
        result.skipped.push({ fileName: base, reason: 'В архиве нет pack.mcmeta — это не ресурспак' });
        continue;
      }
      let title = base;
      let packFormat = null;
      try {
        const mm = JSON.parse(rawMcmeta);
        const pf = mm.pack?.pack_format;
        packFormat = typeof pf === 'number' ? pf : (pf?.min_inclusive ?? null);
        const d = mm.pack?.description;
        const text = typeof d === 'string' ? d : (d?.text || d?.translate);
        if (typeof text === 'string' && text.trim()) title = text.replace(/§./g, '').trim().slice(0, 120);
      } catch { /* метаданные не критичны */ }
      const sha1 = await hashFile(raw, 'sha1');
      const duplicate = Object.entries(meta.files).find(([, m]) => m.sha1 === sha1);
      if (duplicate) {
        result.skipped.push({ fileName: base, reason: `Дубликат ресурспака: ${duplicate[0]}` });
        continue;
      }
      const dest = path.join(dir, base);
      let exists = false;
      for (const candidate of [dest, dest + DISABLED]) {
        try { await fsp.access(candidate); exists = true; } catch { /* нет файла */ }
      }
      if (exists) {
        result.skipped.push({ fileName: base, reason: 'Файл уже есть в папке ресурспаков' });
        continue;
      }
      await fsp.copyFile(raw, dest);
      meta.files[base] = { sha1, size: st.size, title, unchecked: true };
      result.added.push(base);
      if (expected != null && packFormat != null && expected !== packFormat) {
        result.conflicts.push({ fileName: base, reason: `pack_format ${packFormat} не подходит для Minecraft ${p.version} (ожидается ${expected})` });
      }
    }
    if (result.added.length) await this._saveMeta(p, meta);
    return result;
  }

  install(profileId, projectId, versionId) { return this._lock(profileId, () => this._install(profileId, projectId, versionId)); }

  async _install(profileId, projectId, versionId) {
    const p = this._profile(profileId);
    const meta = await this._loadMeta(p);
    if (Object.values(meta.files).some((m) => m.projectId === projectId)) throw new Error('Этот ресурспак уже установлен');
    const version = versionId ? await this.modrinth.getVersion(versionId)
      : pickBestVersion(await this.modrinth.projectVersions(projectId, { gameVersions: [p.version] }));
    if (!version) throw new Error(`Для Minecraft ${p.version} нет подходящей версии ресурспака`);
    const file = version.files.find((f) => f.primary) || version.files.find((f) => /\.zip$/i.test(f.filename)) || version.files[0];
    if (!file) throw new Error('У версии ресурспака нет файлов для загрузки');
    let name = this._safeName(file.filename.replace(/\.disabled$/i, ''));
    if (!/\.zip$/i.test(name)) name += '.zip';
    const dest = path.join(this._dir(p), name);
    await downloadFile(file.url, dest, {
      sha1: file.hashes?.sha1, sha512: file.hashes?.sha512,
      onProgress: (done, total) => this.emit('progress', { name, done, total }),
    });
    if (await readZipEntry(dest, 'pack.mcmeta').catch(() => null) == null) {
      await fsp.rm(dest, { force: true });
      throw new Error('Файл не является корректным ресурспаком (нет pack.mcmeta)');
    }
    const st = await fsp.stat(dest);
    const entry = { sha1: file.hashes?.sha1 || (await hashFile(dest, 'sha1')), size: st.size, projectId: version.project_id, versionId: version.id, versionNumber: version.version_number, title: name, icon: null };
    meta.files[name] = entry;
    await this._saveMeta(p, meta);
    try {
      const project = await this.modrinth.project(projectId);
      entry.title = project.title;
      entry.icon = project.iconUrl || null;
      await this._saveMeta(p, meta);
    } catch { /* иконка не критична */ }
    return { fileName: name, title: entry.title };
  }

  toggle(profileId, fileName, enabled) {
    return this._lock(profileId, async () => {
      const p = this._profile(profileId);
      const base = this._safeName(fileName).replace(/\.disabled$/i, '');
      const { full, enabled: cur } = await this._resolve(p, base);
      if (cur === !!enabled) return;
      await fsp.rename(full, enabled ? full.slice(0, -DISABLED.length) : full + DISABLED);
    });
  }

  remove(profileId, fileName) {
    return this._lock(profileId, async () => {
      const p = this._profile(profileId);
      const base = this._safeName(fileName).replace(/\.disabled$/i, '');
      const { full } = await this._resolve(p, base);
      await fsp.rm(full, { force: true });
      const meta = await this._loadMeta(p);
      delete meta.files[base];
      await this._saveMeta(p, meta);
    });
  }
}

module.exports = { ResourcePackManager, packFormatFor, PACK_FORMATS };
