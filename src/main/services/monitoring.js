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

/**
 * Температуры через PowerShell (только Windows). ACPI thermal zone отдаёт
 * температуру в десятых долях Кельвина; GPU-датчики через WMI недоступны
 * без вендорских утилит, поэтому gpu остаётся null, если данных нет.
 * Запускается однократно с таймаутом и не влияет на работу лаунчера.
 */
async function probeTemperatures() {
  if (process.platform !== 'win32') return { cpu: null, gpu: null };
  const script = [
    '$tz = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue;',
    '$t = $null;',
    'if ($tz) { $avg = ($tz | Measure-Object -Property CurrentTemperature -Average).Average; if ($avg) { $t = [int][math]::Round(($avg / 10) - 273.15, 0) } }',
    '[PSCustomObject]@{ cpu = $t; gpu = $null } | ConvertTo-Json -Compress',
  ].join(' ');
  try {
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 6000, windowsHide: true });
    const parsed = JSON.parse(stdout.trim());
    return {
      cpu: parsed && Number.isFinite(Number(parsed.cpu)) ? Number(parsed.cpu) : null,
      gpu: parsed && Number.isFinite(Number(parsed.gpu)) ? Number(parsed.gpu) : null,
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
    this.emit('state', { active: true });
    this._tick();
    this.timer = setInterval(this._tick, this.intervalMs);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    this.timer = null;
    this.emit('state', { active: false });
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
    if (!this.active || this._ticking) return;
    this._ticking = true;
    try {
      const data = this.snapshot();
      if (!this.tempsProbed) {
        this.tempsProbed = true;
        this.temps = await probeTemperatures().catch(() => ({ cpu: null, gpu: null }));
        data.temps = this.temps;
      }
      this.emit('tick', data);
    } finally {
      this._ticking = false;
    }
  }

  /** Статус запуска игры для расчёта uptime. */
  isGameRunning() {
    return !!(this.launcher && this.launcher.session && this.launcher.session.child);
  }
}

module.exports = { MonitoringService };