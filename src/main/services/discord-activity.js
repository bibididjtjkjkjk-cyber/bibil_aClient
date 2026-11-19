'use strict';
/** Чистая функция построения Rich Presence — без зависимостей от Electron/Discord, покрыта тестами. */
const { VERSION } = require('../config');

const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric' };

/** Discord требует строки длиной 2..128 символов. */
function clip(s) {
  s = String(s ?? '').trim();
  if (s.length < 2) return undefined;
  return s.length > 128 ? s.slice(0, 127) + '…' : s;
}

/**
 * @param {object} d      settings.discord
 * @param {object} ctx    { phase: 'launcher'|'game', mc, loader, profile, startedAt, launcherStartedAt }
 * @returns {object|null} объект активности или null, если статус нужно скрыть
 */
function buildActivity(d, ctx) {
  const act = {
    largeImageKey: d.largeImageKey || 'logo',
    largeImageText: `bibil_aClient v${VERSION}`,
    instance: false,
  };

  if (ctx.phase === 'game') {
    act.details = clip(d.customText) || 'Играет в Minecraft';
    const parts = [];
    if (d.showVersion && ctx.mc) parts.push(`Minecraft ${ctx.mc}`);
    if (d.showLoader && ctx.loader && ctx.loader !== 'vanilla') parts.push(LOADER_NAMES[ctx.loader] || ctx.loader);
    if (d.showProfile && ctx.profile) parts.push(`Профиль: ${ctx.profile}`);
    act.state = clip(parts.join(' · '));
    // Подсказка при наведении на аватар: сразу видно, во что играют.
    if (ctx.mc) {
      act.largeImageText = clip(`Играет в Minecraft ${ctx.mc}${ctx.loader && ctx.loader !== 'vanilla' ? ` · ${LOADER_NAMES[ctx.loader] || ctx.loader}` : ''}`);
    }
    if (d.showElapsed && ctx.startedAt) act.startTimestamp = Math.floor(ctx.startedAt / 1000);
  } else {
    if (!d.showInLauncher) return null;
    act.details = clip(d.customText) || 'В лаунчере bibil_aClient';
    act.state = 'Выбирает сборку';
    if (d.showElapsed && ctx.launcherStartedAt) act.startTimestamp = Math.floor(ctx.launcherStartedAt / 1000);
  }

  if (d.buttonLabel && d.buttonUrl) {
    act.buttons = [{ label: d.buttonLabel.slice(0, 32), url: d.buttonUrl }];
  }
  for (const k of Object.keys(act)) if (act[k] === undefined) delete act[k];
  return act;
}

module.exports = { buildActivity, clip };
