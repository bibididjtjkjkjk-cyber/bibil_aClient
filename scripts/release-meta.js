'use strict';
/**
 * Формує метадані релізу після electron-builder:
 *   dist/latest.json  — для оновлювача (Railway / дзеркало)
 *   dist/version.json — для синхронізації сурсів другим тех-адміном
 *   dist/cosmetics.json — каталог косметики з релізу
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
  const sources = find((f) => /^sources-\d+\.\d+\.\d+\.zip$/i.test(f));
  const setupHash = await hash(path.join(dist, setup));
  const portableHash = await hash(path.join(dist, portable));
  const sourceHash = await hash(path.join(dist, sources));

  const latest = {
    version,
    file: setup,
    sha512: setupHash.base64,
    sha512Hex: setupHash.hex,
    size: fs.statSync(path.join(dist, setup)).size,
    portable,
    portableSha512: portableHash.base64,
    portableSize: fs.statSync(path.join(dist, portable)).size,
    sources,
    sourceSha512: sourceHash.base64,
    sourceSize: fs.statSync(path.join(dist, sources)).size,
    cosmetics: 'cosmetics.json',
    releaseDate: new Date().toISOString(),
    notes: `bibil_aClient ${version}: оновлення, синхронізація сурсів, косметика, анімації.`,
  };
  const versionManifest = {
    version,
    source: { file: sources, url: sources, sha512: sourceHash.base64, size: latest.sourceSize },
    preserve: [
      '.git/**', '.idea/**', 'node_modules/**', 'dist/**', 'out/**', 'update-server/public/**',
      'data/**', '.bibil-sync-backups/**', '.bibil-source-version.json',
      '.env', '.env.*', '*.local.*', '*.log', '*.zip', 'src/main/config.js',
    ],
    notes: latest.notes,
  };

  await fsp.writeFile(path.join(dist, 'latest.json'), JSON.stringify(latest, null, 2));
  await fsp.writeFile(path.join(dist, 'version.json'), JSON.stringify(versionManifest, null, 2));
  await fsp.copyFile(path.join(root, 'src', 'main', 'data', 'cosmetics.json'), path.join(dist, 'cosmetics.json'));
  console.log(`release meta ready: ${version} (${setup}, ${portable}, ${sources})`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
