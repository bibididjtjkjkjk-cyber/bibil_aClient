'use strict';
const pkg = require('../../package.json');

module.exports = {
  APP_NAME: 'bibil_aClient',
  VERSION: pkg.version,
  // Modrinth требует уникальный User-Agent с контактом. Замените ссылку на свою.
  USER_AGENT: `bibil/bibil_aClient/${pkg.version} (launcher; +https://github.com/bibididjtjkjkjk-cyber/bibil_aClient)`,
  // Microsoft Application ID задаётся при сборке или переменной окружения.
  ENV_AZURE_CLIENT_ID: process.env.BIBIL_AZURE_CLIENT_ID || '',
  ENV_UPDATE_URL: process.env.BIBIL_UPDATE_URL || '',
  MODRINTH_API: 'https://api.modrinth.com/v2',
  MOJANG_MANIFEST: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  FABRIC_META: 'https://meta.fabricmc.net/v2',
};
