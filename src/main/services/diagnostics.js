'use strict';
/**
 * Диагностика системы: железо, Java, версия Minecraft и проверки компонентов лаунчера.
 * Собирает реальные данные ОС/процессора/памяти и результаты проверок компонентов.
 */
const os = require('os');
const { JavaService } = require('./java');
const { InstallerService } = require('./installer');

function cpuInfo() {
  const cpus = os.cpus();
  const first = cpus[0] || {};
  return {
    model: first.model || '',
    manufacturer: first.manufacturer || '',
    cores: cpus.length,
    speed: first.speed || 0,
  };
}

class DiagnosticsService {
  constructor({ versions, java, installer } = {}) {
    this.versions = versions || null;
    this.java = java || new JavaService({ runtime: '' });
    this.installer = installer || new InstallerService({ paths: {} });
  }

  async gather({ versionId = null, profileId = null } = {}) {
    const osInfo = {
      platform: process.platform,
      arch: process.arch,
      release: process.release,
      cpu: cpuInfo(),
      totalMemMb: Math.floor(os.totalmem() / 1024 / 1024),
      freeMemMb: Math.floor(os.freemem() / 1024 / 1024),
    };

    const javaList = await this.java.detect().catch(() => []);
    const java = {
      found: javaList,
      latest: javaList[0] || null,
      required: versionId ? await this.versions?.requiredJava(versionId).catch(() => null) : null,
    };

    let minecraft = { version: versionId, type: null, requiredJava: null, installed: false };
    if (versionId) {
      minecraft.requiredJava = await this.versions?.requiredJava(versionId).catch(() => null);
      minecraft.installed = await this.installer?.isInstalled?.(versionId).catch(() => false);
      minecraft.type = await this.versions?.getType?.(versionId).catch(() => 'release');
    }

    const checks = [];
    checks.push({
      id: 'java',
      label: 'Java',
      ok: !!java.latest && (java.required == null || java.latest.major >= java.required),
      value: java.latest ? java.latest.major : null,
      required: java.required,
      hint: java.required ? `Java ${java.required}+` : '',
    });
    checks.push({
      id: 'version',
      label: 'Minecraft',
      ok: !!minecraft.installed,
      value: minecraft.version || null,
      hint: minecraft.version ? `MC ${minecraft.version}` : '',
    });

    return {
      os: osInfo,
      java,
      minecraft,
      checks,
      generatedAt: Date.now(),
    };
  }
}

module.exports = { DiagnosticsService };
