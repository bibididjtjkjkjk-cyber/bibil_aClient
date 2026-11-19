'use strict';

/** Разбивает строку аргументов с учётом кавычек: `-Dfoo="a b" -Xss1M` → ['-Dfoo=a b', '-Xss1M'] */
function splitArgs(str) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(str || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) {
        out.push(cur);
        cur = '';
        has = false;
      }
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

/**
 * Убирает явно заданный сборщик мусора и его настройки: на Java 25 + LWJGL 3.4.3
 * такие флаги приводили к нативному крашу 0xC0000005 при загрузке шрифтов/OpenGL.
 */
function safeJvmArgs(args) {
  const list = Array.isArray(args) ? args : splitArgs(args);
  return list.filter((a) => !/^-XX:(?:\+Use(?:ZGC|G1GC|ParallelGC|SerialGC|EpsilonGC)|MaxGCPauseMillis|G1|Z)/.test(a));
}

const G1_PERFORMANCE_ARGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+DisableExplicitGC',
];

/** Java 25+ uses Mojang's collector defaults; explicit collector flags can crash LWJGL. */
function buildJvmArgs(args, javaMajor, { safe = false } = {}) {
  const custom = safeJvmArgs(args);
  if (safe) return custom;
  const major = Number(javaMajor);
  return major >= 8 && major <= 24 ? [...G1_PERFORMANCE_ARGS, ...custom] : custom;
}

module.exports = { splitArgs, safeJvmArgs, buildJvmArgs, G1_PERFORMANCE_ARGS };
