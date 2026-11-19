'use strict';
/**
 * Збирає bibil_aClient_для_друзей.zip з 4 файлів:
 *   portable exe, Setup exe, discord-avatar.png, ДЛЯ_ДРУЗЕЙ.txt
 *
 * Без зовнішніх залежностей: пише ZIP методом STORE (exe все одно майже не
 * стискаються), з прапорцем UTF-8 у іменах — кириличне ім'я txt коректно
 * читається у Windows Провіднику.
 *
 *   npm run repack                    # версію бере з package.json
 *   npm run repack -- 1.1.0           # або явно
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = process.argv[2] || pkg.version;

const portable = path.join(dist, `bibil_aClient-${version}.exe`);
const setup = path.join(dist, `bibil_aClient-Setup-${version}.exe`);
// В архіві аватар називається discord-avatar.png — це та сама картинка, що й іконка/Discord-ассет `logo`.
const files = [
  { file: portable, name: path.basename(portable) },
  { file: setup, name: path.basename(setup) },
  { file: path.join(root, 'build', 'discord-logo.png'), name: 'discord-avatar.png' },
  { file: path.join(root, 'ДЛЯ_ДРУЗЕЙ.txt'), name: 'ДЛЯ_ДРУЗЕЙ.txt' },
];
const output = path.join(root, `bibil_aClient_для_друзей.zip`);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(file) {
  return new Promise((resolve, reject) => {
    let crc = 0xFFFFFFFF;
    const s = fs.createReadStream(file);
    s.on('data', (buf) => {
      for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    });
    s.on('end', () => resolve((crc ^ 0xFFFFFFFF) >>> 0));
    s.on('error', reject);
  });
}

function dosTime(date) {
  const d = new Date(date);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function main() {
  for (const { file } of files) {
    if (!fs.existsSync(file)) throw new Error(`Не знайдено файл для архіву: ${file}`);
  }

  const out = fs.createWriteStream(output);
  let streamError = null;
  out.on('error', (e) => { streamError = e; });
  const write = (buf) => new Promise((resolve, reject) => {
    if (streamError) return reject(streamError);
    if (out.write(buf)) resolve();
    else out.once('drain', () => streamError ? reject(streamError) : resolve());
  });

  // Власний лічильник: bytesWritten оновлюється асинхронно й може відставати
  // від записаних у буфер байтів — центральний каталог все одно має точні offset-и.
  let position = 0;
  const central = [];
  for (const { file, name } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const stat = await fsp.stat(file);
    const crc = await crc32(file);
    const { time, date } = dosTime(stat.mtime);
    const offset = position;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0x0800, 6);   // UTF-8 filenames
    local.writeUInt16LE(0, 8);        // STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stat.size, 18);
    local.writeUInt32LE(stat.size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    await write(local);
    position += local.length;
    await write(nameBuf);
    position += nameBuf.length;

    for await (const chunk of fs.createReadStream(file)) {
      await write(chunk);
      position += chunk.length;
    }

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(stat.size, 20);
    cd.writeUInt32LE(stat.size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);          // extra
    cd.writeUInt16LE(0, 32);          // comment
    cd.writeUInt16LE(0, 34);          // disk start
    cd.writeUInt16LE(0, 36);          // internal attrs
    cd.writeUInt32LE(0, 38);          // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push({ cd, nameBuf });
    console.log(`  + ${name} (${(stat.size / 1048576).toFixed(1)} МБ)`);
  }

  const cdSize = central.reduce((n, e) => n + e.cd.length + e.nameBuf.length, 0);
  const cdOffset = position;
  for (const e of central) {
    await write(e.cd);
    position += e.cd.length;
    await write(e.nameBuf);
    position += e.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  await write(eocd);
  await new Promise((resolve) => out.end(resolve));

  console.log(`Готово: ${path.basename(output)} (${(fs.statSync(output).size / 1048576).toFixed(1)} МБ, ${central.length} файлів)`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
