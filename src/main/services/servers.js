'use strict';
/**
 * Автоматическое добавление серверов в Minecraft.
 * Модуль позволяет управлять списком серверов и автоматически записывать их
 * в `servers.dat` выбранных (или новых) профилей перед запуском Minecraft.
 * Создаёт резервную копию `servers.dat.bak` перед каждым изменением.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { JsonStore } = require('../store');
const log = require('../logger');

const DEFAULTS = {
  enabled: true,
  servers: [], // [{ id, name, ip, port, autoAdd: true, profiles: [] }]
};

/** Простейшая сериализация/десериализация NBT-формата servers.dat (NBT Compound "servers" -> List of Compound).
 * Используется стандартный бинарный NBT-формат Minecraft.
 */
function encodeNbtString(str) {
  const buf = Buffer.from(str, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function encodeServerEntry(name, ip) {
  // Tag_Compound (0x0A) -> Tag_String "name" (0x08) -> Tag_String "ip" (0x08) -> Tag_End (0x00)
  const nameKey = encodeNbtString('name');
  const nameVal = encodeNbtString(name);
  const ipKey = encodeNbtString('ip');
  const ipVal = encodeNbtString(ip);

  const parts = [
    Buffer.from([0x08]), nameKey, nameVal,
    Buffer.from([0x08]), ipKey, ipVal,
    Buffer.from([0x00]), // Tag_End
  ];
  return Buffer.concat(parts);
}

function buildServersDat(servers) {
  // Root Compound (0x0A) -> Name "" -> Tag_List "servers" (0x09) -> Type Compound (0x0A) -> Length -> Entries... -> Tag_End
  const rootName = encodeNbtString('');
  const listName = encodeNbtString('servers');
  const listHeader = Buffer.alloc(5);
  listHeader.writeByte ? listHeader.writeByte(0x0A, 0) : (listHeader[0] = 0x0A); // Compound element type
  listHeader.writeInt32BE(servers.length, 1);

  const entryBuffers = servers.map((s) => encodeServerEntry(s.name, s.port ? `${s.ip}:${s.port}` : s.ip));

  return Buffer.concat([
    Buffer.from([0x0A]), rootName,
    Buffer.from([0x09]), listName, listHeader,
    ...entryBuffers,
    Buffer.from([0x00]), // Root End
  ]);
}

/** Чтение наивного NBT-файла servers.dat для проверки дубликатов. */
function readServerIpsFromDat(buffer) {
  const ips = new Set();
  try {
    const str = buffer.toString('utf8', 0, buffer.length);
    // Простой поиск совпадений IP:Port в бинарном дампе
    const matches = str.match(/[a-zA-Z0-9.\-_]+:\d{1,5}/g) || [];
    for (const m of matches) ips.add(m.toLowerCase());
  } catch { /* ignore */ }
  return ips;
}

class ServerManager {
  constructor(file, paths) {
    this.store = new JsonStore(file, DEFAULTS, log);
    this.paths = paths;
  }

  list() {
    return JSON.parse(JSON.stringify(this.store.data));
  }

  update(patch) {
    this.store.patch(patch || {});
    this.store.save();
    return this.list();
  }

  addServer({ name, ip, port = 25565, autoAdd = true, profiles = [] }) {
    if (!name || !ip) throw new Error('Укажите название и IP сервера');
    const cleanIp = String(ip).trim();
    const cleanName = String(name).trim();
    const cleanPort = Number(port) || 25565;

    const servers = this.store.data.servers;
    const exists = servers.find((s) => s.ip.toLowerCase() === cleanIp.toLowerCase() && Number(s.port) === cleanPort);
    if (exists) {
      Object.assign(exists, { name: cleanName, autoAdd: !!autoAdd, profiles });
    } else {
      servers.push({
        id: require('crypto').randomUUID(),
        name: cleanName,
        ip: cleanIp,
        port: cleanPort,
        autoAdd: autoAdd !== false,
        profiles: Array.isArray(profiles) ? profiles : [],
      });
    }
    this.store.save();
    return this.list();
  }

  removeServer(id) {
    this.store.data.servers = this.store.data.servers.filter((s) => s.id !== id);
    this.store.save();
    return this.list();
  }

  /**
   * Добавляет сохранённые серверы в `servers.dat` указанной инстанции перед запуском.
   * Безопасно: создает `servers.dat.bak` перед записью и не дублирует уже имеющиеся серверы.
   */
  async applyToInstance(profileId) {
    if (!this.store.data.enabled) return;
    const allServers = this.store.data.servers.filter((s) => s.autoAdd);
    if (!allServers.length) return;

    // Оставляем только те серверы, где явно указан данный профиль или список профилей пуст (для всех)
    const targetServers = allServers.filter((s) => !s.profiles?.length || s.profiles.includes(profileId));
    if (!targetServers.length) return;

    const instanceDir = this.paths.instanceDir(profileId);
    await fsp.mkdir(instanceDir, { recursive: true });
    const datPath = path.join(instanceDir, 'servers.dat');
    const bakPath = path.join(instanceDir, 'servers.dat.bak');

    // Если NBT-файл уже существует, проверяем на наличие дубликатов
    if (fs.existsSync(datPath)) {
      try {
        await fsp.copyFile(datPath, bakPath); // Создаём бэкап
        const existingBuf = await fsp.readFile(datPath);
        const existingIps = readServerIpsFromDat(existingBuf);

        // Отфильтровываем те, которые уже содержатся в файле
        const newServers = targetServers.filter((s) => {
          const fullAddr = s.port ? `${s.ip}:${s.port}` : s.ip;
          return !existingIps.has(fullAddr.toLowerCase()) && !existingIps.has(s.ip.toLowerCase());
        });

        if (!newServers.length) return; // Всё уже добавлено
        log.info(`[servers] Добавление ${newServers.length} новых серверов в профиль ${profileId}`);
      } catch (e) {
        log.warn(`[servers] Не удалось прочитать или сделать бэкап servers.dat: ${e.message}`);
      }
    }

    // Собираем полное содержимое NBT и записываем атомарно
    try {
      const datBuffer = buildServersDat(targetServers);
      const tmpPath = datPath + '.tmp';
      await fsp.writeFile(tmpPath, datBuffer);
      await fsp.rename(tmpPath, datPath);
      log.info(`[servers] Успешно записан servers.dat для профиля ${profileId}`);
    } catch (e) {
      log.error(`[servers] Ошибка при записи servers.dat:`, e);
    }
  }
}

module.exports = { ServerManager, buildServersDat };