'use strict';
/** Читает crash-отчёт Minecraft и превращает его в понятную подсказку. */
const fsp = require('fs').promises;
const path = require('path');

const RULES = [
  [/amdvlk64|vulkan.*(?:crash|error|failed)|(?:crash|error|failed).*vulkan/i, 'Краш драйвера Vulkan AMD (amdvlk64.dll). Лаунчер принудительно включает OpenGL; если повторится — обновите Radeon Software.'],
  [/OutOfMemoryError|Java heap space|Memory allocation/i, 'Не хватило памяти. Уменьшите «Максимум памяти» в настройках до 3–4 ГБ и закройте лишние программы.'],
  [/UnsupportedClassVersionError/i, 'Версия Java слишком старая для этой версии Minecraft. Нажмите «Найти Java» в настройках.'],
  [/pack\.mcmeta|ResourcePack|resource pack|MinecraftException:.*pack/i, 'Проблема с ресурспаком — он не подходит для этой версии игры или повреждён. Отключите его в разделе «Ресурспаки».'],
  [/Caused by: java\.lang\.(NoClassDefFoundError|ClassNotFoundException)|ModLoadingException|Fabric/i, 'Конфликт модов или несовместимая версия мода. Запустите игру кнопкой «Безопасно» — она временно отключит моды и ресурспаки.'],
  // Не совпадает с обычными информационными строками «LWJGL version…», «Using graphics backend OpenGL».
  [/OpenGL error|GL_INVALID|(?:GLFW|SDL|LWJGL).*(?:error|failed|exception)|(?:Failed|Could not) create (?:window|context)|Display\.create failed/i,
    'Ошибка графики/драйвера. Обновите драйвер видеокарты и попробуйте безопасный запуск.'],
  [/AccessDeniedException|Permission denied/i, 'Не хватает прав доступа к папке игры. Проверьте путь к игре в настройках.'],
];

function explain(text) {
  for (const [re, hint] of RULES) if (re.test(text)) return hint;
  return 'Причина не определена автоматически. Откройте вкладку «Консоль» и скопируйте последние строки ошибки.';
}

async function lastCrash(gameDir) {
  try {
    const dir = path.join(gameDir, 'crash-reports');
    const files = (await fsp.readdir(dir)).filter((f) => /^crash-.*\.txt$/.test(f)).sort();
    if (!files.length) return null;
    const file = files[files.length - 1];
    const text = await fsp.readFile(path.join(dir, file), 'utf8');
    return { file, hint: explain(text) };
  } catch {
    return null;
  }
}

function explainLog(lines) {
  return explain(Array.isArray(lines) ? lines.slice(-300).join('\n') : String(lines || ''));
}

/**
 * Нативний краш JVM залишає hs_err_pid*.log у робочій папці (root/minecraft).
 * Використовуємо тільки свіжий файл, інакше старий звіт може переплутати диагноз.
 */
async function nativeHint(gameDir) {
  try {
    const names = (await fsp.readdir(gameDir)).filter((f) => /^hs_err_pid\d+\.log$/.test(f));
    if (!names.length) return '';
    let best = null;
    for (const name of names) {
      const st = await fsp.stat(path.join(gameDir, name));
      if (!best || st.mtimeMs > best.mtime) best = { name, mtime: st.mtimeMs };
    }
    if (!best || Date.now() - best.mtime > 10 * 60 * 1000) return '';

    const text = await fsp.readFile(path.join(gameDir, best.name), 'utf8');
    if (/amdvlk64|vulkan/i.test(text)) {
      return `Краш драйвера Vulkan AMD (${best.name}). Лаунчер принудительно включает OpenGL; если повторится — обновите Radeon Software.`;
    }
    const frame = text.match(/Problematic frame:\s*\n\s*([\s\S]*?)\n\s*\n/);
    const detail = frame ? frame[1].trim().replace(/\s+/g, ' ') : '';
    return `Нативний краш JVM (${best.name}${detail ? `, ${detail}` : ''}). Оновіть драйвер відеокарти та Java 25.`;
  } catch {
    return '';
  }
}

module.exports = { explain, explainLog, lastCrash, nativeHint };
