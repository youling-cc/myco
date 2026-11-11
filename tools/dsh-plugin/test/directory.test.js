/**
 * Agent Directory（lib/directory.js）mock 测试 — 任务要求的五个覆盖点：
 *
 *   1. 三源合并、排序（好友 > 分享 > 会话）
 *   2. displayName 优先级（任务自定义名 > 原始名 > 好友昵称 > 会话标题 > DID尾4）
 *   3. 截断（>20 条时显示前 20 + “…另有 N 个”）
 *   4. 容错（任一源不可达 → 该类为空 + 说明，其余不受影响）
 *   5. 当前会话排除（DSH_SESSION_ID 无前缀 / RPC 项带 session- 前缀，均要排除）
 *
 * 运行方式（二选一，互不依赖 vnet/P2P/真实端口）：
 *   - node test/directory.test.js      （自带 mini runner，输出 PASS/FAIL）
 *   - pnpm test / vitest run           （同一组用例注册成 vitest 套件）
 *
 * 所有 I/O（fetch / execFile / readFile）都是注入的 mock；模块自动拉取在
 * 文件顶部即关闭，测试过程零真实网络。
 */

import { strict as assert } from "node:assert";

import {
  DIRECTORY_BLOCK_HEADER,
  MAX_SUMMARY_ENTRIES,
  buildDirectory,
  buildDirectoryFromSources,
  buildDirectoryMock,
  directoryBlockText,
  directoryCacheState,
  fetchSessions,
  getDirectorySnapshot,
  didTail4,
  refreshDirectory,
  renderDirectoryBlock,
  renderSummary,
  setDirectoryAutofetch,
  setDirectoryCacheForTests,
  shortDid,
} from "../lib/directory.js";
import { baseText } from "../lib/identity.js";

// 关掉自动后台拉取：测试里的一切缓存状态都由用例自己播种。
setDirectoryAutofetch(false);
setDirectoryCacheForTests(undefined);

/* ─────────────────────────────── fixtures ─────────────────────────────── */

const DID_XW = "did:youling:z6Mk1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaXXsHaW";
const DID_LS = "did:youling:z6Mk2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbXXk3Rp";

/** 三源各一条的“黄金样本”，summary 行格式与任务书逐字对齐。 */
const GOLDEN_SOURCES = Object.freeze({
  friends: [
    { did: DID_XW, name: "小王", status: "ok" },
    { did: DID_LS, name: "李四", status: "offline" },
  ],
  shares: [
    {
      shareId: "sh-abc",
      title: "DSH协议应用",
      state: "active",
      sessionId: "session-cd8a3c33",
      ownerAccount: "did:youling:z6Mkmine",
      grants: [{ did: "did:myco:mine", label: "owner" }],
    },
  ],
  sessions: [
    { sessionId: "session-27bcef7c", projections: { values: { title: "有灵myco" } } },
  ],
  myDid: "did:myco:mine",
});

/** 黄金样本的完整 summary（任务给出的样例格式）。 */
const GOLDEN_SUMMARY = [
  "好友：",
  `- 小王 (did:youling:z6Mk...sHaW) — 在线`,
  `- 李四 (did:youling:z6Mk...k3Rp) — 离线`,
  "",
  "分享任务：",
  `- "DSH协议应用" (shareId=sh-abc, owner=我, 绑定会话=session-cd8a3c33)`,
  "",
  "本机其他会话：",
  `- "有灵myco" (session-27bcef7c)`,
].join("\n");

/** 生成 N 个好友记录（用于截断测试）。 */
function manyFriends(n) {
  return Array.from({ length: n }, (_, i) => ({
    did: `did:youling:z6Mk${String(i).padStart(4, "0")}${"f".repeat(30)}fEnd`,
    name: `好友${i + 1}`,
    status: "ok",
  }));
}

/** 200 响应 mock。 */
const okResponse = (body) => ({ status: 200, text: async () => JSON.stringify(body) });
/** 404 响应 mock。 */
const notFound = { status: 404, text: async () => "not found" };

/** 假的 DSH browser-session 凭据（secret=base64("secret")）。 */
const FAKE_CREDS = "client-connection/browser-session:\n    id: bs-1\n    secret: c2VjcmV0\n";
const readFileCreds = async () => FAKE_CREDS;

/** 端到端 mock 环境：chat_state 两个端口都 404 → 走 CLI 回退。 */
const MOCK_ENV = {
  DSH_WEB_URL: "http://127.0.0.1:19999",
  DSH_SESSION_ID: "11111111-2222-3333-4444-555555555555",
};

/** 按URL分发的 fetch mock（e2e 用例）。 */
function routingFetch(handlers) {
  return (url, init) => {
    for (const [needle, handler] of handlers) {
      if (typeof needle === "string" ? url.includes(needle) : needle.test(url)) {
        return typeof handler === "function" ? handler(url, init) : Promise.resolve(handler);
      }
    }
    return Promise.resolve(notFound);
  };
}

/* ──────────────────────────────── 用例 ─────────────────────────────────── */

const tests = [

  ["三源合并：agents 按 好友 > 分享 > 会话 排序", () => {
    const result = buildDirectoryMock(GOLDEN_SOURCES);
    assert.deepEqual(result.agents.map((entry) => entry.kind), ["friend", "friend", "share", "session"]);
    assert.equal(result.count, 4);
    assert.equal(result.agents[0].displayName, "小王");
    assert.equal(result.agents[2].shareId, "sh-abc");
    assert.equal(result.agents[3].sessionId, "session-27bcef7c");
  }],

  ["summary 行格式与任务样例逐字一致", () => {
    const { summary } = buildDirectoryMock(GOLDEN_SOURCES);
    assert.equal(summary, GOLDEN_SUMMARY);
  }],

  ["displayName 优先级：任务自定义名 > 原始名 > shareId", () => {
    const custom = buildDirectoryMock({
      shares: [{ shareId: "sh-1", title: "DSH协议应用开发", customName: "协议对接", state: "active" }],
    });
    assert.equal(custom.agents[0].displayName, "协议对接");

    const original = buildDirectoryMock({
      shares: [{ shareId: "sh-1", title: "DSH协议应用开发", state: "active" }],
    });
    assert.equal(original.agents[0].displayName, "DSH协议应用开发");

    const bare = buildDirectoryMock({ shares: [{ shareId: "sh-1", state: "active" }] });
    assert.equal(bare.agents[0].displayName, "sh-1");
  }],

  ["displayName 优先级：好友昵称 > DID尾4；会话标题 > 未命名", () => {
    const named = buildDirectoryMock({ friends: [{ did: DID_XW, name: "小王", status: "ok" }] });
    assert.equal(named.agents[0].displayName, "小王");

    const anonymous = buildDirectoryMock({ friends: [{ did: DID_XW, status: "ok" }] });
    assert.equal(anonymous.agents[0].displayName, "sHaW");
    assert.equal(didTail4(DID_XW), "sHaW");
    assert.equal(shortDid(DID_XW), "did:youling:z6Mk...sHaW");

    const titled = buildDirectoryMock({
      sessions: [{ sessionId: "session-a", projections: { values: { title: "有灵myco" } } }],
    });
    assert.equal(titled.agents[0].displayName, "有灵myco");

    const untitled = buildDirectoryMock({ sessions: [{ sessionId: "session-a" }] });
    assert.equal(untitled.agents[0].displayName, "（未命名会话）");
  }],

  ["截断：25 条只显示前 20 + “…另有 5 个”，count 仍是 25", () => {
    const result = buildDirectoryMock({ friends: manyFriends(25) });
    assert.equal(result.count, 25);
    assert.equal(result.shown, MAX_SUMMARY_ENTRIES);
    assert.equal(result.hidden, 5);
    const bullets = result.summary.split("\n").filter((line) => line.startsWith("- "));
    assert.equal(bullets.length, MAX_SUMMARY_ENTRIES);
    assert.ok(result.summary.includes("…另有 5 个"));
    assert.ok(!result.summary.includes("好友21"));
    assert.ok(result.summary.includes("好友20"));
  }],

  ["恰好 20 条：不出现截断行", () => {
    const { summary, hidden } = buildDirectoryMock({ friends: manyFriends(20) });
    assert.equal(hidden, 0);
    assert.ok(!summary.includes("…另有"));
  }],

  ["容错：好友源不可达 → 该类为空 + 说明，其余不受影响", () => {
    const result = buildDirectoryMock({
      friends: { error: "unreachable" },
      shares: GOLDEN_SOURCES.shares,
      sessions: GOLDEN_SOURCES.sessions,
      myDid: "did:myco:mine",
    });
    assert.equal(result.count, 2);
    assert.ok(result.agents.every((entry) => entry.kind !== "friend"));
    assert.ok(result.notes.friend === true);
    assert.ok(result.summary.includes("好友列表暂不可达"));
    assert.ok(result.summary.includes(`"DSH协议应用"`));
    assert.ok(result.summary.includes(`"有灵myco"`));
  }],

  ["容错：分享与会话源都不可达 → 双说明 + 好友保留", () => {
    const result = buildDirectoryMock({
      friends: GOLDEN_SOURCES.friends,
      shares: { error: "unreachable" },
      sessions: { error: "unreachable" },
    });
    assert.equal(result.count, 2);
    assert.ok(result.summary.includes("分享任务列表暂不可达"));
    assert.ok(result.summary.includes("本机DSH会话列表暂不可达"));
    assert.ok(result.summary.includes("小王"));
  }],

  ["当前会话排除：session- 前缀归一化（环境变量无前缀 / 有前缀均可）", () => {
    const sessions = [
      { sessionId: "session-11111111-2222-3333-4444-555555555555", projections: { values: { title: "当前" } } },
      { sessionId: "session-99999999-8888-7777-6666-555555555555", projections: { values: { title: "别的会话" } } },
    ];
    const bare = buildDirectoryMock({ sessions }, { currentSessionId: "11111111-2222-3333-4444-555555555555" });
    assert.equal(bare.count, 1);
    assert.equal(bare.agents[0].displayName, "别的会话");

    const prefixed = buildDirectoryMock({ sessions }, { currentSessionId: "session-11111111-2222-3333-4444-555555555555" });
    assert.equal(prefixed.count, 1);
    assert.equal(prefixed.agents[0].sessionId, "session-99999999-8888-7777-6666-555555555555");
  }],

  ["过滤：pending 好友与 closed 分享不进清单", () => {
    const result = buildDirectoryMock({
      friends: [
        { did: DID_XW, name: "小王", status: "ok" },
        { did: DID_LS, name: "待审", status: "ok", pending: true },
      ],
      shares: [
        { shareId: "sh-open", title: "活跃", state: "active" },
        { shareId: "sh-gone", title: "已关", state: "closed" },
      ],
    });
    assert.equal(result.count, 2);
    assert.ok(result.agents.some((entry) => entry.kind === "friend" && entry.friendNickname === "小王"));
    assert.ok(!result.agents.some((entry) => entry.friendNickname === "待审"));
    assert.ok(!result.agents.some((entry) => entry.shareId === "sh-gone"));
  }],

  ["myRole：owner grant 命中我的设备 → owner；否则 collaborator", () => {
    // 设备级匹配：grants 的 owner 条目 did === myDid（设备形态）
    const mine = buildDirectoryMock({
      shares: [{ shareId: "sh-a", title: "A", state: "active", grants: [{ did: "did:myco:mine", label: "owner" }] }],
      myDid: "did:myco:mine",
    });
    assert.equal(mine.agents[0].myRole, "owner");
    assert.equal(mine.agents[0].ownerLabel, "我");

    // youling 级匹配（活数据形态 2026-11-07）：chat_state.myDid 是根 DID，
    // grants 里是设备 DID —— 靠 ownerAccount === myDid 判定
    const mineByAccount = buildDirectoryMock({
      shares: [{
        shareId: "sh-a2",
        title: "A2",
        state: "active",
        ownerAccount: "did:youling:me-root",
        grants: [{ did: "did:myco:mydevice", label: "owner" }],
      }],
      myDid: "did:youling:me-root",
    });
    assert.equal(mineByAccount.agents[0].myRole, "owner");
    assert.equal(mineByAccount.agents[0].ownerLabel, "我");

    const theirs = buildDirectoryMock({
      shares: [{ shareId: "sh-b", title: "B", state: "active", grants: [{ did: "did:myco:other", label: "owner" }], ownerAccount: DID_XW }],
      friends: [{ did: DID_XW, name: "小王", status: "ok" }],
      myDid: "did:myco:mine",
    });
    assert.equal(theirs.agents.find((entry) => entry.kind === "share").myRole, "collaborator");
    // owner 名取好友表交叉命名
    assert.equal(theirs.agents.find((entry) => entry.kind === "share").ownerLabel, "小王");

    const noGrants = buildDirectoryMock({ shares: [{ shareId: "sh-c", title: "C", state: "active", grants: [] }] });
    assert.equal(noGrants.agents[0].myRole, "collaborator");

    // 无 myDid：退回任务书规则（grants 里有 owner 条目 → owner）
    const spec = buildDirectoryMock({
      shares: [{ shareId: "sh-d", title: "D", state: "active", grants: [{ did: "did:myco:whoever", label: "owner" }] }],
    });
    assert.equal(spec.agents[0].myRole, "owner");
  }],

  ["buildDirectory 端到端（注入 fetch/exec/readFile mock）：HTTP 404 → CLI 回退", async () => {
    const sessionEnvelope = {
      type: "server-response",
      result: { ok: true, value: { items: [
        { sessionId: "session-11111111-2222-3333-4444-555555555555", projections: { values: { title: "当前会话" } } },
        { sessionId: "session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", projections: { values: { title: "有灵myco" } } },
      ] } },
    };
    const fetchImpl = routingFetch([
      ["/api/chat_state", notFound],
      ["http://127.0.0.1:19999/api/session/list", okResponse(sessionEnvelope)],
      ["/api/dshShare/list", okResponse({
        shares: [
          { shareId: "sh-abc", title: "DSH协议应用", state: "active", sessionId: "session-cd8a3c33", grants: [{ did: "did:myco:mine", label: "owner" }] },
          { shareId: "sh-closed", title: "已关闭", state: "closed" },
        ],
      })],
    ]);
    const execFileImpl = (exe, args, opts, cb) => cb(null, JSON.stringify({
      friends: [{ did: DID_XW, name: "小王", status: "ok" }],
      myDid: "did:myco:mine",
    }));

    const result = await buildDirectory({
      env: MOCK_ENV,
      fetchImpl,
      execFileImpl,
      readFileImpl: readFileCreds,
      dshHome: "C:\\fake\\.dsh",
    });

    assert.deepEqual(result.agents.map((entry) => entry.kind), ["friend", "share", "session"]);
    assert.equal(result.count, 3);
    assert.equal(result.agents[0].displayName, "小王");
    assert.equal(result.agents[1].myRole, "owner");
    assert.equal(result.agents[2].displayName, "有灵myco");
    assert.deepEqual(result.notes, {});
    assert.ok(result.summary.includes("owner=我"));
  }],

  ["buildDirectory 容错：三源全挂 → 全部说明、agents 空、块仍可注入", async () => {
    const failingExec = (exe, args, opts, cb) => cb(new Error("no cli"));
    const throwingFetch = () => Promise.reject(new Error("conn refused"));
    const throwingRead = async () => { throw new Error("no creds"); };

    const result = await buildDirectory({
      env: { DSH_WEB_URL: "http://127.0.0.1:1", DSH_SESSION_ID: "x" },
      fetchImpl: throwingFetch,
      execFileImpl: failingExec,
      readFileImpl: throwingRead,
      dshHome: "C:\\fake\\.dsh",
    });

    assert.equal(result.count, 0);
    assert.deepEqual(result.agents, []);
    assert.ok(result.notes.friend && result.notes.share && result.notes.session);
    assert.ok(result.summary.includes("好友列表暂不可达"));
    assert.ok(result.summary.includes("分享任务列表暂不可达"));
    assert.ok(result.summary.includes("本机DSH会话列表暂不可达"));
    const block = renderDirectoryBlock(result);
    assert.ok(block.startsWith(DIRECTORY_BLOCK_HEADER));
    assert.ok(block.includes("好友列表暂不可达"));
  }],

  ["fetchSessions：401 忙窗重试一次后成功", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return { status: 401, text: async () => "unauthorized" };
      return okResponse({ type: "server-response", result: { ok: true, value: { items: [{ sessionId: "session-x", projections: { values: { title: "T" } } }] } } });
    };
    const result = await fetchSessions({
      env: { DSH_WEB_URL: "http://127.0.0.1:19999" },
      fetchImpl,
      readFileImpl: readFileCreds,
      dshHome: "C:\\fake\\.dsh",
    });
    assert.equal(calls, 2);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].sessionId, "session-x");
  }],

  ["30s 缓存：新鲜直接命中，过期先给旧值并保持 30s 重建节奏", async () => {
    const seeded = buildDirectoryMock(GOLDEN_SOURCES);
    setDirectoryCacheForTests(seeded, 1_000);

    assert.equal(getDirectorySnapshot(1_000 + 29_999), seeded);
    assert.equal(directoryCacheState(1_000 + 29_999).ageMs, 29_999);

    // 过期：仍返回旧值（后台重建，测试里禁用了自动拉取）
    assert.equal(getDirectorySnapshot(1_000 + 30_001), seeded);
    assert.equal(directoryCacheState(1_000 + 30_001).ageMs, 30_001);

    // refreshDirectory 重建后缓存翻新
    const rebuilt = await refreshDirectory({
      env: MOCK_ENV,
      fetchImpl: routingFetch([
        ["/api/chat_state", okResponse({ friends: [{ did: DID_XW, name: "小王", status: "ok" }] })],
        ["/api/dshShare/list", okResponse({ shares: [] })],
      ]),
      execFileImpl: (exe, args, opts, cb) => cb(new Error("no cli")),
      readFileImpl: async () => { throw new Error("no creds"); },
      now: () => 50_000,
    });
    assert.equal(rebuilt.count, 1);
    assert.equal(directoryCacheState(50_000).hasResult, true);
    assert.equal(directoryCacheState(50_000).count, 1);
    setDirectoryCacheForTests(undefined);
  }],

  ["identity 注入：baseText 在同一注入里追加 [myco:协作智能体清单] 块", () => {
    setDirectoryCacheForTests(undefined);
    const withoutDirectory = baseText("session-x", "标题");
    assert.ok(withoutDirectory.startsWith("[myco:session-identity]"));
    assert.ok(!withoutDirectory.includes(DIRECTORY_BLOCK_HEADER));

    setDirectoryCacheForTests(buildDirectoryMock(GOLDEN_SOURCES), 1_000);
    const withDirectory = baseText("session-x", "标题");
    assert.ok(withDirectory.includes(`- sessionId: session-x`));
    assert.ok(withDirectory.includes(`- title: 标题`));
    const headerAt = withDirectory.indexOf(DIRECTORY_BLOCK_HEADER);
    assert.ok(headerAt > 0);
    assert.ok(withDirectory.includes("你可以向以下对象发送跨会话/跨账号消息"));
    assert.ok(withDirectory.includes("- 小王 (did:youling:z6Mk...sHaW) — 在线"));
    assert.ok(withDirectory.includes("发消息：调 myco skill / send.py --to <名称或ID> --stdin"));
    // 空清单（无条目且无错误说明）不注入块
    setDirectoryCacheForTests(buildDirectoryMock({}), 1_000);
    assert.equal(directoryBlockText(), undefined);
    assert.ok(!baseText("session-x").includes(DIRECTORY_BLOCK_HEADER));
    setDirectoryCacheForTests(undefined);
  }],

  ["buildDirectoryMock 与 buildDirectoryFromSources 行为一致（别名契约）", () => {
    assert.equal(buildDirectoryMock(GOLDEN_SOURCES).summary, buildDirectoryFromSources(GOLDEN_SOURCES).summary);
    assert.equal(buildDirectoryMock(GOLDEN_SOURCES).count, 4);
  }],

  ["renderSummary：全空输入 → 空串；block 渲染为 undefined", () => {
    assert.equal(renderSummary([]), "");
    assert.equal(renderDirectoryBlock({ agents: [], notes: {}, count: 0, summary: "" }), undefined);
  }],

  ["回归 2026-11-08：blank 空壳会话不进清单（1559 条里 70 条 blank）", () => {
    const result = buildDirectoryMock({
      sessions: [
        { sessionId: "session-real", projections: { values: { title: "真会话" } }, updatedAt: 200 },
        { sessionId: "session-blank1", blank: true, updatedAt: 300 },
        { sessionId: "session-blank2", blank: true, projections: { values: { title: "空壳也有标题" } } },
      ],
    });
    assert.equal(result.count, 1);
    assert.equal(result.agents[0].sessionId, "session-real");
    assert.ok(!result.summary.includes("blank"));
    assert.ok(!result.summary.includes("空壳也有标题"));
  }],

  ["回归 2026-11-08：会话按 updatedAt 新→旧排序（无 updatedAt 保持原序）", () => {
    const result = buildDirectoryMock({
      sessions: [
        { sessionId: "session-old", projections: { values: { title: "上周" } }, updatedAt: 100 },
        { sessionId: "session-new", projections: { values: { title: "刚刚" } }, updatedAt: 900 },
        { sessionId: "session-mid", projections: { values: { title: "昨天" } }, updatedAt: 500 },
      ],
    });
    assert.deepEqual(result.agents.map((entry) => entry.sessionId), ["session-new", "session-mid", "session-old"]);
    // 截断时留下的是最新的：maxEntries 只给会话 1 行 → “刚刚” 胜出
    const tight = buildDirectoryMock({
      sessions: [
        { sessionId: "session-old", projections: { values: { title: "上周" } }, updatedAt: 100 },
        { sessionId: "session-new", projections: { values: { title: "刚刚" } }, updatedAt: 900 },
      ],
    }, { maxEntries: 1 });
    assert.ok(tight.summary.includes("刚刚"));
    assert.ok(tight.summary.includes("…另有 1 个"));
  }],

  ["回归 2026-11-08：session/list 慢响应吃 RPC 预算而非 1.5s 探测预算；预算耗尽 → error:budget", async () => {
    // 挂起的 fetch（尊重 AbortSignal）：验证 ①signal 用的是预算内的超时
    // ②整源预算耗尽后立刻返回 {error:"budget"}，不无限等。
    // 注意 fallback 定时器必须有 ref —— AbortSignal.timeout 的定时器是
    // unref 的，单独依赖它会让事件循环空转、进程以 code 13 退出。
    let sawSignal;
    const hangingFetch = (url, init) => new Promise((_resolve, reject) => {
      sawSignal = init.signal;
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      setTimeout(() => reject(new Error("test-timeout")), 5000);
    });
    const t0 = Date.now();
    const result = await fetchSessions({
      env: { DSH_WEB_URL: "http://127.0.0.1:19999" },
      fetchImpl: hangingFetch,
      readFileImpl: readFileCreds,
      dshHome: "C:\\fake\\.dsh",
      budgetMs: 300,
    });
    const elapsed = Date.now() - t0;
    assert.equal(result.error, "budget");
    assert.ok(sawSignal instanceof AbortSignal, "请求必须带 AbortSignal 超时");
    assert.ok(elapsed < 5_000, `预算必须封顶耗时（实际 ${elapsed}ms）`);
  }],
];

/* ────────────────────────── dual-mode runner ───────────────────────────── */

if (process.env.VITEST !== undefined) {
  const { describe, it } = await import("vitest");
  describe("agent directory (mock)", () => {
    for (const [name, fn] of tests) it(name, fn);
  });
} else {
  let passed = 0;
  const failed = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      failed.push(name);
      console.error(`FAIL ${name}\n    ${error?.message ?? error}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}
