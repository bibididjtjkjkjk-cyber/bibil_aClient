'use strict';
/**
 * Интеграционный smoke-тест запуска игры без Electron-окна.
 * Использование: node scripts/smoke-launch.js [profileId] [--safe] [--seconds=60]
 */
process.env.NODE_ENV = 'test';
const path = require('path');
const os = require('os');

const userData = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'bibil_aClient')
  : path.join(os.homedir(), '.config', 'bibil_aClient');
const paths = {
  userData,
  root: path.join(userData, 'minecraft'),
  instances: path.join(userData, 'instances'),
  runtime: path.join(userData, 'runtime'),
  cache: path.join(userData, 'cache'),
  logs: path.join(userData, 'logs'),
  config: path.join(userData, 'config'),
  instanceDir(id) { return path.join(this.instances, id); },
  ensure() {},
};

const log = require('../src/main/logger');
log.init(paths.logs);

const { SettingsService } = require('../src/main/services/settings');
const { ProfileService } = require('../src/main/services/profiles');
const { AuthService } = require('../src/main/services/auth');
const { VersionService } = require('../src/main/services/versions');
const { JavaService } = require('../src/main/services/java');
const { InstallerService } = require('../src/main/services/installer');
if (process.argv.includes('--allow-gc')) {
  const args = require('../src/main/util/args');
  args.safeJvmArgs = (a) => a;
}
const { GameLauncher } = require('../src/main/services/launcher');

const settings = new SettingsService(path.join(paths.config, 'settings.json'));
const profiles = new ProfileService(path.join(paths.config, 'profiles.json'), paths, settings);
const auth = new AuthService(path.join(paths.config, 'accounts.json'), settings);
const versions = new VersionService(paths);
if (process.argv.includes('--no-auto-jvm')) versions.defaultJvmArgs = async () => [];
const java = new JavaService(paths);
const installer = new InstallerService({ paths, versions });
const launcher = new GameLauncher({ paths, settings, profiles, auth, versions, java, installer });

const safe = process.argv.includes('--safe');
const secondsArg = process.argv.find((a) => a.startsWith('--seconds='));
const seconds = secondsArg ? Number(secondsArg.split('=')[1]) || 60 : 60;
const wanted = process.argv.find((a) => a !== '--safe' && !a.startsWith('-'));
const jvmOpt = process.argv.find((a) => a.startsWith('--jvm='));
const javaOpt = process.argv.find((a) => a.startsWith('--java='));
const versionOpt = process.argv.find((a) => a.startsWith('--version='));
if (jvmOpt || javaOpt || versionOpt) {
  const origGet = profiles.get.bind(profiles);
  profiles.get = (id) => {
    const p = origGet(id);
    if (!p) return p;
    return {
      ...p,
      ...(jvmOpt ? { jvmArgs: jvmOpt.slice('--jvm='.length) } : {}),
      ...(javaOpt ? { javaPath: javaOpt.slice('--java='.length) } : {}),
      ...(versionOpt ? { version: versionOpt.slice('--version='.length) } : {}),
    };
  };
}
const profile = profiles.get(wanted) || profiles.getActive() || profiles.list()[0];
if (!profile) throw new Error('Нет профиля для запуска');

console.log(`СМОК: профиль «${profile.name}» (${profile.version}, ${profile.loader}), safe=${safe}`);
console.log(`СМОК: JVM-аргументы после миграции = ${JSON.stringify(settings.get().game.jvmArgs)}`);
console.log(`СМОК: аккаунт = ${auth.getActive()?.name ?? 'НЕТ'}`);

let lastState = '';
launcher.on('state', (s) => {
  const key = `${s.status}|${s.message}`;
  if (key === lastState) return;
  lastState = key;
  console.log(`СМОК состояние: ${s.status} — ${s.message}`);
});
launcher.on('log', ({ msg, level }) => {
  if (/\b(ERROR|FATAL|Exception|Crash|Вылет)\b/i.test(msg)) console.log(`СМОК лог [${level}]: ${msg.slice(0, 300)}`);
});

let watchdog = null;
let finished = false;
function done(code, text) {
  if (finished) return;
  finished = true;
  if (watchdog) clearTimeout(watchdog);
  console.log(text);
  process.exitCode = code;
  setTimeout(() => process.exit(code), 300);
}

launcher.on('exit', (e) => {
  const text = e.failed
    ? `СМОК ПРОВАЛ: код=${e.code}, подсказка=${e.crash?.hint || 'нет'}`
    : `СМОК OK: игра завершилась без вылета (код=${e.code}).`;
  done(e.failed ? 1 : 0, text);
});

launcher.start(profile.id, { safe }).then(() => {
  console.log(`СМОК: игра запущена, ждём ${seconds} с для проверки стабильности…`);
  watchdog = setTimeout(() => {
    if (finished) return;
    const s = launcher.session;
    if (s && s.child && !s.stopped) {
      console.log(`СМОК OK: игра проработала ${seconds} с без вылета — завершаем тест.`);
      launcher.stop();
      setTimeout(() => done(0, 'СМОК OK: Minecraft запускается и работает.'), 1500);
    } else {
      done(1, 'СМОК ПРОВАЛ: процесс игры не найден.');
    }
  }, seconds * 1000);
}).catch((e) => done(2, `СМОК ОШИБКА ЗАПУСКА: ${e.message}`));
