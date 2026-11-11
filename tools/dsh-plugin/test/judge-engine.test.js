/**
 * judge-engine tests — pre-integration vectors V1-V20 (cross-run pending
 * against the Rust side; every expectation derived from dsh_share.rs
 * semantics, anchors in docs/JUDGE-ENGINE-porting-notes.md).
 *
 * Run: node test/judge-engine.test.js   |   vitest run
 */

import { strict as assert } from "node:assert";

import {
  CAPS_DENIED,
  CAP_IDS,
  capsDeclares,
  capsDeniedEnvelope,
  capsDeniedHit,
  capsForGrant,
  capsIdDeclared,
  defaultCaps,
  effectiveCaps,
  effectiveVisibility,
  highRiskCapFor,
  judgeMethod,
  mergeVis,
  normalizeCaps,
  ownerCaps,
  rpcReadExempt,
  sessionVisible,
  spaceNarrower,
  visibilityDeniedEnvelope,
  windowStricter,
} from "../src/judge-engine.js";

const D = defaultCaps();

const tests = [

  ["V5 默认=只读+输入：page/list/prompt 放行；豁免面纯读放行", () => {
    assert.deepEqual(judgeMethod(D, "session/page"), { allowed: true });
    assert.deepEqual(judgeMethod(D, "session/list"), { allowed: true });
    assert.deepEqual(judgeMethod(D, "session/prompt"), { allowed: true }); // 显式声明
    assert.deepEqual(judgeMethod(D, "commands/list"), { allowed: true }); // 豁免
    assert.deepEqual(judgeMethod(D, "llm/listProviders"), { allowed: true }); // 豁免
    assert.deepEqual(judgeMethod(D, "settings/describe"), { allowed: true }); // 豁免
    assert.deepEqual(judgeMethod(D, "permissionPresets/catalog"), { allowed: true }); // 豁免
  }],

  ["V4+V6 默认拒面：高风险/感知面全拒且 rule 正确", () => {
    for (const [method, rule] of [
      ["files/read", "files/"],
      ["files/write", "files/"],
      ["workspaceFiles/list", "workspaceFiles/"],
      ["terminal", "terminal"],
      ["commands/run", "commands/"],
      ["session/activate", "session/activate"],
    ]) {
      assert.deepEqual(judgeMethod(D, method), { allowed: false, rule }, `${method} 应拒于 ${rule}`);
    }
    // job/ 在高风险表（要求 terminal.exec）但不在报告链 → Rust 原版回落 "high-risk"
    assert.deepEqual(judgeMethod(D, "job/follow"), { allowed: false, rule: "high-risk" });
  }],

  ["§3.12.4 名单外放行：未识别方法不默认拒", () => {
    assert.deepEqual(judgeMethod(D, "unknownFace/fooBar"), { allowed: true });
    assert.deepEqual(judgeMethod(D, "session/someFutureMethod"), { allowed: true });
    assert.deepEqual(judgeMethod(undefined, "/assets/index.js"), { allowed: true }); // 非 RPC
  }],

  ["A09 真案：owner 关 session.input → prompt 由名单兜底拒", () => {
    const eff = capsForGrant(D, { "session.input": false });
    assert.equal(capsIdDeclared(eff, "session.input"), false);
    assert.deepEqual(judgeMethod(eff, "session/prompt"), { allowed: false, rule: "session/prompt" });
    // 对照：开着的时候靠显式声明放行
    assert.deepEqual(judgeMethod(capsForGrant(D, {}), "session/prompt"), { allowed: true });
  }],

  ["V1 逐人取交：只能在任务声明集合内收紧；集合外开了被夹回", () => {
    const task = { o: [{ id: "session.read", methods: ["session/list"] }], a: [] }; // 无 input
    const openedByForce = capsForGrant(task, { "session.input": true });
    // 任务级未声明 session.input：四固定 id 中 flags 勾选也无处生效（条目不存在）
    assert.equal(capsIdDeclared(openedByForce, "session.input"), false);
    assert.deepEqual(judgeMethod(openedByForce, "session/prompt"), { allowed: false, rule: "session/prompt" });
  }],

  ["V3 flags 矩阵：缺项继承 / 显式 false 移除 / 四全开自动带 model.select", () => {
    const inherit = capsForGrant(D, {}); // 全缺项=继承
    assert.equal(capsIdDeclared(inherit, "session.read"), true);
    const off = capsForGrant(D, { "session.read": false });
    assert.equal(capsIdDeclared(off, "session.read"), false);
    const allFour = capsForGrant(D, {
      "session.read": true, "session.input": true, "agent.view": true, "scope.switch": true,
    });
    assert.equal(capsIdDeclared(allFour, "model.select"), true); // 全权自动带
    assert.deepEqual(judgeMethod(allFour, "model/selectProvider"), { allowed: true });
    const explicitOff = capsForGrant(D, {
      "session.read": true, "session.input": true, "agent.view": true, "scope.switch": true,
      "model.select": false,
    });
    assert.equal(capsIdDeclared(explicitOff, "model.select"), false); // 显式优先于全权
  }],

  ["V7 双向 * 通配仍拒高风险（高风险层在 declares 之前）", () => {
    const wildcard = { o: [{ id: "*", methods: ["*"] }], a: [{ id: "*", methods: ["*"] }] };
    assert.deepEqual(judgeMethod(wildcard, "session/page"), { allowed: true }); // 声明通配放行普通方法
    assert.deepEqual(judgeMethod(wildcard, "files/read"), { allowed: false, rule: "files/" });
    assert.deepEqual(judgeMethod(wildcard, "model/x"), { allowed: false, rule: "model/" });
    // 但 id=model.select 的条目能开高风险（capsIdDeclared 按 id 认）
    const withModel = { o: [{ id: "*", methods: ["*"] }], a: [{ id: "model.select", methods: ["model/"] }] };
    assert.deepEqual(judgeMethod(withModel, "model/selectProvider"), { allowed: true });
  }],

  ["V8 admin 显式放行；owner caps 全通", () => {
    assert.deepEqual(judgeMethod(D, "files/read", true), { allowed: true });
    const owner = effectiveCaps(D, { owner: true });
    assert.equal(capsDeclares(owner, "anything/at/all"), true); // `*`
    assert.deepEqual(judgeMethod(D, "files/read", true), { allowed: true });
  }],

  ["V9 caps_declares 通配语义：* / prefix/* / prefix/ / 全等 / 子路径", () => {
    const caps = { o: [{ id: "x", methods: ["session/", "goal/*"] }], a: [] };
    assert.equal(capsDeclares(caps, "session/list"), true); // prefix/ 前缀
    assert.equal(capsDeclares(caps, "session"), true);
    assert.equal(capsDeclares(caps, "goal/watch"), true); // prefix/*
    assert.equal(capsDeclares(caps, "goal"), true); // Rust hit: name==p 也命中（含前缀自身）
    assert.equal(capsDeclares(caps, "sessionx/y"), false);
    const exact = { o: [{ id: "x", methods: ["job/list"] }], a: [] };
    assert.equal(capsDeclares(exact, "job/list"), true);
    assert.equal(capsDeclares(exact, "job/list/extra"), true); // 子路径
  }],

  ["cap 常量契约：CAP_IDS 九项目录（四开关+model+高五）/ CAPS_DENIED 含 prompt+steer / 高风险表抽查", () => {
    assert.equal(CAP_IDS.length, 9);
    assert.ok(CAPS_DENIED.includes("session/prompt"));
    assert.ok(CAPS_DENIED.includes("session/steer"));
    assert.equal(highRiskCapFor("files/read"), "files.read");
    assert.equal(highRiskCapFor("files/chmod"), "files.write"); // 泛化兜底
    assert.equal(highRiskCapFor("session/list"), undefined);
    assert.equal(capsDeniedHit("terminal", "terminal"), true);
    assert.equal(capsDeniedHit("terminal", "terminal/x"), true);
    assert.equal(capsDeniedHit("terminal", "terminals"), false);
    assert.equal(rpcReadExempt("files/list"), false); // files 不豁免
  }],

  ["V16/V17 visibility 合并只收紧：sessions 交集 / window 更严 / space 更窄", () => {
    const task = { space: "session", sessions: ["s1", "s2"], windowMs: 3600_000, projects: [] };
    const per = { space: "session", sessions: ["s2", "s3"], windowMs: 600_000, projects: [] };
    const merged = mergeVis(task, per);
    assert.deepEqual(merged.sessions, ["s2"]); // 交集
    assert.equal(merged.windowMs, 600_000); // 更严
    assert.equal(merged.space, "session");
    const wide = mergeVis({ space: "machine", sessions: [] }, { space: "project", sessions: [] });
    assert.equal(wide.space, "project"); // 更窄者
    assert.equal(windowStricter(null, 500), 500);
    assert.equal(windowStricter(null, null), null);
    assert.equal(spaceNarrower("machine", "session"), "session");
  }],

  ["V13/V15 session 可见性：白名单外拒（含 session- 前缀归一）", () => {
    const vis = effectiveVisibility({ space: "session", sessions: ["session-aaa"] }, undefined);
    assert.equal(sessionVisible(vis, "session-aaa"), true);
    assert.equal(sessionVisible(vis, "aaa"), true); // 裸 uuid 等价
    assert.equal(sessionVisible(vis, "session-zzz"), false);
    const machine = effectiveVisibility({ space: "machine" }, undefined);
    assert.equal(sessionVisible(machine, "anything"), true); // 不限
    const owner = effectiveVisibility({ space: "session", sessions: ["x"] }, { owner: true });
    assert.equal(sessionVisible(owner, "whatever"), true); // owner 全可见
  }],

  ["normalizeCaps：缺 o/a 补默认；显式空数组=该向全关（尊重）", () => {
    const empty = normalizeCaps({ o: [], a: [] });
    assert.deepEqual(empty.o, []);
    assert.deepEqual(empty.a, []);
    // 空声明 + session/list 不在 CAPS_DENIED → 名单外放行（§3.12.4 宽松语义）；
    // 真要关掉读面需在任务声明里不含它且方法在名单内——设计如此，不默认拒未识别方法。
    assert.deepEqual(judgeMethod(empty, "session/list"), { allowed: true });
    assert.deepEqual(judgeMethod(empty, "files/read"), { allowed: false, rule: "files/" }); // 高风险仍拒
    const missing = normalizeCaps({});
    assert.equal(missing.o.length, 1); // 补默认
    assert.equal(normalizeCaps("junk").o.length, 1);
  }],

  ["信封形态：A 面中文 code=受保护；P 面=不在可见范围；三字段齐全", () => {
    const a = JSON.parse(capsDeniedEnvelope("rpc-1", "files/"));
    assert.equal(a.type, "server-response");
    assert.equal(a.rpcId, "rpc-1");
    assert.equal(a.result.ok, false);
    assert.equal(a.result.error.code, "受保护");
    assert.equal(typeof a.result.error.message, "string");
    assert.equal(typeof a.result.error.details.rule, "string");
    const p = JSON.parse(visibilityDeniedEnvelope("rpc-2", "session-zzz"));
    assert.equal(p.result.error.code, "不在可见范围");
    assert.equal(p.result.error.details.sessionId, "session-zzz");
    assert.equal(p.result.error.details.scope, "session");
  }],

  ["effectiveCaps 链：owner→全通配；带 flags→取交；无 grant→任务级", () => {
    assert.equal(capsDeclares(effectiveCaps(D, { owner: true }), "x/y"), true);
    const flags = effectiveCaps(D, { caps: { "session.read": false } });
    assert.equal(capsIdDeclared(flags, "session.read"), false);
    assert.equal(capsIdDeclared(effectiveCaps(D, undefined), "session.read"), true);
  }],
];

/* ────────────────────────── dual-mode runner ────────────────────────────── */

if (process.env.VITEST !== undefined) {
  const { describe, it } = await import("vitest");
  describe("judge engine (ported semantics)", () => {
    for (const [name, fn] of tests) it(name, fn);
  });
} else {
  const filter = process.argv[2];
  const selected = filter === undefined ? tests : tests.filter(([name]) => name.includes(filter));
  let passed = 0;
  const failed = [];
  for (const [name, fn] of selected) {
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      failed.push(name);
      console.error(`FAIL ${name}\n    ${error?.message ?? error}`);
    }
  }
  console.log(`\n${passed}/${selected.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}
