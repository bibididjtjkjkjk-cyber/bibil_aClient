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

async function hash(file, algo = 'sha512') {
  const h = crypto.createHash(algo);
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  const buf = h.digest();
  return { base64: buf.toString('base64'), hex: buf.toString('hex') };
}

async function hashes(file) {
  const [sha512, sha256] = await Promise.all([hash(file, 'sha512'), hash(file, 'sha256')]);
  return { sha512, sha256 };
}

async function main() {
  if (!fs.existsSync(dist)) throw new Error('Спочатку виконайте npm run dist:win');
  const setup = find((f) => /-Setup-\d+\.\d+\.\d+.*\.exe$/i.test(f));
  const portable = find((f) => /^bibil_aClient-\d+\.\d+\.\d+.*\.exe$/i.test(f));
  const setupHash = await hashes(path.join(dist, setup));
  const portableHash = await hashes(path.join(dist, portable));

  const latest = {
    version,
    file: setup,
    sha256: setupHash.sha256.hex,
    sha256Base64: setupHash.sha256.base64,
    sha512: setupHash.sha512.base64,
    sha512Hex: setupHash.sha512.hex,
    size: fs.statSync(path.join(dist, setup)).size,
    portable,
    portableSha256: portableHash.sha256.hex,
    portableSha256Base64: portableHash.sha256.base64,
    portableSha512: portableHash.sha512.base64,
    portableSha512Hex: portableHash.sha512.hex,
    portableSize: fs.statSync(path.join(dist, portable)).size,
    releaseDate: new Date().toISOString(),
    notes: `bibil_aClient ${version}: стабільні автооновлення, перевірка цілісності SHA-256/SHA-512, резервне копіювання та відкат.`,
  };

  await fsp.writeFile(path.join(dist, 'latest.json'), JSON.stringify(latest, null, 2));
  console.log(`release meta ready: ${version} (${setup}, ${portable})`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
