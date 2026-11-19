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

module.exports = { splitArgs, safeJvmArgs };
