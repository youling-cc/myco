#!/usr/bin/env node
// myco-mcp — 跨会话消息的 MCP 工具面（零依赖，stdio）
//
// 为什么要有它（2026-10-19 用户提问：「发回消息，不能直接 /myco 么？还要让别的会话用
// send.py？暴露细节？或用 mcp 实现，你怎么看？」）：
//   skill 文档里写 send.py 路径，等于把实现细节暴露给每个会话；而且每次都要拼 shell
//   （引号/编码/超时都能踩坑）。MCP 把它变成**一个工具调用**：结构化参数、返回值，
//   没有路径、没有引号、没有"服务在不在"的问题（stdio 由 DSH 拉起，随会话生命周期）。
//
// 工具：
//   send_message(to, text, mode?, from?)  给本机/跨设备 DSH 会话发消息（自动带 v6 署名头）
//   list_agents(kind?, grep?, limit?)     协作智能体清单（好友+分享+会话，lib/directory.js 单一实现）
//   list_sessions(grep?)                  列本机会话（名字 + sessionId + 更新时间）
//   whoami()                              我是谁（用 $DSH_SESSION_ID 解析名字）
//
// 路由（DESIGN-agent-directory §5）：
//   目标是本机会话（sessionId/标题唯一命中）→ DSH `session/prompt` 直投
//   其余（did:youling:… / sh-… / 好友昵称 / 分享名 / 模糊标题）→ 委托
//   tools/send.py（四格式路由 + /api/msg/route，与 skill 同一实现，不复制逻辑）
//
// MCP stdio 协议：按行分隔的 JSON-RPC（initialize / tools/list / tools/call / ping）。
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MYCO_API = 'http://127.0.0.1:3102/api/cli'; // 保留常量供诊断；消息路由已改走 send.py
const HOME = homedir();
const CREDS = join(HOME, '.dsh', '.credentials.yaml');

// ── DSH 端口 / cookie（与 dsh_rpc.py、myco.exe 同一套 wire）──────────
function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readSecret() {
  const txt = readFileSync(CREDS, 'utf-8');
  let inRec = false;
  for (const raw of txt.split(/\r?\n/)) {
    const l = raw.trimEnd();
    if (l.trimStart().startsWith('client-connection/browser-session:')) { inRec = true; continue; }
    if (!inRec) continue;
    if (!l.startsWith('    ') && l.trim()) { inRec = false; continue; }
    const s = l.trim();
    if (s.startsWith('secret:')) {
      const b = s.slice('secret:'.length).trim();
      return Buffer.from(b + '='.repeat((4 - (b.length % 4)) % 4), 'base64');
    }
  }
  throw new Error('读不到 DSH browser-session secret（~/.dsh/.credentials.yaml）');
}

function mintCookie(authority) {
  const secret = readSecret();
  const now = Date.now();
  const payload = JSON.stringify({
    version: 1, authority, issuedAt: now, expiresAt: now + 30 * 24 * 3600 * 1000,
  });
  const body = b64u(Buffer.from(payload));
  const sig = createHmac('sha256', secret).update(body).digest();
  const name = 'dsh-auth-' + b64u(createHash('sha256').update(authority).digest());
  return `${name}=v1.${body}.${b64u(sig)}`;
}

function candidatePorts() {
  const out = [];
  const envPort = parseInt(process.env.DSH_NATIVE_PORT || '', 10);
  if (Number.isFinite(envPort)) out.push(envPort);
  try {
    const csv = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf-8', timeout: 15000, windowsHide: true });
    const pids = new Set();
    for (const line of csv.split(/\r?\n/)) {
      const parts = line.split('","').map(s => s.replace(/^"|"$/g, '').trim());
      if (parts.length >= 2 && /^\d+$/.test(parts[1])) pids.add(parts[1]);
    }
    if (pids.size) {
      const ns = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf-8', timeout: 20000, windowsHide: true });
      for (const line of ns.split(/\r?\n/)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 5 || f[3] !== 'LISTENING') continue;
        if (!/^(127\.0\.0\.1|0\.0\.0\.0):/.test(f[1])) continue;
        if (!pids.has(f[4])) continue;
        const p = parseInt(f[1].split(':').pop(), 10);
        if (Number.isFinite(p)) out.push(p);
      }
    }
  } catch { /* tasklist/netstat 失败就走 env */ }
  for (const legacy of [19387, 55802]) out.push(legacy);
  return [...new Set(out.filter(p => Number.isFinite(p) && p > 0))];
}

async function dshCall(port, method, args, timeoutMs = 20000) {
  const authority = `127.0.0.1:${port}`;
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'mcp' + (Date.now() % 1000000),
    method,
    payload: { args },
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://${authority}/api/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: mintCookie(authority),
        origin: `http://${authority}`,
      },
      body,
      signal: ac.signal,
    });
    if (resp.status === 401) throw new Error('DSH 短时忙窗（401 鉴权未就绪）——等 ≥5s 重试');
    if (!resp.ok) throw new Error(`DSH HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

let cachedPort = 0;
async function detectPort() {
  if (cachedPort) return cachedPort;
  let lastErr = null;
  for (const p of candidatePorts()) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 3000);
      try {
        // 注意：DSH 的 `GET /` 在**没有 cookie** 时回 401——401 也证明"这个口是 DSH"，
        // 不能要求 2xx（踩过：第一版这里判 r.ok，结果永远找不到端口）。
        await fetch(`http://127.0.0.1:${p}/`, { signal: ac.signal });
        cachedPort = p;
        return p;
      } finally { clearTimeout(t); }
    } catch (e) { lastErr = e; }
  }
  throw new Error(`找不到 DSH web 端口（DSH 没在运行？）${lastErr ? '：' + lastErr.message : ''}`);
}

// 端口失效（DSH 重启换了口）时清缓存重探——与 myco.exe 的自动重探测同款意图
function forgetPort() { cachedPort = 0; }

async function withPortRetry(fn) {
  try {
    return await fn(await detectPort());
  } catch (e) {
    if (e && /fetch failed|ECONNREFUSED|aborted/i.test(String(e.message || e))) {
      forgetPort();
      return await fn(await detectPort());
    }
    throw e;
  }
}

// ── 会话清单 ────────────────────────────────────────────────────────
async function fetchSessions() {
  const res = await withPortRetry(port => dshCall(port, 'session/list', { _request: {} }));
  const v = res?.result?.value ?? res?.result ?? res;
  const items = v?.items || [];
  return items.map(it => ({
    sessionId: it.sessionId || '',
    title: it?.projections?.values?.title || it?.title || it?.name || '',
    cwd: it.cwd || '',
    updatedAt: it.updatedAt || 0,
    blank: !!it.blank,
    subagent: it?.origin === 'subagent',
    parentSessionId: it.parentSessionId || null,
  }));
}

function idTail(sid) {
  return (sid || '').slice(-8);
}

function resolveTarget(sessions, to) {
  const q = String(to || '').trim();
  if (!q) throw new Error('to 不能为空（会话名或 sessionId）');
  const exact = sessions.find(s => s.sessionId === q);
  if (exact) return exact;
  const byTitle = sessions.filter(s => (s.title || '').toLowerCase() === q.toLowerCase());
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) throw new Error(`"${q}" 有 ${byTitle.length} 个同名会话——请改用 sessionId`);
  const subs = sessions.filter(s => (s.title || '').toLowerCase().includes(q.toLowerCase()));
  if (subs.length === 1) return subs[0];
  if (subs.length > 1) throw new Error(`"${q}" 匹配到 ${subs.length} 个会话——请用更长的名字或 sessionId`);
  const byPrefix = sessions.filter(s => s.sessionId.startsWith(q));
  if (byPrefix.length === 1) return byPrefix[0];
  return null;
}

// ── 署名头（v6 充要版，与 myco.exe / send.py 逐字同格式）──────────────
function buildHeader(name, sid, steer) {
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const nm = (name || '').trim() || 'myco';
  const prio = steer ? ' · ⚡插队' : '';
  let out = `[from: ${nm}${prio} · ${stamp}]\n`;
  if (sid && String(sid).trim()) {
    const full = String(sid).trim().startsWith('session-') ? String(sid).trim() : `session-${String(sid).trim()}`;
    out += `reply-to: ${full}\n`;
  }
  return out;
}

// ── 身份 ────────────────────────────────────────────────────────────
async function whoami() {
  const sid = process.env.DSH_SESSION_ID || '';
  if (!sid) return { resolved: false, note: '本进程没有 $DSH_SESSION_ID（MCP 由 DSH 拉起，理论上应有）' };
  let name = idTail(sid);
  try {
    const list = await fetchSessions();
    const hit = list.find(s => s.sessionId === sid || s.sessionId.endsWith(sid));
    if (hit && (hit.title || '').trim()) name = hit.title.trim();
  } catch { /* 清单拉不到就退化成 id 尾 */ }
  return { sessionId: sid, name, tail8: idTail(sid) };
}

async function senderIdentity(explicit) {
  const want = (explicit || '').trim();
  const sid = want || (process.env.DSH_SESSION_ID || '').trim();
  if (!sid) throw new Error('不知道"我是谁"——请传 from（你的 sessionId）');
  const list = await fetchSessions();
  const hit = list.find(s => s.sessionId === sid || s.sessionId.endsWith(sid));
  const name = hit && (hit.title || '').trim() ? hit.title.trim() : idTail(sid);
  return { sessionId: hit ? hit.sessionId : sid, name };
}

// ── 工具实现 ────────────────────────────────────────────────────────
async function sendMessage({ to, text, mode, from }) {
  if (!text || !String(text).trim()) throw new Error('text 不能为空');
  const t0 = Date.now();
  const sessions = await fetchSessions();
  const target = resolveTarget(sessions, to);
  const me = await senderIdentity(from);
  const header = buildHeader(me.name, me.sessionId, mode !== 'queue');
  const full = header + String(text);

  if (target) {
    const res = await withPortRetry(port => dshCall(port, 'session/prompt', {
      request: {
        requestId: 'mcp-' + Date.now(),
        sessionId: target.sessionId,
        mode: mode === 'queue' ? 'queue' : 'steer',
        content: [{ type: 'text', text: full }],
      },
    }));
    const ok = res?.result?.ok !== false;
    return {
      ok,
      route: 'local-dsh-rpc',
      ms: Date.now() - t0,
      to: { name: target.title || idTail(target.sessionId), sessionId: target.sessionId },
      sender: { name: me.name, sessionId: me.sessionId },
      header,
    };
  }

  // 非本机会话：did:youling:… / sh-… / 好友昵称 / 分享任务名 / 模糊标题 ——
  // 全部委托 send.py（四格式路由 + /api/msg/route 契约 + 优雅降级）。
  // 2026-11-08 起：不再走旧的 :3102/api/cli session_send（v6 遗留路径）。
  const delegated = await delegateToSendPy(to, String(text), mode === 'queue' ? 'queue' : 'steer');
  return {
    ok: delegated.ok,
    route: delegated.ok ? 'send-py' : 'send-py-failed',
    ms: Date.now() - t0,
    to: String(to),
    detail: delegated.output.trim(),
  };
}

// ── send.py 委托（跨账号/分享/模糊路由的单一实现）─────────────────────
const SEND_PY = join(dirname(fileURLToPath(import.meta.url)), 'send.py');

function pythonCandidate() {
  if (process.env.MYCO_MCP_PYTHON && existsSync(process.env.MYCO_MCP_PYTHON)) return process.env.MYCO_MCP_PYTHON;
  const fallback = 'C:\\Python314\\python.exe';
  try { execFileSync('python', ['--version'], { timeout: 8000, windowsHide: true, stdio: 'ignore' }); return 'python'; } catch { /* not on PATH */ }
  if (existsSync(fallback)) return fallback;
  throw new Error('找不到 python（PATH 与 C:\\Python314 都没有）——跨账号/分享路由需要 send.py');
}

function delegateToSendPy(to, body, mode) {
  return new Promise((resolve) => {
    let py;
    try { py = pythonCandidate(); } catch (e) { resolve({ ok: false, output: e.message }); return; }
    const child = spawn(py, [SEND_PY, '--to', String(to), '--stdin', '--mode', mode === 'queue' ? 'queue' : 'steer'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 25_000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, output: `无法启动 ${py}: ${e.message}` }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, output: out || `(exit ${code})` }); });
    child.stdin.on('error', () => { /* EPIPE if send.py died early; close event carries the verdict */ });
    child.stdin.end(body, 'utf-8');
  });
}

// ── list_agents：协作智能体清单（lib/directory.js 单一实现）─────────────
let directoryMod;
async function loadDirectoryModule() {
  if (directoryMod) return directoryMod;
  const here = dirname(fileURLToPath(import.meta.url));
  // tools/mcp-server.mjs → ../lib/directory.js；lib/tools/mcp-server.mjs → ../directory.js
  for (const candidate of [join(here, '..', 'lib', 'directory.js'), join(here, '..', 'directory.js')]) {
    if (existsSync(candidate)) { directoryMod = await import(pathToFileURL(candidate).href); return directoryMod; }
  }
  throw new Error('找不到 directory.js（tools/ 与 lib/ 两种布局都试过）');
}

async function listAgents({ kind, grep, limit } = {}) {
  const mod = await loadDirectoryModule();
  const result = await mod.buildDirectory({ currentSessionId: process.env.DSH_SESSION_ID });
  let agents = result.agents || [];
  if (kind) agents = agents.filter(a => a.kind === kind);
  if (grep) {
    const g = String(grep).toLowerCase();
    agents = agents.filter(a => String(a.displayName || '').toLowerCase().includes(g)
      || String(a.did || a.shareId || a.sessionId || '').toLowerCase().includes(g));
  }
  const cap = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
  const slice = agents.slice(0, cap);
  return {
    count: slice.length,
    total: result.count,
    truncated: agents.length - slice.length,
    notes: result.notes,
    agents: slice.map(a => (a.kind === 'friend'
      ? { kind: 'friend', displayName: a.displayName, did: a.did, online: a.online === true }
      : a.kind === 'share'
        ? { kind: 'share', displayName: a.displayName, shareId: a.shareId, myRole: a.myRole, boundSessionId: a.boundSessionId ?? null }
        : { kind: 'session', displayName: a.displayName, sessionId: a.sessionId, running: a.running === true, updatedAt: a.updatedAt ?? null })),
  };
}

const TOOLS = [
  {
    name: 'send_message',
    description:
      '给另一个协作者发消息。to 支持：本机会话名/sessionId（本机直投）；'
      + 'did:youling:…（跨账号 P2P）、sh-…（按分享路由）、好友昵称、分享任务名、'
      + '会话标题模糊匹配（自动路由，歧义会报错并列出候选）。'
      + '自动带 v6 署名头（[from: 名字 · 时间] + reply-to: 完整 sessionId）；'
      + '收到带 reply-to 的消息要回应时，to 直接用那个 sessionId。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标：会话名 / sessionId / did:youling:… / sh-… / 好友昵称 / 分享任务名' },
        text: { type: 'string', description: '正文（只写内容，不要自己写 [from: ] 头）' },
        mode: { type: 'string', enum: ['steer', 'queue'], description: 'steer=插队（默认，下一步边界生效：当前步跑完即插入，不等整轮）；queue=排队（等对方当前轮结束，显式指定才用）' },
        from: { type: 'string', description: '发送方 sessionId（默认取 $DSH_SESSION_ID；署名错时可显式指定）' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'list_agents',
    description:
      '协作智能体清单（三源合并）：好友（跨账号）、分享任务、本机会话。'
      + '这是 systemPrompt 注入块的主动查询版——需要最新/完整清单时调用。'
      + 'kind 过滤（friend/share/session）、grep 按名称或 ID 子串过滤、limit 截取（默认 30，最大 200）。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['friend', 'share', 'session'], description: '只看某一类（可选）' },
        grep: { type: 'string', description: '名称/ID 子串过滤（可选）' },
        limit: { type: 'number', description: '最多返回条数（默认 30，最大 200）' },
      },
    },
  },
  {
    name: 'list_sessions',
    description: '列本机 DSH 会话（名字 + sessionId + 更新时间），grep 按标题子串过滤。',
    inputSchema: {
      type: 'object',
      properties: { grep: { type: 'string', description: '标题子串过滤（可选）' } },
    },
  },
  {
    name: 'whoami',
    description: '返回本会话的身份（sessionId / 名字 / 尾 8）——确认署名会用哪个名字。',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── MCP stdio 主循环 ────────────────────────────────────────────────
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handleToolCall(name, args) {
  if (name === 'send_message') return await sendMessage(args || {});
  if (name === 'list_agents') return await listAgents(args || {});
  if (name === 'list_sessions') {
    const list = await fetchSessions();
    const grep = (args?.grep || '').toLowerCase();
    const rows = list
      .filter(s => !s.blank)
      .filter(s => !grep || (s.title || '').toLowerCase().includes(grep))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 80)
      .map(s => ({ name: s.title || idTail(s.sessionId), sessionId: s.sessionId, cwd: s.cwd }));
    return { count: rows.length, sessions: rows };
  }
  if (name === 'whoami') return await whoami();
  throw new Error(`未知工具 ${name}`);
}

async function handle(msg) {
  const { id, method } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'myco', version: '1.0.0' },
      },
    });
  } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    // 通知，无需回应
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    try {
      const out = await handleToolCall(name, args);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `失败：${e.message}` }], isError: true } });
    }
  } else if (method) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${method}` } });
  }
}

let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch(e => send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: String(e) } }));
  }
});

console.error('[myco-mcp] stdio MCP 就绪（tools: send_message / list_agents / list_sessions / whoami）');
