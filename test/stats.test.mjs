import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slang-stats-'));
process.env.DSH_HOME = tmpHome;

const { recordReport, summarizeStats, STATS_FILE } = await import('../lib/stats.mjs');

test('记录与汇总：extract/research 分开计，成本累加', () => {
  recordReport({ kind: 'extract', tokens: 1200, costCNY: 0.01, added: 2, autoConfirmed: 1 });
  recordReport({ kind: 'research', tokens: 800, costCNY: 0.02 });
  const s = summarizeStats(7);
  assert.equal(s.today.extract, 1);
  assert.equal(s.today.research, 1);
  assert.equal(s.today.tokens, 2000);
  assert.ok(Math.abs(s.today.costCNY - 0.03) < 1e-9);
  assert.equal(s.today.added, 2);
  assert.equal(s.today.autoConfirmed, 1);
});

test('只保留最近 30 天', () => {
  const raw = { version: 1, days: {} };
  for (let i = 0; i < 40; i += 1) {
    const d = new Date(Date.now() - i * 86400000);
    raw.days[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = { extract: 1 };
  }
  fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(raw));
  recordReport({ kind: 'extract' });
  const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  assert.ok(Object.keys(saved.days).length <= 30);
});
