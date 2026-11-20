'use strict';
const { dialog, shell, ipcMain } = require('electron');
const os = require('os');
const path = require('path');
const { VERSION } = require('./config');
const { maxRamMb } = require('./services/settings');
const { errorInfo } = require('./services/updater');
const log = require('./logger');

const isStr = (v, max = 4096) => typeof v === 'string' && v.length > 0 && v.length <= max;
const need = (cond, msg) => {
  if (!cond) throw new Error(msg || 'Некорректные параметры');
};

function registerIpc({ win, services }) {
  const { settings, profiles, auth, versions, java, launcher, mods, resourcepacks, modrinth, installer, updater, paths } = services;
  const send = (ch, payload) => {
    if (!win.isDestroyed()) win.webContents.send(ch, payload);
  };

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== win.webContents) return { ok: false, error: 'Запрос из недоверенного источника' };
      try {
        return { ok: true, data: await fn(...args) };
      } catch (e) {
        log.error(`[ipc:${channel}]`, e);
        const info = errorInfo(e, channel);
        return { ok: false, error: info.message, ...info };
      }
    });
  };

  // ---- события main → renderer ----
  launcher.on('state', (s) => send('launch:state', s));
  launcher.on('log', (l) => send('launch:log', l));
  log.on('line', (l) => send('launcher:log', l));
  mods.on('progress', (p) => send('mods:progress', p));
  resourcepacks.on('progress', (p) => send('resourcepacks:progress', p));
  installer.on('progress', (p) => send('install:progress', p));
  if (updater) updater.on('state', (s) => send('update:state', s));
  win.on('maximize', () => send('win:maximized', true));
  win.on('unmaximize', () => send('win:maximized', false));

  // ---- приложение / окно ----
  handle('app:info', () => ({
    version: VERSION,
    platform: process.platform,
    totalMemMB: Math.floor(os.totalmem() / 1024 / 1024),
    maxRamMb: maxRamMb(),
    userData: paths.userData,
    electron: process.versions.electron,
    maximized: win.isMaximized(),
  }));
  handle('app:openExternal', (url) => {
    need(isStr(url) && /^https:\/\//i.test(url), 'Разрешены только https-ссылки');
    return shell.openExternal(url);
  });
  handle('app:openPath', async (kind, profileId) => {
    const map = { root: paths.root, logs: paths.logs, userData: paths.userData };
    let target = map[kind];
    if (kind === 'instance') target = paths.instanceDir(profileId);
    else if (kind === 'mods') target = path.join(paths.instanceDir(profileId), 'mods');
    else if (kind === 'resourcepacks') target = path.join(paths.instanceDir(profileId), 'resourcepacks');
    need(target, 'Неизвестный каталог');
    await require('fs').promises.mkdir(target, { recursive: true });
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  });
  handle('win:minimize', () => win.minimize());
  handle('win:toggleMaximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  handle('win:close', () => win.close());

  // ---- настройки ----
  handle('settings:get', () => settings.get());
  handle('settings:set', (patch) => {
    need(patch && typeof patch === 'object' && !Array.isArray(patch));
    return settings.update(patch);
  });
  handle('settings:reset', () => settings.reset());

  // ---- аккаунты ----
  handle('accounts:list', () => auth.list());
  handle('accounts:loginMicrosoft', () => auth.loginMicrosoft(send));
  handle('accounts:cancelLogin', () => auth.cancelLogin());
  handle('accounts:addOffline', (name) => auth.addOffline(String(name || '')));
  handle('accounts:remove', (id) => auth.remove(id));
  handle('accounts:setActive', (id) => auth.setActive(id));

  // ---- версии и профили ----
  handle('versions:list', (opts) => versions.list({ snapshots: !!opts?.snapshots }));
  handle('versions:fabricLoaders', (mc) => {
    need(isStr(mc, 64));
    return versions.fabricLoaders(mc);
  });
  handle('versions:installed', () => installer.listInstalled());
  handle('versions:install', async (id, loader, loaderVersion) => {
    need(isStr(id, 64));
    const fabricId = loader === 'fabric' ? await versions.installFabric(id, loaderVersion || '') : null;
    await installer.install(id, { fabricId });
  });
  handle('versions:uninstall', (id) => {
    need(isStr(id, 64));
    need(!launcher.session, 'Нельзя удалять версии во время запуска игры');
    return installer.uninstall(id);
  });
  handle('profiles:list', () => ({ profiles: profiles.list(), active: profiles.getActive()?.id ?? null }));
  handle('profiles:create', (data) => profiles.create(data || {}));
  handle('profiles:update', (id, data) => profiles.update(id, data || {}));
  handle('profiles:remove', (id, opts) => profiles.remove(id, { deleteFiles: !!opts?.deleteFiles }));
  handle('profiles:duplicate', (id) => profiles.duplicate(id));
  handle('profiles:setActive', (id) => {
    need(profiles.get(id), 'Профиль не найден');
    settings.update({ state: { activeProfile: id } });
  });
  handle('java:detect', () => java.detect());

  // ---- запуск ----
  handle('launch:start', (profileId, opts) => {
    need(isStr(profileId, 64));
    return launcher.start(profileId, { safe: !!opts?.safe });
  });
  handle('launch:stop', () => launcher.stop());
  handle('launch:state', () => launcher.getState());

  // ---- моды ----
  handle('mods:categories', () => modrinth.categories());
  handle('mods:search', (q) => modrinth.search(q || {}));
  handle('mods:project', (id) => modrinth.project(id));
  handle('mods:projectVersions', (profileId, projectId) => {
    const p = profiles.get(profileId);
    need(p, 'Профиль не найден');
    return modrinth
      .projectVersions(projectId, { loaders: ['fabric'], gameVersions: [p.version] })
      .then((vs) => vs.map((v) => ({ id: v.id, name: v.name, versionNumber: v.version_number, type: v.version_type, date: v.date_published, downloads: v.downloads })));
  });
  handle('mods:list', (profileId) => mods.list(profileId));
  handle('mods:install', (profileId, projectId, versionId) => mods.install(profileId, projectId, versionId || undefined));
  handle('mods:remove', (profileId, file) => mods.remove(profileId, file));
  handle('mods:toggle', (profileId, file, enabled) => mods.toggle(profileId, file, !!enabled));
  handle('mods:checkUpdates', (profileId) => mods.checkUpdates(profileId));
  handle('mods:update', (profileId, file) => mods.update(profileId, file));
  handle('mods:pickFiles', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Выберите JAR-файлы модов',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Minecraft mods', extensions: ['jar'] }],
    });
    return result.canceled ? [] : result.filePaths.slice(0, 50);
  });
  handle('mods:addLocal', (profileId, files) => {
    need(isStr(profileId, 64) && Array.isArray(files) && files.length <= 50 &&
      files.every((f) => typeof f === 'string' && f.length <= 1000));
    return mods.addLocal(profileId, files);
  });

  // ---- ресурспаки ----
  handle('resourcepacks:categories', () => modrinth.categories('resourcepack'));
  handle('resourcepacks:search', (q) => modrinth.search({ ...(q || {}), projectType: 'resourcepack' }));
  handle('resourcepacks:project', (id) => modrinth.project(id));
  handle('resourcepacks:projectVersions', (profileId, projectId) => {
    const p = profiles.get(profileId);
    need(p, 'Профиль не найден');
    return modrinth.projectVersions(projectId, { gameVersions: [p.version] })
      .then((vs) => vs.map((v) => ({ id: v.id, name: v.name, versionNumber: v.version_number, type: v.version_type, date: v.date_published, downloads: v.downloads })));
  });
  handle('resourcepacks:list', (profileId) => resourcepacks.list(profileId));
  handle('resourcepacks:install', (profileId, projectId, versionId) => resourcepacks.install(profileId, projectId, versionId || undefined));
  handle('resourcepacks:toggle', (profileId, file, enabled) => resourcepacks.toggle(profileId, file, !!enabled));
  handle('resourcepacks:remove', (profileId, file) => resourcepacks.remove(profileId, file));

  // ---- логи ----
  handle('logs:get', () => ({ launcher: log.buffer.slice(-500) }));

  // ---- оновлення клієнта ----
  handle('update:info', () => (updater ? updater.info() : { state: 'unavailable', version: VERSION, supported: false }));
  handle('update:check', async () => {
    need(updater, 'Сервіс оновлень недоступний');
    return updater.check();
  });
  handle('update:install', async () => {
    need(updater, 'Сервіс оновлень недоступний');
    return updater.install();
  });
  handle('update:cancel', () => updater?.cancel());
  handle('update:history', () => (updater ? updater.history() : []));

  // ---- диагностика ----
  handle('diagnostics:gather', async () => {
    const { DiagnosticsService } = require('./services/diagnostics');
    const svc = new DiagnosticsService({ versions, java, installer });
    const active = services.profiles?.getActive?.();
    const versionId = (active && active.version) || null;
    return svc.gather({ versionId });
  });
  handle('diagnostics:gpu', async () => {
    const expr = `(function(){ try { const c = document.createElement('canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl'); if(!gl) return { available: false, renderer: '', vendor: '', version: '' }; const info = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info'); const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); return { available: true, renderer: String(renderer || ''), vendor: String(gl.getParameter(gl.VENDOR) || ''), version: String(gl.getParameter(gl.VERSION) || '') }; } catch (e) { return { available: false, renderer: '', vendor: '', version: '' }; } })()`;
    const gpu = await win.webContents.executeJavaScript(expr);
    return gpu;
  });

}

module.exports = { registerIpc };
