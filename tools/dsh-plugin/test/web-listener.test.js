/**
 * web-listener tests — the credential-free local DSH web entry.
 *
 * Everything runs against a mock upstream that mimics the two DSH web
 * behaviours the listener depends on: HMAC-signed browser-session cookies
 * (401 without them) and the `/api/remote.mux` WebSocket upgrade.
 *
 * Run: node test/web-listener.test.js   (mini runner)
 *      vitest run                      (same cases)
 */

import { strict as assert } from "node:assert";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BASE_PORT,
  parseState,
  proxyRequestHeaders,
  relayedHeaders,
  resolveUpstream,
  startWebListener,
  upstreamAuthority,
} from "../src/web-listener.js";
import { mintDshCookie } from "../src/directory.js";

/* ─────────────────────────── fixtures & helpers ─────────────────────────── */

/** Test secret (32 bytes, same shape as the real browser-session secret). */
const SECRET = crypto.randomBytes(32);

/**
 * Verify one `dsh-auth-*` cookie value against the test secret — the same
 * check the real DSH host performs (HMAC over the body, authority bound).
 * @param cookieHeader - raw Cookie header value.
 * @param authority - expected `host:port`.
 * @returns `true` for a valid, authority-matching cookie.
 */
function validCookie(cookieHeader, authority) {
  const match = /dsh-auth-[A-Za-z0-9_-]+=v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/.exec(cookieHeader ?? "");
  if (match === null) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(match[1]).digest("base64url");
  if (expected !== match[2]) return false;
  const payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  return payload.authority === authority;
}

/**
 * Encode one server→client text frame (RFC 6455, unmasked, short payload).
 * A byte-for-byte echo would relay the *client's masked* frame back, which
 * conforming clients reject (server frames must be unmasked) — so the mock
 * answers with a proper frame instead.
 * @param text - payload.
 * @returns the frame bytes.
 */
function wsServerFrame(text) {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/**
 * Start the mock upstream DSH web server.
 * @returns `{server, port, authority, close()}` — `authority` is the actual
 * `127.0.0.1:<port>` cookies must be bound to.
 */
function startMockUpstream() {
  let authority = "";
  /** Upgraded sockets on the mock upstream — `server.close()` never reaps them. */
  const upgraded = new Set();
  const server = http.createServer((request, response) => {
    if (!validCookie(request.headers.cookie, authority)) {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("dsh web authentication required");
      return;
    }
    if (request.url === "/api/session/list") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: { ok: true, value: { items: [{ sessionId: "session-x" }] } } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>DSH</title></head><body>index</body></html>");
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
    // Uplink check: client bytes must arrive (the bridge is transparent); we
    // do not parse them — just answer once with a proper server frame.
    let answered = false;
    socket.on("data", () => {
      if (!answered) {
        answered = true;
        socket.write(wsServerFrame("bridge-check"));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      authority = `127.0.0.1:${port}`;
      resolve({
        server,
        port,
        authority,
        close: () => {
          for (const socket of upgraded) socket.destroy();
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}

/**
 * Occupy one loopback port with a dummy TCP server.
 * @returns `{port, close()}`.
 */
function occupyPort() {
  const server = net.createServer(() => {});
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

/** One listener harness: mock upstream + listener + temp state file. */
async function createHarness({ statePort } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "web-listener-test-"));
  const stateFile = join(dir, "web-listener.json");
  if (Number.isInteger(statePort)) {
    await writeFile(stateFile, JSON.stringify({ port: statePort, pid: 1, since: 1, basePath: "/" }), "utf8");
  }
  const upstream = await startMockUpstream();
  const authority = upstream.authority;
  const basePort = 20000 + Math.floor(Math.random() * 20000);
  return {
    dir,
    stateFile,
    upstream,
    authority,
    async start(overrides = {}) {
      return startWebListener({
        env: { DSH_WEB_URL: `http://${authority}` },
        config: { stateFile, basePort },
        secret: SECRET,
        ...overrides,
      });
    },
    async cleanup(handle) {
      handle?.close?.();
      await upstream.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/* ───────────────────────────────── cases ────────────────────────────────── */

const tests = [

  ["parseState：合法/畸形/越界输入", () => {
    const good = parseState('{"port":17878,"pid":123,"since":1,"basePath":"/"}');
    assert.equal(good.port, 17878);
    assert.equal(good.pid, 123);
    assert.equal(parseState("not json"), undefined);
    assert.equal(parseState('{"port":0}'), undefined);
    assert.equal(parseState('{"port":70000}'), undefined);
    assert.equal(parseState('{"port":"17878"}'), undefined, "字符串口必须拒绝（防隐式转型）");
    assert.equal(parseState("null"), undefined);
  }],

  ["upstreamAuthority：带口/不带口/畸形", () => {
    assert.equal(upstreamAuthority("http://127.0.0.1:60266"), "127.0.0.1:60266");
    assert.equal(upstreamAuthority("http://localhost"), "localhost:80");
    assert.equal(upstreamAuthority("::::"), undefined);
  }],

  ["proxyRequestHeaders：host/origin 重写 + cookie 注入 + accept-encoding 透传", () => {
    const headers = proxyRequestHeaders(
      {
        host: "127.0.0.1:19999",
        origin: "http://127.0.0.1:19999",
        cookie: "browser=junk",
        "accept-encoding": "br, gzip",
        "user-agent": "test",
        "content-type": "application/json",
      },
      "127.0.0.1:60266",
      "dsh-auth-abc=v1.x.y",
    );
    const map = Object.fromEntries(headers);
    assert.equal(map.host, "127.0.0.1:60266");
    assert.equal(map.origin, "http://127.0.0.1:60266");
    assert.equal(map.cookie, "dsh-auth-abc=v1.x.y");
    assert.equal(map["accept-encoding"], "br, gzip", "字节级透传：编码由浏览器自己协商/解码");
    assert.equal(map["user-agent"], "test");
  }],

  ["relayedHeaders：set-cookie/hop-by-hop 不回传；编码与长度保留（字节原样）", () => {
    const out = relayedHeaders({
      "content-type": "text/html",
      "content-encoding": "br",
      "content-length": "123",
      "set-cookie": "dsh-auth-x=v1",
      "transfer-encoding": "chunked",
      connection: "keep-alive",
    });
    assert.equal(out["content-type"], "text/html");
    assert.equal(out["content-encoding"], "br");
    assert.equal(out["content-length"], "123");
    for (const banned of ["set-cookie", "connection", "keep-alive", "transfer-encoding"]) {
      assert.equal(out[banned], undefined, banned);
    }
  }],

  ["验收 b+a：无凭证 GET / 与 POST /api/session/list 经 listener 全通", async () => {
    const harness = await createHarness();
    const handle = await harness.start();
    try {
      assert.equal(handle.started, true);
      // 无任何 cookie：浏览器式直开
      const page = await fetch(`http://127.0.0.1:${handle.port}/`, { redirect: "manual" });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /index/);
      const api = await fetch(`http://127.0.0.1:${handle.port}/api/session/list`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "t", method: "session/list", payload: { args: {} } }),
      });
      assert.equal(api.status, 200);
      const parsed = await api.json();
      assert.equal(parsed.result.value.items[0].sessionId, "session-x");
    } finally {
      await harness.cleanup(handle);
    }
  }],

  ["验收 a(WS)：/api/remote.mux 透明桥——回显即通", async () => {
    if (process.env.WL_TRACE) console.error("trace: harness...");
    const harness = await createHarness();
    if (process.env.WL_TRACE) console.error("trace: start...");
    const handle = await harness.start();
    if (process.env.WL_TRACE) console.error(`trace: listener ${handle.port}, ws connecting...`);
    try {
      const echoed = await new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/api/remote.mux`);
        const fail = (error) => reject(new Error(`WS bridge: ${String(error?.message ?? error)}`));
        socket.addEventListener("open", () => { if (process.env.WL_TRACE) console.error("trace: open"); socket.send("bridge-check"); });
        socket.addEventListener("message", (event) => { if (process.env.WL_TRACE) console.error("trace: msg"); socket.close(); resolve(String(event.data)); });
        socket.addEventListener("error", () => { if (process.env.WL_TRACE) console.error("trace: error"); fail(new Error("websocket error")); });
        socket.addEventListener("close", () => { if (process.env.WL_TRACE) console.error("trace: close"); fail(new Error("closed before echo")); });
        setTimeout(() => fail(new Error("timeout")), 5000).unref?.();
      });
      assert.equal(echoed, "bridge-check");
    } finally {
      if (process.env.WL_TRACE) console.error("trace: cleanup...");
      await harness.cleanup(handle);
      if (process.env.WL_TRACE) console.error("trace: cleanup done");
    }
  }],

  ["验收 c：状态文件内容与实际监听一致（含 upstream/basePath/pid）", async () => {
    const harness = await createHarness();
    const handle = await harness.start();
    try {
      const state = parseState(await readFile(harness.stateFile, "utf8"));
      assert.equal(state.port, handle.port);
      assert.equal(state.pid, process.pid);
      assert.equal(state.basePath, "/");
      const raw = JSON.parse(await readFile(harness.stateFile, "utf8"));
      assert.equal(raw.upstream, `http://${harness.authority}`);
      const live = await fetch(`http://127.0.0.1:${state.port}/`);
      assert.equal(live.status, 200);
    } finally {
      await harness.cleanup(handle);
    }
  }],

  ["验收 d：状态文件里的空闲口被优先复用", async () => {
    const freePort = 21000 + Math.floor(Math.random() * 20000);
    const harness = await createHarness({ statePort: freePort });
    const handle = await harness.start();
    try {
      assert.equal(handle.port, freePort);
      const state = parseState(await readFile(harness.stateFile, "utf8"));
      assert.equal(state.port, freePort);
    } finally {
      await harness.cleanup(handle);
    }
  }],

  ["验收 d(被占)：状态口被占 → 递增落到 basePort 起", async () => {
    const squatter = await occupyPort();
    const harness = await createHarness({ statePort: squatter.port });
    const handle = await harness.start();
    try {
      assert.equal(handle.started, true);
      assert.notEqual(handle.port, squatter.port);
      const state = parseState(await readFile(harness.stateFile, "utf8"));
      assert.equal(state.port, handle.port);
    } finally {
      await harness.cleanup(handle);
      await squatter.close();
    }
  }],

  ["降级：无 DSH_WEB_URL → started:false，不抛异常", async () => {
    const result = await startWebListener({
      env: {},
      secret: SECRET,
      // 关闭有界重试（生产默认 2s×15 覆盖宿主启动窗口），让降级用例快速返回。
      config: {
        stateFile: "unused.json",
        execFileImpl: (exe, args, opts, cb) => cb(new Error("no exec")),
        upstreamAttempts: 1,
        upstreamRetryMs: 0,
      },
    });
    assert.equal(result.started, false);
    assert.equal(result.reason, "no-upstream");
  }],

  ["降级：读不到 secret（dshHome 指空目录）→ started:false(no-credentials)，不抛异常", async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-listener-nosec-"));
    try {
      const result = await startWebListener({
        env: { DSH_WEB_URL: "http://127.0.0.1:65534" },
        dshHome: dir, // no .credentials.yaml in here
        config: { stateFile: join(dir, "s.json"), basePort: 24000 },
      });
      assert.equal(result.started, false);
      assert.equal(result.reason, "no-credentials");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }],

  ["resolveUpstream 优先级与白名单：env > config；仅 127.0.0.1 http", async () => {
    // env 优先
    const envFirst = await resolveUpstream(
      { DSH_WEB_URL: "http://127.0.0.1:11111" },
      { dshWebUrl: "http://127.0.0.1:22222" },
      SECRET,
      () => {},
    );
    assert.equal(envFirst, "http://127.0.0.1:11111");
    // config 次之（env 缺失）
    const configSecond = await resolveUpstream({}, { dshWebUrl: "http://127.0.0.1:22222" }, SECRET, () => {});
    assert.equal(configSecond, "http://127.0.0.1:22222");
    // 非 loopback / 非 http 一律拒绝（listener 永不指向外网）
    assert.equal(await resolveUpstream({ DSH_WEB_URL: "https://127.0.0.1:9" }, {}, SECRET, () => {}), undefined);
    assert.equal(await resolveUpstream({ DSH_WEB_URL: "http://192.168.1.5:80" }, {}, SECRET, () => {}), undefined);
    assert.equal(await resolveUpstream({ DSH_WEB_URL: "http://localhost:80" }, {}, SECRET, () => {}), undefined);
    // 都没有且探测失败（无进程表）→ undefined
    const none = await resolveUpstream(
      {},
      { execFileImpl: (exe, args, opts, cb) => cb(new Error("no exec")) },
      SECRET,
      () => {},
    );
    assert.equal(none, undefined);
  }],

  ["DEFAULT_BASE_PORT 契约：起始口 17878（与 myco 侧约定一致）", () => {
    assert.equal(DEFAULT_BASE_PORT, 17878);
  }],
];

/* ────────────────────────── dual-mode runner ────────────────────────────── */


/* ── 连接级身份（2026-11-09）：x-myco-viewer 验签与按连接归因 ────────────── */

tests.push(
  ["verifyViewerHeader：有效签名通过 / 坏签名与过期拒绝", async () => {
    const { verifyViewerHeader } = await import("../src/web-listener.js");
    const { createHmac } = await import("node:crypto");
    const key = Buffer.from("test-key-32-bytes-long-abcdefgh", "utf8");
    const keyText = key.toString("base64url");
    const did = "did:myco:tail4";
    const mk = (ts) => `${did}.${ts}.${createHmac("sha256", key).update(`${did}\n${ts}`).digest("base64url")}`;
    const now = Date.now();
    assert.equal(verifyViewerHeader(mk(now), keyText), did);
    assert.equal(verifyViewerHeader(mk(now), key), did);
    assert.equal(verifyViewerHeader(`${did}.${now}.deadbeef`, keyText), undefined);
    assert.equal(verifyViewerHeader(mk(now - 400_000), keyText), undefined);
    assert.equal(verifyViewerHeader("", keyText), undefined);
  }],

  ["连接身份优先于口级归因：同口带他人身份头 → 用该身份的 label 署名", async () => {
    const { startProxySuite } = await import("../src/web-listener.js");
    const { canonicalBody } = await import("../src/policy-proxy.js");
    const { createHmac, randomBytes, randomUUID } = await import("node:crypto");
    const key = randomBytes(32);
    let seen = "";
    const upstream = (await import("node:http")).createServer((q, s) => {
      q.on("data", (c) => { seen += c; });
      q.on("end", () => { s.writeHead(200, { "content-type": "application/json" }); s.end("{}"); });
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "connid-"));
    const suite = await startProxySuite({
      env: { DSH_WEB_URL: `http://127.0.0.1:${upstream.address().port}` },
      config: { stateFile: join(dir, "s.json"), basePort: 24000 + Math.floor(Math.random() * 2000) },
      secret: randomBytes(32), controlKey: key, controlPort: 0, log: () => {},
    });
    const push = async (did, label) => {
      const body = { nonce: randomUUID(), ts: Date.now(), viewerDid: did, authz: { taskCaps: {}, taskVis: {}, grant: {}, viewerLabel: label } };
      body.sig = createHmac("sha256", key).update(canonicalBody(body)).digest("base64url");
      await fetch(`http://127.0.0.1:${suite.controlPort}/policy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    };
    await push("did:myco:AAAA", "设备·笔记本·AAAA");
    await push("did:myco:BBBB", "设备·桌面机·BBBB");
    const text = () => JSON.parse(seen).payload.args.request.content[0].text;
    const send = async (header) => {
      seen = "";
      await fetch(`http://127.0.0.1:${suite.owner.port}/api/session/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(header ? { "x-myco-viewer": header } : {}) },
        body: JSON.stringify({ method: "session/prompt", payload: { args: { request: { content: [{ type: "text", text: "你好" }] } } } }),
      });
      return text();
    };
    const ts = Date.now();
    const headerB = `did:myco:BBBB.${ts}.${createHmac("sha256", key).update(`did:myco:BBBB\n${ts}`).digest("base64url")}`;
    assert.equal(await send(undefined), "你好", "owner 口无头 → 不署名（无口级策略）");
    assert.equal(await send(headerB), "【设备·桌面机·BBBB】：你好", "带 B 身份头 → 按连接归因");
    assert.equal(await send("did:myco:BBBB.1.bad"), "你好", "坏签名 → 回退无策略（不署名）");
    suite.close(); upstream.closeAllConnections?.(); upstream.close();
  }],
);

tests.push(
  ["resolveUpstreamWithRetry：宿主未就绪时重试，就绪后成功（宿主重启自愈）", async () => {
    const { resolveUpstreamWithRetry } = await import("../src/web-listener.js");
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "upstream-retry-"));
    const portFile = join(dir, "dsh-port.txt");
    await writeFile(portFile, "12345\n", "utf8");
    let calls = 0;
    const config = {
      upstreamAttempts: 4,
      upstreamRetryMs: 1,
      dshPortFile: portFile,
      execFileImpl: async () => ({ stdout: "" }),
      fetchImpl: async () => {
        calls += 1;
        if (calls >= 2) return { status: 200, body: { cancel: async () => {} } };
        return { status: 503, body: { cancel: async () => {} } };
      },
    };
    const logs = [];
    const upstream = await resolveUpstreamWithRetry({}, config, "secret", (m) => logs.push(m));
    assert.equal(upstream, "http://127.0.0.1:12345", "应通过 dsh-port.txt 兜底解析");
    assert.ok(calls >= 2, "第一次失败后应重试");
    assert.ok(logs.some((m) => m.includes("retrying")), "应记录重试");
  }],

  ["resolveUpstreamWithRetry：全部失败返回 undefined（有界，不无限挂）", async () => {
    const { resolveUpstreamWithRetry } = await import("../src/web-listener.js");
    const config = {
      upstreamAttempts: 2,
      upstreamRetryMs: 1,
      dshPortFile: "C:/definitely/missing/dsh-port.txt",
      execFileImpl: async () => ({ stdout: "" }),
      fetchImpl: async () => ({ status: 503, body: { cancel: async () => {} } }),
    };
    const upstream = await resolveUpstreamWithRetry({}, config, "secret", () => {});
    assert.equal(upstream, undefined);
  }],
);

tests.push(
  ["连接身份兼容：纯 DID 头 x-myco-viewer-did 也可按连接归因（签名头优先）", async () => {
    const { startProxySuite } = await import("../src/web-listener.js");
    const { canonicalBody } = await import("../src/policy-proxy.js");
    const { createHmac, randomBytes, randomUUID } = await import("node:crypto");
    const key = randomBytes(32);
    let seen = "";
    const upstream = (await import("node:http")).createServer((q, s) => {
      q.on("data", (c) => { seen += c; });
      q.on("end", () => { s.writeHead(200, { "content-type": "application/json" }); s.end("{}"); });
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "didheader-"));
    const suite = await startProxySuite({
      env: { DSH_WEB_URL: `http://127.0.0.1:${upstream.address().port}` },
      config: { stateFile: join(dir, "s.json"), basePort: 27500 + Math.floor(Math.random() * 1200) },
      secret: randomBytes(32), controlKey: key, controlPort: 0,
      log: () => {},
    });
    const did = "did:myco:PLAINDID";
    const body = { nonce: randomUUID(), ts: Date.now(), viewerDid: did, authz: { taskCaps: {}, taskVis: {}, grant: {}, viewerLabel: "设备·纯DID·pppp" } };
    body.sig = createHmac("sha256", key).update(canonicalBody(body)).digest("base64url");
    await fetch(`http://127.0.0.1:${suite.controlPort}/policy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    seen = "";
    await fetch(`http://127.0.0.1:${suite.owner.port}/api/session/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-myco-viewer-did": did },
      body: JSON.stringify({ method: "session/prompt", payload: { args: { request: { content: [{ type: "text", text: "hi" }] } } } }),
    });
    assert.equal(JSON.parse(seen).payload.args.request.content[0].text, "【设备·纯DID·pppp】：hi");
    suite.close(); upstream.close();
  }],
);

if (process.env.VITEST !== undefined) {
  const { describe, it } = await import("vitest");
  describe("web listener (mock upstream)", () => {
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
