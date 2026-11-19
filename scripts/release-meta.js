'use strict';
/**
 * Формує метадані релізу після electron-builder:
 *   dist/latest.json  — для оновлювача (Railway / дзеркало)
 *
 * Використання: npm run release:meta  (або автоматично у .github/workflows/release.yml)
 */
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const find = (fn) => {
  const files = fs.readdirSync(dist).filter(fn);
  // У dist/ можуть залишитися файли попередньої версії — брати тільки поточну.
  const hit = files.find((f) => f.includes(version));
  if (!hit) throw new Error(`Не знайдено артефакт версії ${version} у dist/: ${fn}`);
  return hit;
};

async function hash(file) {
  const h = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  const buf = h.digest();
  return { base64: buf.toString('base64'), hex: buf.toString('hex') };
}

async function main() {
  if (!fs.existsSync(dist)) throw new Error('Спочатку виконайте npm run dist:win');
  const setup = find((f) => /-Setup-\d+\.\d+\.\d+.*\.exe$/i.test(f));
  const portable = find((f) => /^bibil_aClient-\d+\.\d+\.\d+.*\.exe$/i.test(f));
  const setupHash = await hash(path.join(dist, setup));
  const portableHash = await hash(path.join(dist, portable));

  const latest = {
    version,
    file: setup,
    sha512: setupHash.base64,
    sha512Hex: setupHash.hex,
    size: fs.statSync(path.join(dist, setup)).size,
    portable,
    portableSha512: portableHash.base64,
    portableSize: fs.statSync(path.join(dist, portable)).size,
    releaseDate: new Date().toISOString(),
    notes: `bibil_aClient ${version}: обновление и оптимизация Minecraft.`,
  };

  await fsp.writeFile(path.join(dist, 'latest.json'), JSON.stringify(latest, null, 2));
  console.log(`release meta ready: ${version} (${setup}, ${portable})`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
