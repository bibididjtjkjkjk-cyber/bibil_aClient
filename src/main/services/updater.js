'use strict';
/**
 * Надійне оновлення лаунчера bibil_aClient.
 *
 * Джерела (за пріоритетом):
 *   1) GitHub Releases API  GET /repos/{owner}/{repo}/releases/latest
 *   2) Налаштоване дзеркало GET {feed}/latest.json
 *   3) latest.json безпосередньо з GitHub Releases (без API)
 *
 * Можливості:
 *   - GITHUB_TOKEN / GH_TOKEN / updater.githubToken => обхід rate limit;
 *   - 403/429 => автоматичний fallback на дзеркало/manifest;
 *   - перевірка draft/prerelease, наявності ассетів, версії, цілісності;
 *   - перевірка SHA-256 (пріоритет) та SHA-512 для сумісності;
 *   - завантаження потоком з прогресом (відсотки + швидкість), повторні спроби;
 *   - перевірка вільного місця на диску перед завантаженням/встановленням;
 *   - self-update через окремий PowerShell-хелпер: очікує закриття процесу,
 *     робить резервну копію, підміняє exe/запускає Setup, перевіряє старт,
 *     виконує відкат при невдалому запуску (portable), видаляє тимчасові файли;
 *   - захист від нескінченного циклу повторних спроб оновлення;
 *   - збереження журналу оновлень на диску;
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
const { VERSION, ENV_UPDATE_URL } = require('../config');
const log = require('../logger');

const GITHUB_OWNER = process.env.BIBIL_GITHUB_OWNER || 'bibididjtjkjkjk-cyber';
const GITHUB_REPO = process.env.BIBIL_GITHUB_REPO || 'bibil_aClient';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
const GITHUB_RELEASES = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

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
  BAD_MANIFEST: 'Маніфест оновлення пошкоджено або має невірну версію чи хеш.',
  HASH_MISMATCH: 'Хеш файлу не збігся — завантаження може бути пошкоджене.',
  NO_ASSET: 'У релізі немає потрібного файлу для вашого типу збірки.',
  FILE_LOCKED: 'Файл лаунчера зайнятий іншим процесом. Закрийте лаунчер і повторіть.',
  PERMISSION: 'Недостатньо прав для заміни файлів. Запустіть лаунчер від імені адміністратора.',
  ANTIVIRUS: 'Антивірус заблокував заміну файлу. Додайте папку лаунчера у винятки.',
  HELPER_START: 'Не вдалося запустити помічник оновлення. Повторіть спробу.',
  UNSUPPORTED: 'Автооновлення доступне тільки у встановленій або portable збірці для Windows.',
  ALREADY: 'Оновлення вже виконується.',
  BUSY: 'Спочатку закрийте гру — потім можна оновлювати лаунчер.',
  NO_SPACE: 'Недостатньо вільного місця на диску для завантаження або встановлення оновлення.',
  RETRY_LIMIT: 'Не вдалося завершити оновлення після кількох спроб. Спробуйте пізніше.',
  LOOP_GUARD: 'Оновлення до цієї версії тимчасово призупинено після невдалих спроб. Спробуйте пізніше або перевірте журнал.',
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
/** Версії виду 1.21.4, 26.3, 1.20 та інші формати з дозволеними суфіксами. */
const VERSION_RE = /^\d+(\.\d+){1,3}([-+][0-9A-Za-z.-]+)?$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHelperStart(startedFile, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fsp.access(startedFile);
      return true;
    } catch { /* wait for the helper to create its startup marker */ }
    if (child.exitCode !== null || child.signalCode !== null) return false;
    await sleep(100);
  }
  return false;
}

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
  if (info.code === 'NO_SPACE') return ERROR_MESSAGES.NO_SPACE;
  return e?.message || ERROR_MESSAGES.UNKNOWN;
}

async function checkDiskSpace(targetPath, requiredBytes) {
  const need = Number(requiredBytes) || 0;
  if (need <= 0) return { ok: true, free: null };
  try {
    if (typeof fsp.statfs !== 'function') return { ok: true, free: null };
    const st = await fsp.statfs(targetPath);
    const free = Number(st.bavail) * Number(st.bsize);
    if (!Number.isFinite(free)) return { ok: true, free: null };
    return { ok: free >= need, free, required: need };
  } catch {
    return { ok: true, free: null };
  }
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function hashFile(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => h.update(c));
    stream.on('end', () => resolve(h.digest()));
    stream.on('error', reject);
  });
}

async function hashMatches(file, expected, algo = 'sha512') {
  const want = String(expected || '').replace(/\s/g, '');
  if (!want) return false;
  const buf = await hashFile(file, algo);
  const hexLen = algo === 'sha256' ? 64 : 128;
  if (want.length === hexLen) return buf.toString('hex').toLowerCase() === want.toLowerCase();
  return buf.toString('base64') === want;
}

async function verifyIntegrity(file, { sha256, sha512 } = {}) {
  const checks = [];
  if (sha256) checks.push({ algo: 'sha256', expected: sha256 });
  if (sha512) checks.push({ algo: 'sha512', expected: sha512 });
  if (!checks.length) throw new UpdateError('BAD_MANIFEST', 'У маніфесті оновлення немає контрольного хешу (SHA-256/SHA-512).');
  for (const c of checks) {
    const ok = await hashMatches(file, c.expected, c.algo);
    if (!ok) throw new UpdateError('HASH_MISMATCH', `Хеш ${c.algo.toUpperCase()} не збігся — файл пошкоджено.`, { detail: c.algo });
  }
  return true;
}

/** Шлях до exe, який треба замінити. Для portable — оригінальний SFX, а не тимчасовий розпакований файл. */
function resolveUpdateTarget(portable, { execPath, portableExe = '' } = {}) {
  const appExe = execPath || process.execPath;
  return portable ? (portableExe || appExe) : appExe;
}

function buildUpdateScript({ pid, portable, src, target, logFile, startedFile = `${logFile}.started`, backupPath = '' }) {
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const backup = backupPath || `${target}.bak`;
  const installLine = portable
    ? [
      '$backup = $backupPath',
      'if (Test-Path -LiteralPath $backup -PathType Leaf) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }',
      'if (Test-Path -LiteralPath $target -PathType Leaf) { Copy-Item -LiteralPath $target -Destination $backup -Force -ErrorAction SilentlyContinue }',
      '$copied = $false',
      'for ($i = 0; $i -lt 10 -and -not $copied; $i++) {',
      '  try { Copy-Item -LiteralPath $src -Destination $target -Force -ErrorAction Stop; $copied = $true }',
      '  catch { Start-Sleep -Milliseconds 700 }',
      '}',
      'if (-not $copied) { throw "Не вдалося замінити portable exe після 10 спроб" }',
    ].join('\r\n  ')
    : `$setup = Start-Process -FilePath $src -ArgumentList '/S' -Wait -PassThru -ErrorAction Stop; if ($setup.ExitCode -ne 0) { throw "NSIS exit $($setup.ExitCode)" }`;

  return [
    '$ErrorActionPreference = "Stop"',
    `$waitPid = ${pid}`,
    `$portable = ${portable ? '$true' : '$false'}`,
    `$src = ${q(src)}`,
    `$target = ${q(target)}`,
    `$log = ${q(logFile)}`,
    `$startedFile = ${q(startedFile)}`,
    `$backupPath = ${q(backup)}`,
    '$rollbackDone = $false',
    'function Write-Log([string]$msg) { "[$(Get-Date -Format o)] $msg" | Out-File -LiteralPath $log -Append -Encoding utf8 }',
    'try {',
    '  Write-Log "START portable=$portable pid=$waitPid src=$src target=$target"',
    '  Set-Content -LiteralPath $startedFile -Value "started" -Encoding Ascii',
    '  $waitUntil = (Get-Date).AddSeconds(60)',
    '  while ((Get-Process -Id $waitPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $waitUntil) { Start-Sleep -Milliseconds 400 }',
    '  if (Get-Process -Id $waitPid -ErrorAction SilentlyContinue) { throw "Launcher process $waitPid did not exit" }',
    '  Start-Sleep -Milliseconds 700',
    `  ${installLine}`,
    '  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Updated launcher executable not found: $target" }',
    '  $working = [System.IO.Path]::GetDirectoryName($target)',
    '  $started = Start-Process -FilePath $target -WorkingDirectory $working -PassThru -ErrorAction Stop',
    '  Start-Sleep -Seconds 5',
    '  if (-not (Get-Process -Id $started.Id -ErrorAction SilentlyContinue)) { throw "Updated launcher exited during startup" }',
    '  if ($portable -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) { Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue }',
    '  Write-Log "OK portable=$portable src=$src target=$target pid=$($started.Id)"',
    '} catch {',
    '  $errMsg = $_.Exception.Message',
    '  Write-Log "FAIL portable=$($portable) line=$($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)"',
    '  if ($portable -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {',
    '    try {',
    '      Copy-Item -LiteralPath $backupPath -Destination $target -Force -ErrorAction Stop',
    '      $working = [System.IO.Path]::GetDirectoryName($target)',
    '      Start-Process -FilePath $target -WorkingDirectory $working -ErrorAction SilentlyContinue | Out-Null',
    '      $rollbackDone = $true',
    '      Write-Log "ROLLBACK restored portable backup"',
    '    } catch { Write-Log "ROLLBACK failed: $($_.Exception.Message)" }',
    '  }',
    '}',
    'if (-not $rollbackDone -and $portable -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) { }',
    'Remove-Item -LiteralPath $startedFile -Force -ErrorAction SilentlyContinue',
    'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
    '',
  ].join('\r\n');
}

function sha512Matches(file, expected) {
  return hashMatches(file, expected, 'sha512');
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
    this.historyEntries = [];
    this.guardState = { failed: {}, pending: null, lastSuccess: null };
    this._persistFile = this.paths?.config ? path.join(this.paths.config, 'updater-state.json') : '';
    this._loadPersisted();
    this.state = {
      state: 'idle', version: VERSION, latest: null, progress: 0, speed: 0,
      phase: '', message: '', error: null, supported: this.supported(), url: this.sourceLabel(),
      detail: null,
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

  sourceLabel() {
    return this.feedUrl() || 'GitHub Releases';
  }

  canCheck() { return !!GITHUB_OWNER; }

  info() {
    return {
      ...this.state,
      supported: this.supported(),
      url: this.sourceLabel(),
      release: this.candidate ? {
        version: this.candidate.version,
        notes: String(this.candidate.notes || '').slice(0, 2000),
        publishedAt: this.candidate.publishedAt || null,
        via: this.candidate.via || '',
        size: this._candidateAsset()?.size || 0,
        file: this._candidateAsset()?.name || '',
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
        ? fs.readFileSync(this._helperLog(), 'utf8').trim().split(/\r?\n/).slice(-12).join('\n')
        : '';
    } catch { return ''; }
  }

  _helperLog() { return path.join(os.tmpdir(), 'bibil-updater.log'); }

  _log(stage, e) {
    const info = errorInfo(e, stage);
    log.error(`[updater] stage=${info.stage} code=${info.code} http=${info.httpStatus ?? '-'}: ${info.message}`, info);
  }

  _loadPersisted() {
    if (!this._persistFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this._persistFile, 'utf8'));
      if (Array.isArray(raw.history)) this.historyEntries = raw.history.slice(-100);
      if (raw.guard && typeof raw.guard === 'object') this.guardState = { failed: {}, pending: null, lastSuccess: null, ...raw.guard };
    } catch { /* no state yet */ }
  }

  _savePersisted() {
    if (!this._persistFile) return;
    try {
      fs.mkdirSync(path.dirname(this._persistFile), { recursive: true });
      const data = JSON.stringify({ history: this.historyEntries.slice(-100), guard: this.guardState }, null, 2);
      fs.writeFileSync(this._persistFile, data, 'utf8');
    } catch (e) { log.warn('[updater] Не вдалося зберегти стан оновлень:', e.message); }
  }

  _pushHistory(entry) {
    this.historyEntries.push({ at: Date.now(), ...entry });
    this.historyEntries = this.historyEntries.slice(-100);
    this._savePersisted();
  }

  _candidateAsset() {
    if (!this.candidate) return null;
    return this.isPortableBuild() ? this.candidate.portable : (this.candidate.setup || this.candidate.portable);
  }

  _guardKey(version) { return `v:${cleanVersion(version)}`; }

  _isGuarded(version) {
    const key = this._guardKey(version);
    const rec = this.guardState.failed?.[key];
    if (!rec) return false;
    const attempts = Number(rec.attempts || 0);
    const at = Number(rec.at || 0);
    // 3+ невдалих спроби протягом 24 годин => тимчасово не авто-оновлювати цю версію.
    if (attempts >= 3 && Date.now() - at < 24 * 60 * 60 * 1000) return true;
    return false;
  }

  _markGuardFailure(version, code) {
    const v = cleanVersion(version);
    if (!v) return;
    const key = this._guardKey(v);
    const prev = this.guardState.failed?.[key] || { attempts: 0 };
    this.guardState.failed[key] = { attempts: Number(prev.attempts || 0) + 1, at: Date.now(), code: code || 'UNKNOWN' };
    this._savePersisted();
  }

  _clearGuard(version) {
    const v = cleanVersion(version);
    if (!v) return;
    if (this.guardState.failed) delete this.guardState.failed[this._guardKey(v)];
    this.guardState.pending = null;
    this._savePersisted();
  }

  async _backupUserConfig() {
    const cfg = this.paths?.config;
    if (!cfg) return null;
    try {
      const st = await fsp.stat(cfg).catch(() => null);
      if (!st?.isDirectory()) return null;
      const backupDir = path.join(path.dirname(cfg), 'config-backup-updater');
      await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(path.dirname(backupDir), { recursive: true });
      await fsp.cp(cfg, backupDir, { recursive: true, force: true });
      log.info(`[updater] Резервна копія налаштувань: ${backupDir}`);
      return backupDir;
    } catch (e) {
      log.warn('[updater] Не вдалося створити резервну копію налаштувань:', e.message);
      return null;
    }
  }

  _assetHashes(asset) {
    return {
      sha256: asset?.sha256 || '',
      sha512: asset?.sha512 || '',
    };
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
  async check({ internal = false, force = false } = {}) {
    if ((this.installing || this._installStarting) && !internal) throw new UpdateError('ALREADY');
    if (!this.canCheck() || !this.supported()) {
      const msg = ERROR_MESSAGES.UNSUPPORTED;
      this._set({ state: 'unavailable', message: msg, error: errorInfo(new UpdateError('UNSUPPORTED'), 'check') });
      throw new UpdateError('UNSUPPORTED', msg);
    }
    this._set({ state: 'checking', phase: 'check', progress: 0, speed: 0, message: 'Перевіряємо оновлення…', error: null, detail: null });

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
        try {
          release = await this._checkGitHubManifest();
          via = 'github-release';
        } catch (manifestErr) {
          this._log('github-release', manifestErr);
          const networkLike = (e) => e && (e.code === 'NETWORK' || (e.code === 'NO_RELEASE' && /дзеркал/i.test(e.message || '')));
          const code = githubErr.code === 'RATE_LIMIT' ? 'RATE_LIMIT'
            : githubErr.code === 'NO_RELEASE' && mirrorErr.code === 'NO_RELEASE' && manifestErr.code === 'NO_RELEASE' ? 'NO_RELEASE'
              : githubErr.code === 'NETWORK' && networkLike(mirrorErr) && manifestErr.code === 'NETWORK' ? 'NETWORK'
                : 'HTTP';
          const msg = code === 'RATE_LIMIT' ? ERROR_MESSAGES.RATE_LIMIT
            : code === 'NO_RELEASE' ? ERROR_MESSAGES.NO_RELEASE
              : code === 'NETWORK' ? ERROR_MESSAGES.NETWORK : ERROR_MESSAGES.HTTP;
          const err = new UpdateError(code, msg, {
            httpStatus: githubErr.httpStatus || mirrorErr.httpStatus || manifestErr.httpStatus,
            detail: `github: ${githubErr.message} | mirror: ${mirrorErr.message} | github release: ${manifestErr.message}`,
          });
          this._pushHistory({ version: null, via: 'check', result: 'error', ok: false, error: code, notes: msg });
          this._set({ state: 'error', message: msg, error: errorInfo(err, 'check') });
          throw err;
        }
      }
    }

    // Змінилася версія релізу — раніше завантажений exe більше не можна ставити.
    if (this.candidate && this.candidate.version !== release.version) {
      this.downloadedFile = '';
      this.downloadedVersion = '';
    }
    this.candidate = { ...release, via };
    const newer = compareVersions(release.version, VERSION) > 0;
    const guarded = newer && !force && this._isGuarded(release.version);
    const msg = guarded
      ? `Версія ${release.version} доступна, але автооновлення тимчасово призупинено після невдалих спроб.`
      : newer ? `Знайдено версію ${release.version}` : 'У вас найновіша версія';
    log.info(`[updater] ${via}: latest=${release.version}, current=${VERSION}, newer=${newer}, guarded=${guarded}`);
    this._pushHistory({ version: release.version, via, result: newer ? (guarded ? 'guarded' : 'available') : 'up-to-date', ok: true, notes: String(release.notes || '').slice(0, 300) });
    return this._set({
      state: newer ? 'available' : 'up-to-date',
      latest: release.version, message: msg, phase: '', error: null,
      detail: { guarded, size: this._candidateAsset()?.size || 0 },
    });
  }

  /** История проверок и установок обновлений (новые сверху). */
  history() { return this.historyEntries.slice().reverse(); }

  async _checkGitHub() {
    const res = await this._fetch(`${GITHUB_API}/releases/latest`);
    const data = await res.json();
    if (data.draft || data.prerelease) {
      throw new UpdateError('NO_RELEASE', 'Останній реліз є чернеткою або пререлізом.', { httpStatus: 200 });
    }
    const version = cleanVersion(data.tag_name || data.name);
    if (!version || !VERSION_RE.test(version)) {
      throw new UpdateError('BAD_MANIFEST', undefined, { detail: `tag=${data.tag_name}` });
    }
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const setup = assets.find((a) => /setup.*\.exe$/i.test(a.name) || /-Setup-\d/i.test(a.name));
    const portable = assets.find((a) => /\.exe$/i.test(a.name) && a.name !== (setup && setup.name));
    // latest.json contains checksums for launcher executables.
    const manifest = assets.find((a) => /^latest\.json$/i.test(a.name));
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
    const setupSha512 = meta.sha512 || meta.sha512Hex || '';
    const portableSha512 = meta.portableSha512 || meta.portableSha512Hex || '';
    const setupSha256 = meta.sha256 || meta.sha256Hex || '';
    const portableSha256 = meta.portableSha256 || meta.portableSha256Hex || '';
    return {
      version, tag: data.tag_name, publishedAt: data.published_at, notes: data.body || '',
      setup: setup && { name: setup.name, url: setup.browser_download_url, size: setup.size, sha512: setupSha512, sha256: setupSha256 },
      portable: portable && { name: portable.name, url: portable.browser_download_url, size: portable.size, sha512: portableSha512, sha256: portableSha256 },
      sha512: setupSha512, sha256: setupSha256, meta,
    };
  }

  async _checkGitHubManifest() {
    const res = await this._fetch(`${GITHUB_RELEASES}/latest/download/latest.json?t=${Date.now()}`);
    const meta = await res.json();
    const version = cleanVersion(meta.version);
    if (!version || !VERSION_RE.test(version)) {
      throw new UpdateError('BAD_MANIFEST', undefined, { detail: `version=${meta.version}` });
    }

    const asset = (name, hashes, size) => {
      const file = String(name || '');
      const hasHash = !!(hashes?.sha256 || hashes?.sha512);
      if (!file || path.basename(file) !== file || !/\.exe$/i.test(file) || !hasHash) return null;
      const tag = encodeURIComponent(`v${version}`);
      return {
        name: file,
        url: `${GITHUB_RELEASES}/download/${tag}/${encodeURIComponent(file)}`,
        size: Number(size) || 0,
        sha512: hashes.sha512 || '',
        sha256: hashes.sha256 || '',
      };
    };
    const setup = asset(meta.file, { sha512: meta.sha512 || meta.sha512Hex, sha256: meta.sha256 || meta.sha256Hex }, meta.size);
    if (!setup) throw new UpdateError('BAD_MANIFEST', undefined, { detail: 'Setup filename or hash is missing' });
    const portable = asset(meta.portable, { sha512: meta.portableSha512 || meta.portableSha512Hex, sha256: meta.portableSha256 || meta.portableSha256Hex }, meta.portableSize);
    return {
      version, tag: `v${version}`, publishedAt: meta.releaseDate || null, notes: meta.notes || '',
      setup, portable, sha512: setup.sha512 || '', sha256: setup.sha256 || '', meta,
    };
  }

  async _checkMirror() {
    const base = this.feedUrl();
    if (!base) throw new UpdateError('NO_RELEASE', 'Не вказано адресу дзеркала оновлень.');
    const res = await this._fetch(`${base}latest.json`);
    const meta = await res.json();
    const version = cleanVersion(meta.version);
    if (!version || !VERSION_RE.test(version)) throw new UpdateError('BAD_MANIFEST');
    const file = meta.file || meta.path || `bibil_aClient-Setup-${version}.exe`;
    const resolve = (name) => new URL(encodeURIComponent(name), base).toString();
    const setup = { name: file, url: resolve(file), size: meta.size || 0, sha512: meta.sha512 || '', sha256: meta.sha256 || '' };
    if (!setup.sha512 && !setup.sha256) throw new UpdateError('BAD_MANIFEST', undefined, { detail: 'Setup hash is missing in mirror manifest' });
    return {
      version, publishedAt: meta.releaseDate || meta.publishedAt || null, notes: meta.notes || '',
      setup,
      portable: meta.portable ? { name: meta.portable, url: resolve(meta.portable), size: meta.portableSize || 0, sha512: meta.portableSha512 || '', sha256: meta.portableSha256 || '' } : null,
      sha512: meta.sha512 || '', sha256: meta.sha256 || '', meta,
    };
  }

  /** Тихая проверка при старте. */
  async checkOnStart() {
    const u = this.settings?.get?.()?.updater || {};
    if (!u.enabled || !u.autoCheck || !this.canCheck() || !this.supported()) return;
    try {
      await this.check();
      if (this.state.state === 'available' && u.autoInstall && !this.isBusy()) {
        if (this.state.detail?.guarded) {
          log.warn(`[updater] Автооновлення до ${this.state.latest} пропущено: активний захист від повторних невдалих спроб.`);
          return;
        }
        await this.download();
        await this.install();
      }
    } catch (e) {
      log.warn('[updater] автоперевірка пропущена:', e.code || e.message);
    }
  }

  // ---------------------------------------------------------------- download

  /** Скачать ассет с прогрессом. Возвращает путь к файлу. */
  async download(asset, { maxRetries = 3 } = {}) {
    // Для portable не можна підсунути NSIS Setup — це інший бінарник.
    asset = asset || this._candidateAsset();
    if (!asset?.url || !isHttps(asset.url)) throw new UpdateError('NO_ASSET');

    const hashes = this._assetHashes(asset);
    if (!hashes.sha256 && !hashes.sha512) {
      // Запасний хеш (setup) підходить лише для самого setup, не для portable.
      if (asset === this.candidate?.setup) {
        hashes.sha512 = this.candidate?.sha512 || '';
        hashes.sha256 = this.candidate?.sha256 || '';
      }
    }
    if (!hashes.sha256 && !hashes.sha512) {
      throw new UpdateError('BAD_MANIFEST', 'У маніфесті оновлення немає SHA-256/SHA-512 для вибраного файлу.', { detail: asset.name || asset.url });
    }

    const tmpDir = path.join(os.tmpdir(), 'bibil-updates');
    await fsp.mkdir(tmpDir, { recursive: true });
    const required = Number(asset.size) || 0;
    const space = await checkDiskSpace(tmpDir, required ? required + 50 * 1024 * 1024 : 0);
    if (!space.ok) {
      throw new UpdateError('NO_SPACE', undefined, { detail: `Потрібно ~${formatBytes(space.required)}, вільно ${formatBytes(space.free)}` });
    }

    const safeName = path.basename(new URL(asset.url).pathname).replace(/[^\w.\-()]+/g, '_') || `update-${Date.now()}.exe`;
    const dest = path.join(tmpDir, safeName);
    const part = dest + '.part';
    const attempts = Math.max(1, Number(maxRetries) || 1);
    let lastErr = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      this._abort = new AbortController();
      this._set({ state: 'downloading', phase: 'download', progress: 0, speed: 0, error: null,
        message: attempts > 1 ? `Завантаження… (спроба ${attempt}/${attempts})` : 'Завантаження…', detail: { attempt, attempts, total: required } });
      log.info(`[updater] download attempt ${attempt}/${attempts} ${asset.url} -> ${dest}`);
      try {
        const res = await this._fetch(asset.url, { timeout: 0, signal: this._abort.signal, notFoundCode: 'NO_ASSET' });
        const total = Number(res.headers.get('content-length') || asset.size || 0);
        if (!res.body) throw new UpdateError('NETWORK', 'Сервер не повернув дані файлу.');
        const file = await fsp.open(part, 'w');
        let downloaded = 0;
        let last = Date.now();
        let lastBytes = 0;
        let speed = 0;
        let lastActivity = Date.now();
        const stallTimer = setInterval(() => {
          if (Date.now() - lastActivity > 60000) { try { this._abort?.abort(); } catch { /* noop */ } }
        }, 10000);
        try {
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
            lastActivity = Date.now();
            this._set({
              state: 'downloading', phase: 'download', progress: percent, speed,
              message: `Завантаження: ${percent}%${speed ? ` · ${speed} КБ/с` : ''}`,
              detail: { downloaded, total, attempt, attempts },
            });
          }
        } finally { clearInterval(stallTimer); await file.close(); }
        if (total && downloaded !== total) {
          throw new UpdateError('NETWORK', 'Завантаження перервано до завершення.', { detail: `${downloaded}/${total}` });
        }

        this._set({ state: 'downloading', phase: 'verify', progress: 100, speed: 0, message: 'Перевіряємо цілісність файлу…', detail: { downloaded, total } });
        await verifyIntegrity(part, hashes);
        const algos = [hashes.sha256 && 'SHA-256', hashes.sha512 && 'SHA-512'].filter(Boolean).join(' + ');
        log.info(`[updater] Цілісність підтверджено (${algos})`);

        await fsp.rm(dest, { force: true });
        await fsp.rename(part, dest);
        this.downloadedFile = dest;
        this.downloadedVersion = this.candidate?.version || '';
        this._set({ state: 'downloaded', phase: 'verify', progress: 100, speed: 0, message: 'Файл оновлення готовий до встановлення.', detail: { downloaded, total, file: dest } });
        return dest;
      } catch (e) {
        await fsp.rm(part, { force: true }).catch(() => {});
        if (e instanceof UpdateError && e.code === 'NETWORK' && /скасовано/i.test(e.message)) {
          this._set({ state: 'idle', message: 'Завантаження скасовано', error: null, phase: '' });
          throw e;
        }
        lastErr = e instanceof UpdateError ? e : new UpdateError('NETWORK', userMessage(e), { detail: e.message });
        this._log('download', lastErr);
        const retryable = ['NETWORK', 'HTTP'].includes(lastErr.code) || lastErr.code === 'HASH_MISMATCH';
        if (!retryable || attempt >= attempts) break;
        this._set({ state: 'downloading', phase: 'download', progress: 0, speed: 0, message: `Помилка завантаження, повторна спроба (${attempt}/${attempts})…`, error: errorInfo(lastErr, 'download') });
        await sleep(800 * attempt);
      }
    }

    const err = lastErr instanceof UpdateError ? lastErr : new UpdateError('NETWORK', ERROR_MESSAGES.NETWORK);
    if (this.candidate?.version) this._markGuardFailure(this.candidate.version, err.code);
    this._set({ state: 'error', error: errorInfo(err, 'download'), message: err.message, phase: 'download' });
    throw err;
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
  async install({ force = false } = {}) {
    if (!this.supported()) throw new UpdateError('UNSUPPORTED');
    if (this.installing || this._installStarting) throw new UpdateError('ALREADY');
    if (this.isBusy()) throw new UpdateError('BUSY');
    this._installStarting = true;
    try {
      // check() не можна викликати з installing=true — інакше він кине ALREADY.
      if (!this.candidate || compareVersions(this.candidate.version, VERSION) <= 0
        || !this.downloadedFile || this.downloadedVersion !== this.candidate.version) {
        await this.check({ internal: true, force });
      }
      if (!this.candidate || compareVersions(this.candidate.version, VERSION) <= 0) {
        throw new UpdateError('NO_RELEASE', 'У вас найновіша версія — встановлювати нічого.');
      }
      if (!force && this._isGuarded(this.candidate.version)) {
        throw new UpdateError('LOOP_GUARD', undefined, { detail: this.candidate.version });
      }
      const portable = this.isPortableBuild();
      const asset = this._candidateAsset();
      if (!asset) throw new UpdateError('NO_ASSET');

      // Перевірка місця на диску для цільового розташування.
      const targetPath = resolveUpdateTarget(portable, { execPath: process.execPath, portableExe: process.env.PORTABLE_EXECUTABLE_FILE });
      const space = await checkDiskSpace(path.dirname(targetPath), (Number(asset.size) || 0) + 20 * 1024 * 1024);
      if (!space.ok) throw new UpdateError('NO_SPACE', undefined, { detail: `Потрібно ~${formatBytes(space.required)}, вільно ${formatBytes(space.free)}` });

      this.installing = true;
      this.guardState.pending = { version: this.candidate.version, at: Date.now() };
      this._savePersisted();

      const src = (this.downloadedFile && this.downloadedVersion === this.candidate.version)
        ? this.downloadedFile
        : await this.download(asset);

      // Повторна перевірка цілісності перед встановленням (на випадок пошкодження/зміни файлу).
      this._set({ state: 'installing', phase: 'verify', progress: 100, message: 'Перевіряємо цілісність перед встановленням…', error: null });
      await verifyIntegrity(src, this._assetHashes(asset));

      // Резервна копія важливих даних користувача (налаштування/профілі у userData не замінюються, але робимо бекап конфігів).
      this._set({ state: 'installing', phase: 'backup', progress: 100, message: 'Створюємо резервну копію налаштувань…', error: null });
      await this._backupUserConfig();

      this._set({ state: 'installing', phase: 'install', progress: 100, message: 'Замінюємо файли та перезапускаємо…', error: null });
      await this._runHelper({ src, portable, targetPath });
      this._pushHistory({ version: this.candidate?.version, result: 'install', ok: true, notes: 'Оновлення передано зовнішньому помічнику.' });
      return true;
    } catch (e) {
      const ver = this.candidate?.version || this.downloadedVersion || null;
      if (ver) this._markGuardFailure(ver, e?.code || 'UNKNOWN');
      this._pushHistory({ version: ver, result: 'install', ok: false, error: e?.code || 'UNKNOWN', notes: e?.message || '' });
      this._log('install', e);
      const err = e instanceof UpdateError ? e
        : new UpdateError(/EPERM|EACCES/i.test(e.message) ? 'PERMISSION'
          : /EBUSY|used|locked/i.test(e.message) ? 'FILE_LOCKED'
            : /ENOSPC|no space/i.test(e.message) ? 'NO_SPACE' : 'UNKNOWN', userMessage(e), { detail: e.message });
      this._set({ state: 'error', error: errorInfo(err, 'install'), message: err.message });
      throw err;
    } finally {
      this._installStarting = false;
      // Процес завершується разом із хелпером; прапорець знімаємо тільки при помилці.
      if (this.state.state === 'error') this.installing = false;
    }
  }

  /** Хелпер — окремий PowerShell-процес. Не тримаємо exe відкритим у основного процесу. */
  async _runHelper({ src, portable, targetPath }) {
    const pid = process.pid;
    // У portable-збірці process.execPath — тимчасово розпакований exe з $TEMP.
    // PORTABLE_EXECUTABLE_FILE вказує на оригінальний exe користувача — його й міняємо.
    const target = targetPath || resolveUpdateTarget(portable, {
      execPath: process.execPath,
      portableExe: process.env.PORTABLE_EXECUTABLE_FILE,
    });
    const logFile = this._helperLog();
    this._set({ state: 'installing', phase: 'restart', message: 'Перезапуск…', progress: 100 });
    const helper = path.join(os.tmpdir(), `bibil-update-${Date.now()}.ps1`);
    const startedFile = helper + '.started';
    const backupPath = target + '.bak';
    // PowerShell 5.1 читає .ps1 без BOM як ANSI — кириличні шляхи зіпсуються.
    const script = buildUpdateScript({ pid, portable, src, target, logFile, startedFile, backupPath });
    await fsp.writeFile(helper, `\uFEFF${script}`, 'utf8');
    log.info(`[updater] helper=${helper} target=${target} portable=${portable}`);
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    if (await waitForHelperStart(startedFile, child)) {
      await fsp.rm(startedFile, { force: true });
      this.guardState.pending = { version: this.candidate?.version || '', at: Date.now(), helper: true };
      this._savePersisted();
      setTimeout(() => {
        try { electronApp?.exit(0); } catch { /* noop */ }
      }, 1200);
      return true;
    }
    try { child.kill(); } catch { /* noop */ }
    await fsp.rm(startedFile, { force: true });
    throw new UpdateError('HELPER_START', undefined, { detail: helper });
  }
}

module.exports = {
  UpdaterService, UpdateError, compareVersions, ERROR_MESSAGES, errorInfo, userMessage,
  sha512Matches, hashMatches, verifyIntegrity, checkDiskSpace, formatBytes,
  resolveUpdateTarget, buildUpdateScript, waitForHelperStart,
  GITHUB_OWNER, GITHUB_REPO, GITHUB_API, GITHUB_RELEASES,
};