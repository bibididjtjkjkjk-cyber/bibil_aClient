'use strict';
const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Client } = require('minecraft-launcher-core');
const { splitArgs, safeJvmArgs, buildJvmArgs } = require('../util/args');
const { lastCrash, explainLog, nativeHint } = require('../util/crash');
const { applyMinecraftOptions, applyGraphicsBackend } = require('./game-optimization');
const { optimalRamMb } = require('./settings');
const log = require('../logger');

const MAX_SESSION_LINES = 5000;

/**
 * Подготовка и запуск игры: аккаунт → Java → (Fabric) → minecraft-launcher-core
 * (скачивает клиент, библиотеки и ассеты с серверов Mojang и стартует процесс).
 */
class GameLauncher extends EventEmitter {
  constructor({ paths, settings, profiles, auth, versions, java, installer, mods, retryDelay = 1500 }) {
    super();
    Object.assign(this, { paths, settings, profiles, auth, versions, java, installer, mods });
    this.retryDelay = retryDelay;
    this.session = null;
    this.state = { status: 'idle', message: '', profileId: null, progress: null };
    this._attempt = 0;   // скільки разів автоматично повторюємо запуск після крашу
    this._token = 0;     // щоб застарілий таймер повтору не перебив новий запуск
  }

  getState() {
    return this.state;
  }

  _set(status, message = '', extra = {}) {
    this.state = { status, message, profileId: this.session?.profile.id ?? null, progress: null, ...extra };
    this.emit('state', this.state);
  }

  _log(line, level = 'game') {
    const s = this.session;
    if (s) {
      s.lines.push(line);
      if (s.lines.length > MAX_SESSION_LINES) s.lines.splice(0, s.lines.length - MAX_SESSION_LINES);
    }
    this.emit('log', { t: Date.now(), level, msg: line });
  }

  _checkAborted(session) {
    if (session.stopped) throw new Error('Запуск отменён');
  }

  /** safe=true: чистая ваниль без модов/ресурспаков и без пользовательских настроек. */
  async start(profileId, { safe = false, _retry = false } = {}) {
    if (this.session) throw new Error('Игра уже запускается или запущена');
    if (!_retry) {
      this._attempt = 0;
      this._token += 1;
    }
    const token = this._token;
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error('Профиль не найден');

    const session = { profile, stopped: false, child: null, startedAt: 0, lines: [], safe, moved: [], token };
    this.session = session;
    try {
      const s = this.settings.get();

      this._set('preparing', 'Проверка аккаунта…');
      const account = this.auth.getActive();
      if (!account) throw new Error('Сначала добавьте аккаунт на вкладке «Аккаунты»');
      const authorization = await this.auth.getAuthorization(account.id);
      this._checkAborted(session);

      const major = await this.versions.requiredJava(profile.version);
      this._set('preparing', `Подготовка Java ${major}…`);
      const javaPath = await this.java.resolve({
        major,
        custom: profile.javaPath || s.java.path,
        autoDownload: s.java.autoDownload,
        onProgress: (p) => this._set('downloading', `Загрузка Java ${major}…`, { progress: p.total ? p.done / p.total : null }),
      });
      this._checkAborted(session);

      let custom;
      if (profile.loader === 'fabric' && !safe) {
        this._set('preparing', 'Установка Fabric…');
        custom = await this.versions.installFabric(profile.version, profile.loaderVersion);
        this._checkAborted(session);
      }

      // Автоматическая установка версии (клиент, библиотеки, ассеты) с прогрессом.
      this._set('downloading', `Установка Minecraft ${profile.version}…`);
      const onInstall = (p) => {
        if (p.id === profile.version && this.session === session) this._set('downloading', p.message, { progress: p.progress });
      };
      this.installer.on('progress', onInstall);
      try {
        await this.installer.install(profile.version, { fabricId: custom || null });
      } finally {
        this.installer.off('progress', onInstall);
      }
      this._checkAborted(session);

      if (!safe && profile.loader === 'fabric' && s.game.performanceMods !== false) {
        this._set('preparing', 'Проверка оптимизационных модов…');
        try {
          const result = await this.mods.ensurePerformancePack(profile.id);
          if (result.installed.length) this._log(`Установлены оптимизационные моды: ${result.installed.join(', ')}`, 'info');
          if (result.skipped.length) this._log(`Нет совместимых версий оптимизационных модов для Minecraft ${profile.version}: ${result.skipped.join(', ')}`, 'warn');
        } catch (e) {
          this._log(`Оптимизационные моды не установлены: ${e.message}. Игра продолжит запуск без них.`, 'warn');
          this._set('preparing', `Не удалось установить оптимизационные моды; запускаем игру без них: ${e.message}`);
        }
        this._checkAborted(session);
      }

      const gameDir = this.paths.instanceDir(profile.id);
      await fsp.mkdir(path.join(gameDir, 'mods'), { recursive: true });
      await fsp.mkdir(path.join(gameDir, 'resourcepacks'), { recursive: true });
      if (safe) await this._suspendExtras(session);
      const optionsFile = path.join(gameDir, 'options.txt');
      if (!safe && s.game.optimization?.enabled) {
        await applyMinecraftOptions(optionsFile, s.game.optimization);
      }
      // Після невдалого старту MC скидає бекенд на «Default», що на AMD означає Vulkan
      // і краш у amdvlk64.dll. Пишемо вибір явно перед кожним запуском — у тому числі в безпечному режимі.
      await applyGraphicsBackend(optionsFile, s.game.graphicsBackend);

      const ramMax = profile.ramMax || (s.game.ramAuto ? optimalRamMb() : s.game.ramMax);
      const ramMin = Math.min(profile.ramMin || s.game.ramMin, ramMax);

      // Java 25 + LWJGL 3.4.3 can native-crash with explicit collector flags.
      // buildJvmArgs only adds conservative G1 tuning on older supported runtimes.
      const userJvm = safe ? '' : (profile.jvmArgs ?? s.game.jvmArgs);
      const rawJvm = splitArgs(userJvm);
      const safeUserJvm = safeJvmArgs(rawJvm);
      const jvmArgs = buildJvmArgs(safeUserJvm, major, { safe });
      if (safeUserJvm.length !== rawJvm.length) this._log('Небезпечні GC-аргументи JVM відкинуті лаунчером', 'warn');
      const version = { number: profile.version, type: await this.versions.getType(profile.version) };
      if (custom) version.custom = custom;

      const opts = {
        authorization,
        root: this.paths.root,
        javaPath,
        version,
        memory: { max: `${ramMax}M`, min: `${ramMin}M` },
        customArgs: jvmArgs,
        customLaunchArgs: safe ? [] : splitArgs(s.game.gameArgs),
        window: { width: s.game.width, height: s.game.height, fullscreen: s.game.fullscreen },
        overrides: { gameDirectory: gameDir, detached: false },
      };

      const client = new Client();
      client.on('debug', (m) => log.debug(`[MCLC] ${m}`));
      client.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) if (line) this._log(line);
      });
      client.on('progress', (e) => {
        if (this.session !== session || session.child) return;
        this._set('downloading', `Загрузка: ${e.type}`, { progress: e.total ? e.task / e.total : null });
      });
      client.on('package-extract', () => {
        if (this.session === session && !session.child) this._set('preparing', 'Распаковка нативных библиотек…');
      });
      client.on('close', (code) => this._finish(session, code));

      this._set('preparing', 'Загрузка файлов игры…');
      const child = await client.launch(opts);
      if (!child) throw new Error('Не удалось запустить процесс игры. Подробности — на вкладке «Консоль».');
      if (session.stopped) {
        child.kill();
        throw new Error('Запуск отменён');
      }
      session.child = child;
      session.startedAt = Date.now();
      this._set('running', 'Игра запущена', { startedAt: session.startedAt, pid: child.pid });
      this.emit('started', { profile, startedAt: session.startedAt });
      log.info(`Игра запущена: профиль «${profile.name}», Minecraft ${profile.version}, ${profile.loader}`);
    } catch (e) {
      await this._restoreExtras(session);
      if (this.session === session) {
        this.session = null;
        this._set(session.stopped ? 'idle' : 'error', session.stopped ? '' : e.message);
        this.emit('exit', { profile, code: null, failed: true });
      }
      log.error('Ошибка запуска:', e);
      throw e;
    }
  }

  /** Временно отключаем моды, ресурспаки и шейдеры для диагностики вылета. */
  async _suspendExtras(session) {
    const base = this.paths.instanceDir(session.profile.id);
    for (const dir of ['mods', 'resourcepacks', 'shaderpacks']) {
      let names = [];
      try { names = await fsp.readdir(path.join(base, dir)); } catch { continue; }
      for (const n of names) {
        if (!/\.(jar|zip)$/i.test(n)) continue;
        const from = path.join(base, dir, n);
        const to = from + '.disabled';
        try { await fsp.rename(from, to); session.moved.push({ from, to }); } catch { /* файл исчез */ }
      }
    }
    if (session.moved.length) this._log(`Безопасный запуск: временно отключено файлов — ${session.moved.length}`, 'warn');
  }

  async _restoreExtras(session) {
    if (!session.moved?.length) return;
    for (const { from, to } of session.moved) {
      try { await fsp.rename(to, from); } catch { /* оставляем как есть */ }
    }
    session.moved = [];
  }

  stop() {
    const s = this.session;
    if (!s) return;
    s.stopped = true;
    if (s.child) s.child.kill();
    else this._set('preparing', 'Отмена…');
  }

  async _finish(session, code) {
    if (this.session !== session) return;
    this.session = null;
    await this._restoreExtras(session);
    const playedMs = session.startedAt ? Date.now() - session.startedAt : 0;
    this.profiles.touch(session.profile.id, { playedMs });
    const ok = session.stopped || code === 0;
    // 0xC0000005 / 0xC0000409 — це нативний краш самої JVM (java.exe 25 + jvm.dll),
    // а не помилка мода чи ресурспака: crash-report при цьому не створюється.
    const nativeCodes = [3221225477, 3221226505, -1073741819, -1073742825];
    const nativeCrash = !ok && nativeCodes.includes(Number(code));
    let crash = null;
    let hint = '';
    if (!ok) {
      crash = await lastCrash(this.paths.instanceDir(session.profile.id));
      hint = crash?.hint || explainLog(session.lines);
      if (nativeCrash && !crash) {
        hint = await nativeHint(this.paths.root) ||
          'Нативний краш JVM (jvm.dll, Java 25). Оновіть драйвер відеокарти, вимкніть оверлеї GeForce/Discord/MSI Afterburner і спробуйте іншу збірку Java 25.';
      }
      log.warn(`Вылет игры: ${hint}${crash ? ` (${crash.file})` : ''}`);
      // Подсказка должна попасть и в сохранённый лог, а не только в консоль лаунчера.
      session.lines.push(`[launcher] Игра вылетела (код ${code}). ${hint}`);
    }
    await this._saveLog(session);

    // Краш нестабільний (у ~50% запусків на 26.3), тому 1–2 повторні спроби
    // у безпечному режимі дають набагато більше шансів одразу потрапити на сервер.
    const autoRetry = this.settings.get()?.launcher?.autoRetry !== false;
    if (nativeCrash && !session.stopped && autoRetry && this._attempt < 2
        && this._token === session.token && !this.session) {
      this._attempt += 1;
      const msg = `Гра вилетіла (код ${code}). Повторний запуск ${this._attempt}/2 у безпечному режимі…`;
      this._set('preparing', `Нативний краш JVM — повторний запуск (${this._attempt}/2)…`);
      this.emit('log', { t: Date.now(), level: 'warn', msg });
      log.warn(msg);
      const { id } = session.profile;
      setTimeout(() => {
        if (this._token !== session.token || this.session) return;
        this.start(id, { safe: true, _retry: true })
          .catch((e) => log.error('Не вдалося повторити запуск гри:', e));
      }, this.retryDelay);
      return;
    }

    this.state = {
      status: ok ? 'idle' : 'error',
      message: ok ? '' : `Игра вылетела (код ${code}). ${hint} Попробуйте кнопку «Безопасно» на главной.`,
      profileId: null,
      progress: null,
      crash,
      safe: session.safe,
    };
    this.emit('state', this.state);
    this.emit('exit', { profile: session.profile, code, failed: !ok, crash });
    log.info(`Игра завершена, код ${code}`);
  }

  async _saveLog(session) {
    try {
      const file = path.join(this.paths.logs, `game-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
      await fsp.writeFile(file, session.lines.join('\n'));
      await this._pruneLogs();
    } catch (e) {
      log.warn('Не удалось сохранить лог игры:', e.message);
    }
  }

  /** Оставляет 20 последних игровых логов. */
  async _pruneLogs() {
    const files = (await fsp.readdir(this.paths.logs)).filter((f) => f.startsWith('game-')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 20))) await fsp.rm(path.join(this.paths.logs, f), { force: true });
  }
}

module.exports = { GameLauncher };
