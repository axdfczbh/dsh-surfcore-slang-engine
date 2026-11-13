// 黑话引擎 · 存储层
//
// 词库文件仍沿用桥接的那份 state/slang.json（插件是唯一写入方，Phase 2 起桥接改为读 API）。
// 这里负责：路径解析、旧格式迁移、原子写、每日备份轮转、插件自己的设置文件。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, normalizeEntry, STATUS } from './engine.mjs';

export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
export const ENGINE_DIR = path.join(DSH_HOME, 'surfcore', 'slang-engine');
export const SETTINGS_FILE = path.join(ENGINE_DIR, 'settings.json');
export const TOKEN_FILE = path.join(ENGINE_DIR, 'bridge.token');

const STORE_VERSION = 2;
const BACKUP_KEEP = 7;

function candidates() {
  const list = [];
  if (process.env.SURFCORE_ROOT) list.push(path.join(process.env.SURFCORE_ROOT, 'state', 'slang.json'));
  // 旧版本把词库写在 SurfCore 的 state 下：只作为一次性迁移来源，不再作为默认写入位置
  list.push(path.join(DSH_HOME, 'surfcore', 'state', 'slang.json'));
  return list;
}

/** 解析词库文件路径。优先级：配置 > 环境变量 > 探测已存在的候选 > 插件目录兜底。 */
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ALLOWED_ROOTS = () => [DSH_HOME, PLUGIN_DIR, os.tmpdir(), ...(process.env.SURFCORE_ROOT ? [process.env.SURFCORE_ROOT] : [])];

/** 只允许写 DSH 目录、本插件目录、SURFCORE_ROOT 或临时目录，防止把词库写到任意路径。 */
export function assertAllowedPath(file) {
  const resolved = path.resolve(String(file));
  const ok = ALLOWED_ROOTS().some((root) => {
    const r = path.resolve(String(root));
    return resolved === r || resolved.startsWith(r + path.sep);
  });
  if (!ok) throw new Error(`黑话库路径不在允许范围内：${resolved}`);
  return resolved;
}

export function resolveSlangFile(config = {}) {
  const explicit = String(config?.slangFile ?? '').trim();
  if (explicit) return assertAllowedPath(explicit);
  const envFile = String(process.env.SURFCORE_SLANG_FILE ?? '').trim();
  if (envFile) return assertAllowedPath(envFile);
  const own = path.join(ENGINE_DIR, 'slang.json');
  // 旧位置有库、插件目录还没有：读旧文件并复制一份到插件目录，之后只写插件目录
  for (const legacy of candidates()) {
    if (!fs.existsSync(legacy)) continue;
    if (!fs.existsSync(own)) {
      try {
        fs.mkdirSync(ENGINE_DIR, { recursive: true });
        fs.copyFileSync(legacy, own);
      } catch {}
    }
    break;
  }
  return own;
}

function iso(value) {
  return typeof value === 'string' && value ? value : new Date().toISOString();
}

/** 读词库（不存在或坏文件都返回空库，不抛错）。 */
export function loadStore(file) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    raw = null;
  }
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.entries) ? raw.entries : []);
  const entries = list
    .filter((e) => e && typeof e === 'object')
    .map((e) => {
      const entry = normalizeEntry(e);
      if (!entry.id) entry.id = `mig-${randomUUID().slice(0, 8)}`;
      if (!entry.createdAt) entry.createdAt = iso(e.createdAt);
      if (!entry.updatedAt) entry.updatedAt = iso(e.updatedAt);
      // 迁移：旧数据没有 groupIds，用证据里的群号补上（只认真实的 group:<数字>）
      if (!entry.groupIds.length) {
        const groups = new Set();
        for (const ev of entry.evidence) {
          const m = /^group:(\d+)$/.exec(String(ev.key ?? ''));
          if (m) groups.add(m[1]);
        }
        if (groups.size) entry.groupIds = [...groups];
      }
      return entry;
    });
  const excluded = Array.isArray(raw?.excluded)
    ? raw.excluded.map((x) => String(x ?? '').trim()).filter(Boolean).slice(-500)
    : [];
  return {
    version: STORE_VERSION,
    entries,
    excluded,
    updatedAt: iso(raw?.updatedAt),
    file,
  };
}

function pruneBackups(file) {
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const backups = fs.readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.bak-`))
      .sort()
      .reverse();
    for (const old of backups.slice(BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(dir, old)); } catch {}
    }
  } catch {}
}

/** 原子写词库；写前对当天文件做一次备份。返回写入的条目数。 */
export function saveStore(file, store) {
  assertAllowedPath(file);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().slice(0, 10);
    const backup = `${file}.bak-${stamp}`;
    try {
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
      pruneBackups(file);
    } catch {}
  }
  const payload = {
    version: STORE_VERSION,
    updatedAt: new Date().toISOString(),
    entries: store.entries.map((e) => ({ ...e })),
    excluded: [...new Set(store.excluded ?? [])].slice(-500),
  };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return payload.entries.length;
}

/** 插件设置：默认值 + 磁盘覆盖。 */
export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, '')) ?? {};
  } catch {
    saved = {};
  }
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    autoConfirm: { ...DEFAULT_SETTINGS.autoConfirm, ...(saved.autoConfirm ?? {}) },
    commonWords: { ...DEFAULT_SETTINGS.commonWords, ...(saved.commonWords ?? {}) },
    groupOverrides: { ...(saved.groupOverrides ?? {}) },
  };
}

export function saveSettings(patch = {}) {
  const current = loadSettings();
  const next = {
    ...current,
    ...patch,
    autoConfirm: { ...current.autoConfirm, ...(patch.autoConfirm ?? {}) },
    commonWords: { ...current.commonWords, ...(patch.commonWords ?? {}) },
    groupOverrides: { ...current.groupOverrides, ...(patch.groupOverrides ?? {}) },
  };
  fs.mkdirSync(ENGINE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** 桥接用的本机令牌：首次启动生成，之后复用。 */
export function ensureBridgeToken() {
  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[a-f0-9]{32}$/i.test(saved)) return saved;
  } catch {}
  const token = randomUUID().replace(/-/g, '');
  fs.mkdirSync(ENGINE_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

/** 统计（给设置页与 /status 用）。 */
export function summarize(store) {
  const byStatus = { candidate: 0, confirmed: 0, rejected: 0 };
  let withMeaning = 0;
  const groups = new Set();
  for (const e of store.entries) {
    if (byStatus[e.status] !== undefined) byStatus[e.status] += 1;
    if (e.meaning) withMeaning += 1;
    for (const g of e.groupIds ?? []) groups.add(g);
  }
  return {
    total: store.entries.length,
    byStatus,
    withMeaning,
    excluded: store.excluded.length,
    groups: [...groups],
    updatedAt: store.updatedAt,
    file: store.file,
  };
}

export { STATUS };
