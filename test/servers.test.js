'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ServerManager, buildServersDat } = require('../src/main/services/servers');
const { MonitoringService } = require('../src/main/services/monitoring');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bibil-test-srv-'));

test('ServerManager: сохранение серверов, валидация и генерация servers.dat', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'servers.json');
  const instanceDir = path.join(dir, 'instances', 'test-prof');
  const mgr = new ServerManager(file, { instanceDir: () => instanceDir });

  // Добавление сервера
  const res = mgr.addServer({ name: ' Hypixel ', ip: ' mc.hypixel.net ', port: 25565 });
  assert.equal(res.servers.length, 1);
  assert.equal(res.servers[0].name, 'Hypixel');
  assert.equal(res.servers[0].ip, 'mc.hypixel.net');

  // Добавление дубликата обновит название
  mgr.addServer({ name: 'Hypixel Network', ip: 'mc.hypixel.net', port: 25565 });
  assert.equal(mgr.list().servers.length, 1);
  assert.equal(mgr.list().servers[0].name, 'Hypixel Network');

  // Проверка генерации бинарного NBT
  const datBuf = buildServersDat(mgr.list().servers);
  assert.ok(datBuf.length > 20);
  assert.ok(datBuf.includes(Buffer.from('mc.hypixel.net')));

  // Применение к инстанции
  await mgr.applyToInstance('test-prof');
  const datPath = path.join(instanceDir, 'servers.dat');
  assert.ok(fs.existsSync(datPath));
  assert.ok(fs.statSync(datPath).size > 20);

  // Повторное применение не перезаписывает файл заново при совпадении
  await mgr.applyToInstance('test-prof');
  assert.ok(fs.existsSync(path.join(instanceDir, 'servers.dat.bak')));

  // Удаление
  mgr.removeServer(res.servers[0].id);
  assert.equal(mgr.list().servers.length, 0);
});

test('MonitoringService: расчет CPU, RAM и снятие снимков', async () => {
  const svc = new MonitoringService();
  const snap = svc.snapshot();
  assert.ok(typeof snap.cpu === 'number');
  assert.ok(snap.ramTotalMb > 0);
  assert.ok(snap.ramUsedMb > 0);
  assert.equal(snap.uptimeMs, 0);

  svc.start();
  assert.equal(svc.active, true);
  await new Promise((r) => setTimeout(r, 600));
  const snapActive = svc.snapshot();
  assert.ok(snapActive.uptimeMs > 500);
  svc.stop();
  assert.equal(svc.active, false);
});