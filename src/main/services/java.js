'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { downloadFile } = require('../util/http');
const log = require('../logger');

const execFileP = promisify(execFile);
const IS_WIN = process.platform === 'win32';
const BIN = IS_WIN ? 'java.exe' : 'java';

async function javaMajor(bin) {
  try {
    const { stdout, stderr } = await execFileP(bin, ['-version'], { timeout: 8000, windowsHide: true });
    const m = /version "(\d+)(?:\.(\d+))?/.exec(stderr || stdout);
    if (!m) return null;
    let major = +m[1];
    if (major === 1) major = +m[2]; // 1.8.0_xxx → 8
    return major;
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Ищет bin/java в каталоге на глубину до 5 уровней. */
async function findBinary(dir, depth = 5) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === BIN && path.basename(dir) === 'bin') return path.join(dir, e.name);
  }
  if (depth <= 0) return null;
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = await findBinary(path.join(dir, e.name), depth - 1);
      if (r) return r;
    }
  }
  return null;
}

class JavaService {
  constructor(paths) {
    this.paths = paths;
  }

  /** Путь к java: принимает и файл, и JAVA_HOME-каталог. */
  async _normalize(p) {
    if (!p) return null;
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory()) return (await exists(path.join(p, 'bin', BIN))) ? path.join(p, 'bin', BIN) : null;
      return p;
    } catch {
      return null;
    }
  }

  async _scanDirs() {
    const out = [];
    const roots = [];
    if (IS_WIN) {
      for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
        for (const v of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto']) roots.push(path.join(pf, v));
      }
    } else if (process.platform === 'darwin') {
      roots.push('/Library/Java/JavaVirtualMachines');
    } else {
      roots.push('/usr/lib/jvm', '/usr/java', path.join(os.homedir(), '.sdkman/candidates/java'));
    }
    for (const r of roots) {
      let list = [];
      try {
        list = await fsp.readdir(r);
      } catch {
        continue;
      }
      for (const name of list) {
        const home = process.platform === 'darwin' ? path.join(r, name, 'Contents', 'Home') : path.join(r, name);
        const bin = await this._normalize(home);
        if (bin) out.push(bin);
      }
    }
    return out;
  }

  /** Все найденные установки Java (для настроек). */
  async detect() {
    const candidates = new Set();
    const rt = this.paths.runtime;
    try {
      for (const d of await fsp.readdir(rt)) {
        const b = await findBinary(path.join(rt, d));
        if (b) candidates.add(b);
      }
    } catch {
      /* нет runtime */
    }
    if (process.env.JAVA_HOME) {
      const b = await this._normalize(process.env.JAVA_HOME);
      if (b) candidates.add(b);
    }
    candidates.add('java');
    for (const b of await this._scanDirs()) candidates.add(b);

    const result = [];
    const seen = new Set();
    for (const bin of candidates) {
      const major = await javaMajor(bin);
      if (!major) continue;
      const key = bin === 'java' ? 'java' : await fsp.realpath(bin).catch(() => bin);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ path: bin, major, bundled: bin.startsWith(rt) });
    }
    return result.sort((a, b) => b.major - a.major);
  }

  static suits(found, required) {
    // Старые игры (≤1.16, Java 8) требуют именно Java 8.
    return required <= 8 ? found === 8 : found >= required;
  }

  async resolve({ major, custom, autoDownload = true, onProgress }) {
    if (custom) {
      const bin = await this._normalize(custom);
      const found = bin ? await javaMajor(bin) : null;
      if (!found) throw new Error(`Указанная Java не запускается: ${custom}`);
      if (!JavaService.suits(found, major)) {
        throw new Error(`Для этой версии Minecraft нужна Java ${major}${major <= 8 ? '' : '+'}, а указана Java ${found}`);
      }
      return bin;
    }
    const all = await this.detect();
    const suitable = all.filter((j) => JavaService.suits(j.major, major));
    const exact = suitable.find((j) => j.major === major);
    const pick = exact || suitable.sort((a, b) => a.major - b.major)[0];
    if (pick) return pick.path;
    if (!autoDownload) {
      throw new Error(`Java ${major} не найдена. Установите её или включите автозагрузку в настройках.`);
    }
    return this.download(major, onProgress);
  }

  /** Скачивает JRE Eclipse Temurin (Adoptium) нужной версии. */
  async download(major, onProgress) {
    const osName = { win32: 'windows', linux: 'linux', darwin: 'mac' }[process.platform];
    const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch];
    if (!osName || !arch) throw new Error(`Автозагрузка Java не поддерживается на ${process.platform}/${process.arch}`);

    const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${osName}/${arch}/jre/hotspot/normal/eclipse`;
    const finalDir = path.join(this.paths.runtime, `java-${major}`);
    const tmpDir = `${finalDir}.tmp`;
    const archive = path.join(this.paths.runtime, `java-${major}.${IS_WIN ? 'zip' : 'tar.gz'}`);

    log.info(`Загрузка Java ${major}: ${url}`);
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await fsp.mkdir(tmpDir, { recursive: true });
    await downloadFile(url, archive, { onProgress: (done, total) => onProgress && onProgress({ done, total }) });
    try {
      // tar есть в Windows 10+ (bsdtar, понимает zip), Linux и macOS.
      await execFileP('tar', ['-xf', archive, '-C', tmpDir], { timeout: 5 * 60 * 1000, windowsHide: true });
    } catch (e) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      throw new Error(`Не удалось распаковать Java (нужна утилита tar): ${e.message}`);
    } finally {
      await fsp.rm(archive, { force: true });
    }
    await fsp.rm(finalDir, { recursive: true, force: true });
    await fsp.rename(tmpDir, finalDir);
    const bin = await findBinary(finalDir);
    if (!bin) throw new Error('В загруженном архиве не найден исполняемый файл java');
    if ((await javaMajor(bin)) === null) throw new Error('Загруженная Java не запускается');
    return bin;
  }
}

module.exports = { JavaService };
