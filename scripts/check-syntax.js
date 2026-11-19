'use strict';
// Проверка синтаксиса всех JS-файлов без установки зависимостей:  npm run check
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bibil-check-'));
let failed = 0;
let count = 0;

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') walk(p);
    } else if (e.name.endsWith('.js')) {
      check(p);
    }
  }
}

function check(file) {
  count++;
  const isRenderer = file.includes(`${path.sep}renderer${path.sep}`);
  let target = file;
  if (isRenderer) {
    // ES-модули браузера проверяем как .mjs
    target = path.join(tmp, `${count}.mjs`);
    fs.writeFileSync(target, fs.readFileSync(file));
  }
  const r = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`✗ ${path.relative(root, file)}\n${r.stderr}`);
  }
}

walk(path.join(root, 'src'));
walk(path.join(root, 'test'));
walk(path.join(root, 'scripts'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `Ошибок: ${failed}` : `Синтаксис OK (${count} файлов)`);
process.exit(failed ? 1 : 0);
