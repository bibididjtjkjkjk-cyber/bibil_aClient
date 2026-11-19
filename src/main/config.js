'use strict';
const pkg = require('../../package.json');

// Адрес папки с обновлениями (latest.yml + Setup exe). Пример: https://example.com/updates/
// Можно задать через BIBIL_UPDATE_URL или в Настройки → Обновление. Пусто = проверка не выполняется.
const BUNDLED_UPDATE_URL = 'https://bibil-updates-production.up.railway.app/';

// Якщо збірка опублікована з `build.publish` (GitHub Releases), electron-updater сам
// читає provider з app-update.yml — окрема адреса в налаштуваннях не потрібна.
const publish = Array.isArray(pkg.build?.publish) ? pkg.build.publish[0] : pkg.build?.publish;
const PACKAGED_UPDATE_PROVIDER = String(publish?.provider || '');

module.exports = {
  APP_NAME: 'bibil_aClient',
  VERSION: pkg.version,
  // Modrinth требует уникальный User-Agent с контактом. Замените ссылку на свою.
  USER_AGENT: `bibil/bibil_aClient/${pkg.version} (launcher; +https://github.com/bibididjtjkjkjk-cyber/bibil_aClient)`,
  // Microsoft Application ID задаётся при сборке или переменной окружения.
  ENV_AZURE_CLIENT_ID: process.env.BIBIL_AZURE_CLIENT_ID || '',
  ENV_UPDATE_URL: process.env.BIBIL_UPDATE_URL || BUNDLED_UPDATE_URL,
  PACKAGED_UPDATE_PROVIDER,
  MODRINTH_API: 'https://api.modrinth.com/v2',
  MOJANG_MANIFEST: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  FABRIC_META: 'https://meta.fabricmc.net/v2',
};
