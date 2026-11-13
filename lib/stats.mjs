// 成本统计：桥接每次学习调用后上报一条，插件按天聚合，保留 30 天。
// 只做数字，不记内容。

import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_DIR } from './store.mjs';

export const STATS_FILE = path.join(ENGINE_DIR, 'stats.json');
const KEEP_DAYS = 30;

const emptyDay = () => ({ extract: 0, research: 0, tokens: 0, costCNY: 0, added: 0, autoConfirmed: 0 });

function dayKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function loadStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const days = raw?.days && typeof raw.days === 'object' ? raw.days : {};
    return { version: 1, days };
  } catch {
    return { version: 1, days: {} };
  }
}

function saveStats(stats) {
  fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
  const tmp = `${STATS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, days: stats.days }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, STATS_FILE);
}

function prune(days) {
  const keys = Object.keys(days).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[key];
}

/** 记一笔：kind = extract | research，可带 tokens / costCNY / added / autoConfirmed */
export function recordReport({ kind = 'extract', tokens = 0, costCNY = 0, added = 0, autoConfirmed = 0, at = Date.now() } = {}) {
  const stats = loadStats();
  const key = dayKey(at);
  const day = { ...emptyDay(), ...(stats.days[key] ?? {}) };
  if (kind === 'research') day.research += 1;
  else day.extract += 1;
  day.tokens += Math.max(0, Number(tokens) || 0);
  day.costCNY += Math.max(0, Number(costCNY) || 0);
  day.added += Math.max(0, Number(added) || 0);
  day.autoConfirmed += Math.max(0, Number(autoConfirmed) || 0);
  stats.days[key] = day;
  prune(stats.days);
  saveStats(stats);
  return { day: key, ...day };
}

/** 最近 N 天汇总（含今天）。 */
export function summarizeStats(daysBack = 7) {
  const stats = loadStats();
  const keys = Object.keys(stats.days).sort().slice(-Math.max(1, daysBack));
  const sum = { extract: 0, research: 0, tokens: 0, costCNY: 0, added: 0, autoConfirmed: 0, days: keys.length };
  for (const key of keys) {
    const d = stats.days[key];
    for (const field of Object.keys(sum)) if (field !== 'days' && d[field]) sum[field] += d[field];
  }
  return { today: stats.days[dayKey(Date.now())] ?? emptyDay(), last7: sum, days: keys.map((k) => ({ day: k, ...stats.days[k] })) };
}
