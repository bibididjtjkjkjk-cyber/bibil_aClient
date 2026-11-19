import { h, toast } from '../ui.js';

const api = window.bibil;
const MAX_LINES = 3000;

// Буферы живут на уровне модуля: вывод игры сохраняется, даже если вкладка «Консоль» закрыта.
const buffers = { game: [], launcher: [] };
let live = null; // callback активной вкладки

function push(kind, l) {
  const buf = buffers[kind];
  buf.push(l);
  if (buf.length > MAX_LINES) buf.shift();
  if (live) live(kind, l);
}
api.on('launch:log', (l) => push('game', l));
api.on('launcher:log', (l) => push('launcher', l));
api.invoke('logs:get').then((r) => { if (!buffers.launcher.length) buffers.launcher = r.launcher; }).catch(() => {});

export function consoleView(root) {
  const out = h('div', { class: 'console' });
  let source = 'game';
  const fmt = (l) => `${new Date(l.t).toLocaleTimeString('ru-RU')}  ${l.msg}`;
  const line = (l) => h('div', { class: l.level }, fmt(l));

  const tabs = h('div', { class: 'tabs' },
    h('button', { class: 'tab', 'data-k': 'game', onclick: () => { source = 'game'; repaint(); } }, 'Игра'),
    h('button', { class: 'tab', 'data-k': 'launcher', onclick: () => { source = 'launcher'; repaint(); } }, 'Лаунчер'));

  function repaint() {
    out.replaceChildren(...buffers[source].map(line));
    out.scrollTop = out.scrollHeight;
    for (const b of tabs.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.k === source);
  }

  live = (kind, l) => {
    if (kind !== source) return;
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
    out.append(line(l));
    if (out.childNodes.length > MAX_LINES) out.firstChild.remove();
    if (atBottom) out.scrollTop = out.scrollHeight;
  };

  root.append(
    h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, h('h1', {}, 'Консоль'), h('p', { class: 'sub' }, 'Вывод игры и журнал лаунчера в реальном времени.')),
      h('button', { class: 'btn', onclick: () => { buffers[source].length = 0; repaint(); } }, 'Очистить'),
      h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(buffers[source].map(fmt).join('\n')).then(() => toast('Скопировано', 'success')) }, 'Копировать'),
      h('button', { class: 'btn', onclick: () => api.invoke('app:openPath', 'logs').catch((e) => toast(e.message, 'error')) }, 'Папка логов')),
    tabs, out);
  repaint();

  return () => { live = null; };
}
