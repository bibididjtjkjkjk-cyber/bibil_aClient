'use strict';
/**
 * Синхронізація сурсів для другого тех-адміна.
 *
 * Джерело істини — той самий реліз GitHub / дзеркало Railway:
 *   version.json → { version, source: { file, url, sha512, size }, preserve: [...] }
 *
 * Перед заміною:
 *   - зчитується git status (незакомічені правки);
 *   - усі локальні правки й захищені файли копіюються в .bibil-sync-backups/<час>/;
 *   - застосовується чистий маніфест (старі файли, яких немає в новому релізі, видаляються).
 *
 * Модуль не вимагає Electron — його можна запустити окремим CLI:
 *   npm run sources:sync -- check
 *   npm run sources:sync -- sync --dir "C:\work\bibil_aClient"
 */
const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { listZipEntries, extractZip } = require('../util/zip');
const { VERSION, ENV_UPDATE_URL } = require('../config');
const log = require('../logger');

const GITHUB_OWNER = process.env.BIBIL_GITHUB_OWNER || 'bibididjtjkjkjk-cyber';
const GITHUB_REPO = process.env.BIBIL_GITHUB_REPO || 'bibil_aClient';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

const LOCAL_MANIFEST = '.bibil-source-version.json';
const BACKUP_DIR = '.bibil-sync-backups';
const DEFAULT_PRESERVE = [
  '.git/**', '.idea/**', 'node_modules/**', 'dist/**', 'out/**', 'update-server/public/**',
  'data/**', '.bibil-sync-backups/**', LOCAL_MANIFEST,
  '.env', '.env.*', '*.local.*', '*.log', '*.zip',
  // Локальні ключі/шляхи тех-адміна не повинні затиратися релізом.
  'src/main/config.js',
];

function isHttps(url) { try { return new URL(url).protocol === 'https:'; } catch { return false; } }

function globToRegExp(pattern) {
  const esc = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

function isPreserved(rel, extra = []) {
  const name = String(rel).replace(/\\/g, '/');
  const base = path.basename(name);
  for (const raw of [...DEFAULT_PRESERVE, ...extra]) {
    const p = String(raw).replace(/\\/g, '/');
    if (p.endsWith('/**') && name.startsWith(p.slice(0, -2))) return true;
    if (p === name || p === base) return true;
    if (/[*?]/.test(p) && (globToRegExp(p).test(name) || globToRegExp(p).test(base))) return true;
  }
  return false;
}

function normalizeManifest(meta, baseUrl) {
  const version = String(meta?.version || '').replace(/^v/i, '').trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('У релізі відсутня коректна версія сурсів');
  const source = meta.source || meta.sources || {};
  const file = source.file || source.name || `sources-${version}.zip`;
  if (!source.url && !baseUrl) throw new Error('У релізі немає посилання на архів сурсів');
  return {
    version,
    file,
    url: isHttps(source.url) ? source.url : new URL(encodeURIComponent(file), baseUrl).toString(),
    sha512: String(source.sha512 || '').replace(/\s/g, ''),
    size: Number(source.size || 0) || 0,
    notes: String(meta.notes || ''),
    preserve: Array.isArray(meta.preserve) ? meta.preserve.filter((x) => typeof x === 'string').slice(0, 200) : [],
  };
}

async function matchesSha512(file, expected) {
  if (!expected) return true;
  const h = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  const buf = h.digest();
  return expected.length === 128
    ? buf.toString('hex').toLowerCase() === expected.toLowerCase()
    : buf.toString('base64') === expected;
}

class SourceSyncService extends EventEmitter {
  constructor({ settings, paths } = {}) {
    super();
    this.settings = settings;
    this.paths = paths || null;
    this.busy = false;
    this.lastError = null;
    this.remote = null;
  }

  config() {
    const s = this.settings?.get?.() || {};
    return { ...(s.sources || {}), updater: s.updater || {} };
  }

  feedUrl() {
    const cfg = this.config();
    const raw = String(cfg.updater.url || '').trim() || ENV_UPDATE_URL || '';
    return isHttps(raw) ? raw.replace(/\/+$/, '') + '/' : '';
  }

  token() {
    const cfg = this.config();
    return String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || cfg.updater.githubToken || '').trim();
  }

  dir() {
    const configured = String(this.config().dir || '').trim();
    if (configured) return path.resolve(configured);
    if (process.env.BIBIL_SOURCES_DIR) return path.resolve(process.env.BIBIL_SOURCES_DIR);
    // У dev-режимі cwd — це корінь проєкту. У packaged-збірці потрібно вказати шлях у налаштуваннях.
    try {
      if (fs.existsSync(path.join(process.cwd(), 'package.json'))) return process.cwd();
    } catch { /* noop */ }
    return '';
  }

  status() {
    const dir = this.dir();
    let localVersion = null;
    let appliedAt = null;
    let fileCount = 0;
    if (dir) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, LOCAL_MANIFEST), 'utf8'));
        localVersion = String(m.version || '');
        appliedAt = m.appliedAt || null;
        fileCount = Array.isArray(m.files) ? m.files.length : 0;
      } catch { /* немає локального маніфесту */ }
    }
    return {
      dir, configured: !!dir, exists: !!(dir && fs.existsSync(dir)),
      localVersion, appliedAt, fileCount,
      remoteVersion: this.remote?.version || null,
      version: VERSION, busy: this.busy,
      error: this.lastError ? { code: this.lastError.code || 'UNKNOWN', message: this.lastError.message } : null,
    };
  }

  _emit(state, patch = {}) {
    this.emit('state', { ...this.status(), state, ...patch });
  }

  async _fetch(url, { timeout = 20000, signal } = {}) {
    const ctrl = new AbortController();
    const timer = timeout > 0 ? setTimeout(() => ctrl.abort(), timeout) : null;
    const headers = { 'User-Agent': `bibil-aClient/${VERSION} (source-sync)`, Accept: 'application/json' };
    if (this.token() && /api\.github\.com/i.test(url)) headers.Authorization = `Bearer ${this.token()}`;
    try {
      const res = await fetch(url, { headers, signal: signal || ctrl.signal, redirect: 'follow' });
      if (!res.ok) {
        const rate = (res.status === 403 || res.status === 429)
          && String(res.headers.get('x-ratelimit-remaining') ?? '') === '0';
        const e = new Error(rate ? 'Ліміт GitHub API вичерпано — додайте GITHUB_TOKEN або скористайтеся дзеркалом.' : `HTTP ${res.status} при запиті ${new URL(url).host}`);
        e.code = rate ? 'RATE_LIMIT' : res.status === 404 ? 'NO_RELEASE' : 'HTTP';
        e.httpStatus = res.status;
        throw e;
      }
      return res;
    } catch (e) {
      if (e.code) throw e;
      const err = new Error(`Немає з'єднання з сервером оновлень: ${e.message}`);
      err.code = 'NETWORK';
      throw err;
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Отримати manifest останнього релізу. GitHub → дзеркало. */
  async check() {
    this._emit('checking', { message: 'Перевіряємо версію сурсів…' });
    let lastErr = null;
    try {
      const res = await this._fetch(`${GITHUB_API}/releases/latest`);
      const release = await res.json();
      const asset = (release.assets || []).find((a) => /^version\.json$/i.test(a.name));
      if (!asset) throw Object.assign(new Error('У релізі немає version.json'), { code: 'BAD_MANIFEST' });
      const meta = await (await this._fetch(asset.browser_download_url)).json();
      // Відносне ім'я архіву в version.json має резолвитися відносно самого
      // version.json у GitHub Releases, а не від дзеркала (інакше хеш не збіжиться).
      this.remote = normalizeManifest(meta, asset.browser_download_url);
      this.lastError = null;
    } catch (e) {
      lastErr = e;
      log.warn('[source-sync] GitHub недоступний:', e.message);
      const feed = this.feedUrl();
      if (!feed) throw e;
      try {
        const meta = await (await this._fetch(`${feed}version.json`)).json();
        this.remote = normalizeManifest(meta, feed);
        this.lastError = null;
      } catch (mirrorErr) {
        this.lastError = lastErr;
        this._emit('error', { message: `${lastErr.message} / ${mirrorErr.message}`, error: { code: lastErr.code, message: lastErr.message } });
        throw lastErr;
      }
    }
    const status = this.status();
    this._emit('checked', {
      message: status.localVersion === this.remote.version
        ? 'Сурси актуальні' : `Доступна версія сурсів ${this.remote.version}`,
    });
    return this.remote;
  }

  async _dirtyFiles(dir) {
    const out = await new Promise((resolve) => {
      execFile('git', ['status', '--porcelain', '-z'], { cwd: dir, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout) => resolve(err ? '' : stdout));
    });
    const files = [];
    for (const entry of out.split('\0')) {
      if (!entry) continue;
      const rel = entry.slice(3).replace(/ -> /g, '\0').split('\0').pop();
      const abs = path.resolve(dir, rel);
      if (abs.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(abs)) files.push(rel);
      if (files.length >= 500) break;
    }
    return files;
  }

  async _backup(dir, rels) {
    const uniq = [...new Set(rels.filter(Boolean))].slice(0, 1000);
    if (!uniq.length) return null;
    const backup = path.join(dir, BACKUP_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
    await fsp.mkdir(backup, { recursive: true });
    const copied = [];
    for (const rel of uniq) {
      const from = path.join(dir, rel);
      const to = path.join(backup, rel);
      try {
        const st = await fsp.stat(from);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.cp(from, to, { recursive: st.isDirectory(), force: true });
        copied.push(rel);
      } catch { /* файл зник — пропускаємо */ }
    }
    await fsp.writeFile(path.join(backup, 'backup.json'), JSON.stringify({
      created: Date.now(), count: copied.length, files: copied,
    }, null, 2));
    log.info(`[source-sync] backup: ${backup} (${copied.length} files)`);
    return backup;
  }

  async _download(manifest) {
    const tmpDir = path.join(os.tmpdir(), 'bibil-source-sync');
    await fsp.mkdir(tmpDir, { recursive: true });
    const dest = path.join(tmpDir, `sources-${manifest.version}-${Date.now()}.zip`);
    const res = await this._fetch(manifest.url, { timeout: 0 });
    if (!res.body) throw Object.assign(new Error('Сервер не повернув архів сурсів'), { code: 'NETWORK' });
    const file = await fsp.open(dest, 'w');
    let done = 0;
    let lastPct = -1;
    const total = Number(res.headers.get('content-length') || manifest.size || 0);
    try {
      for await (const chunk of Readable.fromWeb(res.body)) {
        await file.write(chunk);
        done += chunk.length;
        const pct = total ? Math.min(99, Math.round((done / total) * 99)) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          this._emit('downloading', { percent: pct, message: `Завантаження сурсів: ${pct}%` });
        }
      }
    } finally { await file.close(); }
    this._emit('verifying', { percent: 100, message: 'Перевіряємо хеш архіву…' });
    if (manifest.sha512 && !(await matchesSha512(dest, manifest.sha512))) {
      await fsp.rm(dest, { force: true });
      throw Object.assign(new Error('SHA-512 архіву сурсів не збігся'), { code: 'HASH_MISMATCH' });
    }
    return dest;
  }

  /** Повна синхронізація. Повертає {version, backup, files, dir}. */
  async sync({ backup = true, force = false } = {}) {
    if (this.busy) throw Object.assign(new Error('Синхронізація вже виконується'), { code: 'ALREADY' });
    this.busy = true;
    try {
      const manifest = this.remote && this.remote.version ? this.remote : await this.check();
      const dir = this.dir();
      if (!dir || !fs.existsSync(dir) || !(await fsp.stat(dir)).isDirectory()) {
        throw Object.assign(new Error('Вкажіть існуючий каталог сурсів у Налаштування → Сурси'), { code: 'NO_DIR' });
      }
      const local = JSON.parse(await fsp.readFile(path.join(dir, LOCAL_MANIFEST), 'utf8').catch(() => '{}'));
      if (!force && String(local.version || '') === manifest.version) {
        this._emit('done', { percent: 100, message: `Сурси вже мають версію ${manifest.version}` });
        return { version: manifest.version, backup: null, files: [], dir, upToDate: true };
      }

      const zip = await this._download(manifest);
      const staging = path.join(os.tmpdir(), `bibil-source-stage-${Date.now()}`);
      await fsp.rm(staging, { recursive: true, force: true });
      await fsp.mkdir(staging, { recursive: true });
      this._emit('extracting', { message: 'Розпаковуємо архів…' });
      const files = await extractZip(zip, staging, {
        onEntry: (rel, i, total) => {
          if (i % 20 === 0) this._emit('extracting', { percent: Math.round((i / total) * 100), message: `Розпаковуємо: ${rel}` });
        },
      });
      await fsp.rm(zip, { force: true });

      const dirty = await this._dirtyFiles(dir);
      const preservedExisting = files.filter((rel) => isPreserved(rel, manifest.preserve)
        && fs.existsSync(path.join(dir, rel)));
      let backupDir = null;
      if (backup) {
        this._emit('backup', { message: `Резервуємо ${dirty.length + preservedExisting.length} локальних файлів…` });
        backupDir = await this._backup(dir, [...dirty, ...preservedExisting]);
      }

      this._emit('applying', { message: 'Застосовуємо сурси…' });
      const newSet = new Set(files);
      for (const rel of Array.isArray(local.files) ? local.files : []) {
        if (newSet.has(rel) || isPreserved(rel, manifest.preserve)) continue;
        const oldFile = path.join(dir, rel);
        if (fs.existsSync(oldFile)) await fsp.rm(oldFile, { recursive: true, force: true }).catch(() => {});
      }
      for (const rel of files) {
        if (!force && isPreserved(rel, manifest.preserve) && fs.existsSync(path.join(dir, rel))) continue;
        const from = path.join(staging, rel);
        const to = path.join(dir, rel);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rm(to, { recursive: true, force: true }).catch(() => {});
        await fsp.cp(from, to, { recursive: true, force: true });
      }
      await fsp.writeFile(path.join(dir, LOCAL_MANIFEST), JSON.stringify({
        version: manifest.version, appliedAt: new Date().toISOString(), files, backup: backupDir,
      }, null, 2));
      await fsp.rm(staging, { recursive: true, force: true });

      this.lastError = null;
      this._emit('done', {
        percent: 100, files: files.length, backup: backupDir,
        message: `Сурси ${manifest.version} синхронізовано. Перезапустіть лаунчер з сурсів.`,
      });
      log.info(`[source-sync] applied ${manifest.version}: ${files.length} files, backup=${backupDir || 'none'}`);
      return { version: manifest.version, backup: backupDir, files, dir };
    } catch (e) {
      this.lastError = e;
      this._emit('error', { message: e.message, error: { code: e.code || 'UNKNOWN', message: e.message } });
      throw e;
    } finally {
      this.busy = false;
    }
  }
}

module.exports = {
  SourceSyncService, normalizeManifest, isPreserved, DEFAULT_PRESERVE,
  LOCAL_MANIFEST, GITHUB_API,
};
