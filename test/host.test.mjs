import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// 插件在模块加载时算目录，必须在 import 之前改 DSH_HOME
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slang-host-'));
process.env.DSH_HOME = tmpHome;

const mod = await import('../index.js');

const TOKEN_FILE = path.join(tmpHome, 'surfcore', 'slang-engine', 'bridge.token');
const STORE_FILE = path.join(tmpHome, 'slang.json');

async function startHost() {
  const routes = new Map();
  const webServer = { register: (route) => { routes.set(route.path, route.handler); return () => {}; } };
  const ctx = {
    get: (name) => (name === 'webServer' ? webServer : undefined),
    effect: (fn) => fn(),
  };
  mod.apply(ctx, { slangFile: STORE_FILE });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const handler = routes.get(url.pathname);
    if (!handler) { res.statusCode = 404; res.end('{"ok":false}'); return; }
    try { await handler(req, res); } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  return { server, base: `http://127.0.0.1:${server.address().port}`, token };
}

function clientFor(base, token) {
  return async (pathname, body, { auth = true } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { 'x-slang-token': token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

test('host 端到端：候选 → 计数 → 研究 → 自动确认 → 注入', async () => {
  const { server, base, token } = await startHost();
  const call = clientFor(base, token);
  try {
    // 令牌错误要被拒
    const denied = await call('/api/slang-engine/status', undefined, { auth: false });
    assert.equal(denied.status, 503); // 没有令牌、也没有宿主认证服务：失败关闭

    const status0 = await call('/api/slang-engine/status');
    assert.equal(status0.data.ok, true);
    assert.equal(status0.data.summary.total, 0);

    // 手动挡 + 这个群自动挡
    const saved = await call('/api/slang-engine/settings', { settings: { enabled: true, confirmMode: 'manual', groupOverrides: { 106: 'auto' } } });
    assert.equal(saved.data.settings.groupOverrides['106'], 'auto');

    // 候选入库（自动计入 groupId）
    const cand = await call('/api/slang-engine/candidates', {
      items: [{ content: '恶语伤狗心', confidence: 0.9, isCommon: false, family: '', sender: '甲', text: '恶语伤狗心', time: Date.now() }],
      groupId: '106',
    });
    assert.equal(cand.data.ok, true);
    assert.equal(cand.data.added, 1);

    // 两次命中、两个群友 → count=2, senders=2
    await call('/api/slang-engine/ingest', { key: 'group:106', sender: '甲', text: '恶语伤狗心', time: Date.now() });
    await call('/api/slang-engine/ingest', { key: 'group:106', sender: '乙', text: '恶语伤狗心啊', time: Date.now() });

    const words = await call('/api/slang-engine/words?status=candidate');
    const word = words.data.words[0];
    assert.equal(word.count, 2);
    assert.equal(word.senders, 2);

    // 研究结果：含义 + 用法 → high，且群是自动挡 → 自动转正
    const research = await call('/api/slang-engine/research-result', {
      items: [{ content: '恶语伤狗心', meaning: '群里的梗，说重话会伤到人，拿狗打比方自嘲', usage: '有人说话太冲时用来打圆场', sources: [] }],
    });
    assert.equal(research.data.updated, 1);
    assert.equal(research.data.autoConfirmed, 1);

    // 注入表里应该出现
    const ctxRes = await call(`/api/slang-engine/context?key=group%3A106&q=${encodeURIComponent('恶语伤狗心')}`);
    assert.equal(ctxRes.data.ok, true);
    assert.ok(ctxRes.data.block.includes('恶语伤狗心'));

    // 统计上报
    const rep = await call('/api/slang-engine/stats/report', { kind: 'extract', tokens: 1000, costCNY: 0.01, added: 1 });
    assert.equal(rep.data.ok, true);
    const stats = await call('/api/slang-engine/stats');
    assert.equal(stats.data.cost.today.extract, 1);
  } finally {
    server.close();
  }
});

