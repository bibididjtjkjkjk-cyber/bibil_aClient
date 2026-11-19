'use strict';
/** Минимальный читатель ZIP без зависимостей: нужен, чтобы прочитать pack.mcmeta из ресурспака. */
const fsp = require('fs').promises;
const zlib = require('zlib');

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function findEocd(buf) {
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.length >= i + 4 && buf.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

/** Читает одну запись архива. ZIP64 и шифрование не поддерживаются — для pack.mcmeta достаточно. */
async function readZipEntry(file, wanted) {
  const buf = await fsp.readFile(file);
  if (buf.length < 4 || buf.readUInt32LE(0) !== LOCAL) throw new Error('Это не ZIP-архив');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Повреждён ZIP-архив');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CENTRAL) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === wanted) {
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOCAL) throw new Error('Повреждён ZIP-архив');
      const ln = buf.readUInt16LE(localOff + 26);
      const le = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + ln + le;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
      throw new Error(`Неподдерживаемое сжатие ZIP (${method})`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

module.exports = { readZipEntry };
