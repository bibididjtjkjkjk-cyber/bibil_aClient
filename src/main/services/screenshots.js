'use strict';
const fs = require('fs').promises;
const path = require('path');

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _().-]{0,119}\.png$/i;

class ScreenshotManager {
  constructor({ paths, profiles, nativeImage }) {
    this.paths = paths;
    this.profiles = profiles;
    this.nativeImage = nativeImage;
  }

  _dir(profileId) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(String(profileId))) throw new Error('Некорректный идентификатор профиля');
    if (!this.profiles.get(profileId)) throw new Error('Профиль не найден');
    return path.join(this.paths.instanceDir(profileId), 'screenshots');
  }

  _file(dir, name) {
    if (!FILE_NAME.test(String(name)) || path.basename(name) !== name) throw new Error('Некорректное имя скриншота');
    return path.join(dir, name);
  }

  async list(profileId) {
    const dir = this._dir(profileId);
    await fs.mkdir(dir, { recursive: true });
    const names = await fs.readdir(dir);
    const entries = await Promise.all(names.filter((name) => FILE_NAME.test(name)).map(async (name) => {
      const file = this._file(dir, name);
      const stat = await fs.stat(file);
      if (!stat.isFile()) return null;
      const image = this.nativeImage.createFromPath(file);
      if (image.isEmpty()) return null;
      const preview = image.resize({ width: 720, quality: 'good' }).toDataURL();
      return { name, size: stat.size, modifiedAt: stat.mtimeMs, preview };
    }));
    return entries.filter(Boolean).sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  async read(profileId, name) {
    const file = this._file(this._dir(profileId), name);
    const data = await fs.readFile(file);
    return `data:image/png;base64,${data.toString('base64')}`;
  }

  async rename(profileId, oldName, requestedName) {
    const dir = this._dir(profileId);
    const oldFile = this._file(dir, oldName);
    let name = String(requestedName || '').trim().replace(/\.png$/i, '');
    if (!name || /[^A-Za-z0-9 _().-]/.test(name) || name.length > 120) throw new Error('Название может содержать латиницу, цифры, пробелы, _, (), . и - (до 120 символов)');
    const newName = `${name}.png`;
    const newFile = this._file(dir, newName);
    if (newName.toLowerCase() !== oldName.toLowerCase()) {
      try { await fs.access(newFile); throw new Error('Скриншот с таким названием уже существует'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    await fs.rename(oldFile, newFile);
    return newName;
  }

  async remove(profileId, name) {
    await fs.rm(this._file(this._dir(profileId), name));
  }

  path(profileId, name) {
    return this._file(this._dir(profileId), name);
  }
}

module.exports = { ScreenshotManager, FILE_NAME };
