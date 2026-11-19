'use strict';
/**
 * CLI для другого тех-адміна (не потребує Electron):
 *   npm run sources:sync -- check
 *   npm run sources:sync -- sync --dir "C:\work\bibil_aClient"
 *   npm run sources:sync -- sync --dir . --force --no-backup
 *
 * Змінні оточення: BIBIL_UPDATE_URL, GITHUB_TOKEN / GH_TOKEN, BIBIL_SOURCES_DIR.
 */
const path = require('path');
const { SourceSyncService } = require('../src/main/services/source-sync');

const argv = process.argv.slice(2);
const command = argv[0] || 'check';
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

const dirFromArgs = arg('--dir') || process.env.BIBIL_SOURCES_DIR || '';
const settings = {
  get: () => ({
    sources: {
      dir: dirFromArgs,
      backup: !argv.includes('--no-backup'),
      autoCheck: false,
    },
    updater: {
      url: arg('--url') || process.env.BIBIL_UPDATE_URL || '',
      githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
    },
  }),
};

const svc = new SourceSyncService({ settings, paths: null });
svc.on('state', (s) => {
  if (s.percent !== undefined) process.stdout.write(`\r[${s.state}] ${s.percent}% ${s.message || ''}   `);
  else console.log(`\n[${s.state}] ${s.message || ''}`);
});

(async () => {
  if (!['check', 'sync', 'status'].includes(command)) {
    throw new Error('Використання: node scripts/source-sync.js check|status|sync [--dir ...] [--force] [--no-backup]');
  }
  if (command === 'status') {
    console.log(JSON.stringify(svc.status(), null, 2));
    return;
  }
  if (command === 'check') {
    const m = await svc.check();
    console.log('\n' + JSON.stringify(m, null, 2));
    return;
  }
  const result = await svc.sync({ backup: !argv.includes('--no-backup'), force: argv.includes('--force') });
  console.log('\n' + JSON.stringify(result, null, 2));
})().catch((e) => {
  console.error(`\n[${e.code || 'ERROR'}] ${e.message}`);
  process.exit(1);
});
