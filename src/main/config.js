'use strict';
const pkg = require('../../package.json');

// ID приложения bibil_aClient из https://discord.com/developers/applications (18–19 цифр).
const BUNDLED_DISCORD_CLIENT_ID = '';

// Azure Application (client) ID, который вы зарегистрируете сами (см. README).
// Вставьте его сюда перед сборкой — тогда друзьям не придётся настраивать вход вручную.
const BUNDLED_AZURE_CLIENT_ID = '';

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
  // Можно задать через переменные окружения (или в настройках лаунчера).
  // Вставьте сюда Application ID вашего Discord-приложения — статус будет включаться сам у всех пользователей.
  ENV_DISCORD_CLIENT_ID: process.env.BIBIL_DISCORD_CLIENT_ID || BUNDLED_DISCORD_CLIENT_ID,
  ENV_AZURE_CLIENT_ID: process.env.BIBIL_AZURE_CLIENT_ID || BUNDLED_AZURE_CLIENT_ID,
  ENV_UPDATE_URL: process.env.BIBIL_UPDATE_URL || BUNDLED_UPDATE_URL,
  PACKAGED_UPDATE_PROVIDER,
  MODRINTH_API: 'https://api.modrinth.com/v2',
  MOJANG_MANIFEST: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  FABRIC_META: 'https://meta.fabricmc.net/v2',
};
