'use strict';
/**
 * Собственный установщик версий Minecraft: клиент, библиотеки, индекс и объекты ассетов
 * (всё с официальных серверов Mojang, с проверкой SHA-1). Умеет также докачивать библиотеки Fabric.
 * Формат файлов совместим с minecraft-launcher-core, поэтому при запуске он ничего не перекачивает.
 */
const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { downloadFile } = require('../util/http');
const log = require('../logger');

const ASSETS_URL = 'https://resources.download.minecraft.net';
const OS_NAME = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform] || 'linux';
const NATIVE_KEY = OS_NAME; // ключ в lib.natives

/** Правила библиотек Mojang (rules → allow/disallow по ОС). Правила с features не применяются. */
function ruleAllowed(rules) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const r of rules) {
    if (r.features) continue;
    const osOk = !r.os || ((!r.os.name || r.os.name === OS_NAME) && (!r.os.arch || r.os.arch !== 'x86' || process.arch === 'ia32'));
    if (osOk) allowed = r.action === 'allow';
  }
  return allowed;
}

/** group:artifact:version[:classifier] → относительный путь в maven-репозитории. */
function mavenPath(name) {
  const [group, artifact, version, classifier] = String(name).split(':');
  if (!group || !artifact || !version) throw new Error(`Некорректное имя библиотеки: ${name}`);
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.jar`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

/** Собирает список файлов для скачивания из JSON версии. */
function collectLibraries(meta, root) {
  const out = [];
  for (const lib of meta.libraries || []) {
    if (!ruleAllowed(lib.rules)) continue;
    const dl = lib.downloads;
    if (dl?.artifact?.url) {
      out.push({ url: dl.artifact.url, dest: path.join(root, 'libraries', dl.artifact.path), sha1: dl.artifact.sha1, size: dl.artifact.size });
    } else if (lib.name && lib.url) {
      // Формат Fabric/Maven: только имя и базовый URL.
      const rel = mavenPath(lib.name);
      out.push({ url: lib.url.replace(/\/?$/, '/') + rel, dest: path.join(root, 'libraries', rel), sha1: lib.sha1, size: lib.size });
    }
    const nat = lib.natives?.[NATIVE_KEY];
    if (nat && dl?.classifiers) {
      const key = nat.replace('${arch}', process.arch === 'x64' ? '64' : '32');
      const c = dl.classifiers[key];
      if (c?.url) out.push({ url: c.url, dest: path.join(root, 'libraries', c.path), sha1: c.sha1, size: c.size });
    }
  }
  return out;
}

async function pool(items, limit, worker) {
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

class InstallerService extends EventEmitter {
  constructor({ paths, versions }) {
    super();
    this.paths = paths;
    this.versions = versions;
    this.active = new Map(); // id → Promise (защита от параллельной установки одной версии)
  }

  _vdir(id) {
    return path.join(this.paths.root, 'versions', id);
  }

  async _exists(file, size) {
    try {
      const st = await fsp.stat(file);
      return size ? st.size === size : st.size > 0;
    } catch {
      return false;
    }
  }

  async isInstalled(id) {
    return (await this._exists(path.join(this._vdir(id), `${id}.jar`))) && (await this._exists(path.join(this._vdir(id), `${id}.json`)));
  }

  /** Установленные ванильные версии (есть и .json, и .jar). */
  async listInstalled() {
    const dir = path.join(this.paths.root, 'versions');
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) if (await this.isInstalled(n)) out.push(n);
    return out;
  }

  async uninstall(id) {
    if (!/^[\w.+\- ]{1,64}$/.test(id)) throw new Error('Некорректная версия');
    await fsp.rm(this._vdir(id), { recursive: true, force: true });
  }

  /** Устанавливает версию целиком. emit — прогресс { id, message, progress|null }. */
  install(id, { fabricId = null } = {}) {
    const key = id + '|' + (fabricId || '');
    if (this.active.has(key)) return this.active.get(key);
    const p = this._install(id, fabricId).finally(() => this.active.delete(key));
    this.active.set(key, p);
    return p;
  }

  _progress(id, message, progress = null) {
    this.emit('progress', { id, message, progress });
  }

  async _install(id, fabricId) {
    const root = this.paths.root;
    const meta = await this.versions.getMeta(id);
    log.info(`Установка Minecraft ${id}`);

    const files = [];
    // 1. JSON и клиент
    await fsp.mkdir(this._vdir(id), { recursive: true });
    await fsp.writeFile(path.join(this._vdir(id), `${id}.json`), JSON.stringify(meta));
    const client = meta.downloads?.client;
    if (!client) throw new Error(`У версии ${id} нет клиентского файла`);
    files.push({ url: client.url, dest: path.join(this._vdir(id), `${id}.jar`), sha1: client.sha1, size: client.size });

    // 2. Библиотеки
    files.push(...collectLibraries(meta, root));

    // 3. Ассеты
    this._progress(id, 'Загрузка списка ассетов…');
    const ai = meta.assetIndex;
    if (ai) {
      const indexFile = path.join(root, 'assets', 'indexes', `${ai.id}.json`);
      if (!(await this._exists(indexFile, ai.size))) await downloadFile(ai.url, indexFile, { sha1: ai.sha1 });
      const index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
      const seen = new Set();
      for (const obj of Object.values(index.objects || {})) {
        if (seen.has(obj.hash)) continue;
        seen.add(obj.hash);
        const sub = obj.hash.slice(0, 2);
        files.push({ url: `${ASSETS_URL}/${sub}/${obj.hash}`, dest: path.join(root, 'assets', 'objects', sub, obj.hash), sha1: obj.hash, size: obj.size, light: true });
      }
    }

    // 4. Fabric: библиотеки загрузчика
    if (fabricId) {
      const fj = JSON.parse(await fsp.readFile(path.join(this._vdir(fabricId), `${fabricId}.json`), 'utf8'));
      files.push(...collectLibraries(fj, root));
    }

    await this._downloadAll(id, files);
    this._progress(id, 'Готово', 1);
    log.info(`Minecraft ${id} установлен`);
  }

  async _downloadAll(id, files) {
    // Пропускаем уже имеющиеся файлы (проверка по размеру; «лёгкие» ассеты не хэшируем).
    const todo = [];
    for (const f of files) if (!(await this._exists(f.dest, f.size))) todo.push(f);
    const total = todo.reduce((s, f) => s + (f.size || 0), 0) || todo.length;
    let done = 0;
    let last = 0;
    let count = 0;
    const tick = (bytes) => {
      done += bytes;
      const now = Date.now();
      if (now - last > 150) {
        last = now;
        this._progress(id, `Загрузка файлов: ${count}/${todo.length}`, Math.min(1, done / total));
      }
    };
    if (!todo.length) return;
    await pool(todo, 12, async (f) => {
      let prev = 0;
      await downloadFile(f.url, f.dest, {
        sha1: f.light ? undefined : f.sha1,
        onProgress: (d) => {
          tick(f.size ? d - prev : 0);
          prev = d;
        },
      });
      if (!f.size) tick(1);
      count++;
    });
  }
}

module.exports = { InstallerService, ruleAllowed, mavenPath, collectLibraries };
