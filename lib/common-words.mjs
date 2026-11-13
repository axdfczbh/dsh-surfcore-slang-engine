// 大众词表：由桥接定期联网生成后推送进来，插件只负责存、并、匹配。
// 目的：提取器捞上来的"冒泡/撞衫/话唠"这类词，在入库前就被拦掉。

import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_DIR } from './store.mjs';

export const COMMON_WORDS_FILE = path.join(ENGINE_DIR, 'common-words.json');
const MAX_ENTRIES = 500;

const empty = { version: 1, updatedAt: '', words: [], manual: [] };

function cleanList(list) {
  return (Array.isArray(list) ? list : [])
    .map((w) => String(w ?? '').trim())
    .filter((w) => w.length >= 2 && w.length <= 8)
    .filter((w, i, arr) => arr.indexOf(w) === i);
}

export function loadCommonWords() {
  try {
    const raw = JSON.parse(fs.readFileSync(COMMON_WORDS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return {
      version: 1,
      updatedAt: String(raw?.updatedAt ?? ''),
      words: cleanList(raw?.words).slice(0, MAX_ENTRIES),
      manual: cleanList(raw?.manual).slice(0, MAX_ENTRIES),
    };
  } catch {
    return { ...empty };
  }
}

export function saveCommonWords(data) {
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    words: cleanList(data?.words).slice(0, MAX_ENTRIES),
    manual: cleanList(data?.manual).slice(0, MAX_ENTRIES),
  };
  fs.mkdirSync(path.dirname(COMMON_WORDS_FILE), { recursive: true });
  const tmp = `${COMMON_WORDS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, COMMON_WORDS_FILE);
  return next;
}

/** 自动抓到的一批词合并进词表（人工词永不被覆盖、也不被裁掉）。 */
export function mergeCommonWords(incoming, { source = 'web' } = {}) {
  const current = loadCommonWords();
  const incomingClean = cleanList(incoming);
  const manual = current.manual;
  // words 只放自动词；人工词单独存 manual，匹配时两者取并集
  const words = current.words.filter((w) => !manual.includes(w));
  for (const w of incomingClean) {
    if (!manual.includes(w) && !words.includes(w)) words.push(w);
  }
  return saveCommonWords({ words: words.slice(0, MAX_ENTRIES), manual, source });
}

/** 给判定用的集合：自动词表 + 人工词表。 */
export function commonWordSet(data = loadCommonWords()) {
  return new Set([...(data.words ?? []), ...(data.manual ?? [])]);
}

export function addManualWord(word) {
  const current = loadCommonWords();
  const w = String(word ?? '').trim();
  if (!w) return current;
  const manual = cleanList([...current.manual, w]);
  const words = current.words.filter((x) => x !== w);
  return saveCommonWords({ words, manual });
}

export function removeWord(word) {
  const current = loadCommonWords();
  const w = String(word ?? '').trim();
  return saveCommonWords({
    words: current.words.filter((x) => x !== w),
    manual: current.manual.filter((x) => x !== w),
  });
}
