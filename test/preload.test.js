'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

/** Достаёт строки из `const NAME = new Set([ ... ])`. */
function readSet(source, name) {
  const match = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(match, `В preload.js не найден список ${name}`);
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const preload = read('src', 'main', 'preload.js');
const ipc = read('src', 'main', 'ipc.js');
const INVOKE = readSet(preload, 'INVOKE');
const EVENTS = readSet(preload, 'EVENTS');

const rendererFiles = walk(path.join(root, 'src', 'renderer', 'js'));
const channels = (pattern) => {
  const found = new Set();
  for (const file of rendererFiles) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(pattern)) found.add(m[1]);
  }
  return found;
};

test('preload: каждое событие, на которое подписывается рендерер, разрешено', () => {
  const used = channels(/api\.on\('([^']+)'/g);
  const missing = [...used].filter((ch) => !EVENTS.has(ch));
  assert.deepEqual(missing, [], `События без разрешения в preload EVENTS: ${missing.join(', ')}`);
  assert.ok(EVENTS.has('monitor:state'), 'monitor:state должен быть в EVENTS');
  assert.ok(EVENTS.has('monitor:tick'), 'monitor:tick должен быть в EVENTS');
});

test('preload: каждый invoke-канал рендерера разрешён и зарегистрирован в main', () => {
  const used = channels(/api\.invoke\('([^']+)'/g);
  const missing = [...used].filter((ch) => !INVOKE.has(ch));
  assert.deepEqual(missing, [], `Invoke-каналы без разрешения в preload INVOKE: ${missing.join(', ')}`);

  const handled = new Set([...ipc.matchAll(/handle\('([^']+)'/g)].map((m) => m[1]));
  const unhandled = [...used].filter((ch) => !handled.has(ch));
  assert.deepEqual(unhandled, [], `Invoke-каналы без обработчика в ipc.js: ${unhandled.join(', ')}`);
});

test('preload: все события из main-процесса разрешены', () => {
  const sent = new Set([...ipc.matchAll(/send\('([^']+)'/g)].map((m) => m[1]));
  const missing = [...sent].filter((ch) => !EVENTS.has(ch));
  assert.deepEqual(missing, [], `События main → renderer без разрешения в preload EVENTS: ${missing.join(', ')}`);
});
