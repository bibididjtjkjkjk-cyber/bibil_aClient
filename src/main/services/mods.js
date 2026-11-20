'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const EventEmitter = require('events');
const { hashFile, downloadFile } = require('../util/http');
const { pickBestVersion } = require('./modrinth');
const log = require('../logger');

const DISABLED = '.disabled';
const PERFORMANCE_MODS = [
  { id: 'AANobbMI', title: 'Sodium' },
  { id: 'gvQqBUqZ', title: 'Lithium' },
  { id: 'uXXizFIs', title: 'FerriteCore' },
  { id: '5ZwdcRci', title: 'ImmediatelyFast' },
  { id: 'NNAgCjsB', title: 'Entity Culling' },
];

/** Управление модами профиля (Fabric) через Modrinth. Метаданные — instances/<id>/bibil-mods.json. */
class ModManager extends EventEmitter {
  constructor({ paths, profiles, modrinth }) {
    super();
    this.paths = paths;
    this.profiles = profiles;
    this.modrinth = modrinth;
    this.locks = new Map();
  }

  // ---------- вспомогательное ----------

  _profile(id) {
    const p = this.profiles.get(id);
    if (!p) throw new Error('Профиль не найден');
    return p;
  }

  _ctx(p) {
    if (p.loader !== 'fabric') {
      throw new Error('Моды доступны только для профилей с Fabric. Измените загрузчик профиля.');
    }
    return { loaders: ['fabric'], gameVersions: [p.version] };
  }

  _dir(p) {
    return path.join(this.paths.instanceDir(p.id), 'mods');
  }

  _metaFile(p) {
    return path.join(this.paths.instanceDir(p.id), 'bibil-mods.json');
  }

  async _loadMeta(p) {
    try {
      const m = JSON.parse(await fsp.readFile(this._metaFile(p), 'utf8'));
      if (m && typeof m.files === 'object') return m;
    } catch {
      /* нет или повреждён — создаём заново */
    }
    return { files: {} };
  }

  async _saveMeta(p, meta) {
    await fsp.mkdir(path.dirname(this._metaFile(p)), { recursive: true });
    const tmp = this._metaFile(p) + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(meta, null, 2));
    await fsp.rename(tmp, this._metaFile(p));
  }

  /** Последовательное выполнение операций над одним профилем. */
  _lock(profileId, fn) {
    const prev = this.locks.get(profileId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(profileId, next);
    return next;
  }

  _safeName(name) {
    const base = path.basename(String(name));
    if (!/^[^\\/:*?"<>|]+\.jar$/i.test(base)) throw new Error(`Недопустимое имя файла мода: ${base}`);
    return base;
  }

  _baseOf(fileName) {
    return fileName.endsWith(DISABLED) ? fileName.slice(0, -DISABLED.length) : fileName;
  }

  async _resolveFile(p, base) {
    const dir = this._dir(p);
    for (const n of [base, base + DISABLED]) {
      const full = path.join(dir, n);
      try {
        await fsp.access(full);
        return { full, enabled: n === base };
      } catch {
        /* следующий вариант */
      }
    }
    throw new Error('Файл мода не найден');
  }

  // ---------- публичный API ----------

  /** Список установленных модов; неизвестные файлы опознаются по хэшу через Modrinth. */
  list(profileId) {
    return this._lock(profileId, () => this._list(profileId));
  }

  async _list(profileId) {
    const p = this._profile(profileId);
    const dir = this._dir(p);
    await fsp.mkdir(dir, { recursive: true });
    const meta = await this._loadMeta(p);
    const names = (await fsp.readdir(dir)).filter((n) => /\.jar(\.disabled)?$/i.test(n));

    const toIdentify = [];
    const rows = [];
    for (const n of names) {
      const base = this._baseOf(n);
      const st = await fsp.stat(path.join(dir, n));
      let m = meta.files[base];
      if (!m || m.size !== st.size || m.unchecked) {
        const sha1 = await hashFile(path.join(dir, n), 'sha1');
        m = meta.files[base] = { sha1, size: st.size, title: base, unknown: true, unchecked: true };
        toIdentify.push(base);
      }
      rows.push({ base, enabled: n === base, size: st.size });
    }
    for (const k of Object.keys(meta.files)) {
      if (!names.includes(k) && !names.includes(k + DISABLED)) delete meta.files[k];
    }

    if (toIdentify.length) {
      try {
        const map = await this.modrinth.versionsByHashes(toIdentify.map((b) => meta.files[b].sha1));
        const ids = [...new Set(Object.values(map).map((v) => v.project_id))];
        const projects = await this.modrinth.projects(ids);
        const pm = new Map(projects.map((x) => [x.id, x]));
        for (const b of toIdentify) {
          const entry = meta.files[b];
          const v = map[entry.sha1];
          delete entry.unchecked;
          if (v) {
            const pr = pm.get(v.project_id);
            Object.assign(entry, {
              projectId: v.project_id,
              versionId: v.id,
              versionNumber: v.version_number,
              title: pr?.title || b,
              icon: pr?.icon_url || null,
              unknown: false,
            });
          }
        }
      } catch (e) {
        log.warn(`Не удалось опознать моды через Modrinth: ${e.message}`);
      }
    }
    await this._saveMeta(p, meta);

    return rows
      .map((r) => {
        const m = meta.files[r.base];
        return {
          fileName: r.base,
          enabled: r.enabled,
          size: r.size,
          title: m.title,
          icon: m.icon || null,
          projectId: m.projectId || null,
          versionNumber: m.versionNumber || null,
          known: !m.unknown,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Устанавливает мод (и обязательные зависимости) в профиль. */
  install(profileId, projectId, versionId) {
    return this._lock(profileId, () => this._install(profileId, projectId, versionId));
  }

  async _install(profileId, projectId, versionId) {
    const p = this._profile(profileId);
    const ctx = this._ctx(p);
    const meta = await this._loadMeta(p);
    const installedProjects = new Set(Object.values(meta.files).map((m) => m.projectId).filter(Boolean));
    if (installedProjects.has(projectId)) throw new Error('Этот мод уже установлен');

    const queue = [{ projectId, versionId, dependency: false }];
    const seen = new Set();
    const installed = [];

    while (queue.length) {
      const item = queue.shift();
      if (seen.has(item.projectId) || (item.dependency && installedProjects.has(item.projectId))) continue;
      seen.add(item.projectId);

      let version;
      if (item.versionId) version = await this.modrinth.getVersion(item.versionId);
      else version = pickBestVersion(await this.modrinth.projectVersions(item.projectId, ctx));
      if (!version) {
        throw new Error(
          item.dependency
            ? `Обязательная зависимость недоступна для Minecraft ${p.version} / Fabric`
            : `Для Minecraft ${p.version} и Fabric нет подходящей версии этого мода`
        );
      }

      const file = version.files.find((f) => f.primary) || version.files[0];
      if (!file) throw new Error('У версии нет файлов для загрузки');
      const name = this._safeName(file.filename);
      for (const candidate of [name, name + DISABLED]) {
        try {
          await fsp.access(path.join(this._dir(p), candidate));
          throw new Error(`Файл ${candidate} уже существует в папке модов`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }

      const entry = await this._downloadVersion(p, version);
      meta.files[entry.base] = entry.meta;
      installed.push(entry.base);
      await this._saveMeta(p, meta); // сохраняем после каждого файла

      for (const dep of version.dependencies || []) {
        if (dep.dependency_type === 'required' && dep.project_id) {
          queue.push({ projectId: dep.project_id, versionId: dep.version_id || undefined, dependency: true });
        }
      }
    }

    // Подтягиваем названия и иконки проектов одним запросом.
    try {
      const ids = installed.map((b) => meta.files[b].projectId);
      const projects = await this.modrinth.projects(ids);
      for (const pr of projects) {
        for (const b of installed) {
          if (meta.files[b].projectId === pr.id) Object.assign(meta.files[b], { title: pr.title, icon: pr.icon_url || null });
        }
      }
      await this._saveMeta(p, meta);
    } catch (e) {
      log.warn(`Не удалось получить данные проектов: ${e.message}`);
    }
    return installed.map((b) => ({ fileName: b, title: meta.files[b].title }));
  }

  /** Добавляет локальные JAR-файлы в профиль; проверяет дубликаты и совместимость через Modrinth. */
  addLocal(profileId, files) {
    return this._lock(profileId, () => this._addLocal(profileId, files));
  }

  async _addLocal(profileId, files) {
    const p = this._profile(profileId);
    const ctx = this._ctx(p);
    const dir = this._dir(p);
    await fsp.mkdir(dir, { recursive: true });
    await this._list(profileId);
    const meta = await this._loadMeta(p);
    const result = { added: [], skipped: [], conflicts: [] };
    const seen = new Set();
    const sources = (Array.isArray(files) ? files : []).map((f) => String(f)).filter(Boolean).slice(0, 50);

    for (const src of sources) {
      let base;
      try {
        base = this._safeName(src);
      } catch (e) {
        result.skipped.push({ fileName: path.basename(String(src)), reason: e.message });
        continue;
      }
      if (seen.has(base)) continue;
      seen.add(base);
      let st;
      try {
        st = await fsp.stat(src);
      } catch {
        result.skipped.push({ fileName: base, reason: 'Файл не найден' });
        continue;
      }
      if (!st.isFile()) {
        result.skipped.push({ fileName: base, reason: 'Это не файл' });
        continue;
      }
      if (st.size > 200 * 1024 * 1024) {
        result.skipped.push({ fileName: base, reason: 'Файл слишком большой (более 200 МБ)' });
        continue;
      }
      const sha1 = await hashFile(src, 'sha1');
      const duplicate = Object.entries(meta.files).find(([, m]) => m.sha1 === sha1);
      if (duplicate) {
        result.skipped.push({ fileName: base, reason: `Дубликат мода: ${duplicate[0]}` });
        continue;
      }
      const dest = path.join(dir, base);
      let exists = false;
      for (const candidate of [dest, dest + DISABLED]) {
        try {
          await fsp.access(candidate);
          exists = true;
        } catch { /* нет файла */ }
      }
      if (exists) {
        result.skipped.push({ fileName: base, reason: 'Файл уже есть в папке модов' });
        continue;
      }
      await fsp.copyFile(src, dest);
      meta.files[base] = { sha1, size: st.size, title: base, unknown: true, unchecked: true, local: true };
      result.added.push(base);
    }
    if (result.added.length) await this._saveMeta(p, meta);

    if (result.added.length) {
      try {
        const hashes = result.added.map((b) => meta.files[b].sha1).filter(Boolean);
        const map = hashes.length ? await this.modrinth.versionsByHashes(hashes) : {};
        const ids = [...new Set(Object.values(map).map((v) => v.project_id))];
        const projects = ids.length ? await this.modrinth.projects(ids) : [];
        const byId = new Map(projects.map((x) => [x.id, x]));
        const installedProjects = new Map();
        for (const [base, m] of Object.entries(meta.files)) if (m.projectId) installedProjects.set(m.projectId, base);
        for (const base of result.added) {
          const entry = meta.files[base];
          const version = map[entry.sha1];
          if (!version) continue;
          const project = byId.get(version.project_id);
          Object.assign(entry, {
            projectId: version.project_id,
            versionId: version.id,
            versionNumber: version.version_number,
            title: project?.title || base,
            icon: project?.icon_url || null,
            unknown: false,
          });
          delete entry.unchecked;
          const gameOk = !version.game_versions?.length || version.game_versions.includes(p.version);
          const loaderOk = !version.loaders?.length || version.loaders.some((l) => ctx.loaders.includes(l));
          if (!gameOk || !loaderOk) {
            result.conflicts.push({ fileName: base, reason: `Несовместим с Minecraft ${p.version} / ${ctx.loaders.join('/')}` });
          }
          const prev = installedProjects.get(version.project_id);
          if (prev && prev !== base) result.conflicts.push({ fileName: base, reason: `Дубликат проекта: ${prev}` });
          installedProjects.set(version.project_id, base);
        }
        await this._saveMeta(p, meta);
      } catch (e) {
        log.warn(`Не удалось проверить совместимость локальных модов: ${e.message}`);
      }
    }
    return result;
  }

  /** Устанавливает совместимые с версией игры Fabric-моды для производительности. */
  ensurePerformancePack(profileId) {
    return this._lock(profileId, () => this._ensurePerformancePack(profileId));
  }

  async _ensurePerformancePack(profileId) {
    const p = this._profile(profileId);
    const ctx = this._ctx(p);
    await this._list(profileId);

    const meta = await this._loadMeta(p);
    const installedProjects = new Set(Object.values(meta.files).map((m) => m.projectId).filter(Boolean));
    const installed = [];
    const skipped = [];

    for (const project of PERFORMANCE_MODS) {
      if (installedProjects.has(project.id)) continue;
      const versions = await this.modrinth.projectVersions(project.id, ctx);
      if (!versions.length) {
        skipped.push(project.title);
        continue;
      }
      const files = await this._install(profileId, project.id);
      installed.push(...files.map((file) => file.title));
      installedProjects.add(project.id);
    }

    return { installed, skipped };
  }

  async _downloadVersion(p, version) {
    const file = version.files.find((f) => f.primary) || version.files[0];
    if (!file) throw new Error('У версии нет файлов для загрузки');
    const name = this._safeName(file.filename);
    const dest = path.join(this._dir(p), name);
    await downloadFile(file.url, dest, {
      sha1: file.hashes?.sha1,
      sha512: file.hashes?.sha512,
      onProgress: (done, total) => this.emit('progress', { name, done, total }),
    });
    const st = await fsp.stat(dest);
    return {
      base: name,
      meta: {
        sha1: file.hashes?.sha1 || (await hashFile(dest, 'sha1')),
        size: st.size,
        projectId: version.project_id,
        versionId: version.id,
        versionNumber: version.version_number,
        title: name,
        icon: null,
        unknown: false,
      },
    };
  }

  remove(profileId, fileName) {
    return this._lock(profileId, async () => {
      const p = this._profile(profileId);
      const { full } = await this._resolveFile(p, this._safeName(fileName));
      await fsp.rm(full, { force: true });
      const meta = await this._loadMeta(p);
      delete meta.files[fileName];
      await this._saveMeta(p, meta);
    });
  }

  toggle(profileId, fileName, enabled) {
    return this._lock(profileId, async () => {
      const p = this._profile(profileId);
      const base = this._safeName(fileName);
      const { full, enabled: cur } = await this._resolveFile(p, base);
      if (cur === !!enabled) return;
      await fsp.rename(full, enabled ? full.slice(0, -DISABLED.length) : full + DISABLED);
    });
  }

  /** Проверяет обновления для опознанных модов. */
  checkUpdates(profileId) {
    return this._lock(profileId, async () => {
      const p = this._profile(profileId);
      const ctx = this._ctx(p);
      const meta = await this._loadMeta(p);
      const known = Object.entries(meta.files).filter(([, m]) => m.projectId && m.sha1);
      if (!known.length) return [];
      const map = await this.modrinth.latestByHashes(known.map(([, m]) => m.sha1), ctx);
      const out = [];
      for (const [base, m] of known) {
        const latest = map[m.sha1];
        if (latest && latest.id !== m.versionId) {
          out.push({ fileName: base, title: m.title, current: m.versionNumber, latest: latest.version_number, latestId: latest.id });
        }
      }
      return out;
    });
  }

  /** Заменяет мод на последнюю совместимую версию (сохраняя состояние вкл/выкл). */
  update(profileId, fileName) {
    return this._lock(profileId, async () => {
      const p = this._profile(profileId);
      const ctx = this._ctx(p);
      const meta = await this._loadMeta(p);
      const old = meta.files[fileName];
      if (!old?.projectId) throw new Error('Этот мод не связан с Modrinth — обновление недоступно');
      const { full: oldPath, enabled } = await this._resolveFile(p, this._safeName(fileName));

      const map = await this.modrinth.latestByHashes([old.sha1], ctx);
      const latest = map[old.sha1];
      if (!latest || latest.id === old.versionId) throw new Error('Установлена последняя версия');

      const entry = await this._downloadVersion(p, latest);
      entry.meta.title = old.title;
      entry.meta.icon = old.icon;
      if (entry.base !== fileName) {
        await fsp.rm(oldPath, { force: true });
        delete meta.files[fileName];
      }
      meta.files[entry.base] = entry.meta;
      if (!enabled) {
        const newPath = path.join(this._dir(p), entry.base);
        await fsp.rename(newPath, newPath + DISABLED);
      }
      await this._saveMeta(p, meta);
      return { fileName: entry.base, version: latest.version_number };
    });
  }
}

module.exports = { ModManager };
