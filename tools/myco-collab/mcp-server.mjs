// tools/myco-collab/mcp-server.mjs — aop 插件本体（AOP 范式，aop.md PCDATR 映射）
//
// 这是 harness 进程肚子里的 aop 代理。模型（LLM）通过 MCP 工具调用它；它把
// 调用翻译成对 myco 环境面（env 核心 HTTP）的读写。分层：
// - **P（感知）**: AOP_TASK 环境变量感知（进程级路由身份，spawn 注入继承）；
//   hub 探活（/api/ping）。无主动感知循环——感知按需（工具调用时读环境）。
// - **C（认知）**: 空缺（无状态维护/发现——env 核心侧承担）。
// - **D（决策）**: 等待策略——take 长轮询分段（4h/段）+ 空段 300ms 重挂 + 进度
//   通知保活；投递目标解析（尾段→全键）在 env 侧。
// - **A（执行）**: 三工具=执行面：
//   aop_myco  = 等待位（取协作者指令；双主模型里 aop 是驾驶舱的"收"）
//   aop_msg   = 跨任务通讯（AI↔AI/人；[from:发起任务] 署名）
//   aop_open  = 反向拉起/聚焦 aop 工作区（对等双主：aop→harness 用 spawn，
//               harness→aop 用本工具——去中心化双向）
// - **T（转移）**: 空缺（任务实体演化在 env 侧 task-meta）。
// - **R（回报）**: 空缺（usage 由 llm_proxy 记账，不经本插件）。
//
// 对等性（去中心化）: 本插件既服务 aop.exe 启动的 harness 任务（AOP_TASK 有值），
// 也服务用户手开的 harness 会话（AOP_TASK 空——cwd 键路由兜底）。任一侧都可以
// 是发起方。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const hubArg = process.argv.indexOf('--hub');
const HUB = hubArg > 0 ? process.argv[hubArg + 1] : (process.env.MYCO_COLLAB_HUB || 'http://127.0.0.1:3002');
const DIAG = dirname(fileURLToPath(import.meta.url)) + '/server-diag.log';
const NL = String.fromCharCode(10);
const dlog = (m) => { try { appendFileSync(DIAG, new Date().toISOString().slice(11, 19) + ' ' + m + NL); } catch {} };

const server = new McpServer({ name: 'aop', version: '0.2.0' });

server.tool(
  'aop_myco',
  '向 myco 协作者查询指令（有指令立即收到；短暂等待无指令返回空）。适用于后台协作代理的持续轮询循环——空手时等 30 秒再查，有指令则执行并把结果带 [aop] 前缀报告主线程。',
  { cwd: z.string().describe('项目目录（用于路由到对应任务队列）') },
  async ({ cwd }, extra) => {
    // 共驾连接心跳 + 断开信号（§5.3）：每轮刷新 agentAt；stop=true（aop 工作区
    // 「断开」钮）→ 返回退出指引，aop-collab 循环体看到即结束并清标志。
    const dirN = String(cwd).split('\\').join('/');
    if (beatLink(dirN)) {
      clearLink(dirN);
      dlog('stop signal -> disconnected: ' + dirN);
      return { content: [{ type: 'text', text: '【已断开】用户收回协作连接。请结束循环，回一句「[aop] 协作代理已退出」作为最终结果。' }] };
    }
    // 自主性语义（2026-09-08 设计定稿，推翻 2026-09-05 长挂等待位）：
    //  - 曾「挂到有指令才 return」——模型冻在工具调用里（用户实测报「卡在那
    //    不知道在等什么」，期望无输入时 LLM 仍能自主干活）。
    //  - 现在：一次有界 hold（env 侧 hold=45s，有指令秒回）——空手返回明确指引，
    //    模型取回控制权。投递不依赖挂着：工作中 Stop 钩子回合末投（claude）、
    //    离线确定性唤醒（kill+resume 注入）兜底。
    let lastErr = '';
    for (let round = 1; round <= 2; round++) {
      try {
        dlog('take(hold) round=' + round);
        // AOP_TASK env（spawn 注入，claude→server 继承）：同项目多任务的路由键
        const TASK = process.env.AOP_TASK || '';
        const qstr = 'wait=1&hold=45&cwd=' + encodeURIComponent(cwd) + (TASK ? '&task=' + encodeURIComponent(TASK) : '');
        const r = await fetch(HUB + '/api/collab/mcp/take?' + qstr, {
          method: 'POST',
          signal: AbortSignal.timeout(60_000),
        });
        const j = await r.json();
        if (j.text) {
          dlog('got len=' + String(j.text).length);
          return { content: [{ type: 'text', text: '协作者指令：' + j.text }] };
        }
        dlog('hold 空手（45s 无指令）——放模型回自主工作');
        return { content: [{ type: 'text', text: '（45 秒内无新指令）继续你当前的工作；需要协作者指令时再调用 aop_myco 查询。若你已完成全部工作选择结束回合，协作者的指令会自动唤醒你（会话连续，不丢上下文）。' }] };
      } catch (e) {
        lastErr = e.message;
        dlog('err ' + e.message + (round < 2 ? ' — 重试一次' : ''));
      }
    }
    return { content: [{ type: 'text', text: '（查询暂时失败：' + lastErr + '——环境瞬时不可达。请继续当前工作，稍后再调用 aop_myco 查询。）' }] };
  },
);

server.tool(
  'aop_tasks',
  '列出任务环境（磁盘直读非进程查询）——随时重查任务列表/状态/锚的动态。默认当前项目；scope=all 列全部注册项目（跨项目协作找目标：任务键可直接作 aop_msg 的 to，或用「项目名/尾段」）',
  { cwd: z.string().describe('项目目录'), scope: z.string().optional().describe('"all"=全部注册项目（跨项目发现协作方）') },
  async ({ cwd, scope }) => {
    const linesOf = (dir, projName) => {
      try {
        const meta = JSON.parse(readFileSync(dir + '/.aop/task-meta.json', 'utf-8'));
        return Object.entries(meta).map(([k, v]) =>
          '- ' + (v.title || k) + '｜' + (v.closed ? '已关' : '进行中') + '｜' + (projName ? projName + '/' + k.split('-').pop() + '｜' : '') + k);
      } catch { return null }
    };
    if (scope === 'all') {
      // 注册项目面（env myco-projects.json——与 env 侧「项目名/尾段」寻址同源）
      let projects = [];
      try {
        const reg = process.env.APPDATA ? JSON.parse(readFileSync(process.env.APPDATA.split(String.fromCharCode(92)).join('/') + '/myco/myco-projects.json', 'utf-8')) : { projects: [] };
        projects = (reg.projects || []).filter(p => p.path);
      } catch { /* 注册面不可达时退化为仅本项目 */ }
      const blocks = [];
      for (const p of projects) {
        const ls = linesOf(p.path.split(String.fromCharCode(92)).join('/'), p.name || '');
        if (ls) blocks.push('【' + (p.name || p.path) + '】' + NL + ls.join(NL));
      }
      if (!blocks.length) return { content: [{ type: 'text', text: '（注册项目均无任务环境）' }] };
      return { content: [{ type: 'text', text: '【aop 任务环境·全部项目】' + NL + blocks.join(NL + NL) }] };
    }
    try {
      const ls = linesOf(cwd, '');
      if (!ls) return { content: [{ type: 'text', text: '（该项目暂无 .aop/task-meta.json）' }] };
      return { content: [{ type: 'text', text: '【aop 任务环境（磁盘直读）】' + NL + ls.join(NL) }] };
    } catch {
      return { content: [{ type: 'text', text: '（该项目暂无 .aop/task-meta.json）' }] };
    }
  },
);

// ── A（执行）：反向拉起 + 视图聚焦 ──
// aop_open：harness→aop 方向（对等双主完形）。语义：
// ①aop UI(:17894) 已在跑 → 只发 focus 请求（env 记录 → aop 轮询切换到本任务
//   视图——单实例多任务并行，不重复开窗）
// ②aop UI 不在 → detached 拉起 aop.exe（env 核心探活：env 活=exe 大概率活）
// focus 携带 cwd+taskKey：env 侧确保项目已注册（没有则按目录新建）——aop 侧
// 复用既有项目/任务行（任务 session 锚在 task-meta，不重复建）。
import { spawn as cpSpawn } from 'node:child_process';

// ── A（执行）：反向停靠（opt-in 交权，AOP-COLLAB §4.6b）──
// 用户经 skill/指令让模型调用 aop_park = 显式移交驾驶权：此后 llm_proxy 对该
// 项目的 end_turn 响应伪造 aop_park tool_use（工具循环永续，消息经本工具的
// tool_result 持续送达，idle 期间零 API 成本）；aop_release = 归还。
// 停靠标志走文件（%APPDATA%/myco/park-flags.json）——mcp-server(写) 与
// llm-proxy(读) 的共享面，不经 env（避免与 env 部署耦合）。
function readParkFlags() {
  try { return JSON.parse(readFileSync(PARK_FLAGS_FILE, 'utf-8')); } catch { return {}; }
}
function writeParkFlags(map) {
  try {
    const dir = dirname(PARK_FLAGS_FILE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(PARK_FLAGS_FILE, JSON.stringify(map, null, 1));
  } catch (e) { dlog('park-flags write fail: ' + e.message); }
}
const os_home = (await import('node:os')).homedir();
const path_mod = await import('node:path');
const PARK_FLAGS_FILE = path_mod.join(os_home, 'AppData', 'Roaming', 'myco', 'park-flags.json').split(path_mod.sep).join('/');

// ── 连接心跳（共驾模式，docs/aop-reverse-codrive.md §5.3）──
// aop-collab 后台代理每轮 aop_myco 刷新 agentAt；env 读它判「已连接/中断」；
// aop 工作区「断开」钮经 env 写 stop:true → 代理下一轮读到即退出并清标志。
const LINKS_FILE = path_mod.join(os_home, 'AppData', 'Roaming', 'myco', 'collab-links.json').split(path_mod.sep).join('/');
function readLinks() {
  try { return JSON.parse(readFileSync(LINKS_FILE, 'utf-8')); } catch { return {}; }
}
function writeLinks(map) {
  try {
    const dir = dirname(LINKS_FILE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(LINKS_FILE, JSON.stringify(map, null, 1));
  } catch (e) { dlog('links write fail: ' + e.message); }
}
/** 心跳键：cwd#taskKey（2026-09-09 旅程 J 猎 bug 抓到：纯 cwd 键=项目粒度——
 *  同项目两任务各挂 aop-collab 共享一条状态，A 退出被 B 的心跳掩盖/A 断开误杀 B。
 *  AOP_TASK 有值=任务粒度；无值（野生会话 cwd 路由）=项目粒度兼容。） */
function linkKey(dir) {
  const TASK = process.env.AOP_TASK || '';
  return TASK ? dir + '#' + TASK : dir;
}
/** 刷新心跳；返回 stop 信号（true=用户已断开） */
function beatLink(dir) {
  const key = linkKey(dir);
  const links = readLinks();
  const st = links[key];
  links[key] = { agentAt: Date.now(), stop: st ? st.stop : false };
  writeLinks(links);
  return !!(st && st.stop);
}
function clearLink(dir) {
  const key = linkKey(dir);
  const links = readLinks();
  if (links[key]) { delete links[key]; writeLinks(links); }
}

server.tool(
  'aop_park',
  '进入全托管停靠（用户明确要走开时才用；日常共驾用后台代理模式）。停靠期间主线程阻塞待命，协作者消息经本工具直达，空闲零成本。',
  { cwd: z.string().describe('当前项目目录') },
  async ({ cwd }) => {
    const dir = cwd.split('\\').join('/');
    const flags = readParkFlags();
    flags[dir] = { on: true, at: Date.now() };
    writeParkFlags(flags);
    dlog('park ON: ' + dir);
    // 长等待循环：每段 150s take；消息即回；解挂标志即回。全段零 API 成本。
    for (;;) {
      const flagsNow = readParkFlags();
      const st = flagsNow[dir];
      if (!st || !st.on) {
        return { content: [{ type: 'text', text: '【已解挂】用户收回驾驶权。回到交互待命，等用户输入。' }] };
      }
      const TASK = process.env.AOP_TASK || '';
      const qstr = 'wait=1&hold=150&cwd=' + encodeURIComponent(dir) + (TASK ? '&task=' + encodeURIComponent(TASK) : '');
      try {
        const r = await fetch(HUB + '/api/collab/mcp/take?' + qstr, {
          method: 'POST', signal: AbortSignal.timeout(160_000),
        });
        const j = await r.json();
        if (j.text) {
          dlog('park got msg len=' + String(j.text).length);
          return { content: [{ type: 'text', text: '协作者指令：' + j.text }] };
        }
      } catch (e) {
        dlog('park take err: ' + e.message);
        await new Promise((sl) => setTimeout(sl, 2000));
      }
    }
  },
);

server.tool(
  'aop_release',
  '解除停靠（用户收回驾驶权时调用）：此后回到普通交互模式，end_turn 不再被接管。',
  { cwd: z.string().describe('当前项目目录') },
  async ({ cwd }) => {
    const dir = cwd.split('\\').join('/');
    const flags = readParkFlags();
    if (flags[dir]) { flags[dir].on = false; writeParkFlags(flags); }
    dlog('park OFF: ' + dir);
    return { content: [{ type: 'text', text: '已解挂。回到用户驾驶。' }] };
  },
);

// ── A（执行）：跨任务通讯 ──
server.tool(
  'aop_msg',
  '跨任务通讯：给另一个任务（或人值守的任意任务）发消息，也可回复 aop 的指令。后台协作代理处理完 aop 指令后用本工具回传结果（[from:agent] 署名）。',
  { to: z.string().describe('目标寻址：同项目=尾段（h1）或完整 taskKey；跨项目=「项目名/尾段」（如 docs/t1）或完整 taskKey（全局唯一）。显式跨项目寻址失败会报错并提示已注册项目清单'), text: z.string().describe('消息内容'), cwd: z.string().optional().describe('当前项目目录（路由解析用，默认本进程 cwd') },
  async ({ to, text, cwd }) => {
    const TASK = process.env.AOP_TASK || '';
    const dir = cwd || process.cwd();
    try {
      const r = await fetch(HUB + '/api/collab/msg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: TASK || 'anon', to, text, cwd: dir }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      dlog('aop_msg -> ' + to + ' ok=' + j.ok);
      return { content: [{ type: 'text', text: j.ok ? ('已送达 ' + (j.to || to) + '。' + (j.loopHint ? '【环境提醒】' + j.loopHint : '')) : ('送达失败: ' + (j.error || '未知')) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'aop_msg 传输失败: ' + e.message }] };
    }
  },
);

server.tool(
  'aop_open',
  '拉起/聚焦 aop 工作区（用户想切到可视化工作区看本任务时调用；aop 已在跑则切换到本任务视图，不重复开窗）',
  { cwd: z.string().optional().describe('当前项目目录（视图定位用，默认本进程 cwd') },
  async ({ cwd }) => {
    const dir = cwd || process.cwd();
    const TASK = process.env.AOP_TASK || '';
    let uiAlive = false;
    let envAlive = false;
    try {
      const r = await fetch('http://127.0.0.1:17894/', { signal: AbortSignal.timeout(1200) });
      uiAlive = r.ok;
    } catch { /* aop UI 不在 */ }
    try {
      const r2 = await fetch(HUB + '/api/ping', { signal: AbortSignal.timeout(1200) });
      envAlive = r2.ok;
    } catch { /* env 核心不在 */ }
    if (!uiAlive) {
      // aop UI 不在：env 核心活也可能只是没开 UI——都尝试拉起（aop.exe 单实例：
      // 端口占用时它自己会聚焦既有窗退出）
      const exe = process.env.AOP_EXE || 'D:/myco/aop.exe';
      try {
        cpSpawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        dlog('aop_open spawned ' + exe);
      } catch (e) {
        return { content: [{ type: 'text', text: '（aop 工作区拉起失败：' + e.message + '——请告知用户手动打开）' }] };
      }
    }
    // focus 请求（env 记录 → aop UI 轮询切换视图 + 项目注册确保）
    try {
      const r3 = await fetch(HUB + '/api/collab/focus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: dir, taskKey: TASK, title: TASK }),
        signal: AbortSignal.timeout(3000),
      });
      const j = await r3.json();
      dlog('aop_open focus ok=' + j.ok + ' project=' + (j.project || ''));
      return { content: [{ type: 'text', text: uiAlive
        ? 'aop 工作区已在运行，已切换到本任务视图（' + (j.project || dir) + '）。'
        : 'aop 工作区拉起中，稍后自动定位到本任务（' + (j.project || dir) + '）。' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: uiAlive ? 'aop 工作区已在运行。' : 'aop 工作区拉起中（focus 通知失败：' + e.message + '，不影响运行）。' }] };
    }
  },
);

dlog('boot argv=' + JSON.stringify(process.argv));
await server.connect(new StdioServerTransport());
// 宿主 harness 退出 → stdio 管道关闭 → 自退（2026-09-07 孤儿 node 根修：
// claude 死后本 node 脱离进程树继续重连长轮询 take——心跳永真把已关任务
// 行恒判开，且每实例 ~50MB 泄漏。管道断即退，源头根治）。
for (const ev of ['close', 'end']) {
  process.stdin.on(ev, () => { dlog('stdin ' + ev + ' — host gone, exit'); process.exit(0); });
}
