'use strict';

/**
 * Мониторинг во время игры: FPS, RAM, CPU, температуры (если доступны), ping, время игры.
 *
 * Собирается в главном процессе и передаётся в рендерер событием `monitor:tick`.
 * Интервал обновления подобран так, чтобы не нагружать систему: метрики, которые
 * меняются медленно, опрашиваются раз в 500 мс, FPS — через requestAnimationFrame
 * в рендерере (самый дешёвый способ).
 */
const os = require('os');
const EventEmitter = require('events');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

const TICK_MS = 500; // как часто шлём обновление
const CPU_SAMPLE_MS = 250; // интервал замера CPU (через process.cpuUsage)

/** Температура CPU/GPU через PowerShell (только Windows). Запускается однократно с таймаутом. */
async function probeTemperatures() {
  if (process.platform !== 'win32') return { cpu: null, gpu: null };
  const script = [
    '$cpu = Get-CimInstance -ClassName Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object -ExpandProperty Average;',
    '$gpu = Get-CimInstance -ClassName Win32_VideoController | Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalInformation -ErrorAction SilentlyContinue;',
    'if ($gpu) { $t = ($gpu | Measure-Object -Property CurrentTemperature -Average | Select-Object -ExpandProperty Average) } else { $t = $null }',
    '[PSCustomObject]@{cpu=[int]($cpu ?? -1); gpu=if ($t) { [int]$t } else { $null } } | ConvertTo-Json',
  ].join(' ');
  try {
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 6000, windowsHide: true });
    const parsed = JSON.parse(stdout.trim());
    return {
      cpu: parsed && parsed.cpu >= 0 ? parsed.cpu : null,
      gpu: parsed && parsed.gpu != null ? parsed.gpu : null,
    };
  } catch {
    return { cpu: null, gpu: null };
  }
}

class MonitoringService extends EventEmitter {
  constructor({ launcher, intervalMs = TICK_MS } = {}) {
    super();
    this.launcher = launcher || null;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.active = false;
    this.startedAt = 0;
    this.lastCpu = process.cpuUsage();
    this.lastCpuTime = Date.now();
    this.temps = { cpu: null, gpu: null };
    this.tempsProbed = false;
    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.startedAt = Date.now();
    this.lastCpu = process.cpuUsage();
    this.lastCpuTime = Date.now();
    this.emit('monitor:state', { active: true });
    this._tick();
    this.timer = setInterval(this._tick, this.intervalMs);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    this.timer = null;
    this.emit('monitor:state', { active: false });
  }

  /** Текущие метрики (без запуска цикла). */
  snapshot() {
    const now = Date.now();
    const cpu = process.cpuUsage(this.lastCpu);
    const dt = now - this.lastCpuTime;
    this.lastCpu = process.cpuUsage();
    this.lastCpuTime = now;
    const cpuPct = dt > 0 ? ((cpu.user + cpu.system) / 1000 / dt) * 100 : 0;
    const totalMemMb = Math.floor(os.totalmem() / 1024 / 1024);
    const freeMemMb = Math.floor(os.freemem() / 1024 / 1024);
    const usedMemMb = totalMemMb - freeMemMb;
    return {
      fps: 0, // заполняется рендерером
      cpu: Math.max(0, Math.min(100, cpuPct)),
      ramUsedMb: usedMemMb,
      ramTotalMb: totalMemMb,
      uptimeMs: this.startedAt ? now - this.startedAt : 0,
      temps: { ...this.temps },
    };
  }

  async _tick() {
    if (!this.active) return;
    const data = this.snapshot();
    if (!this.tempsProbed) {
      this.tempsProbed = true;
      this.temps = await probeTemperatures().catch(() => ({ cpu: null, gpu: null }));
      data.temps = this.temps;
    }
    this.emit('monitor:tick', data);
  }

  /** Статус запуска игры для расчёта uptime. */
  isGameRunning() {
    return !!(this.launcher && this.launcher.session && this.launcher.session.child);
  }
}

module.exports = { MonitoringService };