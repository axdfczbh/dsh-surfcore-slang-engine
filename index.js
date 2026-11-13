// 黑话引擎 · Host 半边
//
// 职责：词库读写、规则判定、注入块生成、设置接口。
// 不碰 QQ、不调模型、不建会话——那部分仍留在桥接（它有消息通道和学习会话）。
//
// 鉴权两条路：
//   · GUI（设置页）：走宿主 connection.admit()，用浏览器凭据；
//   · 桥接：不在 GUI 里，用 ~/.dsh/surfcore/slang-engine/bridge.token 里的本机令牌。
// 失败一律关闭，不做“没认证就放行”的降级。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadStore, saveStore, loadSettings, saveSettings, summarize,
  resolveSlangFile, ensureBridgeToken, TOKEN_FILE,
} from './lib/store.mjs';
import {
  pickInjection, evaluateAutoConfirm, confirmModeFor, normalizeEntry,
  distinctSenders, inferMeaningConfidence, applyOccurrences, evaluateCandidate,
  groupMatches, sanitizeText, STATUS, CONFIDENCE, DEFAULT_SETTINGS,
} from './lib/engine.mjs';
import { recordReport, summarizeStats } from './lib/stats.mjs';
import {
  loadCommonWords, saveCommonWords, mergeCommonWords, commonWordSet,
  addManualWord, removeWord,
} from './lib/common-words.mjs';

export const name = 'slang-engine';
export const inject = ['webServer'];

function groupIdOf(key) {
  const s = String(key ?? '');
  if (s.startsWith('group:')) return s.slice('group:'.length);
  return s;
}

export function apply(ctx, config) {
  const webServer = ctx.get('webServer');
  if (!webServer) {
    console.log('[slang-engine] 没有 webServer，接口不可用');
    return;
  }

  const file = resolveSlangFile(config);
  let store = loadStore(file);
  const token = ensureBridgeToken();
  const counters = { ingest: 0, context: 0, autoConfirm: 0, research: 0, since: new Date().toISOString() };

  const json = (res, code, value) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(value));
  };

  // 桥接令牌只放行桥接真正需要的接口；管理类接口必须走宿主认证
  const TOKEN_GET = new Set([
    'health', 'context', 'words', 'research-queue', 'common-words',
    'common-words/refresh-status', 'settings', 'status',
  ]);
  const TOKEN_POST = new Set([
    'ingest', 'candidates', 'research-result', 'stats/report', 'words/auto-confirm',
  ]);
  function bridgeTokenAllowed(req) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const prefix = '/api/slang-engine/';
    if (!url.pathname.startsWith(prefix)) return false;
    const sub = url.pathname.slice(prefix.length).replace(/\/+$/, '');
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET') return TOKEN_GET.has(sub);
    if (method === 'POST') return TOKEN_POST.has(sub);
    return false;
  }

  const admit = (req, res) => {
    const bridgeToken = String(req.headers['x-slang-token'] ?? '');
    if (bridgeToken) {
      if (bridgeToken !== token) { json(res, 401, { ok: false, error: '桥接令牌错误' }); return false; }
      if (!bridgeTokenAllowed(req)) {
        json(res, 403, { ok: false, error: '桥接令牌不允许调用该接口（管理操作请用设置页）' });
        return false;
      }
      return true;
    }
    const connection = ctx.get('connection');
    if (!connection || typeof connection.admit !== 'function') {
      json(res, 503, { ok: false, error: '宿主认证不可用（缺少 connection 服务）' });
      return false;
    }
    let admission;
    try {
      admission = connection.admit({ headers: req.headers });
    } catch {
      json(res, 403, { ok: false, error: '认证失败' });
      return false;
    }
    if (!admission || typeof admission !== 'object' || 'rejection' in admission) {
      const code = Number(admission?.rejection) || 401;
      json(res, code, { ok: false, error: '未通过宿主认证' });
      return false;
    }
    return true;
  };

  const register = (route) => webServer.register({
    ...route,
    handler: async (req, res) => {
      if (!admit(req, res)) return;
      ensureFresh();
      try {
        await route.handler(req, res);
      } catch (error) {
        try { json(res, 500, { ok: false, error: String(error?.message ?? error) }); } catch {}
      }
    },
  });

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) { reject(new Error('请求体太大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')) : {});
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });

  const reload = () => { store = loadStore(file); return store; };
  // 桥接在 inject 模式下仍会直接写词库文件；插件每次请求前比对 mtime，变了就重读，
  // 避免两边各自持有一份内存副本互相覆盖。
  let lastLoadMtime = 0;
  try { lastLoadMtime = fs.statSync(file).mtimeMs; } catch {}
  const ensureFresh = () => {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (mtime !== lastLoadMtime) {
        store = loadStore(file);
        lastLoadMtime = mtime;
      }
    } catch {}
  };
  const persist = () => {
    saveStore(file, store);
    try { lastLoadMtime = fs.statSync(file).mtimeMs; } catch {}
  };
  // 命中计数会随每条消息发生，落盘做 2 秒合并，别每条消息都写一次磁盘
  let persistTimer = null;
  const schedulePersist = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try { persist(); } catch {}
    }, 2000);
  };

  const mergedSettings = () => {
    const s = loadSettings();
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      qq: { ...DEFAULT_SETTINGS.qq, ...(s.qq ?? {}), collect: { ...DEFAULT_SETTINGS.qq.collect, ...(s.qq?.collect ?? {}) } },
      bili: {
        ...DEFAULT_SETTINGS.bili,
        ...(s.bili ?? {}),
        collect: { ...DEFAULT_SETTINGS.bili.collect, ...(s.bili?.collect ?? {}) },
        comments: { ...DEFAULT_SETTINGS.bili.comments, ...(s.bili?.comments ?? {}) },
      },
    };
  };

  const statusPayload = () => {
    const common = loadCommonWords();
    const byPlatform = { qq: { total: 0 }, bili: { total: 0 } };
    for (const e of store.entries) {
      const p = e.platform === 'bili' ? 'bili' : 'qq';
      byPlatform[p].total += 1;
      byPlatform[p][e.status] = (byPlatform[p][e.status] ?? 0) + 1;
    }
    return {
      ok: true,
      name: 'slang-engine',
      file: store.file,
      tokenFile: TOKEN_FILE,
      summary: summarize(store),
      byPlatform,
      settings: mergedSettings(),
      counters: { ...counters },
      commonWords: {
        auto: common.words.length,
        manual: common.manual.length,
        updatedAt: common.updatedAt,
        file: path.join(path.dirname(TOKEN_FILE), 'common-words.json'),
      },
    };
  };

  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/status',
    handler: (_req, res) => json(res, 200, statusPayload()),
  }));

  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/settings',
    handler: async (req, res) => {
      if (req.method === 'GET') return json(res, 200, { ok: true, settings: mergedSettings() });
      const body = await readBody(req);
      const saved = saveSettings(body?.settings ?? body ?? {});
      return json(res, 200, { ok: true, settings: saved });
    },
  }));

  // 桥接推送一条群消息（Phase 1 只记录窗口，不触发提取）
  const windows = new Map();
  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/ingest',
    handler: async (req, res) => {
      const body = await readBody(req);
      const key = String(body?.key ?? '');
      const text = String(body?.text ?? '').trim();
      if (!key || !text) return json(res, 400, { ok: false, error: '缺少 key 或 text' });
      const arr = windows.get(key) ?? [];
      arr.push({ sender: String(body.sender ?? ''), text: text.slice(0, 200), time: Number(body.time) || Date.now() });
      if (arr.length > 80) arr.splice(0, arr.length - 80);
      windows.set(key, arr);
      counters.ingest += 1;
      // 命中计数：让 count 反映"这个群真的说过几次"
      const settings = loadSettings();
      let hits = [];
      if (settings.countOnIngest !== false) {
        const groupId = key.startsWith('group:') ? key.slice('group:'.length) : key;
        const result = applyOccurrences(store.entries, {
          key, groupId, sender: String(body.sender ?? ''), text, time: Number(body.time) || Date.now(),
        });
        hits = result.hits;
        if (hits.length) schedulePersist();
      }
      return json(res, 200, { ok: true, size: arr.length, hits });
    },
  }));

  // 取本轮注入块（命中优先）
  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/context',
    handler: (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const key = url.searchParams.get('key') ?? '';
      const q = url.searchParams.get('q') ?? '';
      const settings = loadSettings();
      if (settings.enabled === false) return json(res, 200, { ok: true, block: '', chars: 0, items: [], disabled: true });
      // 关掉自动注入后，改由模型主动查（qq_slang_query / slang_lookup）
      if (settings.injectEnabled === false) return json(res, 200, { ok: true, block: '', chars: 0, items: [], autoInject: false });
      counters.context += 1;
      const result = pickInjection({ entries: store.entries, groupId: groupIdOf(key), messageText: q, settings });
      return json(res, 200, {
        ok: true,
        block: result.block,
        chars: result.chars,
        items: result.items.map((e) => ({
          id: e.id, content: e.content, count: e.count, groupIds: e.groupIds,
        })),
      });
    },
  }));

  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/words',
    handler: (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const status = url.searchParams.get('status') ?? '';
      const platform = url.searchParams.get('platform') ?? '';
      const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200));
      let list = store.entries;
      if (status) list = list.filter((e) => e.status === status);
      if (platform) list = list.filter((e) => (e.platform ?? 'qq') === platform);
      if (q) {
        list = list.filter((e) => String(e.content).toLowerCase().includes(q)
          || String(e.meaning).toLowerCase().includes(q)
          || String(e.usage).toLowerCase().includes(q));
      }
      list = list.slice().sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0)).slice(0, limit);
      return json(res, 200, {
        ok: true,
        count: list.length,
        words: list.map((e) => ({
          id: e.id, content: e.content, meaning: e.meaning, usage: e.usage, example: e.example, risk: e.risk,
          platform: e.platform ?? 'qq',
          status: e.status, count: e.count, senders: distinctSenders(e), groupIds: e.groupIds,
          confidence: e.meaningConfidence, source: e.meaningSource,
          confirmedBy: e.confirmedBy, updatedAt: e.updatedAt,
        })),
      });
    },
  }));

  const findByIds = (ids) => {
    const set = new Set((Array.isArray(ids) ? ids : []).map(String));
    return store.entries.filter((e) => set.has(e.id));
  };

  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/words/confirm',
    handler: async (req, res) => {
      const body = await readBody(req);
      const targets = findByIds(body?.ids);
      let confirmed = 0;
      const skipped = [];
      for (const e of targets) {
        if (!e.meaning) { skipped.push({ id: e.id, reason: '缺少含义' }); continue; }
        e.status = STATUS.CONFIRMED;
        e.confirmedBy = 'manual';
        e.confirmedAt = new Date().toISOString();
        e.updatedAt = e.confirmedAt;
        confirmed += 1;
      }
      if (confirmed) persist();
      return json(res, 200, { ok: true, confirmed, skipped });
    },
  }));

  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/words/reject',
    handler: async (req, res) => {
      const body = await readBody(req);
      const targets = findByIds(body?.ids);
      for (const e of targets) {
        e.status = STATUS.REJECTED;
        e.updatedAt = new Date().toISOString();
      }
      // 拒绝的词进 excluded，提取阶段不再反复上报
      const excluded = new Set(store.excluded);
      for (const e of targets) excluded.add(e.content);
      store.excluded = [...excluded].slice(-500);
      if (targets.length) persist();
      return json(res, 200, { ok: true, rejected: targets.length });
    },
  }));

  // 批量恢复为候选（误杀兜底，也用于一次清理后反悔）
  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/words/restore',
    handler: async (req, res) => {
      const body = await readBody(req);
      const targets = findByIds(body?.ids);
      let restored = 0;
      for (const e of targets) {
        if (e.status === STATUS.CANDIDATE) continue;
        e.status = STATUS.CANDIDATE;
        e.confirmedBy = '';
        e.confirmedAt = '';
        e.updatedAt = new Date().toISOString();
        restored += 1;
      }
      if (restored) persist();
      return json(res, 200, { ok: true, restored });
    },
  }));

  // 一次性清理：把"次数太少且没有含义"的候选批量拒绝。
  // 默认不写进排除名单——它们只是"暂时不够格"，以后真被用起来还能重新学；
  // 要不要永久排除由调用方传 toExcluded=true 决定。
  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/words/prune',
    handler: async (req, res) => {
      const body = await readBody(req);
      const dryRun = body?.dryRun !== false;
      const minCount = Math.max(1, Number(body?.minCount) || 2);
      const keepWithMeaning = body?.keepWithMeaning !== false;
      const toExcluded = body?.toExcluded === true;
      const candidates = store.entries.filter((e) => e.status === STATUS.CANDIDATE);
      const doomed = candidates.filter((e) => (Number(e.count) || 0) < minCount
        && !(keepWithMeaning && e.meaning));
      const sample = doomed.slice(0, 20).map((e) => ({ id: e.id, content: e.content, count: e.count }));
      if (!dryRun && doomed.length) {
        const excluded = new Set(store.excluded);
        for (const e of doomed) {
          e.status = STATUS.REJECTED;
          e.updatedAt = new Date().toISOString();
          if (toExcluded) excluded.add(e.content);
        }
        if (toExcluded) store.excluded = [...excluded].slice(-500);
        persist();
      }
      return json(res, 200, {
        ok: true, dryRun, candidates: candidates.length, wouldReject: doomed.length,
        rejected: dryRun ? 0 : doomed.length, toExcluded, sample,
      });
    },
  }));

  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/words/delete',
    handler: async (req, res) => {
      const body = await readBody(req);
      const ids = new Set((Array.isArray(body?.ids) ? body.ids : [body?.id]).map(String).filter(Boolean));
      if (!ids.size) return json(res, 400, { ok: false, error: '缺少 ids' });
      const before = store.entries.length;
      store.entries = store.entries.filter((e) => !ids.has(e.id));
      const removed = before - store.entries.length;
      if (removed) persist();
      return json(res, 200, { ok: true, removed });
    },
  }));

  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/words/edit',
    handler: async (req, res) => {
      const body = await readBody(req);
      const target = store.entries.find((e) => e.id === String(body?.id ?? ''));
      if (!target) return json(res, 404, { ok: false, error: '词条不存在' });
      const merged = normalizeEntry({ ...target, ...(body?.patch ?? {}) });
      merged.id = target.id;
      merged.createdAt = target.createdAt || new Date().toISOString();
      merged.updatedAt = new Date().toISOString();
      store.entries[store.entries.indexOf(target)] = merged;
      persist();
      return json(res, 200, { ok: true, word: merged });
    },
  }));

  // 桥接把提取结果推过来：插件负责准入、去重、写库、必要时自动转正
  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/candidates',
    handler: async (req, res) => {
      const body = await readBody(req);
      const items = Array.isArray(body?.items) ? body.items : [];
      if (!items.length) return json(res, 400, { ok: false, error: 'items 为空' });
      const settings = loadSettings();
      if (settings.enabled === false) {
        return json(res, 200, { ok: true, disabled: true, added: 0, updated: 0, skipped: 0, autoConfirmed: 0 });
      }
      const commonSet = commonWordSet();
      const excludedSet = new Set(store.excluded);
      const groupId = String(body?.groupId ?? '');
      const platform = body?.platform === 'bili' ? 'bili' : 'qq';
      let added = 0;
      let updated = 0;
      let autoConfirmed = 0;
      const skipped = [];
      // 同族硬上限：每批同族最多 2 条
      const familyUsed = new Map();
      for (const item of items) {
        const famKey = sanitizeText(item?.family, 20);
        if (famKey && (familyUsed.get(famKey) ?? 0) >= 2) {
          skipped.push({ content: String(item?.content ?? ''), reasons: ['同族超限（每批最多 2）'] });
          continue;
        }
        const verdict = evaluateCandidate(item, { commonSet, excludedSet });
        if (!verdict.ok) {
          if (item?.isCommon === true || verdict.reasons.includes('命中大众词表')) excludedSet.add(verdict.content);
          skipped.push({ content: verdict.content, reasons: verdict.reasons });
          continue;
        }
        const content = verdict.content;
        const existing = store.entries.find((e) => e.content === content
          && (e.platform ?? 'qq') === platform
          && groupMatches(e, groupId));
        const key = String(item?.key ?? (groupId ? `group:${groupId}` : ''));
        const sender = String(item?.sender ?? '');
        const text = sanitizeText(item?.text, 200);
        const time = Number(item?.time) || Date.now();
        if (existing) {
          if (!existing.family && item?.family) existing.family = sanitizeText(item.family, 20);
          if (text) existing.evidence = [...existing.evidence, { key, sender, text, time }].slice(-20);
          existing.lastSeenAt = time;
          existing.updatedAt = new Date().toISOString();
          if (settings.countOnIngest === false) existing.count = (Number(existing.count) || 0) + 1;
          updated += 1;
        } else {
          store.entries.push(normalizeEntry({
            id: `c-${randomUUID().slice(0, 8)}`,
            content,
            platform,
            family: item?.family ?? '',
            groupIds: groupId ? [groupId] : [],
            evidence: text ? [{ key, sender, text, time }] : [],
            count: settings.countOnIngest === false ? 1 : 0,
            status: STATUS.CANDIDATE,
            source: 'ai',
            meaning: item?.meaning ?? '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));
          added += 1;
          const fam = sanitizeText(item?.family, 20);
          if (fam) familyUsed.set(fam, (familyUsed.get(fam) ?? 0) + 1);
        }
      }
      // 写回排除名单（标注为大众词的，下次别再报）
      store.excluded = [...excludedSet].slice(-500);
      // 自动挡：只有这个群是 auto 才尝试转正
      if (confirmModeFor(groupId, settings) === 'auto') {
        for (const e of store.entries) {
          if (e.status !== STATUS.CANDIDATE) continue;
          if (!groupMatches(e, groupId)) continue;
          const v = evaluateAutoConfirm(e, settings, commonSet);
          if (!v.ok) continue;
          e.status = STATUS.CONFIRMED;
          e.confirmedBy = 'auto';
          e.confirmedAt = new Date().toISOString();
          e.updatedAt = e.confirmedAt;
          autoConfirmed += 1;
        }
      }
      if (added || updated || autoConfirmed) persist();
      counters.autoConfirm += autoConfirmed;
      return json(res, 200, {
        ok: true,
        added,
        updated,
        skipped: skipped.length,
        autoConfirmed,
        details: skipped.slice(0, 20),
      });
    },
  }));

  // 按规则跑一遍自动确认（Phase 3 起由桥接定时调用）
  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/words/auto-confirm',
    handler: async (req, res) => {
      const body = await readBody(req);
      const settings = loadSettings();
      if (settings.enabled === false) return json(res, 200, { ok: true, disabled: true, wouldConfirm: 0, confirmed: 0, candidates: [] });
      const commonSet = commonWordSet();
      for (const w of Array.isArray(body?.commonWords) ? body.commonWords : []) commonSet.add(String(w));
      const dryRun = body?.dryRun !== false;
      const report = [];
      let confirmed = 0;
      for (const e of store.entries) {
        if (e.status !== STATUS.CANDIDATE) continue;
        if (confirmModeFor(e.groupIds?.[0] ?? '', settings) !== 'auto') continue;
        const verdict = evaluateAutoConfirm(e, settings, commonSet);
        if (!verdict.ok) continue;
        report.push({ id: e.id, content: e.content });
        if (!dryRun) {
          e.status = STATUS.CONFIRMED;
          e.confirmedBy = 'auto';
          e.confirmedAt = new Date().toISOString();
          e.updatedAt = e.confirmedAt;
          confirmed += 1;
        }
      }
      if (!dryRun && confirmed) { persist(); counters.autoConfirm += confirmed; }
      return json(res, 200, { ok: true, dryRun, wouldConfirm: report.length, confirmed, candidates: report });
    },
  }));

  // 大众词表：查看 / 导入（桥接联网抓完后推过来）/ 手工增删 / 请求刷新
  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/common-words',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        const data = loadCommonWords();
        const settings = loadSettings();
        return json(res, 200, {
          ok: true,
          ...data,
          total: data.words.length + data.manual.length,
          refreshRequestedAt: settings.commonWords?.refreshRequestedAt ?? '',
          buildMode: settings.commonWords?.buildMode ?? 'regex',
        });
      }
      const body = await readBody(req);
      if (body?.action === 'refresh') {
        const settings = saveSettings({ commonWords: { refreshRequestedAt: new Date().toISOString() } });
        return json(res, 200, { ok: true, refreshRequestedAt: settings.commonWords.refreshRequestedAt, note: '桥接下次唤醒时会尝试刷新' });
      }
      if (body?.action === 'add' && body.word) return json(res, 200, { ok: true, ...addManualWord(body.word) });
      if (body?.action === 'remove' && body.word) return json(res, 200, { ok: true, ...removeWord(body.word) });
      if (Array.isArray(body?.import)) {
        const merged = mergeCommonWords(body.import, { source: String(body.source ?? 'web') });
        saveSettings({ commonWords: { refreshRequestedAt: '' } });
        return json(res, 200, { ok: true, ...merged });
      }
      return json(res, 400, { ok: false, error: '需要 action=add|remove|refresh 或 import 数组' });
    },
  }));

  // 桥接查刷新状态：到期或收到请求时就联网抓一次
  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/common-words/refresh-status',
    handler: (_req, res) => {
      const settings = loadSettings();
      const data = loadCommonWords();
      const days = Math.max(1, Number(settings.commonWords?.refreshDays) || 7);
      const updated = data.updatedAt ? Date.parse(data.updatedAt) : 0;
      const due = !updated || Date.now() - updated > days * 86400000;
      const requested = Boolean(settings.commonWords?.refreshRequestedAt);
      return json(res, 200, {
        ok: true, due: due || requested, requested, updatedAt: data.updatedAt, days,
        buildMode: settings.commonWords?.buildMode ?? 'regex',
      });
    },
  }));

  // 待研究队列：候选、没有含义、出现过至少 2 次、且这次出现还没研究过。
  // 桥接拿走这些词，用学习会话联网研究，再把结果回写 /research-result。
  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/research-queue',
    handler: (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 5));
      const items = store.entries
        .filter((e) => e.status === STATUS.CANDIDATE
          && !e.meaning
          && (Number(e.count) || 0) >= 2
          && (Number(e.lastInferenceCount) || 0) < (Number(e.count) || 0))
        .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
        .slice(0, limit)
        .map((e) => ({
          id: e.id, content: e.content, count: e.count,
          evidence: (e.evidence ?? []).slice(-3), groupIds: e.groupIds,
        }));
      return json(res, 200, { ok: true, items });
    },
  }));

  // 桥接把研究结果回写：插件这里统一算置信度并按挡位决定要不要自动转正
  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/research-result',
    handler: async (req, res) => {
      const body = await readBody(req);
      const items = Array.isArray(body?.items) ? body.items : [];
      if (!items.length) return json(res, 400, { ok: false, error: 'items 为空' });
      const settings = loadSettings();
      if (settings.enabled === false) return json(res, 200, { ok: true, disabled: true, updated: 0 });
      const commonSet = commonWordSet();
      let updated = 0;
      let autoConfirmed = 0;
      for (const item of items) {
        const content = String(item?.content ?? '').trim();
        if (!content) continue;
        const entry = store.entries.find((e) => e.content === content);
        if (!entry) continue;
        if (item.meaning) entry.meaning = normalizeEntry({ ...entry, meaning: item.meaning }).meaning;
        if (item.usage) entry.usage = normalizeEntry({ ...entry, usage: item.usage }).usage;
        if (item.example) entry.example = normalizeEntry({ ...entry, example: item.example }).example;
        if (Array.isArray(item.sources) && item.sources.length) {
          entry.sources = item.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        }
        if (!entry.risk) {
          const staged = normalizeEntry({ ...entry, risk: '' });
          if (staged.risk) entry.risk = staged.risk;
        }
        entry.meaningSource = entry.sources.length ? 'source' : 'evidence';
        entry.isSlang = item?.isSlang !== false;
        entry.meaningConfidence = inferMeaningConfidence(entry);
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
        updated += 1;
        // 只对在自动挡群里的候选尝试转正
        if (entry.status === STATUS.CANDIDATE && confirmModeFor(entry.groupIds?.[0] ?? '', settings) === 'auto') {
          const verdict = evaluateAutoConfirm(entry, settings, commonSet);
          if (verdict.ok) {
            entry.status = STATUS.CONFIRMED;
            entry.confirmedBy = 'auto';
            entry.confirmedAt = entry.updatedAt;
            autoConfirmed += 1;
          }
        }
      }
      counters.research += 1;
      if (updated) { persist(); counters.autoConfirm += autoConfirmed; }
      return json(res, 200, { ok: true, updated, autoConfirmed });
    },
  }));

  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/stats',
    handler: (_req, res) => json(res, 200, { ok: true, summary: summarize(store), counters: { ...counters }, cost: summarizeStats(7) }),
  }));

  // 桥接每次学习调用后上报一笔账：kind=extract|research
  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/stats/report',
    handler: async (req, res) => {
      const body = await readBody(req);
      const day = recordReport({
        kind: body?.kind === 'research' ? 'research' : 'extract',
        tokens: body?.tokens,
        costCNY: body?.costCNY,
        added: body?.added,
        autoConfirmed: body?.autoConfirmed,
        at: body?.at,
      });
      return json(res, 200, { ok: true, day });
    },
  }));

  ctx.effect(() => register({
    kind: 'exact',
    path: '/api/slang-engine/health',
    handler: (_req, res) => json(res, 200, { ok: true, name: 'slang-engine', version: '0.1.0' }),
  }));

  console.log(`[slang-engine] 已挂载：词库 ${file}（${store.entries.length} 条），令牌 ${TOKEN_FILE}`);
  // 词库文件可能被外部工具改（例如桥接回退路径），启动时读一次，之后以本插件内存为准。
  try { fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true }); } catch {}

}
