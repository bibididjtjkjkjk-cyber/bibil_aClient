'use strict';
/**
 * Надійне оновлення лаунчера.
 *
 * Джерела (за пріоритетом):
 *   1) GitHub Releases API  GET /repos/{owner}/{repo}/releases/latest
 *   2) Дзеркало Railway     GET {feed}/latest.json  (або latest.yml через electron-updater)
 *
 * Можливості:
 *   - GITHUB_TOKEN / GH_TOKEN / updater.githubToken => обхід rate limit;
 *   - 403/429 + X-RateLimit-Remaining: 0 => автоматичний fallback на дзеркало;
 *   - перевірка draft/prerelease, наявності ассетів, sha512, версії;
 *   - завантаження потоком з прогресом (відсотки + швидкість);
 *   - self-update через окремий PowerShell-хелпер: він чекає закриття процесу,
 *     підміняє exe/ставлять Setup і перезапускає лаунчер (працює і для portable);
 *   - деталізовані помилки {code, stage, httpStatus, detail} у стані, IPC й логах.
 */
const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { VERSION, ENV_UPDATE_URL, PACKAGED_UPDATE_PROVIDER } = require('../config');
const log = require('../logger');

const GITHUB_OWNER = process.env.BIBIL_GITHUB_OWNER || 'bibididjtjkjkjk-cyber';
const GITHUB_REPO = process.env.BIBIL_GITHUB_REPO || 'bibil_aClient';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

let electronApp = null;
try {
  const electron = require('electron');
  if (electron && electron.app) electronApp = electron.app;
} catch { /* запуск поза Electron (тести/CLI) */ }

const ERROR_MESSAGES = {
  NO_RELEASE: 'Реліз ще не опубліковано або у вас найновіша версія.',
  RATE_LIMIT: 'Ліміт запитів GitHub API вичерпано — перевіряємо дзеркало оновлень.',
  NETWORK: 'Немає з\'єднання з сервером оновлень. Перевірте інтернет.',
  HTTP: 'Сервер оновлень повернув помилку. Деталі записані в журнал.',
  BAD_MANIFEST: 'Маніфест оновлення пошкоджено або має невірну версію.',
  HASH_MISMATCH: 'Хеш файлу не збігся — завантаження може бути пошкоджене.',
  NO_ASSET: 'У релізі немає потрібного файлу для вашого типу збірки.',
  FILE_LOCKED: 'Файл лаунчера зайнятий іншим процесом. Закрийте лаунчер і повторіть.',
  PERMISSION: 'Недостатньо прав для заміни файлів. Запустіть лаунчер від імені адміністратора.',
  ANTIVIRUS: 'Антивірус заблокував заміну файлу. Додайте папку лаунчера у винятки.',
  UNSUPPORTED: 'Автооновлення доступне тільки у встановленій або portable збірці для Windows.',
  ALREADY: 'Оновлення вже виконується.',
  BUSY: 'Спочатку закрийте гру — потім можна оновлювати лаунчер.',
  UNKNOWN: 'Не вдалося виконати оновлення. Деталі — у журналі лаунчера.',
};

class UpdateError extends Error {
  constructor(code, message, detail = {}) {
    super(message || ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN);
    this.name = 'UpdateError';
    this.code = code;
    for (const [k, v] of Object.entries(detail)) if (v !== undefined) this[k] = v;
  }
}

/** Порівняння версій без залежностей: 1.10.2 > 1.9.9. */
function compareVersions(a, b) {
  const parse = (v) => String(v || '').replace(/^v/i, '').split(/[.+-]/).slice(0, 4)
    .map((n) => (/^\d+$/.test(n) ? Number(n) : 0));
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const isHttps = (url) => { try { return new URL(url).protocol === 'https:'; } catch { return false; } };
/** Токен GitHub додаємо лише до справжнього api.github.com. */
const isGithubApi = (url) => { try { return new URL(url).hostname.toLowerCase() === 'api.github.com'; } catch { return false; } };
const cleanVersion = (v) => String(v || '').replace(/^v/i, '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errorInfo(e, stage = '') {
  return {
    code: e?.code || (/EPERM|EACCES/i.test(e?.message || '') ? 'PERMISSION'
      : /EBUSY|being used|locked/i.test(e?.message || '') ? 'FILE_LOCKED' : 'UNKNOWN'),
    stage: e?.stage || stage,
    httpStatus: e?.httpStatus || null,
    message: e instanceof UpdateError ? e.message : (e?.message || ERROR_MESSAGES.UNKNOWN),
    detail: e?.detail || '',
    url: e?.url || '',
  };
}

function userMessage(e) {
  if (e instanceof UpdateError) return e.message;
  const info = errorInfo(e);
  if (info.code === 'PERMISSION') return ERROR_MESSAGES.PERMISSION;
  if (info.code === 'FILE_LOCKED') return ERROR_MESSAGES.FILE_LOCKED;
  return e?.message || ERROR_MESSAGES.UNKNOWN;
}

/** Перевірка SHA-512 у base64 або hex. */
/** Шлях до exe, який треба замінити. Для portable — оригінальний SFX, а не тимчасовий розпакований файл. */
function resolveUpdateTarget(portable, { execPath, portableExe = '' } = {}) {
  const appExe = execPath || process.execPath;
  return portable ? (portableExe || appExe) : path.join(path.dirname(appExe), 'bibil_aClient.exe');
}

function sha512Matches(file, expected) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => h.update(c));
    stream.on('end', () => {
      const want = String(expected || '').replace(/\s/g, '');
      const buf = h.digest();
      resolve(want.length === 128
        ? buf.toString('hex').toLowerCase() === want.toLowerCase()
        : buf.toString('base64') === want);
    });
    stream.on('error', reject);
  });
}

class UpdaterService extends EventEmitter {
  /** @param {{settings: object, isBusy?: () => boolean, paths?: object}} opts */
  constructor({ settings, isBusy, paths } = {}) {
    super();
    this.settings = settings;
    this.paths = paths || null;
    this.isBusy = typeof isBusy === 'function' ? isBusy : () => false;
    this.installing = false;
    this._installStarting = false;
    this._abort = null;
    this.candidate = null;
    this.downloadedFile = '';
    this.downloadedVersion = '';
    this.state = {
      state: 'idle', version: VERSION, latest: null, progress: 0, speed: 0,
      phase: '', message: '', error: null, supported: this.supported(), url: this.sourceLabel(),
    };
  }

  supported() {
    return process.platform === 'win32' && !!electronApp && !!electronApp.isPackaged;
  }

  feedUrl() {
    const configured = String(this.settings?.get?.()?.updater?.url || '').trim();
    const url = configured || ENV_UPDATE_URL || '';
    return isHttps(url) ? url.replace(/\/+$/, '') + '/' : '';
  }

  githubToken() {
    return String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN
      || this.settings?.get?.()?.updater?.githubToken || '').trim();
  }

  hasPackagedProvider() {
    return ['github', 'gitlab', 'bitbucket'].includes(PACKAGED_UPDATE_PROVIDER);
  }

  sourceLabel() {
    return this.feedUrl() || (this.hasPackagedProvider() ? 'GitHub Releases' : '');
  }

  canCheck() {
    return !!(this.feedUrl() || GITHUB_OWNER);
  }

  info() {
    return {
      ...this.state,
      supported: this.supported(),
      url: this.sourceLabel(),
      release: this.candidate ? {
        version: this.candidate.version,
        notes: String(this.candidate.notes || '').slice(0, 1000),
        publishedAt: this.candidate.publishedAt || null,
        via: this.candidate.via || '',
      } : null,
      log: this._readHelperLog(),
    };
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.info());
    return this.info();
  }

  _readHelperLog() {
    try {
      return fs.existsSync(this._helperLog())
        ? fs.readFileSync(this._helperLog(), 'utf8').trim().split(/\r?\n/).slice(-8).join('\n')
        : '';
    } catch { return ''; }
  }

  _helperLog() { return path.join(os.tmpdir(), 'bibil-updater.log'); }

  _log(stage, e) {
    const info = errorInfo(e, stage);
    log.error(`[updater] stage=${info.stage} code=${info.code} http=${info.httpStatus ?? '-'}: ${info.message}`, info);
  }

  // ---------------------------------------------------------------- HTTP

  async _fetch(url, { timeout = 20000, headers = {}, signal, notFoundCode = 'NO_RELEASE', ...init } = {}) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = timeout > 0 ? setTimeout(() => ctrl.abort(), timeout) : null;
    const h = {
      'User-Agent': `bibil-aClient/${VERSION} (auto-update)`,
      Accept: 'application/vnd.github+json, application/json, text/yaml, */*',
      ...headers,
    };
    if (this.githubToken() && isGithubApi(url)) h.Authorization = `Bearer ${this.githubToken()}`;
    try {
      const res = await fetch(url, { ...init, headers: h, signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) {
        // 403/429 майже завжди означають ліміт GitHub (включно з secondary rate limit,
        // коли заголовок X-RateLimit-Remaining відсутній) — усе одно пробуємо дзеркало.
        const rateLimited = res.status === 429 || res.status === 403;
        const code = res.status === 404 ? notFoundCode : rateLimited ? 'RATE_LIMIT' : 'HTTP';
        const e = new UpdateError(code, undefined, {
          httpStatus: res.status, url,
          detail: `${res.status} ${res.statusText}`.trim(),
          rateRemaining: res.headers.get('x-ratelimit-remaining'),
        });
        throw e;
      }
      return res;
    } catch (e) {
      if (e instanceof UpdateError) throw e;
      if (signal?.aborted || ctrl.signal.aborted) throw new UpdateError('NETWORK', 'Завантаження скасовано.', { url });
      throw new UpdateError('NETWORK', undefined, { url, detail: e.message });
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // ---------------------------------------------------------------- check

  /** Публичная проверка. Возвращает info(). internal=true — виклик з install(). */
  async check({ internal = false } = {}) {
    if ((this.installing || this._installStarting) && !internal) throw new UpdateError('ALREADY');
    if (!this.canCheck() || !this.supported()) {
      const msg = ERROR_MESSAGES.UNSUPPORTED;
      this._set({ state: 'unavailable', message: msg, error: errorInfo(new UpdateError('UNSUPPORTED'), 'check') });
      throw new UpdateError('UNSUPPORTED', msg);
    }
    this._set({ state: 'checking', phase: 'check', progress: 0, message: 'Перевіряємо оновлення…', error: null });

    let release = null;
    let via = 'github';
    let githubErr = null;

    try {
      release = await this._checkGitHub();
    } catch (e) {
      githubErr = e;
      this._log('github', e);
      via = 'mirror';
      log.warn(`[updater] GitHub недоступний (${e.code}), пробуємо дзеркало`);
      try {
        release = await this._checkMirror();
      } catch (mirrorErr) {
        this._log('mirror', mirrorErr);
        const code = githubErr.code === 'RATE_LIMIT' ? 'RATE_LIMIT'
          : githubErr.code === 'NO_RELEASE' && mirrorErr.code === 'NO_RELEASE' ? 'NO_RELEASE'
            : mirrorErr.code === 'NETWORK' && githubErr.code !== 'HTTP' ? 'NETWORK' : 'HTTP';
        const msg = code === 'RATE_LIMIT' ? ERROR_MESSAGES.RATE_LIMIT
          : code === 'NO_RELEASE' ? ERROR_MESSAGES.NO_RELEASE
            : code === 'NETWORK' ? ERROR_MESSAGES.NETWORK : ERROR_MESSAGES.HTTP;
        const err = new UpdateError(code, msg, {
          httpStatus: githubErr.httpStatus || mirrorErr.httpStatus,
          detail: `github: ${githubErr.message} | mirror: ${mirrorErr.message}`,
        });
        this._set({ state: 'error', message: msg, error: errorInfo(err, 'check') });
        throw err;
      }
    }

    // Змінилася версія релізу — раніше завантажений exe більше не можна ставити.
    if (this.candidate && this.candidate.version !== release.version) {
      this.downloadedFile = '';
      this.downloadedVersion = '';
    }
    this.candidate = { ...release, via };
    const newer = compareVersions(release.version, VERSION) > 0;
    const msg = newer ? `Знайдено версію ${release.version}` : 'У вас найновіша версія';
    log.info(`[updater] ${via}: latest=${release.version}, current=${VERSION}, newer=${newer}`);
    return this._set({
      state: newer ? 'available' : 'up-to-date',
      latest: release.version, message: msg, phase: '', error: null,
    });
  }

  async _checkGitHub() {
    const res = await this._fetch(`${GITHUB_API}/releases/latest`);
    const data = await res.json();
    if (data.draft || data.prerelease) {
      throw new UpdateError('NO_RELEASE', 'Останній реліз є чернеткою або пререлізом.', { httpStatus: 200 });
    }
    const version = cleanVersion(data.tag_name || data.name);
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
      throw new UpdateError('BAD_MANIFEST', undefined, { detail: `tag=${data.tag_name}` });
    }
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const setup = assets.find((a) => /setup.*\.exe$/i.test(a.name) || /-Setup-\d/i.test(a.name));
    const portable = assets.find((a) => /\.exe$/i.test(a.name) && a !== setup);
    const sources = assets.find((a) => /sources?.*\.zip$/i.test(a.name));
    // latest.json містить хеші обох exe; version.json — хеш архіву сурсів.
    const manifest = assets.find((a) => /^latest\.json$/i.test(a.name))
      || assets.find((a) => /^version\.json$/i.test(a.name));
    let meta = {};
    if (manifest) {
      try {
        meta = await (await this._fetch(manifest.browser_download_url)).json();
      } catch (e) {
        log.warn('[updater] latest.json недоступний, пробуємо latest.yml:', e.message);
        const yml = assets.find((a) => /^latest\.yml$/i.test(a.name));
        if (yml) {
          try {
            const text = await (await this._fetch(yml.browser_download_url)).text();
            const sha = text.match(/^\s*sha512:\s*(\S+)/m)?.[1] || '';
            if (sha) meta = { version, sha512: sha, file: setup?.name || '' };
          } catch (e2) { log.warn('[updater] latest.yml теж недоступний:', e2.message); }
        }
      }
    }
    const setupSha = meta.sha512 || meta.sha512Hex || '';
    const portableSha = meta.portableSha512 || meta.portableSha512Hex || '';
    return {
      version, tag: data.tag_name, publishedAt: data.published_at, notes: data.body || '',
      setup: setup && { name: setup.name, url: setup.browser_download_url, size: setup.size, sha512: setupSha },
      portable: portable && { name: portable.name, url: portable.browser_download_url, size: portable.size, sha512: portableSha },
      sources: sources && { name: sources.name, url: sources.browser_download_url, size: sources.size, sha512: meta.sourceSha512 || meta.source?.sha512 || '' },
      cosmetics: assets.find((a) => /^cosmetics\.json$/i.test(a.name))?.browser_download_url || null,
      sha512: setupSha, meta,
    };
  }

  async _checkMirror() {
    const base = this.feedUrl();
    if (!base) throw new UpdateError('NO_RELEASE', 'Не вказано адресу дзеркала оновлень.');
    const res = await this._fetch(`${base}latest.json`);
    const meta = await res.json();
    const version = cleanVersion(meta.version);
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) throw new UpdateError('BAD_MANIFEST');
    const file = meta.file || meta.path || `bibil_aClient-Setup-${version}.exe`;
    const resolve = (name) => new URL(encodeURIComponent(name), base).toString();
    return {
      version, publishedAt: meta.releaseDate || meta.publishedAt || null, notes: meta.notes || '',
      setup: { name: file, url: resolve(file), size: meta.size || 0, sha512: meta.sha512 || '' },
      portable: meta.portable ? { name: meta.portable, url: resolve(meta.portable), size: meta.portableSize || 0, sha512: meta.portableSha512 || '' } : null,
      sources: meta.sources ? { name: meta.sources, url: resolve(meta.sources), size: meta.sourceSize || 0, sha512: meta.sourceSha512 || '' } : null,
      cosmetics: meta.cosmetics ? resolve('cosmetics.json') : null,
      sha512: meta.sha512 || '', meta,
    };
  }

  /** Тихая проверка при старте. */
  async checkOnStart() {
    const u = this.settings?.get?.()?.updater || {};
    if (!u.enabled || !u.autoCheck || !this.canCheck() || !this.supported()) return;
    try {
      await this.check();
      if (this.state.state === 'available' && u.autoInstall && !this.isBusy()) {
        await this.download();
        this._set({ message: `Завантажено версію ${this.candidate.version} — можна встановити` });
      }
    } catch (e) {
      log.warn('[updater] автоперевірка пропущена:', e.code || e.message);
    }
  }

  // ---------------------------------------------------------------- download

  /** Скачать ассет с прогрессом. Возвращает путь к файлу. */
  async download(asset) {
    // Для portable не можна підсунути NSIS Setup — це інший бінарник.
    asset = asset || (this.isPortableBuild()
      ? this.candidate?.portable
      : (this.candidate?.setup || this.candidate?.portable));
    if (!asset?.url || !isHttps(asset.url)) throw new UpdateError('NO_ASSET');

    const tmpDir = path.join(os.tmpdir(), 'bibil-updates');
    await fsp.mkdir(tmpDir, { recursive: true });
    const name = path.basename(new URL(asset.url).pathname).replace(/[^\w.\-()]+/g, '_') || `update-${Date.now()}.exe`;
    const dest = path.join(tmpDir, name);
    const part = dest + '.part';
    this._abort = new AbortController();
    this._set({ state: 'downloading', phase: 'download', progress: 0, speed: 0, error: null, message: 'Завантаження…' });
    log.info(`[updater] download ${asset.url} -> ${dest}`);

    try {
      const res = await this._fetch(asset.url, { timeout: 0, signal: this._abort.signal, notFoundCode: 'NO_ASSET' });
      const total = Number(res.headers.get('content-length') || asset.size || 0);
      if (!res.body) throw new UpdateError('NETWORK', 'Сервер не повернув дані файлу.');
      const file = await fsp.open(part, 'w');
      let downloaded = 0;
      let last = Date.now();
      let lastBytes = 0;
      let speed = 0;
      try {
        // FileHandle.write може записати не весь chunk — дописуємо залишок.
        const writeAll = async (buf) => {
          let offset = 0;
          while (offset < buf.length) {
            const { bytesWritten } = await file.write(buf, offset, buf.length - offset);
            if (!bytesWritten) throw new UpdateError('NETWORK', 'Запис файлу оновлення перервано.');
            offset += bytesWritten;
          }
        };
        for await (const chunk of Readable.fromWeb(res.body)) {
          await writeAll(chunk);
          downloaded += chunk.length;
          const now = Date.now();
          if (now - last >= 500) {
            speed = Math.round(((downloaded - lastBytes) / 1024) / ((now - last) / 1000));
            last = now;
            lastBytes = downloaded;
          }
          const percent = total ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
          this._set({
            state: 'downloading', phase: 'download', progress: percent, speed,
            message: `Завантаження: ${percent}%${speed ? ` · ${speed} КБ/с` : ''}`,
            detail: { downloaded, total },
          });
        }
      } finally { await file.close(); }
      if (total && downloaded !== total) {
        throw new UpdateError('NETWORK', 'Завантаження перервано до завершення.', { detail: `${downloaded}/${total}` });
      }

      // Хеш беремо саме для вибраного ассета (setup і portable мають різні хеші).
      // Немає хеша — НЕ встановлюємо: краще зрозуміла помилка, ніж неперевірений exe.
      // Запасний хеш (setup) підходить лише для самого setup, не для portable.
      const expected = asset.sha512 || (asset === this.candidate?.setup ? this.candidate?.sha512 : '');
      if (!expected) {
        throw new UpdateError('BAD_MANIFEST', 'У маніфесті оновлення немає SHA-512 для вибраного файлу.', {
          detail: asset.name || asset.url,
        });
      }
      this._set({ state: 'downloading', phase: 'verify', progress: 100, speed: 0, message: 'Перевіряємо цілісність файлу…' });
      let ok = false;
      try { ok = await sha512Matches(part, expected); } catch (e) { throw new UpdateError('BAD_MANIFEST', undefined, { detail: e.message }); }
      if (!ok) {
        const e = new UpdateError('HASH_MISMATCH');
        this._log('verify', e);
        this._set({ state: 'error', error: errorInfo(e, 'verify'), message: e.message });
        throw e;
      }
      log.info('[updater] SHA-512 підтверджено');

      await fsp.rm(dest, { force: true });
      await fsp.rename(part, dest);
      this.downloadedFile = dest;
      this.downloadedVersion = this.candidate?.version || '';
      return dest;
    } catch (e) {
      await fsp.rm(part, { force: true }).catch(() => {});
      if (e instanceof UpdateError && e.code === 'NETWORK' && /скасовано/i.test(e.message)) {
        this._set({ state: 'idle', message: 'Завантаження скасовано', error: null });
        throw e;
      }
      this._log('download', e);
      const err = e instanceof UpdateError ? e : new UpdateError('NETWORK', userMessage(e), { detail: e.message });
      this._set({ state: 'error', error: errorInfo(err, 'download'), message: err.message });
      throw err;
    }
  }

  cancel() {
    try { this._abort?.abort(); } catch { /* noop */ }
  }

  // ---------------------------------------------------------------- install

  isPortableBuild() {
    return !!(process.env.PORTABLE_EXECUTABLE_DIR
      || /^bibil_aClient[ -]\d/i.test(path.basename(process.execPath)));
  }

  /** Перевірити → завантажити → запустити зовнішній хелпер. */
  async install() {
    if (!this.supported()) throw new UpdateError('UNSUPPORTED');
    if (this.installing || this._installStarting) throw new UpdateError('ALREADY');
    if (this.isBusy()) throw new UpdateError('BUSY');
    this._installStarting = true;
    try {
      // check() не можна викликати з installing=true — інакше він кине ALREADY.
      if (!this.candidate || compareVersions(this.candidate.version, VERSION) <= 0
        || !this.downloadedFile || this.downloadedVersion !== this.candidate.version) {
        await this.check({ internal: true });
      }
      if (!this.candidate || compareVersions(this.candidate.version, VERSION) <= 0) {
        throw new UpdateError('NO_RELEASE', 'У вас найновіша версія — встановлювати нічого.');
      }
      const portable = this.isPortableBuild();
      const asset = portable ? this.candidate.portable : (this.candidate.setup || this.candidate.portable);
      if (!asset) throw new UpdateError('NO_ASSET');
      this.installing = true;
      const src = (this.downloadedFile && this.downloadedVersion === this.candidate.version)
        ? this.downloadedFile
        : await this.download(asset);
      this._set({ state: 'installing', phase: 'install', progress: 100, message: 'Замінюємо файли та перезапускаємо…', error: null });
      await this._runHelper({ src, portable });
      return true;
    } catch (e) {
      this._log('install', e);
      const err = e instanceof UpdateError ? e
        : new UpdateError(/EPERM|EACCES/i.test(e.message) ? 'PERMISSION'
          : /EBUSY|used|locked/i.test(e.message) ? 'FILE_LOCKED' : 'UNKNOWN', userMessage(e), { detail: e.message });
      this._set({ state: 'error', error: errorInfo(err, 'install'), message: err.message });
      throw err;
    } finally {
      this._installStarting = false;
      // Процес завершується разом із хелпером; прапорець знімаємо тільки при помилці.
      if (this.state.state === 'error') this.installing = false;
    }
  }

  /** Хелпер — окремий PowerShell-процес. Не тримаємо exe відкритим у основного процесу. */
  async _runHelper({ src, portable }) {
    const pid = process.pid;
    // У portable-збірці process.execPath — тимчасово розпакований exe з $TEMP.
    // PORTABLE_EXECUTABLE_FILE вказує на оригінальний exe користувача — його й міняємо.
    const target = resolveUpdateTarget(portable, {
      execPath: process.execPath,
      portableExe: process.env.PORTABLE_EXECUTABLE_FILE,
    });
    const logFile = this._helperLog();
    const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

    const installLine = portable
      ? [
        '$copied = $false',
        'for ($i = 0; $i -lt 10 -and -not $copied; $i++) {',
        '  try { Copy-Item -LiteralPath $src -Destination $target -Force -ErrorAction Stop; $copied = $true }',
        '  catch { Start-Sleep -Milliseconds 700 }',
        '}',
        'if (-not $copied) { throw "Не вдалося замінити portable exe після 10 спроб" }',
      ].join('; ')
      : `$setup = Start-Process -FilePath $src -ArgumentList '/S' -Wait -PassThru -ErrorAction Stop; if ($setup.ExitCode -ne 0) { throw "NSIS exit $($setup.ExitCode)" }`;

    const script = [
      '$ErrorActionPreference = "Stop"',
      `$waitPid = ${pid}`,
      `$portable = ${portable ? '$true' : '$false'}`,
      `$src = ${q(src)}`,
      `$target = ${q(target)}`,
      `$log = ${q(logFile)}`,
      'while (Get-Process -Id $waitPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 400 }',
      'Start-Sleep -Milliseconds 700',
      'try {',
      `  ${installLine}`,
      '  Start-Process -FilePath $target -ErrorAction Stop',
      '  "[$(Get-Date -Format o)] OK portable=$portable src=$src target=$target" | Out-File -LiteralPath $log -Append -Encoding utf8',
      '} catch {',
      '  "[$(Get-Date -Format o)] FAIL portable=$portable: $_" | Out-File -LiteralPath $log -Append -Encoding utf8',
      '}',
      'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
      '',
    ].join('\r\n');

    this._set({ state: 'installing', phase: 'restart', message: 'Перезапуск…', progress: 100 });
    const helper = path.join(os.tmpdir(), `bibil-update-${Date.now()}.ps1`);
    // PowerShell 5.1 читає .ps1 без BOM як ANSI — кириличні шляхи зіпсуються.
    await fsp.writeFile(helper, `\uFEFF${script}`, 'utf8');
    log.info(`[updater] helper=${helper} target=${target} portable=${portable}`);
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    setTimeout(() => {
      try { electronApp?.exit(0); } catch { /* noop */ }
    }, 1200);
    return true;
  }
}

module.exports = {
  UpdaterService, UpdateError, compareVersions, ERROR_MESSAGES, errorInfo, userMessage,
  sha512Matches, resolveUpdateTarget, GITHUB_OWNER, GITHUB_REPO, GITHUB_API,
};
