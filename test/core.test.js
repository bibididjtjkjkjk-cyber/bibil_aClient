'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { splitArgs, safeJvmArgs, buildJvmArgs } = require('../src/main/util/args');
const { JsonStore, deepMerge, prune } = require('../src/main/store');
const { SettingsService, normalize, DEFAULTS, maxRamMb, optimalRamMb, cleanArgs } = require('../src/main/services/settings');
const { buildFacets, pickBestVersion } = require('../src/main/services/modrinth');
const { guessJava, defaultJvmArgsFromMeta, versionInRange } = require('../src/main/services/versions');
const { normalize: normalizeProfile } = require('../src/main/services/profiles');
const { applyMinecraftOptions, applyGraphicsBackend, toMinecraftOptions } = require('../src/main/services/game-optimization');
const { AuthService, offlineUuid, offlineAuthorization } = require('../src/main/services/auth');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bibil-test-'));
const clone = (o) => JSON.parse(JSON.stringify(o));

test('splitArgs учитывает кавычки', () => {
  assert.deepEqual(splitArgs('-Xss1M -Dfoo="a b" \'c d\''), ['-Xss1M', '-Dfoo=a b', 'c d']);
  assert.deepEqual(splitArgs('   '), []);
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(
    safeJvmArgs('-XX:+UseG1GC -XX:MaxGCPauseMillis=100 -XX:+UseZGC -Dfoo=bar -Xss1M'),
    ['-Dfoo=bar', '-Xss1M'],
  );
});

test('JVM: подбирает безопасные G1-флаги по версии Java', () => {
  assert.deepEqual(buildJvmArgs(['-Dfoo=bar', '-XX:+UseZGC'], 21), [
    '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
    '-XX:+DisableExplicitGC', '-Dfoo=bar',
  ]);
  assert.deepEqual(buildJvmArgs(['-Dfoo=bar', '-XX:+UseG1GC'], 25), ['-Dfoo=bar']);
  assert.deepEqual(buildJvmArgs([], 21, { safe: true }), []);
});

test('ОЗУ: автоматически выделяется половина системы, максимум 6 ГБ', () => {
  assert.equal(optimalRamMb(4096), 2048);
  assert.equal(optimalRamMb(8192), 4096);
  assert.equal(optimalRamMb(32768), 6144);
  assert.equal(optimalRamMb(3072), 1536);
});

test('deepMerge не допускает prototype pollution', () => {
  const t = {};
  deepMerge(t, JSON.parse('{"__proto__":{"x":1},"a":{"b":2}}'));
  assert.equal({}.x, undefined);
  assert.equal(t.a.b, 2);
});

test('prune удаляет неизвестные ключи', () => {
  const o = { a: 1, z: 2, n: { b: 1, q: 2 } };
  prune(o, { a: 0, n: { b: 0 } });
  assert.deepEqual(o, { a: 1, n: { b: 1 } });
});

test('JsonStore: сохранение, чтение и восстановление после повреждения', () => {
  const dir = tmpDir();
  const file = path.join(dir, 's.json');
  const s = new JsonStore(file, { a: 1, n: { b: 2 } });
  s.patch({ n: { b: 5 } });
  s.save();
  assert.deepEqual(new JsonStore(file, { a: 1, n: { b: 2 } }).data, { a: 1, n: { b: 5 } });

  fs.writeFileSync(file, '{ битый json');
  const recovered = new JsonStore(file, { a: 1 });
  assert.deepEqual(recovered.data, { a: 1 });
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')));
});

test('settings.normalize ограничивает и очищает значения', () => {
  const s = clone(DEFAULTS);
  s.game.ramMax = 999999;
  s.game.ramMin = 70000;
  s.game.width = 'abc';
  s.launcher.theme = 'neon';
  s.launcher.language = 'fr';
  s.launcher.accent = 'red';
  const r = normalize(s);
  assert.equal(r.game.ramMax, maxRamMb());
  assert.ok(r.game.ramMin <= r.game.ramMax);
  assert.equal(r.game.width, 854);
  assert.equal(r.launcher.theme, 'dark');
  assert.equal(r.launcher.language, 'ru');
  assert.equal(r.launcher.accent, DEFAULTS.launcher.accent);
  assert.equal(r.game.optimization.enabled, true);
  assert.equal(r.game.optimization.preset, 'performance');
  assert.equal(r.game.performanceMods, true);
  assert.equal(r.game.ramAuto, true);
  assert.equal(r.game.optimization.renderDistance, 6);
  assert.equal(r.game.optimization.simulationDistance, 5);
  assert.equal(r.game.optimization.particles, 'minimal');
  assert.equal(r.game.optimization.entityDistance, 0.5);
  assert.equal(r.game.optimization.mipmapLevels, 0);
  assert.equal(r.game.optimization.maxFps, 220);
  s.game.optimization.renderDistance = 100;
  s.game.optimization.simulationDistance = 2;
  const tuned = normalize(s);
  assert.equal(tuned.game.optimization.renderDistance, 32);
  assert.equal(tuned.game.optimization.simulationDistance, 5);
  s.launcher.language = 'uk';
  assert.equal(normalize(s).launcher.language, 'uk');
  s.launcher.language = 'en';
  assert.equal(normalize(s).launcher.language, 'en');
});

test('settings migrate the previous unlimited FPS default to 220 FPS', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  const oldSettings = clone(DEFAULTS);
  oldSettings.game.optimization.maxFps = 260;
  fs.writeFileSync(file, JSON.stringify(oldSettings));

  const service = new SettingsService(file);
  assert.equal(service.get().game.optimization.maxFps, 220);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).game.optimization.maxFps, 220);
});

test('локальный аккаунт: UUID стабилен для ника, авторизация не требует Microsoft', () => {
  const auth = offlineAuthorization('Steve', 'local-client');
  assert.equal(auth.name, 'Steve');
  assert.match(auth.uuid, /^[0-9a-f]{32}$/);
  assert.equal(auth.uuid, offlineUuid('Steve'));
  assert.notEqual(auth.uuid, offlineUuid('Alex'));
  assert.equal(auth.access_token, auth.uuid);
  assert.equal(auth.client_token, 'local-client');
  assert.equal(auth.meta.type, 'mojang');
});

test('AuthService добавляет ник активным и выдаёт офлайн-авторизацию без настроек Microsoft', async () => {
  const service = new AuthService(path.join(tmpDir(), 'accounts.json'));
  const first = service.addOffline('Steve');
  const same = service.addOffline('steve');
  assert.equal(same.id, first.id);
  assert.equal(service.getActive().id, first.id);

  const authorization = await service.getAuthorization(first.id);
  assert.equal(authorization.name, 'Steve');
  assert.equal(authorization.uuid, offlineUuid('Steve'));
  assert.match(authorization.client_token, /^[0-9a-f]{32}$/);
});

test('оптимизация: нормализует настройки и записывает параметры, сохраняя остальные', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'options.txt');
  fs.writeFileSync(file, 'version:3465\r\nmusic:0.5\r\ngraphicsMode:1\r\nrenderDistance:12\r\n', 'utf8');

  await applyMinecraftOptions(file, {
    graphics: 'fast',
    renderDistance: 6,
    simulationDistance: 4,
    particles: 'minimal',
    clouds: 'off',
    entityDistance: 0.5,
    mipmapLevels: 0,
    maxFps: 260,
    vsync: false,
  });

  const result = fs.readFileSync(file, 'utf8');
  assert.match(result, /music:0\.5/);
  assert.match(result, /graphicsMode:0/);
  assert.match(result, /renderDistance:6/);
  assert.match(result, /simulationDistance:4/);
  assert.match(result, /particles:2/);
  assert.match(result, /clouds:0/);
  assert.match(result, /maxFps:260/);
  assert.match(result, /entityShadows:false/);
  assert.match(result, /biomeBlendRadius:0/);
  assert.equal((result.match(/^renderDistance:/gm) || []).length, 1);
  assert.deepEqual(toMinecraftOptions({
    graphics: 'fancy', renderDistance: 12, simulationDistance: 8, particles: 'all',
    clouds: 'fast', entityDistance: 1, mipmapLevels: 4, maxFps: 120, vsync: true,
  }), {
    graphicsMode: '1', renderDistance: '12', simulationDistance: '8', particles: '0',
    clouds: '1', entityDistanceScaling: '1', mipmapLevels: '4', maxFps: '120', enableVsync: 'true',
    entityShadows: 'false', biomeBlendRadius: '0',
  });
});

test('Modrinth: facets и выбор версии', () => {
  assert.deepEqual(buildFacets({ gameVersion: '1.21.1', loader: 'fabric', category: 'optimization' }), [
    ['project_type:mod'], ['versions:1.21.1'], ['categories:fabric'], ['categories:optimization'],
  ]);
  assert.deepEqual(buildFacets({ gameVersion: '1.21.1', loader: 'fabric', projectType: 'resourcepack' }), [
    ['project_type:resourcepack'], ['versions:1.21.1'],
  ]);
  const vs = [{ id: 'a', version_type: 'beta' }, { id: 'b', version_type: 'release' }];
  assert.equal(pickBestVersion(vs).id, 'b');
  assert.equal(pickBestVersion([{ id: 'x', version_type: 'alpha' }]).id, 'x');
  assert.equal(pickBestVersion([]), null);
});

test('оптимизационный модпак: ставятся только совместимые и ещё не установленные моды', async () => {
  const { ModManager } = require('../src/main/services/mods');
  const dir = tmpDir();
  const profile = { id: 'p1', version: '26.3', loader: 'fabric' };
  const modsDir = path.join(dir, profile.id, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'sodium.jar'), 'sodium');
  fs.writeFileSync(path.join(dir, profile.id, 'bibil-mods.json'), JSON.stringify({
    files: { 'sodium.jar': { projectId: 'AANobbMI', size: 6, title: 'Sodium' } },
  }));
  const modrinth = {
    projectVersions: async (id) => id === 'gvQqBUqZ' ? [{ id: 'lithium-v1' }] : [],
  };
  const manager = new ModManager({
    paths: { instanceDir: (id) => path.join(dir, id) },
    profiles: { get: (id) => id === profile.id ? profile : null },
    modrinth,
  });
  const installed = [];
  manager._install = async (_profileId, projectId) => {
    installed.push(projectId);
    return [{ title: projectId }];
  };

  const result = await manager.ensurePerformancePack(profile.id);
  assert.deepEqual(installed, ['gvQqBUqZ']);
  assert.deepEqual(result, {
    installed: ['gvQqBUqZ'],
    skipped: ['FerriteCore', 'ImmediatelyFast', 'Entity Culling'],
  });
});

test('установка модов не перезаписывает существующий JAR', async () => {
  const { ModManager } = require('../src/main/services/mods');
  const dir = tmpDir();
  const profile = { id: 'p1', version: '1.21.1', loader: 'fabric' };
  const modsDir = path.join(dir, profile.id, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'existing.jar'), 'keep this mod');
  const manager = new ModManager({
    paths: { instanceDir: (id) => path.join(dir, id) },
    profiles: { get: (id) => id === profile.id ? profile : null },
    modrinth: {
      projectVersions: async () => [{
        id: 'version-1', version_type: 'release', dependencies: [],
        files: [{ primary: true, filename: 'existing.jar', url: 'https://example.com/mod.jar' }],
      }],
    },
  });

  await assert.rejects(() => manager.install(profile.id, 'project-id'), /уже существует/);
  assert.equal(fs.readFileSync(path.join(modsDir, 'existing.jar'), 'utf8'), 'keep this mod');
});

test('guessJava по версии игры', () => {
  assert.equal(guessJava('1.12.2'), 8);
  assert.equal(guessJava('1.17.1'), 16);
  assert.equal(guessJava('1.20.1'), 17);
  assert.equal(guessJava('1.20.6'), 21);
  assert.equal(guessJava('1.21.4'), 21);
});

test('версия: обязательные JVM-флагы default-user-jvm и правила ОС', () => {
  assert.equal(versionInRange('10.0.26200', { min: '10.0.17134' }), true);
  assert.equal(versionInRange('10.0.26200', { max: '10.0.17134' }), false);
  assert.equal(versionInRange('10.0.15000', { min: '10.0.17134' }), false);
  const meta = { arguments: { 'default-user-jvm': [
    { value: ['-Xms2G', '-Xmx4G', '-XX:+UseCompactObjectHeaders', '-XX:+AlwaysPreTouch', '-XX:+UseStringDeduplication'] },
    { rules: [
      { action: 'allow', os: { name: 'osx' } }, { action: 'allow', os: { name: 'linux' } },
      { action: 'allow', os: { name: 'windows', versionRange: { min: '10.0.17134' } } },
    ], value: ['-XX:+UseZGC'] },
    { rules: [{ action: 'allow', os: { name: 'windows', versionRange: { max: '10.0.17134' } } }],
      value: ['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=50'] },
  ] } };
  const args = defaultJvmArgsFromMeta(meta);
  assert.ok(args.includes('-XX:+UseZGC'));
  assert.ok(args.includes('-XX:+UseCompactObjectHeaders'));
  assert.ok(!args.some((a) => /^-Xm[xs]/.test(a)), 'память задаётся лаунчером, не метаданными');
  assert.ok(!args.includes('-XX:+UseG1GC'), 'старый G1GC не должен конфликтовать с ZGC');
  assert.deepEqual(defaultJvmArgsFromMeta({}), []);
});

test('профиль: валидация', () => {
  assert.throws(() => normalizeProfile({ name: '', version: '1.20.1' }), /название/);
  assert.throws(() => normalizeProfile({ name: 'A', version: '../x' }), /версию/);
  const p = normalizeProfile({ name: ' Test ', version: '1.20.1', loader: 'fabric', ramMax: '4096', jvmArgs: '' }, { id: 'id1' });
  assert.equal(p.name, 'Test');
  assert.equal(p.ramMax, 4096);
  assert.equal(p.loader, 'fabric');
  assert.equal(normalizeProfile({ name: 'A', version: '1.20.1', loader: 'evil' }).loader, 'vanilla');
});

// ---------- установщик версий ----------
const { ruleAllowed, mavenPath, collectLibraries } = require('../src/main/services/installer');

test('installer: правила библиотек по ОС', () => {
  assert.equal(ruleAllowed(undefined), true);
  assert.equal(ruleAllowed([{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }]), process.platform !== 'win32');
  assert.equal(ruleAllowed([{ action: 'allow', os: { name: 'windows' } }]), process.platform === 'win32');
});

test('installer: путь maven и сбор библиотек (Mojang + Fabric)', () => {
  assert.equal(mavenPath('net.fabricmc:fabric-loader:0.16.9'), 'net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar');
  assert.equal(mavenPath('org.lwjgl:lwjgl:3.3.3:natives-windows'), 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar');
  assert.throws(() => mavenPath('bad'), /Некорректное/);
  const files = collectLibraries({
    libraries: [
      { name: 'a:b:1', downloads: { artifact: { url: 'https://x/a.jar', path: 'a/b/1/b-1.jar', sha1: 's', size: 5 } } },
      { name: 'net.fabricmc:intermediary:1.21', url: 'https://maven.fabricmc.net/' },
    ],
  }, '/root');
  assert.equal(files.length, 2);
  assert.equal(files[1].url, 'https://maven.fabricmc.net/net/fabricmc/intermediary/1.21/intermediary-1.21.jar');
  assert.ok(files[0].dest.endsWith(path.join('libraries', 'a', 'b', '1', 'b-1.jar')));
});

// ---------- безопасный запуск, ресурспаки и диагностика вылетов ----------

test('настройки: вредные аргументы убираются, сброс возвращает безопасные значения', () => {
  assert.equal(cleanArgs('-Xmx99999M -Xms8G -Dfoo=bar\n-Dx=1'), '-Dfoo=bar -Dx=1');
  const service = new SettingsService(path.join(tmpDir(), 'settings.json'));
  service.update({ game: { ramMax: 99999, jvmArgs: '-Xmx64G' } });
  assert.equal(service.get().game.ramMax, maxRamMb());
  assert.equal(service.get().game.jvmArgs, '');
  const reset = service.reset();
  assert.equal(reset.game.ramMax, DEFAULTS.game.ramMax);
  assert.equal(reset.auth.allowOffline, true);
});

test('настройки: адреса обновлений только HTTPS, автоповтор и флаги updater', () => {
  const service = new SettingsService(path.join(tmpDir(), 'settings-updater.json'));
  service.update({ updater: { url: 'http://bad.example/updates' }, launcher: { autoRetry: false }, game: { graphicsBackend: 'bogus' } });
  assert.equal(service.get().updater.url, '');
  assert.equal(service.get().launcher.autoRetry, false);
  assert.equal(service.get().game.graphicsBackend, 'opengl');
  service.update({ updater: { url: 'https://example.com/updates' } });
  assert.equal(service.get().updater.url, 'https://example.com/updates/');
  assert.equal(service.get().updater.autoCheck, true);
  assert.equal(service.get().updater.autoInstall, true);
  assert.equal(service.reset().launcher.autoRetry, true);
});

test('обновление: служба не падает без Electron и без адресы ленты', async () => {
  const { UpdaterService } = require('../src/main/services/updater');
  const settings = { get: () => ({ updater: { enabled: true, autoCheck: true, url: '' }, launcher: {} }) };
  const updater = new UpdaterService({ settings, isBusy: () => false });
  assert.match(updater.feedUrl(), /railway\.app/);
  assert.equal(updater.hasPackagedProvider(), false);
  assert.equal(updater.canCheck(), true);
  assert.match(updater.info().url, /railway\.app/);
  await assert.rejects(() => updater.check());
  await updater.checkOnStart(); // тихая проверка не выбрасывает ошибку
});

test('автоповтор: нативный краш JVM запускает игру ещё раз в безопасном режиме', async () => {
  const { GameLauncher } = require('../src/main/services/launcher');
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const paths = { logs: path.join(dir, 'logs'), instanceDir: () => path.join(dir, 'instance') };
  const launcher = new GameLauncher({
    paths,
    settings: { get: () => ({ launcher: { autoRetry: true } }) },
    profiles: { touch() {} }, auth: {}, versions: {}, java: {}, installer: {},
    retryDelay: 5,
  });
  const calls = [];
  launcher.start = (id, opts) => { calls.push({ id, opts }); return Promise.resolve(); };
  const base = { profile: { id: 'p1' }, stopped: false, child: null, startedAt: Date.now(), lines: [], safe: false, moved: [], token: launcher._token };

  for (let i = 0; i < 2; i++) {
    const s = { ...base, lines: [] };
    launcher.session = s;
    await launcher._finish(s, 3221225477);
    assert.equal(launcher.state.status, 'preparing');
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.deepEqual(calls, [
    { id: 'p1', opts: { safe: true, _retry: true } },
    { id: 'p1', opts: { safe: true, _retry: true } },
  ]);

  const last = { ...base, lines: [] };
  launcher.session = last;
  await launcher._finish(last, 3221225477);
  assert.equal(launcher.state.status, 'error');
  assert.equal(calls.length, 2); // больше двух повторов не делаем
});

test('графика: OpenGL фиксируется перед запуском и не ломает options.txt', async () => {
  const file = path.join(tmpDir(), 'options.txt');
  fs.writeFileSync(file, 'renderDistance:8\npreferredGraphicsBackend:"vulkan"\nresourcePacks:["x"]\n');
  await applyGraphicsBackend(file);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /preferredGraphicsBackend:"opengl"/);
  assert.match(text, /renderDistance:8/);
  assert.match(text, /resourcePacks:\["x"\]/);
  assert.doesNotMatch(text, /vulkan/);
  await applyGraphicsBackend(file, 'vulkan');
  assert.match(fs.readFileSync(file, 'utf8'), /preferredGraphicsBackend:"vulkan"/);
});

test('диагностика: свежий hs_err лог AMD Vulkan даёт понятную подсказку', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'hs_err_pid8956.log'), 'Problematic frame:\nC [amdvlk64.dll+0x2667057]\n');
  assert.match(await nativeHint(dir), /Vulkan AMD/i);
  assert.match(explain('Problematic frame:\nC [amdvlk64.dll+0x2667057]'), /Vulkan AMD/i);
  assert.equal(await nativeHint(tmpDir()), '');
});

const { ResourcePackManager, packFormatFor } = require('../src/main/services/resourcepacks');
const { explain, nativeHint } = require('../src/main/util/crash');

test('ресурспак: версия pack_format и подсказка по вылету', () => {
  assert.equal(packFormatFor('1.20.1'), 15);
  assert.equal(packFormatFor('1.18.2'), 9);
  assert.equal(packFormatFor('26.3'), 97);
  assert.equal(packFormatFor('1.99.0'), null);
  assert.match(explain('java.lang.OutOfMemoryError: Java heap space'), /памяти/i);
  assert.match(explain('Caused by: net.fabricmc.api.ModLoadingException'), /модов/i);
  // Информационные строки о LWJGL/OpenGL есть и при нормальном запуске — не должны давать ложный диагноз.
  assert.match(explain('Backend library: LWJGL version 3.4.3+4\nUsing graphics backend OpenGL, using drivers: 3.3.0'), /не определена/i);
  assert.match(explain('[Render thread/ERROR]: OpenGL error 1282 (GL_INVALID_OPERATION)'), /графики/i);
});

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

/** Минимальный ZIP без сжатия — чтобы проверить чтение pack.mcmeta. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nb = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nb, data);
    centrals.push(ch, nb);
    offset += lh.length + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('ресурспаки: список определяет несовместимость, переключатель и удаление работают', async () => {
  const dir = tmpDir();
  const paths = { root: dir, instanceDir: (id) => path.join(dir, 'instances', id) };
  const profile = { id: 'p1', name: 'Тест', version: '1.20.1', loader: 'vanilla' };
  const modrinth = { versionsByHashes: async () => ({}), projects: async () => [] };
  const mgr = new ResourcePackManager({ paths, profiles: { get: () => profile }, modrinth });
  const packDir = path.join(paths.instanceDir('p1'), 'resourcepacks');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'good.zip'), makeZip([['pack.mcmeta', '{"pack":{"pack_format":15,"description":"Хороший пак"}}']]));
  fs.writeFileSync(path.join(packDir, 'old.zip'), makeZip([['pack.mcmeta', '{"pack":{"pack_format":1,"description":"Старый пак"}}']]));

  const list = await mgr.list('p1');
  assert.equal(list.length, 2);
  const good = list.find((r) => r.fileName === 'good.zip');
  const old = list.find((r) => r.fileName === 'old.zip');
  assert.equal(good.compatible, true);
  assert.equal(good.title, 'Хороший пак');
  assert.equal(old.compatible, false);

  await mgr.toggle('p1', 'old.zip', false);
  assert.ok(fs.existsSync(path.join(packDir, 'old.zip.disabled')));
  assert.equal((await mgr.list('p1')).find((r) => r.fileName === 'old.zip').enabled, false);
  await mgr.toggle('p1', 'old.zip', true);
  assert.ok(fs.existsSync(path.join(packDir, 'old.zip')));
  await mgr.remove('p1', 'old.zip');
  assert.equal(fs.existsSync(path.join(packDir, 'old.zip')), false);
});

test('версії порівнюються числово: 1.10.2 > 1.9.9, префікс v ігнорується', () => {
  const { compareVersions, UpdateError, errorInfo } = require('../src/main/services/updater');
  assert.equal(compareVersions('v1.10.2', '1.9.9'), 1);
  assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
  assert.equal(compareVersions('1.0.9', '1.1.0'), -1);
  const e = new UpdateError('RATE_LIMIT', undefined, { httpStatus: 403, stage: 'github', detail: 'limit' });
  const info = errorInfo(e);
  assert.equal(info.code, 'RATE_LIMIT');
  assert.equal(info.httpStatus, 403);
  assert.equal(info.stage, 'github');
  assert.match(info.message, /ліміт/i);
});

test('настройки: токен GitHub сохраняется, настройки удалённых функций очищаются', () => {
  const service = new SettingsService(path.join(tmpDir(), 'settings-sync.json'));
  service.update({
    updater: { githubToken: '  ghp_test  ' },
    sources: { dir: ' C:\\work\\repo ', autoCheck: true, backup: false },
    discord: { clientId: '12345678901234567' },
    auth: { azureClientId: '00000000-0000-0000-0000-000000000000' },
  });
  const s = service.get();
  assert.equal(s.updater.githubToken, 'ghp_test');
  assert.equal('sources' in s, false);
  assert.equal('discord' in s, false);
  assert.equal('azureClientId' in s.auth, false);
});

test('оновлення: холодний install викликає check без ALREADY і міняє оригінальний portable exe', async () => {
  const { UpdaterService, resolveUpdateTarget, buildUpdateScript } = require('../src/main/services/updater');
  const u = new UpdaterService({ settings: { get: () => ({}) } });
  const asset = { name: 'portable.exe', url: 'https://example.com/p.exe' };
  let checked = 0;
  let downloaded = 0;
  let helperArgs = null;
  u.supported = () => true;
  u.isPortableBuild = () => true;
  u.check = async (opts) => {
    checked++;
    assert.equal(opts?.internal, true);
    u.candidate = { version: '9.9.9', portable: asset };
    return {};
  };
  u.download = async (a) => {
    downloaded++;
    assert.equal(a.name, 'portable.exe');
    u.downloadedFile = 'C:\\tmp\\new.exe';
    u.downloadedVersion = '9.9.9';
    return u.downloadedFile;
  };
  u._runHelper = async (args) => { helperArgs = args; return true; };
  assert.equal(await u.install(), true);
  assert.equal(checked, 1);
  assert.equal(downloaded, 1);
  assert.equal(helperArgs.src, 'C:\\tmp\\new.exe');
  assert.equal(helperArgs.portable, true);
  assert.equal(
    resolveUpdateTarget(true, {
      execPath: 'C:\\Temp\\app\\bibil_aClient.exe',
      portableExe: 'C:\\Games\\bibil_aClient-1.1.0.exe',
    }),
    'C:\\Games\\bibil_aClient-1.1.0.exe',
  );
  assert.equal(
    resolveUpdateTarget(false, { execPath: 'C:\\Games\\Custom Launcher\\launcher.exe' }),
    'C:\\Games\\Custom Launcher\\launcher.exe',
  );
  const helperScript = buildUpdateScript({
    pid: 123,
    portable: true,
    src: "C:\\Temp\\new's.exe",
    target: 'C:\\Games\\bibil_aClient.exe',
    logFile: 'C:\\Temp\\updater.log',
  });
  assert.match(helperScript, /FAIL portable=\$\(\$portable\): \$\(\$_.Exception.Message\)/);
  assert.doesNotMatch(helperScript, /}\s*;\s*catch/);
  assert.match(helperScript, /new''s\.exe/);
  assert.match(helperScript, /-WorkingDirectory \(Split-Path -LiteralPath \$target -Parent\)/);
  assert.match(helperScript, /Updated launcher executable not found/);
  assert.match(helperScript, /Launcher process \$waitPid did not exit/);

  const setupScript = buildUpdateScript({
    pid: 123,
    portable: false,
    src: 'C:\\Temp\\setup.exe',
    target: 'C:\\Games\\Custom Launcher\\launcher.exe',
    logFile: 'C:\\Temp\\updater.log',
  });
  assert.match(setupScript, /Start-Process -FilePath \$src -ArgumentList '\/S' -Wait/);
});

test('оновлення: застарілий завантажений exe не встановлюється після появи нової версії', async () => {
  const { UpdaterService } = require('../src/main/services/updater');
  const u = new UpdaterService({ settings: { get: () => ({}) } });
  u.supported = () => true;
  u.isPortableBuild = () => false;
  u.candidate = { version: '9.9.9', setup: { name: 'setup.exe', url: 'https://example.com/s.exe' } };
  u.downloadedFile = 'C:\\tmp\\old.exe';
  u.downloadedVersion = '1.0.0';
  let checked = 0;
  let downloaded = 0;
  u.check = async (opts) => { checked++; assert.equal(opts?.internal, true); return {}; };
  u.download = async () => {
    downloaded++;
    u.downloadedFile = 'C:\\tmp\\new.exe';
    u.downloadedVersion = '9.9.9';
    return u.downloadedFile;
  };
  u._runHelper = async () => true;
  assert.equal(await u.install(), true);
  assert.equal(checked, 1);
  assert.equal(downloaded, 1);
  assert.equal(u.downloadedVersion, '9.9.9');
});

test('оновлення: відсутній SHA-512 блокує встановлення замість тихої перевірки', async () => {
  const { UpdaterService, UpdateError } = require('../src/main/services/updater');
  const u = new UpdaterService({ settings: { get: () => ({}) } });
  u.candidate = { version: '9.9.9' };
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(Buffer.from('test'), {
    status: 200, headers: { 'content-length': '4' },
  });
  try {
    await assert.rejects(
      () => u.download({ name: 'no-hash.exe', url: 'https://example.com/no-hash.exe' }),
      (e) => e instanceof UpdateError && e.code === 'BAD_MANIFEST',
    );
  } finally {
    global.fetch = originalFetch;
  }
});
