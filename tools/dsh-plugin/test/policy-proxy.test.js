/**
 * policy-proxy tests — D1/D2/D3/D4/D5 of the final test plan.
 *
 * Harness: mock upstream (HMAC cookie gate + 101 echo-ish mux) + full proxy
 * suite (owner port, control plane, viewer ports), everything on temp state
 * files and random ports.
 *
 * Run: node test/policy-proxy.test.js   |   vitest run
 */

import { strict as assert } from "node:assert";
import http from "node:http";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PolicyStore,
  canonicalBody,
  decideHttp,
  decideSession,
  denialEnvelope,
  ensureControlKey,
  methodFromUrl,
  normalizeSessionId,
} from "../src/policy-proxy.js";
import { startProxySuite } from "../src/web-listener.js";

const SECRET = crypto.randomBytes(32);
const CONTROL_KEY = crypto.randomBytes(32);

function validCookie(header, authority) {
  const match = /dsh-auth-[A-Za-z0-9_-]+=v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/.exec(header ?? "");
  if (match === null) return false;
  if (crypto.createHmac("sha256", SECRET).update(match[1]).digest("base64url") !== match[2]) return false;
  return JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")).authority === authority;
}

function wsServerFrame(text) {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/** Mock upstream: cookie-gated HTTP + mux that echoes one server frame per open. */
function startMockUpstream() {
  let authority = "";
  const upgraded = new Set();
  const server = http.createServer((request, response) => {
    if (!validCookie(request.headers.cookie, authority)) {
      response.writeHead(401).end("auth required");
      return;
    }
    if (request.url === "/api/session/list") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        type: "server-response",
        rpcId: "r",
        result: { ok: true, value: { items: [
          { sessionId: "session-aaa" }, { sessionId: "session-bbb" }, { sessionId: "session-ccc" },
        ] } },
      }));
      return;
    }
    if (request.url === "/api/session/prompt") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "server-response", rpcId: "r", result: { ok: true, value: { accepted: true } } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end("<html>index</html>");
  });
  server.on("upgrade", (request, socket) => {
    if (!validCookie(request.headers.cookie, authority)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"] ?? "";
    const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    let answered = false;
    socket.on("data", () => {
      if (!answered) {
        answered = true;
        socket.write(wsServerFrame(JSON.stringify({ type: "ok", streamId: "any", echo: true })));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      authority = `127.0.0.1:${server.address().port}`;
      resolve({ server, authority, close: () => { for (const s of upgraded) s.destroy(); server.closeAllConnections?.(); server.close(); } });
    });
  });
}

/** Signed policy message builder (mirrors what myco will send). */
function signedPolicy(store2, fields, key = CONTROL_KEY) {
  const body = { nonce: crypto.randomUUID(), ts: Date.now(), ...fields };
  body.sig = crypto.createHmac("sha256", key).update(canonicalBody(body)).digest("base64url");
  return body;
}


/** 经 owner 口 + 连接身份头请求（per-viewer 分口已于 2026-11-10 删除）。 */
const viewerCall = (suite, viewerDid, path, init = {}) => fetch(
  `http://127.0.0.1:${suite.owner.port}${path}`,
  {
    ...init,
    headers: { "content-type": "application/json", "x-myco-viewer-did": viewerDid, ...(init.headers ?? {}) },
  },
);

async function createSuite({ controlPort, viewerBasePort } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "policy-proxy-test-"));
  const upstream = await startMockUpstream();
  // Random ports: the production suite owns 17878/17877 whenever a DSH host
  // runs, and tests must never fight it (nightly B-group traffic is live).
  const suite = await startProxySuite({
    env: { DSH_WEB_URL: `http://${upstream.authority}` },
    config: { stateFile: join(dir, "web-listener.json"), basePort: 20000 + Math.floor(Math.random() * 20000) },
    secret: SECRET,
    controlKey: CONTROL_KEY,
    controlPort: controlPort ?? 0,
    viewerBasePort: viewerBasePort ?? 30000 + Math.floor(Math.random() * 10000),
    log: () => {},
  });
  return { dir, upstream, suite };
}

async function postPolicy(suite, body) {
  const response = await fetch(`http://127.0.0.1:${suite.controlPort}/policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

const tests = [

  ["D5 前置：验签拒伪造 / 错钥 / 重放 / 过期 ts", async () => {
    const store = new PolicyStore();
    const ok = store.apply(signedPolicy(store, { viewerDid: "did:myco:v", allow: ["session/list"] }), CONTROL_KEY);
    assert.equal(ok.ok, true);
    const forged = { ...signedPolicy(store, { viewerDid: "did:myco:x" }), sig: "AAAA" };
    assert.equal(store.apply(forged, CONTROL_KEY).error, "bad-sig");
    const wrongKey = signedPolicy(store, { viewerDid: "did:myco:x" }, crypto.randomBytes(32));
    assert.equal(store.apply(wrongKey, CONTROL_KEY).error, "bad-sig");
    // replay: same message twice
    const original = signedPolicy(store, { viewerDid: "did:myco:v" });
    assert.equal(store.apply(original, CONTROL_KEY).ok, true);
    assert.equal(store.apply(original, CONTROL_KEY).error, "replayed-nonce");
    const stale = signedPolicy(store, { viewerDid: "did:myco:v" });
    stale.ts = Date.now() - 10 * 60_000;
    stale.sig = crypto.createHmac("sha256", CONTROL_KEY).update(canonicalBody(stale)).digest("base64url");
    assert.equal(store.apply(stale, CONTROL_KEY).error, "stale-ts");
  }],

  ["决策：方法白名单 / 会话白名单 / 默认全放", () => {
    const owner = decideHttp(undefined, "session/prompt");
    assert.equal(owner.allowed, true);
    const policy = { allow: new Set(["session/list"]), sessions: new Set(["aaa"]) };
    assert.equal(decideHttp(policy, "session/list").allowed, true);
    assert.equal(decideHttp(policy, "session/prompt").allowed, false);
    assert.equal(decideSession(policy, "session-aaa").allowed, true);
    assert.equal(decideSession(policy, "session-zzz").allowed, false);
    assert.equal(decideSession(undefined, "session-zzz").allowed, true);
    assert.equal(normalizeSessionId("session-aaa"), "aaa");
    assert.equal(methodFromUrl("/api/session/list"), "session/list");
    assert.equal(methodFromUrl("/assets/index.js"), undefined);
  }],

  ["良性信封形态：server-response + ok:false + myco/policy-denied", () => {
    const parsed = JSON.parse(denialEnvelope("rpc-1", "nope"));
    assert.equal(parsed.type, "server-response");
    assert.equal(parsed.rpcId, "rpc-1");
    assert.equal(parsed.result.ok, false);
    assert.equal(parsed.result.error.code, "myco/policy-denied");
  }],

  ["D1+D2：控制面下发 → 同口按连接身份区分（分口已删）", async () => {
    const harness = await createSuite();
    try {
      assert.equal(harness.suite.started, true);
      // D1: policy push takes effect immediately
      const pushed = await postPolicy(harness.suite, signedPolicy(null, {
        viewerDid: "did:myco:viewerA", allow: ["session/list"],
      }));
      assert.equal(pushed.status, 200);
      assert.equal(pushed.json.ok, true);
      assert.equal(pushed.json.port, undefined, "分口已删除：响应不再返回 port");

      // owner port 无身份头：prompt allowed（无策略）
      const viaOwner = await fetch(`http://127.0.0.1:${harness.suite.owner.port}/api/session/prompt`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "o1", method: "session/prompt", payload: { args: {} } }),
      });
      assert.equal(viaOwner.status, 200);
      assert.equal((await viaOwner.json()).result.ok, true);

      // 同一 owner 口 + viewerA 身份头：list ok, prompt denied with the benign envelope
      const listA = await viewerCall(harness.suite, "did:myco:viewerA", "/api/session/list", {
        method: "POST",
        body: JSON.stringify({ type: "client-request", rpcId: "a1", method: "session/list", payload: { args: {} } }),
      });
      assert.equal(listA.status, 200);
      const promptA = await viewerCall(harness.suite, "did:myco:viewerA", "/api/session/prompt", {
        method: "POST",
        body: JSON.stringify({ type: "client-request", rpcId: "a2", method: "session/prompt", payload: { args: {} } }),
      });
      assert.equal(promptA.status, 200);
      const denial = await promptA.json();
      assert.equal(denial.result.ok, false);
      assert.equal(denial.result.error.code, "myco/policy-denied");
      assert.equal(denial.rpcId, "a2");

      // D2: 第二个 viewer（无 allow 条目=全放行）在同一口上互不干扰
      await postPolicy(harness.suite, signedPolicy(null, { viewerDid: "did:myco:viewerB" }));
      const promptB = await viewerCall(harness.suite, "did:myco:viewerB", "/api/session/prompt", {
        method: "POST",
        body: JSON.stringify({ type: "client-request", rpcId: "b1", method: "session/prompt", payload: { args: {} } }),
      });
      assert.equal((await promptB.json()).result.ok, true, "viewerB 无 allow 条目=全放行");

      // GET /policy snapshot
      const snapshot = await (await fetch(`http://127.0.0.1:${harness.suite.controlPort}/policy`)).json();
      assert.equal(snapshot.viewers.length, 2);

      // C3: closePort 撤销 → 该身份再请求被拒（不回退口级）
      const closed = await postPolicy(harness.suite, signedPolicy(null, { viewerDid: "did:myco:viewerA", closePort: true }));
      assert.equal(closed.json.ok, true);
      const revoked = await viewerCall(harness.suite, "did:myco:viewerA", "/api/session/list", { method: "POST", body: "{}" });
      assert.equal(revoked.status, 403, "撤销后该身份必须被拒");
      // 其他身份不受影响
      const stillOk = await viewerCall(harness.suite, "did:myco:viewerB", "/api/session/list", { method: "POST", body: "{}" });
      assert.equal(stillOk.status, 200);
    } finally {
      harness.suite.close();
      harness.upstream.close();
      await rm(harness.dir, { recursive: true, force: true });
    }
  }],

  ["D4：会话白名单——prompt 白名单外被拒；list 响应被过滤", async () => {
    const harness = await createSuite();
    try {
      const pushed = await postPolicy(harness.suite, signedPolicy(null, {
        viewerDid: "did:myco:scoped", sessions: ["session-aaa"],
      }));
      const promptAllowed = await viewerCall(harness.suite, "did:myco:scoped", "/api/session/prompt", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "s1", method: "session/prompt",
          payload: { args: { request: { requestId: "x", sessionId: "session-aaa", mode: "queue", content: [] } } } }),
      });
      assert.equal((await promptAllowed.json()).result.ok, true);
      const promptDenied = await viewerCall(harness.suite, "did:myco:scoped", "/api/session/prompt", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "s2", method: "session/prompt",
          payload: { args: { request: { requestId: "x", sessionId: "session-zzz", mode: "queue", content: [] } } } }),
      });
      const denial = await promptDenied.json();
      assert.equal(denial.result.ok, false);
      assert.equal(denial.result.error.code, "myco/policy-denied");

      const list = await viewerCall(harness.suite, "did:myco:scoped", "/api/session/list", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "s3", method: "session/list", payload: { args: {} } }),
      });
      const items = (await list.json()).result.value.items;
      assert.deepEqual(items.map((item) => item.sessionId), ["session-aaa"]);
    } finally {
      harness.suite.close();
      harness.upstream.close();
      await rm(harness.dir, { recursive: true, force: true });
    }
  }],

  ["D3(WS)：viewer 口 open 帧 endpoint 被拒 → error 帧并断连", async () => {
    const harness = await createSuite();
    try {
      const pushed = await postPolicy(harness.suite, signedPolicy(null, {
        viewerDid: "did:myco:wsv", allow: ["session/follow"],
      }));
      assert.equal(pushed.json.ok, true);
      const outcome = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${harness.suite.owner.port}/api/remote.mux`, {
          headers: { "x-myco-viewer-did": "did:myco:wsv" },
        });
        ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "open", streamId: "1", endpoint: "session/prompt", payload: { args: {} } })));
        ws.addEventListener("message", (event) => resolve({ kind: "message", text: String(event.data) }));
        ws.addEventListener("close", () => resolve({ kind: "closed-after" }));
        ws.addEventListener("error", () => resolve({ kind: "error" }));
        setTimeout(() => resolve({ kind: "timeout" }), 5000).unref?.();
      });
      if (outcome.kind === "message") {
        const frame = JSON.parse(outcome.text);
        assert.equal(frame.error?.code, "myco/policy-denied");
      } else {
        assert.equal(outcome.kind, "closed-after", "拒绝后必须断连（或先回 error 帧）");
      }
    } finally {
      harness.suite.close();
      harness.upstream.close();
      await rm(harness.dir, { recursive: true, force: true });
    }
  }],

  ["引擎格式端到端：authz 原始数据 → 判定链生效 + 中文信封", async () => {
    const harness = await createSuite();
    try {
      // 原始授权数据（终态 2③ 格式）：协作者默认 caps + session 粒度可见性
      const pushed = await postPolicy(harness.suite, signedPolicy(null, {
        viewerDid: "did:myco:eng",
        authz: {
          taskCaps: {}, // 默认 caps（只读+输入）
          taskVis: { space: "session", sessions: ["session-aaa"] },
          grant: { owner: false },
        },
      }));
      assert.equal(pushed.json.ok, true);

      // 默认放行面
      const list = await viewerCall(harness.suite, "did:myco:eng", "/api/session/list", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "e1", method: "session/list", payload: { args: {} } }),
      });
      const listJson = await list.json();
      assert.equal(listJson.result.ok, true);
      // P 面：白名单外条目被 visibility 过滤（mock 上游 3 条 → 只剩 aaa）
      assert.deepEqual(listJson.result.value.items.map((i) => i.sessionId), ["session-aaa"]);

      // A 面：高风险拒 → 信封 code=受保护
      const denied = await viewerCall(harness.suite, "did:myco:eng", "/api/files/read", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "e2", method: "files/read", payload: { args: {} } }),
      });
      const deniedJson = await denied.json();
      assert.equal(deniedJson.result.ok, false);
      assert.equal(deniedJson.result.error.code, "受保护");
      assert.equal(deniedJson.rpcId, "e2");

      // 名单外放行（§3.12.4）：未知方法不拒
      const unknown = await viewerCall(harness.suite, "did:myco:eng", "/api/futureFace/whatever", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "e3", method: "futureFace/whatever", payload: { args: {} } }),
      });
      assert.equal(unknown.status, 200); // 上游 404 也好，本地不拒

      // owner grant → 全放行
      const ownerPush = await postPolicy(harness.suite, signedPolicy(null, {
        viewerDid: "did:myco:boss",
        authz: { taskCaps: {}, taskVis: {}, grant: { owner: true } },
      }));
      assert.equal(ownerPush.json.ok, true);
      const ownerList = await viewerCall(harness.suite, "did:myco:boss", "/api/session/list", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "e4", method: "session/list", payload: { args: {} } }),
      });
      const ownerItems = (await ownerList.json()).result.value.items;
      assert.equal(ownerItems.length, 3); // 不过滤

      // GET /policy 快照含 kind
      const snapshot = await (await fetch(`http://127.0.0.1:${harness.suite.controlPort}/policy`)).json();
      assert.ok(snapshot.viewers.some((v) => v.kind === "engine"));
    } finally {
      harness.suite.close();
      harness.upstream.close();
      await rm(harness.dir, { recursive: true, force: true });
    }
  }],

  ["引擎格式端到端：白名单外 prompt → 信封 code=不在可见范围", async () => {
    const harness = await createSuite();
    try {
      const pushed = await postPolicy(harness.suite, signedPolicy(null, {
        viewerDid: "did:myco:vis",
        authz: { taskCaps: {}, taskVis: { space: "session", sessions: ["session-aaa"] }, grant: {} },
      }));
      assert.equal(pushed.json.ok, true);
      const outside = await viewerCall(harness.suite, "did:myco:vis", "/api/session/prompt", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "v1", method: "session/prompt",
          payload: { args: { request: { requestId: "x", sessionId: "session-zzz", mode: "queue", content: [] } } } }),
      });
      const json = await outside.json();
      assert.equal(json.result.ok, false);
      assert.equal(json.result.error.code, "不在可见范围");
      assert.equal(json.result.error.details.sessionId, "session-zzz");
      // 白名单内放行
      const inside = await viewerCall(harness.suite, "did:myco:vis", "/api/session/prompt", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "v2", method: "session/prompt",
          payload: { args: { request: { requestId: "x", sessionId: "session-aaa", mode: "queue", content: [] } } } }),
      });
      assert.equal((await inside.json()).result.ok, true);
    } finally {
      harness.suite.close();
      harness.upstream.close();
      await rm(harness.dir, { recursive: true, force: true });
    }
  }],

  ["密钥文件：首启生成、复用、长度合规", async () => {
    const dir = await mkdtemp(join(tmpdir(), "control-key-"));
    const path = join(dir, "web-proxy-control.key");
    const first = await ensureControlKey(path);
    const second = await ensureControlKey(path);
    assert.equal(first.equals(second), true);
    assert.ok(first.length >= 32);
    await rm(dir, { recursive: true, force: true });
  }],

  ["状态文件带 controlPort（myco 读者字段）", async () => {
    const harness = await createSuite({ controlPort: 0 });
    try {
      const raw = JSON.parse(await readFile(join(harness.dir, "web-listener.json"), "utf8"));
      assert.equal(typeof raw.controlPort, "number");
    } finally {
      harness.suite.close();
      harness.upstream.close();
      await rm(harness.dir, { recursive: true, force: true });
    }
  }],
];

tests.push(
  ["策略持久化：推一条 → 落盘 → 新 store 加载后仍生效（重启不丢授权）", async () => {
    const { PolicyStore } = await import("../src/policy-proxy.js");
    const { createHmac, randomBytes, randomUUID } = await import("node:crypto");
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const key = randomBytes(32);
    const dir = await mkdtemp(join(tmpdir(), "policy-persist-"));
    const statePath = join(dir, "web-proxy-policy.json");
    const now = () => 1_700_000_000_000;
    const a = new PolicyStore({ now, statePath });
    await a.load();
    const body = { nonce: randomUUID(), ts: now(), viewerDid: "did:myco:PersistMe",
      authz: { taskCaps: {}, taskVis: {}, grant: { owner: true }, viewerLabel: "设备·持久化·pppp" } };
    body.sig = createHmac("sha256", key).update(canonicalBody(body)).digest("base64url");
    assert.equal(a.apply(body, key).ok, true);
    await new Promise((r) => setTimeout(r, 50)); // persist is fire-and-forget
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    assert.ok(raw.viewers["did:myco:PersistMe"], "落盘应包含该 viewer");
    // 新 store（模拟重启）加载后仍能查到策略
    const b = new PolicyStore({ now, statePath });
    const loaded = await b.load();
    assert.equal(loaded, 1, "重启后应加载 1 条");
    const entry = b.viewers.get("did:myco:PersistMe");
    assert.equal(entry.kind, "engine");
    assert.equal(entry.label, "设备·持久化·pppp");
    assert.equal(entry.admin, false);
    // closePort 撤销也要落盘
    const closeBody = { nonce: randomUUID(), ts: now(), viewerDid: "did:myco:PersistMe", closePort: true };
    closeBody.sig = createHmac("sha256", key).update(canonicalBody(closeBody)).digest("base64url");
    a.apply(closeBody, key);
    await new Promise((r) => setTimeout(r, 50));
    const after = new PolicyStore({ now, statePath });
    assert.equal(await after.load(), 0, "撤销后重启应加载 0 条");
  }],
);

/* ────────────────────────── dual-mode runner ────────────────────────────── */

if (process.env.VITEST !== undefined) {
  const { describe, it } = await import("vitest");
  describe("policy proxy (semantic P/A)", () => {
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
