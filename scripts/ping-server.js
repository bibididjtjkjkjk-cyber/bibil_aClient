'use strict';
/** Простий Minecraft Server List Ping (state=1): node scripts/ping-server.js host port */
const net = require('net');
const host = process.argv[2] || 'mc.politpig.ru';
const port = Number(process.argv[3] || 25565);

function readVarInt(b, off) {
  let value = 0, size = 0;
  while (off < b.length && size < 5) {
    const byte = b[off++];
    value |= (byte & 0x7f) << (size++ * 7);
    if (!(byte & 0x80)) return { value, off };
  }
  throw new Error('bad varint');
}
function writeVarInt(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return Buffer.from(out);
}
function writeString(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
}

const sock = net.connect(port, host, () => {
  const handshake = Buffer.concat([
    writeVarInt(0), writeVarInt(-1), writeString(host),
    Buffer.from([port >> 8, port & 0xff]), writeVarInt(1),
  ]);
  sock.write(Buffer.concat([writeVarInt(handshake.length), handshake, writeVarInt(1), writeVarInt(0)]));
});
let buf = Buffer.alloc(0);
sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  try {
    const { value: len, off } = readVarInt(buf, 0);
    if (buf.length < off + len) return;
    const { value: id, off: p } = readVarInt(buf, off);
    if (id !== 0) throw new Error('packet ' + id);
    const { value: strLen, off: s } = readVarInt(buf, p);
    const json = buf.slice(s, s + strLen).toString('utf8');
    const info = JSON.parse(json);
    const name = typeof info.version?.name === 'string' ? info.version.name : info.version?.name?.text;
    console.log('VERSION:', name, '| protocol:', info.version?.protocol, '| players:', info.players?.online + '/' + info.players?.max);
  } catch (e) {
    console.log('RAW:', buf.toString('utf8').slice(0, 300), '| err:', e.message);
  }
  sock.destroy();
});
sock.on('error', (e) => console.error('PING ERROR:', e.message));
sock.setTimeout(8000, () => { console.log('TIMEOUT'); sock.destroy(); });
