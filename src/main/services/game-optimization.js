'use strict';
const fs = require('fs/promises');

const OPTION_VALUES = {
  graphics: { fast: '0', fancy: '1' },
  particles: { all: '0', decreased: '1', minimal: '2' },
  clouds: { off: '0', fast: '1', fancy: '2' },
};

function toMinecraftOptions(optimization) {
  return {
    graphicsMode: OPTION_VALUES.graphics[optimization.graphics],
    renderDistance: String(optimization.renderDistance),
    simulationDistance: String(optimization.simulationDistance),
    particles: OPTION_VALUES.particles[optimization.particles],
    clouds: OPTION_VALUES.clouds[optimization.clouds],
    entityDistanceScaling: String(optimization.entityDistance),
    mipmapLevels: String(optimization.mipmapLevels),
    maxFps: String(optimization.maxFps),
    enableVsync: String(optimization.vsync),
    entityShadows: 'false',
    biomeBlendRadius: '0',
  };
}

/** Змінює/додаєOnly потрібні ключі, зберігаючи все інше (наприклад, resourcePacks). */
async function setOptions(file, values) {
  let contents = '';
  try {
    contents = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const seen = new Set();
  const hadTrailingNewline = contents.endsWith('\n');
  const lines = contents ? contents.split(/\r?\n/) : [];
  if (hadTrailingNewline) lines.pop();

  const updated = lines.map((line) => {
    const separator = line.indexOf(':');
    if (separator < 1) return line;
    const key = line.slice(0, separator);
    if (!(key in values)) return line;
    seen.add(key);
    return `${key}:${values[key]}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) updated.push(`${key}:${value}`);
  }

  await fs.writeFile(file, updated.join('\n') + (hadTrailingNewline || updated.length ? '\n' : ''), 'utf8');
}

async function applyMinecraftOptions(file, optimization) {
  await setOptions(file, toMinecraftOptions(optimization));
}

/**
 * Minecraft 26.x сам обирає графічний бекенд і після невдалого запуску може перейти
 * на Vulkan. На AMD це призводить до крашу в amdvlk64.dll (0xC0000005) під час
 * завантаження моделей. Явно вказуємо бекенд у options.txt до старту гри.
 */
async function applyGraphicsBackend(file, backend = 'opengl') {
  const value = ['opengl', 'vulkan', 'default'].includes(backend) ? backend : 'opengl';
  // Рядкові опції MC зберігає в лапках (наприклад soundDevice:"...").
  await setOptions(file, { preferredGraphicsBackend: JSON.stringify(value) });
}

module.exports = { applyMinecraftOptions, applyGraphicsBackend, toMinecraftOptions };
