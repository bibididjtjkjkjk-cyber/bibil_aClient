'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SkinManager } = require('../src/main/services/skins');
const { ScreenshotManager } = require('../src/main/services/screenshots');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bibil-extended-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function png(width = 64, height = 64) {
  const data = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.write('IHDR', 12, 'ascii');
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

test('skin library imports, lists, renames, and removes validated PNGs', async (t) => {
  const dir = tempDir(t);
  const source = path.join(dir, 'skin.png');
  fs.writeFileSync(source, png());
  const updatedSource = path.join(dir, 'updated.png');
  fs.writeFileSync(updatedSource, png(64, 32));
  const manager = new SkinManager({ paths: { config: dir }, auth: {} });

  const skin = await manager.importFile(source, 'Test skin', 'slim');
  assert.equal(skin.model, 'slim');
  assert.equal((await manager.list())[0].name, 'Test skin');
  assert.match((await manager.list())[0].dataUrl, /^data:image\/png;base64,/);
  assert.equal(manager.rename(skin.id, 'Renamed').name, 'Renamed');
  const updated = await manager.replace(skin.id, updatedSource, 'Updated', 'classic');
  assert.equal(updated.name, 'Updated');
  assert.equal(updated.model, 'classic');
  await manager.remove(skin.id);
  assert.deepEqual(await manager.list(), []);
  fs.writeFileSync(source, Buffer.from('not png'));
  await assert.rejects(manager.importFile(source, 'Invalid'));
});

test('screenshots are sorted, previewed, safely renamed, and removed per profile', async (t) => {
  const dir = tempDir(t);
  const profileId = 'profile-test';
  const shotsDir = path.join(dir, 'screenshots');
  fs.mkdirSync(shotsDir);
  const older = path.join(shotsDir, 'older.png');
  const newer = path.join(shotsDir, 'newer.png');
  fs.writeFileSync(older, png());
  fs.writeFileSync(newer, png());
  fs.utimesSync(older, new Date(1000), new Date(1000));
  fs.utimesSync(newer, new Date(2000), new Date(2000));
  const manager = new ScreenshotManager({
    paths: { instanceDir: () => dir },
    profiles: { get: (id) => id === profileId ? { id } : null },
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => false,
        resize: () => ({ toDataURL: () => 'data:image/png;base64,preview' }),
      }),
    },
  });

  const entries = await manager.list(profileId);
  assert.deepEqual(entries.map((x) => x.name), ['newer.png', 'older.png']);
  assert.equal(entries[0].preview, 'data:image/png;base64,preview');
  assert.equal(await manager.rename(profileId, 'older.png', 'renamed'), 'renamed.png');
  await assert.rejects(manager.rename(profileId, 'newer.png', '../escape'));
  await manager.remove(profileId, 'renamed.png');
  assert.deepEqual((await manager.list(profileId)).map((x) => x.name), ['newer.png']);
  assert.throws(() => manager.path(profileId, '../escape.png'));
  assert.throws(() => manager.path('missing-profile', 'newer.png'));
});
