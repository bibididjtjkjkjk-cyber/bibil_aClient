'use strict';
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const MAX_BUFFER = 2000;
const MAX_FILE = 2 * 1024 * 1024;

class Logger extends EventEmitter {
  constructor() {
    super();
    this.buffer = [];
    this.stream = null;
    this.file = null;
  }

  init(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'launcher.log');
    try {
      if (fs.statSync(this.file).size > MAX_FILE) fs.renameSync(this.file, this.file + '.old');
    } catch {
      /* файла ещё нет */
    }
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.stream.on('error', () => {});
  }

  _write(level, args) {
    const msg = args
      .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a)))
      .join(' ');
    const line = { t: Date.now(), level, msg };
    this.buffer.push(line);
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    if (this.stream) this.stream.write(`[${new Date(line.t).toISOString()}] [${level}] ${msg}\n`);
    if (process.env.NODE_ENV !== 'test') console.log(`[${level}] ${msg}`);
    this.emit('line', line);
  }

  info(...a) { this._write('info', a); }
  warn(...a) { this._write('warn', a); }
  error(...a) { this._write('error', a); }
  debug(...a) { this._write('debug', a); }

  close() {
    if (this.stream) this.stream.end();
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

module.exports = new Logger();
