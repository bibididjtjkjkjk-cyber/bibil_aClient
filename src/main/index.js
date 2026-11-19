'use strict';
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

const IS_DEV = process.argv.includes('--dev');

const log = require('./logger');
const paths = require('./paths');

process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let services = null;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  function createWindow() {
    win = new BrowserWindow({
      width: 1180,
      height: 740,
      minWidth: 980,
      minHeight: 620,
      frame: false,
      show: false,
      backgroundColor: '#0e0f14',
      title: 'bibil_aClient',
      icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: IS_DEV,
      },
    });
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    // Запрещаем навигацию и открытие новых окон: внешние ссылки — только https в браузере.
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    return win;
  }

  async function bootstrap() {
    paths.ensure();
    log.init(paths.logs);
    log.info(`bibil_aClient ${require('./config').VERSION} запускается (${process.platform}/${process.arch})`);
    Menu.setApplicationMenu(null);

    const { SettingsService } = require('./services/settings');
    const { ProfileService } = require('./services/profiles');
    const { AuthService } = require('./services/auth');
    const { VersionService } = require('./services/versions');
    const { JavaService } = require('./services/java');
    const { ModrinthClient } = require('./services/modrinth');
    const { ModManager } = require('./services/mods');
    const { ResourcePackManager } = require('./services/resourcepacks');
    const { SkinManager } = require('./services/skins');
    const { ScreenshotManager } = require('./services/screenshots');
    const { InstallerService } = require('./services/installer');
    const { GameLauncher } = require('./services/launcher');
    const { UpdaterService } = require('./services/updater');

    const settings = new SettingsService(path.join(paths.config, 'settings.json'));
    const profiles = new ProfileService(path.join(paths.config, 'profiles.json'), paths, settings);
    const auth = new AuthService(path.join(paths.config, 'accounts.json'));
    const versions = new VersionService(paths);
    const java = new JavaService(paths);
    const modrinth = new ModrinthClient();
    const mods = new ModManager({ paths, profiles, modrinth });
    const resourcepacks = new ResourcePackManager({ paths, profiles, modrinth });
    const skins = new SkinManager({ paths, auth });
    const screenshots = new ScreenshotManager({ paths, profiles, nativeImage: require('electron').nativeImage });
    const installer = new InstallerService({ paths, versions });
    const launcher = new GameLauncher({ paths, settings, profiles, auth, versions, java, installer, mods });
    const updater = new UpdaterService({ settings, isBusy: () => !!launcher.session, paths });
    services = { settings, profiles, auth, versions, java, modrinth, mods, resourcepacks, skins, screenshots, launcher, installer, updater, paths };

    // Игра должна быть доступна сразу: локальный аккаунт создаётся при первом запуске.
    if (!auth.list().accounts.length) {
      try {
        const acc = auth.addOffline('Player' + Math.floor(1000 + Math.random() * 9000));
        log.info(`Создан локальный аккаунт «${acc.name}» (одиночная игра и LAN). Для онлайна войдите через Microsoft.`);
      } catch (e) {
        log.warn('Не удалось создать локальный аккаунт:', e.message);
      }
    }

    createWindow();
    require('./ipc').registerIpc({ win, services });

    // Тихая проверка обновлений при старте (только если задан адрес ленты).
    setTimeout(() => updater.checkOnStart().catch(() => {}), 3000);
    // Поведение окна при запуске игры.
    launcher.on('started', () => {
      const mode = settings.get().launcher.onLaunch;
      if (mode === 'minimize') win.minimize();
      else if (mode === 'hide') win.hide();
    });
    launcher.on('exit', () => {
      if (win && !win.isDestroyed()) {
        if (!win.isVisible()) win.show();
        if (win.isMinimized()) win.restore();
      }
    });
  }

  app.whenReady().then(() => bootstrap().catch((e) => {
    log.error('Критическая ошибка запуска', e);
    app.quit();
  }));

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => log.close());
}
