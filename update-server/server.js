'use strict';
/**
 * Мінімальний статичний сервер для автооновлення bibil_aClient.
 * Віддає latest.yml і Setup.exe з папки public/. Працює на Railway (PORT задається середовищем).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');

const TYPES = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  const name = path.basename(pathname === '/' ? '/latest.yml' : pathname);
  const file = path.join(PUBLIC, name);

  // Захист від виходу за межі public/
  if (path.dirname(file) !== PUBLIC) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    // pipeline закриває файл при обриві клієнта і не дає впасти процесу на помилці читання.
    pipeline(fs.createReadStream(file), res, (e) => {
      if (e && !res.headersSent) res.writeHead(500).end('Read error');
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[update-server] listening on 0.0.0.0:${PORT}, public=${PUBLIC}`);
});
