'use strict';
const { clipboard, dialog, ipcMain, nativeImage, shell } = require('electron');
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
  const { settings, profiles, auth, versions, java, launcher, mods, resourcepacks, skins, screenshots, modrinth, installer, updater, paths } = services;
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

  // ---- скины ----
  handle('skins:list', () => skins.list());
  handle('skins:importFile', async (name, model) => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Выберите PNG-скин',
      properties: ['openFile'],
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return skins.importFile(result.filePaths[0], name || path.basename(result.filePaths[0], '.png'), model);
  });
  handle('skins:importUrl', (url, name, model) => {
    need(isStr(url, 2048));
    return skins.importUrl(url, name, model);
  });
  handle('skins:importNickname', (nickname) => {
    need(isStr(nickname, 16));
    return skins.importNickname(nickname);
  });
  handle('skins:replace', async (id, name, model) => {
    need(isStr(id, 64));
    const result = await dialog.showOpenDialog(win, {
      title: 'Выберите PNG для редактирования скина',
      properties: ['openFile'],
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return skins.replace(id, result.filePaths[0], name, model);
  });
  handle('skins:rename', (id, name) => {
    need(isStr(id, 64) && isStr(name, 64));
    return skins.rename(id, name);
  });
  handle('skins:remove', (id) => {
    need(isStr(id, 64));
    return skins.remove(id);
  });
  handle('skins:apply', (id, accountId) => {
    need(isStr(id, 64) && isStr(accountId, 64));
    return skins.apply(id, accountId);
  });

  // ---- скриншоты ----
  handle('screenshots:list', (profileId) => {
    need(isStr(profileId, 64));
    return screenshots.list(profileId);
  });
  handle('screenshots:read', (profileId, name) => {
    need(isStr(profileId, 64) && isStr(name, 128));
    return screenshots.read(profileId, name);
  });
  handle('screenshots:copy', (profileId, name) => {
    const file = screenshots.path(profileId, name);
    const image = nativeImage.createFromPath(file);
    need(!image.isEmpty(), 'Не удалось прочитать изображение');
    clipboard.writeImage(image);
  });
  handle('screenshots:open', (profileId, name) => {
    const file = screenshots.path(profileId, name);
    const err = shell.showItemInFolder(file);
    if (err) throw new Error(err);
  });
  handle('screenshots:rename', (profileId, name, nextName) => {
    need(isStr(profileId, 64) && isStr(name, 128) && isStr(nextName, 128));
    return screenshots.rename(profileId, name, nextName);
  });
  handle('screenshots:remove', (profileId, name) => {
    need(isStr(profileId, 64) && isStr(name, 128));
    return screenshots.remove(profileId, name);
  });

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

}

module.exports = { registerIpc };
