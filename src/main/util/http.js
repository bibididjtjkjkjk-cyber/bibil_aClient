'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { USER_AGENT } = require('../config');

class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} (${safeHost(url)})${body ? `: ${String(body).slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

/** fetch с таймаутом и повторами (сеть, 429, 5xx). */
async function request(url, { retries = 2, timeout = 30000, ...init } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) },
        signal: ctrl.signal,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        await sleep(Math.max(retryAfter * 1000, 800 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(600 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  const err = new Error(`Нет соединения с ${safeHost(url)}: ${lastErr?.message || lastErr}`);
  err.cause = lastErr;
  throw err;
}

async function getJson(url, init = {}) {
  const res = await request(url, init);
  if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''));
  return res.json();
}

async function postJson(url, body, init = {}) {
  return getJson(url, {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers || {}) },
    body: JSON.stringify(body),
  });
}

async function hashFile(file, algo) {
  const h = crypto.createHash(algo);
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

async function verifyFile(file, algo, expected) {
  const actual = await hashFile(file, algo);
  if (actual.toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`Контрольная сумма ${algo} не совпала (файл повреждён)`);
  }
}

/** Скачивает файл во временный .part, проверяет хэш и атомарно переименовывает. */
async function downloadFile(url, dest, { sha1, sha512, onProgress } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const res = await request(url, { timeout: 60000, retries: 2 });
  if (!res.ok) throw new HttpError(res.status, url);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      if (onProgress) onProgress(done, total);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
    if (sha1) await verifyFile(tmp, 'sha1', sha1);
    if (sha512) await verifyFile(tmp, 'sha512', sha512);
    await fsp.rename(tmp, dest);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

module.exports = { request, getJson, postJson, downloadFile, hashFile, HttpError, sleep };
