import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slang-prune-'));
process.env.DSH_HOME = tmpHome;
const mod = await import('../index.js');

const STORE_FILE = path.join(tmpHome, 'slang.json');
const TOKEN_FILE = path.join(tmpHome, 'surfcore', 'slang-engine', 'bridge.token');

async function startHost() {
  const routes = new Map();
  const webServer = { register: (route) => { routes.set(route.path, route.handler); return () => {}; } };
  mod.apply({ get: (n) => (n === 'webServer' ? webServer : undefined), effect: (fn) => fn() }, { slangFile: STORE_FILE });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const handler = routes.get(url.pathname);
    if (!handler) { res.statusCode = 404; res.end('{"ok":false}'); return; }
    await handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, token: fs.readFileSync(TOKEN_FILE, 'utf8').trim() };
}

test('prune：默认 dry-run，apply 后候选被拒绝并进排除名单', async () => {
  const { server, base, token } = await startHost();
  const call = async (p, body) => {
    const res = await fetch(`${base}${p}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-slang-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };
  try {
    for (const content of ['一次词甲', '一次词乙']) {
      await call('/api/slang-engine/candidates', { items: [{ content, confidence: 0.9 }], groupId: '1' });
    }
    const dry = await call('/api/slang-engine/words/prune', {});
    assert.equal(dry.dryRun, true);
    assert.equal(dry.wouldReject, 2);
    assert.equal(dry.rejected, 0);

    const applied = await call('/api/slang-engine/words/prune', { dryRun: false });
    assert.equal(applied.rejected, 2);

    const left = await call('/api/slang-engine/words?status=candidate');
    assert.equal(left.words.length, 0);
    const rejected = await call('/api/slang-engine/words?status=rejected');
    assert.equal(rejected.words.length, 2);
  } finally {
    server.close();
  }
});

