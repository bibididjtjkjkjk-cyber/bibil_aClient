'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Белые списки каналов: рендерер не получает произвольный доступ к IPC.
const INVOKE = new Set([
  'app:info', 'app:openExternal', 'app:openPath',
  'win:minimize', 'win:toggleMaximize', 'win:close',
  'settings:get', 'settings:set', 'settings:reset',
  'accounts:list', 'accounts:loginMicrosoft', 'accounts:cancelLogin', 'accounts:addOffline', 'accounts:remove', 'accounts:setActive',
  'versions:list', 'versions:fabricLoaders', 'versions:installed', 'versions:install', 'versions:uninstall',
  'profiles:list', 'profiles:create', 'profiles:update', 'profiles:remove', 'profiles:duplicate', 'profiles:setActive',
  'java:detect',
  'launch:start', 'launch:stop', 'launch:state',
  'mods:categories', 'mods:search', 'mods:project', 'mods:projectVersions', 'mods:list', 'mods:install', 'mods:remove',
  'mods:toggle', 'mods:checkUpdates', 'mods:update', 'mods:pickFiles', 'mods:addLocal',
  'resourcepacks:categories', 'resourcepacks:search', 'resourcepacks:project', 'resourcepacks:projectVersions',
  'resourcepacks:list', 'resourcepacks:install', 'resourcepacks:toggle', 'resourcepacks:remove',
  'resourcepacks:pickFiles', 'resourcepacks:addLocal',
  'logs:get',
  'update:info', 'update:check', 'update:install', 'update:cancel', 'update:history',
  'diagnostics:gather', 'diagnostics:gpu',
]);

const EVENTS = new Set([
  'launch:state', 'launch:log', 'install:progress', 'auth:code', 'mods:progress', 'resourcepacks:progress', 'win:maximized', 'launcher:log', 'update:state',
]);

contextBridge.exposeInMainWorld('bibil', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Канал не разрешён: ${channel}`));
    return ipcRenderer.invoke(channel, ...args).then((r) => {
      if (r && r.ok === false) {
        const err = new Error(r.error || 'Неизвестная ошибка');
        for (const k of ['code', 'stage', 'httpStatus', 'detail', 'url']) if (r[k] !== undefined) err[k] = r[k];
        throw err;
      }
      return r ? r.data : undefined;
    });
  },
  on(channel, cb) {
    if (!EVENTS.has(channel)) throw new Error(`Событие не разрешено: ${channel}`);
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  platform: process.platform,
  pathForFile(file) {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
});
