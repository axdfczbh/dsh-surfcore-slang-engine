import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import 之前改 DSH_HOME：store.mjs 在模块加载时就算好了目录
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slang-cw-'));
process.env.DSH_HOME = tmpHome;

const cw = await import('../lib/common-words.mjs');

test('大众词表：合并、去重、上限与人工词保护', () => {
  const a = cw.mergeCommonWords(['冒泡', '撞衫', '话唠', '冒泡'], { source: 'web' });
  assert.equal(a.words.length, 3);
  assert.ok(a.updatedAt);

  const b = cw.addManualWord('踩雷');
  assert.ok(b.manual.includes('踩雷'));

  // 自动刷新不会覆盖人工词
  const c = cw.mergeCommonWords(['养鱼'], { source: 'web' });
  assert.ok(c.manual.includes('踩雷'));
  assert.ok(c.words.includes('养鱼'));
  assert.ok(!c.words.includes('踩雷'));

  const set = cw.commonWordSet(c);
  assert.ok(set.has('冒泡'));
  assert.ok(set.has('踩雷'));

  const d = cw.removeWord('撞衫');
  assert.ok(!d.words.includes('撞衫'));
});

test('大众词表：非法词被过滤', () => {
  const a = cw.mergeCommonWords(['', 'x', '这是一个特别特别长的词', '  ', '正常词'], {});
  assert.ok(a.words.includes('正常词'));
  for (const bad of ['x', '这是一个特别特别长的词', '  ']) assert.ok(!a.words.includes(bad));
});

