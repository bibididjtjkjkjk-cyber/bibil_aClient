'use strict';
const fs = require('fs');
const path = require('path');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target, source) {
  for (const k of Object.keys(source)) {
    if (FORBIDDEN.has(k)) continue;
    if (isObj(source[k]) && isObj(target[k])) deepMerge(target[k], source[k]);
    else target[k] = isObj(source[k]) ? deepMerge({}, source[k]) : source[k];
  }
  return target;
}

/** Удаляет из obj ключи, которых нет в эталоне def (рекурсивно для объектов). */
function prune(obj, def) {
  for (const k of Object.keys(obj)) {
    if (!(k in def)) delete obj[k];
    else if (isObj(def[k]) && isObj(obj[k])) prune(obj[k], def[k]);
  }
  return obj;
}

/** JSON-хранилище с атомарной записью и восстановлением после повреждения файла. */
class JsonStore {
  constructor(file, defaults = {}, log = null) {
    this.file = file;
    this.defaults = defaults;
    this.log = log;
    this.data = this._load();
  }

  _load() {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.file, backup);
        } catch {
          /* ignore */
        }
        if (this.log) this.log.warn(`Файл ${this.file} повреждён, сохранён как ${backup}`);
      }
    }
    const data = clone(this.defaults);
    return isObj(parsed) ? deepMerge(data, parsed) : data;
  }

  patch(obj) {
    deepMerge(this.data, obj);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonStore, deepMerge, prune, clone, isObj };
