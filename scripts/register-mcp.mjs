#!/usr/bin/env node
// 安装时生成：给当前 DSH profile 的 cordis.patch.yml 插入一条 mcp-client 行，
// 指向本包内的 mcp-slang.mjs（路径在运行时算，换机器/换目录都不用改）。
//
// 用法：
//   node scripts/register-mcp.mjs                 # 默认 profile：~/.dsh/profiles/desktop
//   node scripts/register-mcp.mjs --profile xxx   # 指定 profile 名或目录
//   node scripts/register-mcp.mjs --dry-run       # 只打印将要写入的区块
//
// 设计取舍：不去改 package.json 的 postinstall（安装脚本会被安全策略拦），
// 也不依赖 surfcore 的 setup；由用户/安装说明显式跑一次，跑完重启 DSH 生效。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(__dirname, '..');
const MCP_SCRIPT = path.join(PACKAGE_DIR, 'mcp-slang.mjs');
const BEGIN = '# === slang-engine MCP BEGIN ===';
const END = '# === slang-engine MCP END ===';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}

function resolvePatchFile() {
  const explicit = arg('--profile');
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const dir = explicit
    ? (path.isAbsolute(explicit) ? explicit : path.join(dshHome, 'profiles', explicit))
    : path.join(dshHome, 'profiles', 'desktop');
  return { dir, file: path.join(dir, 'cordis.patch.yml') };
}

function block() {
  const node = process.execPath;
  return [
    BEGIN,
    '# 由 dsh-surfcore-slang-engine/scripts/register-mcp.mjs 生成；重跑会整体替换这一段。',
    '- insert:',
    '    - id: mcp-slang-engine',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: slang-engine',
    '        transport: stdio',
    `        command: '${node.replace(/'/g, "''")}'`,
    '        args:',
    `          - '${MCP_SCRIPT.replace(/'/g, "''")}'`,
    '        toolCallTimeoutMs: 30000',
    END,
  ].join('\n');
}

const { dir, file } = resolvePatchFile();
if (!fs.existsSync(MCP_SCRIPT)) {
  console.error(`✗ 找不到 ${MCP_SCRIPT}`);
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`✗ profile 补丁不存在：${file}`);
  console.error('  先确认 profile 名（默认 desktop），或用 --profile 指定。');
  process.exit(1);
}
const text = fs.readFileSync(file, 'utf8');
const start = text.indexOf(BEGIN);
const end = text.indexOf(END);
const section = block();
let next;
if (start >= 0 && end > start) {
  next = text.slice(0, start) + section + text.slice(end + END.length);
} else {
  next = `${text.replace(/\s*$/, '')}\n\n${section}\n`;
}
if (process.argv.includes('--dry-run')) {
  console.log(section);
  process.exit(0);
}
fs.writeFileSync(file, next, 'utf8');
console.log(`✓ 已写入 ${file}`);
console.log(`  node: ${process.execPath}`);
console.log(`  mcp : ${MCP_SCRIPT}`);
console.log('  重启 DSH 后，工具 slang_lookup 才会出现。');
