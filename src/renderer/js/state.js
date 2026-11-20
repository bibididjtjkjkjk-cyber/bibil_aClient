// Общее состояние рендерера и подписки. Источник истины — main-процесс.
import { setLocale, getLocale } from './i18n.js';

const api = window.bibil;

export const state = {
  info: null,
  settings: null,
  profiles: [],
  activeProfileId: null,
  accounts: [],
  activeAccountId: null,
  launch: { status: 'idle', message: '', progress: null, profileId: null },
  install: null, // { id, message, progress } — фоновая установка версии
  monitor: { active: false, fps: 0, cpu: 0, ramUsedMb: 0, ramTotalMb: 0, uptimeMs: 0, temps: { cpu: null, gpu: null } },
};

const subs = new Set();
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
export function notify(what) {
  for (const fn of subs) fn(what);
}

export const activeProfile = () => state.profiles.find((p) => p.id === state.activeProfileId) || null;
export const activeAccount = () => state.accounts.find((a) => a.id === state.activeAccountId) || null;

export async function refreshProfiles() {
  const r = await api.invoke('profiles:list');
  state.profiles = r.profiles;
  state.activeProfileId = r.active;
  notify('profiles');
}

export async function refreshAccounts() {
  const r = await api.invoke('accounts:list');
  state.accounts = r.accounts;
  state.activeAccountId = r.active;
  notify('accounts');
}

export async function saveSettings(patch) {
  state.settings = await api.invoke('settings:set', patch);
  applyAppearance();
  const language = state.settings.launcher.language || 'ru';
  if (language !== getLocale()) {
    setLocale(language);
    notify('language');
  }
  notify('settings');
  return state.settings;
}

export function applyAppearance() {
  const l = state.settings.launcher;
  const root = document.documentElement;
  root.dataset.theme = l.theme;
  root.dataset.anim = l.animations ? 'on' : 'off';
  root.style.setProperty('--accent', l.accent);
}

export async function init() {
  const [info, settings, launch] = await Promise.all([api.invoke('app:info'), api.invoke('settings:get'), api.invoke('launch:state')]);
  state.info = info;
  state.settings = settings;
  state.launch = launch;
  setLocale(settings.launcher.language || 'ru');
  applyAppearance();
  await Promise.all([refreshProfiles(), refreshAccounts()]);
  api.on('install:progress', (p) => {
    state.install = p.progress === 1 ? null : p;
    notify('install');
  });
  api.on('launch:state', (s) => {
    state.launch = s;
    notify('launch');
    if (s.status === 'idle' || s.status === 'running') refreshProfiles().catch(() => {}); // обновить «последний запуск»
  });
  api.on('monitor:state', (s) => { state.monitor.active = !!s.active; notify('monitor'); });
  api.on('monitor:tick', (d) => {
    if (!d) return;
    state.monitor = { active: state.monitor.active, fps: d.fps || 0, cpu: d.cpu || 0,
      ramUsedMb: d.ramUsedMb || 0, ramTotalMb: d.ramTotalMb || 0, uptimeMs: d.uptimeMs || 0,
      temps: d.temps || { cpu: null, gpu: null } };
    notify('monitor');
  });
}
