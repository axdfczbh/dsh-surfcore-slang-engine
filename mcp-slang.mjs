// 黑话词典 MCP server（stdio，零依赖）。
//
// 由 DSH 的 MCP 客户端 spawn（mcp-client 行由 scripts/register-mcp.mjs 在安装时生成）。
// 只做一件事：把插件词库里已确认/候选的词暴露成一个可查的工具。
// 不依赖 @modelcontextprotocol/sdk：这里手写最小 JSON-RPC 子集（initialize /
// tools/list / tools/call / ping），避免插件包为了一个查询工具再背一份依赖。
import readline from 'node:readline';
import { resolveSlangFile, loadStore } from './lib/store.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER = { name: 'slang-engine', version: '0.1.0' };

const TOOL = {
  name: 'slang_lookup',
  description: '查黑话/群梗词典（DeepSeek 圈、B站、群内说法）。有本地词库可查时先用它，不够再联网搜索；'
    + '不确定某个词是不是梗、想用群里的说法但怕用错、或看不懂别人在说什么时使用。查不到就按普通词理解，不必硬套。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词，按词/含义/用法匹配；留空则列出已确认的词条。' },
    },
    additionalProperties: false,
  },
};

function loadWords() {
  try {
    const file = resolveSlangFile({});
    const store = loadStore(file);
    return Array.isArray(store?.entries) ? store.entries : [];
  } catch {
    return [];
  }
}

function lookup(query) {
  const q = String(query ?? '').trim().toLowerCase();
  const words = loadWords().filter((e) => e && String(e.content ?? '').trim());
  const confirmed = words.filter((e) => e.status === 'confirmed' && e.meaning);
  const pool = q
    ? words.filter((e) => [e.content, e.meaning, e.usage, e.example]
      .some((v) => String(v ?? '').toLowerCase().includes(q)))
    : confirmed;
  const rank = (e) => (e.status === 'confirmed' ? 2 : 0) + (e.meaning ? 1 : 0);
  const picked = [...pool]
    .sort((a, b) => rank(b) - rank(a) || (Number(b.count) || 0) - (Number(a.count) || 0))
    .slice(0, 15);
  if (!picked.length) {
    return q
      ? `没查到「${query}」。词库共 ${words.length} 条，已确认 ${confirmed.length} 条——按普通词理解即可。`
      : `词库里还没有已确认的词（共 ${words.length} 条候选）。`;
  }
  const lines = picked.map((e) => {
    const head = `- ${e.content}［${e.status === 'confirmed' ? '已确认' : '候选'}］：${e.meaning || '（还没有含义）'}`;
    const usage = e.usage ? `（用法：${e.usage}）` : '';
    const example = e.example ? `（例：${e.example}）` : '';
    return `${head}${usage}${example}`;
  });
  return `${q ? `搜索「${query}」` : '已确认词条'}：${picked.length} 条\n${lines.join('\n')}\n（只作参考，不必刻意堆砌）`;
}

function reply(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function error(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return null;
  const { id, method, params } = msg;
  // 通知（无 id）不需要响应
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER,
      instructions: '本地黑话词典优先于联网搜索：遇到群内说法/梗，先 slang_lookup，查不到再搜。',
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: [TOOL] });
  if (method === 'tools/call') {
    if (params?.name !== TOOL.name) return error(id, -32602, `unknown tool: ${params?.name}`);
    const text = lookup(params?.arguments?.query);
    return reply(id, { content: [{ type: 'text', text }] });
  }
  if (id === undefined) return null;
  return error(id, -32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  const out = handle(msg);
  if (out) process.stdout.write(`${out}\n`);
});
